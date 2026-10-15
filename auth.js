// Authentication UI (email/password, phone OTP, recovery) and the customer account page.
import { sb, getSession, getMyRoles } from './api.js';
import { state, bus, rememberedOrders } from './state.js';
import { $, esc, toast, modal, confirmDialog, arabicError, toE164, validPhone, money, dateFmt } from './util.js';

const STATUS_AR = { pending: 'بانتظار التأكيد', confirmed: 'تم التأكيد', preparing: 'جارٍ التجهيز', out_for_delivery: 'في الطريق إليك', completed: 'مكتمل', canceled: 'ملغي' };
export const statusAr = (s) => STATUS_AR[s] || s;
const PAY_AR = { unpaid: 'غير مدفوع', paid: 'مدفوع', refunded: 'مسترد' };
export const payAr = (s) => PAY_AR[s] || s;

export async function refreshSession() {
  state.session = await getSession();
  state.roles = await getMyRoles();
  state.profile = null;
  if (state.session) {
    const { data } = await sb.from('profiles').select('*').eq('id', state.session.user.id).maybeSingle();
    state.profile = data;
  }
  bus.emit('auth');
}

export function initAuth() {
  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') { setTimeout(openResetPassword, 0); return; }
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') setTimeout(refreshSession, 0);
  });
  return refreshSession();
}

function openResetPassword() {
  const m = modal(`<form id="rp" novalidate><p>اختر كلمة مرور جديدة لحسابك.</p>
    <label class="f">كلمة المرور الجديدة<input name="p1" type="password" minlength="8" autocomplete="new-password" required></label>
    <label class="f">تأكيد كلمة المرور<input name="p2" type="password" minlength="8" autocomplete="new-password" required></label>
    <div class="notice bad" id="rp-err" hidden></div><button class="btn primary block">حفظ كلمة المرور</button></form>`, { title: 'تعيين كلمة مرور جديدة' });
  $('#rp', m.el).onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; const err = $('#rp-err', m.el);
    if (f.p1.value.length < 8) { err.textContent = 'كلمة المرور يجب ألا تقل عن ٨ أحرف'; err.hidden = false; return; }
    if (f.p1.value !== f.p2.value) { err.textContent = 'كلمتا المرور غير متطابقتين'; err.hidden = false; return; }
    const { error } = await sb.auth.updateUser({ password: f.p1.value });
    if (error) { err.textContent = arabicError(error); err.hidden = false; return; }
    toast('تم تغيير كلمة المرور بنجاح'); m.close(); refreshSession();
  };
}

export function openAuth(tab = 'login') {
  const m = modal(`
    <div class="tabs" role="tablist">
      <button data-t="login" role="tab">تسجيل الدخول</button><button data-t="register" role="tab">حساب جديد</button><button data-t="phone" role="tab">برقم الهاتف</button>
    </div><div id="auth-pane"></div>`, { title: 'حسابي' });
  const pane = $('#auth-pane', m.el);
  const show = (t) => {
    m.el.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    ({ login, register, phone, forgot })[t]();
  };
  const fail = (msg) => { const e = $('#auth-err', m.el); e.textContent = msg; e.hidden = false; };
  const busy = (btn, on, label) => { btn.disabled = on; btn.innerHTML = on ? '<span class="spinner"></span>' : label; };
  const err = '<div class="notice bad" id="auth-err" hidden></div>';

  function login() {
    pane.innerHTML = `<form novalidate><label class="f">البريد الإلكتروني<input name="email" type="email" dir="ltr" autocomplete="username" required></label>
      <label class="f">كلمة المرور<input name="password" type="password" autocomplete="current-password" required></label>${err}
      <button class="btn primary block">دخول</button><p class="center"><button type="button" class="btn ghost sm" data-forgot>نسيت كلمة المرور؟</button></p></form>`;
    pane.querySelector('[data-forgot]').onclick = () => show('forgot');
    pane.querySelector('form').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target, b = f.querySelector('.primary');
      if (!f.email.value || !f.password.value) return fail('يرجى إدخال البريد وكلمة المرور');
      busy(b, true); const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      if (error) { busy(b, false, 'دخول'); return fail(arabicError(error)); }
      toast('تم تسجيل الدخول'); m.close();
    };
  }
  function register() {
    pane.innerHTML = `<form novalidate><label class="f">الاسم<input name="name" autocomplete="name" required maxlength="100"></label>
      <label class="f">البريد الإلكتروني<input name="email" type="email" dir="ltr" autocomplete="email" required></label>
      <label class="f">كلمة المرور<input name="password" type="password" minlength="8" autocomplete="new-password" required><span class="hint">٨ أحرف على الأقل</span></label>${err}
      <button class="btn primary block">إنشاء الحساب</button></form>`;
    pane.querySelector('form').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target, b = f.querySelector('.primary');
      if (f.name.value.trim().length < 2) return fail('يرجى إدخال الاسم');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.value)) return fail('البريد الإلكتروني غير صحيح');
      if (f.password.value.length < 8) return fail('كلمة المرور يجب ألا تقل عن ٨ أحرف');
      busy(b, true);
      const { data, error } = await sb.auth.signUp({ email: f.email.value.trim(), password: f.password.value,
        options: { data: { full_name: f.name.value.trim() }, emailRedirectTo: location.origin + location.pathname } });
      if (error) { busy(b, false, 'إنشاء الحساب'); return fail(arabicError(error)); }
      if (data.session) { toast('تم إنشاء حسابك'); m.close(); }
      else pane.innerHTML = '<div class="notice info">أرسلنا رابط تأكيد إلى بريدك الإلكتروني. افتح الرسالة واضغط على الرابط لتفعيل حسابك ثم سجّل الدخول.</div>';
    };
  }
  function phone() {
    pane.innerHTML = `<form id="ph1" novalidate><label class="f">رقم الهاتف<input name="phone" inputmode="tel" dir="ltr" placeholder="01xxxxxxxxx" autocomplete="tel" required></label>${err}
      <button class="btn primary block">إرسال رمز التحقق</button><p class="hint">سيصلك رمز من ٦ أرقام برسالة SMS. لا يتم اعتبار الرقم موثقا إلا بعد إدخال الرمز.</p></form>`;
    pane.querySelector('#ph1').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target, b = f.querySelector('.primary');
      if (!validPhone(f.phone.value)) return fail('يرجى إدخال رقم هاتف صحيح');
      const phoneNo = toE164(f.phone.value); busy(b, true);
      const { error } = await sb.auth.signInWithOtp({ phone: phoneNo });
      if (error) { busy(b, false, 'إرسال رمز التحقق'); return fail(arabicError(error)); }
      pane.innerHTML = `<form id="ph2" novalidate><p>أدخل الرمز المرسل إلى <b dir="ltr">${esc(phoneNo)}</b></p>
        <label class="f">رمز التحقق<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" dir="ltr" required></label>${err}
        <button class="btn primary block">تأكيد</button></form>`;
      pane.querySelector('#ph2').onsubmit = async (ev) => {
        ev.preventDefault(); const b2 = ev.target.querySelector('.primary'); busy(b2, true);
        const r = await sb.auth.verifyOtp({ phone: phoneNo, token: ev.target.code.value.trim(), type: 'sms' });
        if (r.error) { busy(b2, false, 'تأكيد'); return fail(arabicError(r.error)); }
        toast('تم التحقق وتسجيل الدخول'); m.close();
      };
    };
  }
  function forgot() {
    pane.innerHTML = `<form novalidate><p>اكتب بريدك الإلكتروني وسنرسل لك رابطا لتعيين كلمة مرور جديدة (صالح لفترة محدودة).</p>
      <label class="f">البريد الإلكتروني<input name="email" type="email" dir="ltr" required></label>${err}<button class="btn primary block">إرسال الرابط</button></form>`;
    pane.querySelector('form').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target, b = f.querySelector('.primary');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.value)) return fail('البريد الإلكتروني غير صحيح');
      busy(b, true);
      const { error } = await sb.auth.resetPasswordForEmail(f.email.value.trim(), { redirectTo: location.origin + location.pathname });
      if (error) { busy(b, false, 'إرسال الرابط'); return fail(arabicError(error)); }
      // Same message whether or not the account exists (prevents account enumeration).
      pane.innerHTML = '<div class="notice info">إذا كان البريد مسجلا لدينا فقد أرسلنا إليه رابط إعادة تعيين كلمة المرور. تحقق من صندوق الوارد.</div>';
    };
  }
  m.el.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => show(b.dataset.t)));
  show(tab);
}

// ---------------- account page ----------------
export async function renderAccount(root) {
  if (!state.session) {
    root.innerHTML = `<div class="section"><div class="panel center"><div class="big" style="font-size:2.4rem">👤</div><h2>مرحبا بك</h2>
      <p class="muted">سجّل الدخول لمتابعة طلباتك وحفظ عناوينك، أو تصفح كضيف وأتمم طلبك بدون حساب.</p>
      <button class="btn primary" id="acc-login">تسجيل الدخول / حساب جديد</button></div>${guestOrdersBlock()}</div>`;
    $('#acc-login').onclick = () => openAuth('login');
    bindGuestOrders(root);
    return;
  }
  const u = state.session.user, pf = state.profile || {};
  root.innerHTML = `<div class="section"><h1>حسابي</h1>
    ${(state.roles.owner || state.roles.staff) ? `<p><a class="btn accent" href="admin.html">الدخول إلى لوحة الإدارة</a></p>` : ''}
    <div class="panel"><h2 style="margin-top:0">البيانات الشخصية</h2>
      <form id="pf" novalidate class="field-grid">
        <label class="f">الاسم<input name="full_name" maxlength="100" value="${esc(pf.full_name || '')}"></label>
        <label class="f">الهاتف<input name="phone" dir="ltr" inputmode="tel" value="${esc(pf.phone || '')}"></label>
        <label class="f full">البريد / الدخول<input value="${esc(u.email || u.phone || '')}" dir="ltr" disabled></label>
        <div class="full row gap"><button class="btn primary">حفظ</button><button type="button" class="btn ghost" id="signout">تسجيل الخروج</button></div>
      </form></div>
    <div class="panel" style="margin-top:14px"><h2 style="margin-top:0">عناويني</h2><div id="addr-list"></div>
      <form id="addr-form" class="row gap wrap" style="margin-top:10px"><input class="input grow" name="label" placeholder="اسم العنوان (المنزل/العمل)" maxlength="40" style="min-width:160px"><input class="input" name="address" placeholder="العنوان بالتفصيل" maxlength="400" required style="flex:3;min-width:220px"><button class="btn ghost">إضافة</button></form></div>
    <div class="panel" style="margin-top:14px"><h2 style="margin-top:0">طلباتي</h2><div id="my-orders" class="orders-list"><span class="spinner"></span></div></div></div>`;
  $('#signout').onclick = async () => { await sb.auth.signOut(); toast('تم تسجيل الخروج'); location.hash = '#/'; };
  $('#pf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    if (f.phone.value && !validPhone(f.phone.value)) return toast('رقم الهاتف غير صحيح', 'err');
    const { error } = await sb.from('profiles').update({ full_name: f.full_name.value.trim() || null, phone: f.phone.value.trim() || null }).eq('id', u.id);
    if (error) return toast(arabicError(error), 'err');
    toast('تم حفظ البيانات'); refreshSession();
  };
  const loadAddrs = async () => {
    const { data } = await sb.from('customer_addresses').select('*').order('created_at', { ascending: false });
    $('#addr-list').innerHTML = (data || []).length ? data.map((a) => `<div class="order-row"><span>${esc(a.label ? a.label + ' — ' : '')}${esc(a.address)}</span><button class="btn ghost sm" data-del="${a.id}">حذف</button></div>`).join('') : '<p class="muted">لا توجد عناوين محفوظة.</p>';
    $('#addr-list').querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('حذف هذا العنوان؟', 'حذف'))) return;
      const { error } = await sb.from('customer_addresses').delete().eq('id', b.dataset.del); if (error) return toast(arabicError(error), 'err'); loadAddrs();
    }));
  };
  loadAddrs();
  $('#addr-form').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    if (f.address.value.trim().length < 5) return toast('اكتب العنوان بالتفصيل', 'err');
    const { error } = await sb.from('customer_addresses').insert({ user_id: u.id, label: f.label.value.trim() || null, address: f.address.value.trim() });
    if (error) return toast(arabicError(error), 'err'); f.reset(); loadAddrs();
  };
  const { data: orders, error } = await sb.from('orders').select('id,order_number,access_token,status,total,created_at').eq('user_id', u.id).order('created_at', { ascending: false }).limit(50);
  $('#my-orders').innerHTML = error ? `<div class="notice bad">${esc(arabicError(error))}</div>` : (orders || []).length
    ? orders.map((o) => `<div class="order-row"><div><b dir="ltr">${esc(o.order_number)}</b><div class="muted">${dateFmt(o.created_at)}</div></div><span class="status ${o.status}">${statusAr(o.status)}</span><b>${money(o.total)}</b><a class="btn ghost sm" href="invoice.html?id=${o.id}" target="_blank" rel="noopener">الفاتورة</a></div>`).join('')
    : '<p class="muted">لم تقم بأي طلب بعد.</p>';
}

function guestOrdersBlock() {
  return rememberedOrders().length ? `<div class="panel" style="margin-top:14px"><h2 style="margin-top:0">طلباتك على هذا الجهاز</h2><div id="guest-orders" class="orders-list"><span class="spinner"></span></div></div>` : '';
}
async function bindGuestOrders(root) {
  const box = $('#guest-orders', root); if (!box) return;
  const rows = await Promise.all(rememberedOrders().slice(0, 10).map(async (o) => {
    const { data } = await sb.rpc('get_order_public', { p_order_number: o.n, p_token: o.t });
    return data ? `<div class="order-row"><div><b dir="ltr">${esc(data.order_number)}</b><div class="muted">${dateFmt(data.created_at)}</div></div><span class="status ${data.status}">${statusAr(data.status)}</span><b>${money(data.total)}</b><a class="btn ghost sm" href="#/order/${esc(o.n)}/${esc(o.t)}">عرض</a></div>` : '';
  }));
  box.innerHTML = rows.join('') || '<p class="muted">لا توجد طلبات.</p>';
}
