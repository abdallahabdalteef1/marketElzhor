// Shared helpers: DOM, formatting, dialogs, toasts, phone handling, error messages.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const money = (n) =>
  Number(n || 0).toLocaleString('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ج.م';
export const qtyFmt = (n) => Number(n || 0).toLocaleString('ar-EG', { maximumFractionDigits: 2 });
export const dateFmt = (d) =>
  new Date(d).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' });

export const debounce = (fn, ms = 300) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

// Inline SVG placeholder shown when a product has no image (honest: no fake photos).
export const PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#eef3ec"/>` +
    `<path d="M30 50h60l-6 38H36z" fill="none" stroke="#9db8a3" stroke-width="4" stroke-linejoin="round"/>` +
    `<path d="M44 50c0-14 8-22 16-22s16 8 16 22" fill="none" stroke="#9db8a3" stroke-width="4" stroke-linecap="round"/></svg>`
  );
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && !t.dataset.fb) { t.dataset.fb = '1'; t.src = PLACEHOLDER; }
}, true);

// Only http(s) URLs are allowed in owner-provided links (blocks javascript: URLs).
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '');

// ---- toasts ----
export function toast(msg, type = 'ok') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  box.append(el);
  setTimeout(() => el.classList.add('out'), type === 'err' ? 5200 : 3200);
  setTimeout(() => el.remove(), type === 'err' ? 5600 : 3600);
}

// ---- dialogs (native <dialog>: focus trap + Esc for free) ----
export function modal(html, { title = '', wide = false, onClose } = {}) {
  const d = document.createElement('dialog');
  d.className = 'modal' + (wide ? ' wide' : '');
  d.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="إغلاق">✕</button></div><div class="modal-body">${html}</div>`;
  document.body.append(d);
  const close = () => { if (d.open) d.close(); };
  d.addEventListener('close', () => { d.remove(); onClose && onClose(); });
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) close(); });
  d.showModal();
  return { el: d, body: d.querySelector('.modal-body'), close };
}

export function confirmDialog(message, okText = 'تأكيد', danger = true) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(
      `<p class="confirm-msg">${esc(message)}</p><div class="row end gap"><button class="btn ghost" data-no>إلغاء</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okText)}</button></div>`,
      { title: 'تأكيد', onClose: () => { if (!done) resolve(false); } }
    );
    m.el.querySelector('[data-yes]').onclick = () => { done = true; resolve(true); m.close(); };
    m.el.querySelector('[data-no]').onclick = () => m.close();
  });
}

// ---- phone helpers (Egypt) ----
export function waNumber(p) {               // -> digits for wa.me, e.g. 201008927372
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '20' + d.slice(1);
  else if (!d.startsWith('20') && d.length === 10) d = '20' + d;
  return d;
}
export const toE164 = (p) => '+' + waNumber(p);
export const validPhone = (p) => /^[0-9+ ()-]{8,20}$/.test(String(p || '').trim());

// ---- readable Arabic errors ----
export function arabicError(err) {
  const m = String(err?.message || err || '');
  const map = [
    [/Invalid login credentials/i, 'البريد الإلكتروني أو كلمة المرور غير صحيحة'],
    [/Email not confirmed/i, 'يرجى تأكيد بريدك الإلكتروني من الرسالة المرسلة إليك أولا'],
    [/User already registered/i, 'هذا البريد مسجل بالفعل، جرّب تسجيل الدخول'],
    [/Password should be at least/i, 'كلمة المرور قصيرة (٨ أحرف على الأقل)'],
    [/rate limit|too many/i, 'محاولات كثيرة، برجاء الانتظار قليلا ثم المحاولة مرة أخرى'],
    [/Token has expired|invalid.*token|otp.*expired/i, 'الرمز غير صحيح أو انتهت صلاحيته'],
    [/Failed to fetch|NetworkError|network/i, 'تعذر الاتصال بالخادم، تحقق من الإنترنت وحاول مرة أخرى'],
    [/permission denied|row-level security/i, 'ليست لديك صلاحية لتنفيذ هذا الإجراء'],
    [/duplicate key|already exists/i, 'هذه القيمة مستخدمة بالفعل'],
    [/violates foreign key/i, 'لا يمكن الحذف لارتباط هذا العنصر ببيانات أخرى (يمكنك إخفاؤه بدلا من ذلك)'],
  ];
  for (const [re, ar] of map) if (re.test(m)) return ar;
  // RPC business errors are already Arabic
  return /[؀-ۿ]/.test(m) ? m : 'حدث خطأ غير متوقع، حاول مرة أخرى';
}

// ---- client-side image compression before upload ----
export async function compressImage(file, maxSide = 900, quality = 0.82) {
  if (file.type === 'image/svg+xml') return file;
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/webp', quality));
  return blob || file;
}
