// Shopping cart (product ids + quantities only), cart drawer, checkout and order submission.
// Prices shown here are for display; the SERVER recalculates everything in create_order().
import { sb, orderMessage, waLink } from './api.js';
import { state, bus, rememberOrder } from './state.js';
import { $, esc, money, qtyFmt, toast, modal, confirmDialog, uuid, validPhone, arabicError, PLACEHOLDER } from './util.js';

const KEY = 'market.cart.v1';
const load = () => { try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };

// Only a convenience copy of {productId: qty}; the database remains the source of truth for everything else.
export const cart = {
  items: load(),
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.items)); } catch { /* ignore */ } bus.emit('cart'); },
  count() { return Object.keys(this.items).length; },
  set(id, q) { if (!(q > 0)) delete this.items[id]; else this.items[id] = q; this.save(); },
  clear() { this.items = {}; this.save(); },
};

export const stepFor = (p) => (/كجم|كيلو|لتر/.test(p.unit || '') || Number(p.min_qty) % 1 !== 0 ? 0.5 : 1);
export const maxFor = (p) => Math.max(0, Math.min(Number(p.stock), p.max_qty == null ? Infinity : Number(p.max_qty)));

export function addToCart(p, qty) {
  const max = maxFor(p);
  const want = (cart.items[p.id] || 0) + qty;
  if (want > max) { cart.set(p.id, max); toast(`الحد الأقصى المتاح من هذا المنتج ${qtyFmt(max)}`, 'err'); return; }
  cart.set(p.id, want);
}

const feeFor = (net, ful) => {
  const s = state.settings;
  if (ful === 'pickup') return 0;
  return s.free_delivery_over != null && net >= Number(s.free_delivery_over) ? 0 : Number(s.delivery_fee);
};

let lines = [];   // [{p, qty}]
let notices = [];

async function refreshLines() {
  const ids = Object.keys(cart.items);
  notices = [];
  if (!ids.length) { lines = []; return; }
  const { data, error } = await sb.from('store_products')
    .select('id,name,price,final_price,discount_amount,unit,stock,image_url,min_qty,max_qty,is_active').in('id', ids);
  if (error) throw error;
  const map = new Map((data || []).map((p) => [p.id, p]));
  let changed = false;
  lines = [];
  for (const id of ids) {
    const p = map.get(id);
    if (!p || !p.is_active || Number(p.stock) <= 0) {
      delete cart.items[id]; changed = true;
      notices.push(`تمت إزالة "${p ? p.name : 'منتج'}" لأنه غير متاح حاليا`);
      continue;
    }
    let q = cart.items[id];
    const max = maxFor(p);
    if (q > max) { q = max; changed = true; notices.push(`تم تعديل كمية "${p.name}" حسب المتاح (${qtyFmt(max)})`); }
    if (q < Number(p.min_qty)) { q = Number(p.min_qty); changed = true; }
    cart.items[id] = q;
    lines.push({ p, qty: q });
  }
  if (changed) cart.save();
}

export function totals(ful = 'delivery') {
  let subtotal = 0, discount = 0;
  for (const { p, qty } of lines) { subtotal += Number(p.price) * qty; discount += Number(p.discount_amount) * qty; }
  const net = subtotal - discount;
  const fee = lines.length ? feeFor(net, ful) : 0;
  return { subtotal, discount, net, fee, total: net + fee };
}

// ---------------- drawer ----------------
export function openCart() { document.body.classList.add('cart-open'); $('#drawer').setAttribute('aria-hidden', 'false'); renderCart(); }
export function closeCart() { document.body.classList.remove('cart-open'); $('#drawer').setAttribute('aria-hidden', 'true'); }

export async function renderCart() {
  const body = $('#drawer-body'), foot = $('#drawer-foot');
  body.innerHTML = '<p class="center"><span class="spinner"></span></p>'; foot.innerHTML = '';
  try { await refreshLines(); } catch (e) { body.innerHTML = `<div class="notice bad">${esc(arabicError(e))}</div>`; return; }
  if (!lines.length) {
    body.innerHTML = `${notices.map((n) => `<div class="notice">${esc(n)}</div>`).join('')}<div class="empty"><div class="big">🛒</div><p>سلتك فارغة حاليا</p><button class="btn primary" id="cart-shop">ابدأ التسوق</button></div>`;
    $('#cart-shop').onclick = () => { closeCart(); location.hash = '#/all'; };
    return;
  }
  body.innerHTML = notices.map((n) => `<div class="notice">${esc(n)}</div>`).join('') + lines.map(({ p, qty }) => {
    const unitPrice = Number(p.final_price);
    const st = stepFor(p), mx = maxFor(p);
    return `<div class="line" data-id="${p.id}">
      <img src="${esc(p.image_url || PLACEHOLDER)}" alt="" loading="lazy">
      <div><h4>${esc(p.name)}</h4>
        <div class="muted">${money(unitPrice)} / ${esc(p.unit)}${Number(p.discount_amount) > 0 ? ` <s>${money(p.price)}</s>` : ''}</div>
        <div class="ctrl">
          <div class="qty sm"><button data-dec aria-label="إنقاص">−</button><input type="number" inputmode="decimal" min="${p.min_qty}" max="${mx}" step="${st}" value="${qty}" aria-label="الكمية"><button data-inc aria-label="زيادة">+</button></div>
          <strong>${money(unitPrice * qty)}</strong>
          <button class="rm" data-rm>حذف</button>
        </div></div></div>`;
  }).join('');
  renderFoot();
  body.querySelectorAll('.line').forEach((row) => {
    const id = row.dataset.id; const l = lines.find((x) => x.p.id === id); const inp = row.querySelector('input');
    const apply = (q) => {
      const st = stepFor(l.p), mx = maxFor(l.p), mn = Number(l.p.min_qty);
      if (q > mx) { toast(`المتاح من هذا المنتج ${qtyFmt(mx)} فقط`, 'err'); q = mx; }
      if (q < mn) q = mn;
      q = Math.round(q / st) * st || mn;
      cart.set(id, q); l.qty = q; inp.value = q;
      row.querySelector('strong').textContent = money(Number(l.p.final_price) * q); renderFoot();
    };
    row.querySelector('[data-inc]').onclick = () => apply(Number(inp.value) + stepFor(l.p));
    row.querySelector('[data-dec]').onclick = () => apply(Number(inp.value) - stepFor(l.p));
    inp.onchange = () => apply(Number(inp.value) || Number(l.p.min_qty));
    row.querySelector('[data-rm]').onclick = () => { cart.set(id, 0); renderCart(); };
  });
}

function renderFoot() {
  const foot = $('#drawer-foot');
  if (!lines.length) { foot.innerHTML = ''; return; }
  const t = totals('delivery'), s = state.settings;
  const belowMin = t.net < Number(s.min_order_amount);
  foot.innerHTML = `
    ${belowMin ? `<div class="notice">الحد الأدنى للطلب ${money(s.min_order_amount)}، أضف منتجات بقيمة ${money(Number(s.min_order_amount) - t.net)} لإتمام الطلب.</div>` : ''}
    <div class="totals">
      <div><span>المجموع الفرعي</span><span>${money(t.subtotal)}</span></div>
      ${t.discount > 0 ? `<div><span>الخصم</span><span>− ${money(t.discount)}</span></div>` : ''}
      <div><span>رسوم التوصيل</span><span>${t.fee ? money(t.fee) : 'مجانا'}</span></div>
      <div class="grand"><span>الإجمالي</span><span>${money(t.total)}</span></div>
    </div>
    <p class="muted" style="font-size:.82rem;margin:0 0 10px">يتم احتساب السعر النهائي من الخادم عند تأكيد الطلب. الاستلام من المتجر بدون رسوم توصيل.</p>
    <div class="row gap"><button class="btn primary grow" id="go-checkout" ${belowMin ? 'disabled' : ''}>إتمام الطلب</button>
    <button class="btn ghost" id="clear-cart">إفراغ</button></div>
    <button class="btn ghost block" style="margin-top:8px" id="keep-shopping">متابعة التسوق</button>`;
  $('#go-checkout').onclick = openCheckout;
  $('#keep-shopping').onclick = closeCart;
  $('#clear-cart').onclick = async () => { if (await confirmDialog('هل تريد إفراغ السلة بالكامل؟', 'إفراغ السلة')) { cart.clear(); renderCart(); } };
}

// ---------------- checkout ----------------
async function openCheckout() {
  const s = state.settings, pf = state.profile || {};
  let addrs = [];
  if (state.session) {
    const { data } = await sb.from('customer_addresses').select('*').order('is_default', { ascending: false });
    addrs = data || [];
  }
  const methods = Array.isArray(s.payment_methods) && s.payment_methods.length ? s.payment_methods : ['الدفع عند الاستلام'];
  const m = modal(`
    <form id="co-form" novalidate>
      <div class="radio-row" role="radiogroup" aria-label="طريقة الاستلام">
        <label><input type="radio" name="fulfillment" value="delivery" checked> توصيل للمنزل</label>
        <label><input type="radio" name="fulfillment" value="pickup"> استلام من المتجر</label>
      </div>
      <div class="field-grid">
        <label class="f">الاسم بالكامل *<input name="name" required maxlength="100" autocomplete="name" value="${esc(pf.full_name || '')}"><span class="err" data-err="name"></span></label>
        <label class="f">رقم الهاتف *<input name="phone" required inputmode="tel" autocomplete="tel" dir="ltr" placeholder="01xxxxxxxxx" value="${esc(pf.phone || '')}"><span class="err" data-err="phone"></span></label>
        <label class="f full">البريد الإلكتروني (اختياري)<input name="email" type="email" autocomplete="email" dir="ltr" value="${esc(pf.email || (state.session?.user?.email) || '')}"><span class="err" data-err="email"></span></label>
        <div class="full" id="addr-box">
          ${addrs.length ? `<label class="f">عناوينك المحفوظة<select id="addr-pick"><option value="">اختر عنوانا…</option>${addrs.map((a) => `<option value="${esc(a.address)}">${esc(a.label ? a.label + ' — ' : '')}${esc(a.address)}</option>`).join('')}</select></label>` : ''}
          <label class="f">عنوان التوصيل *<textarea name="address" rows="2" maxlength="400" autocomplete="street-address" placeholder="المحافظة، المدينة، الشارع، رقم العقار، علامة مميزة"></textarea><span class="err" data-err="address"></span></label>
        </div>
        <label class="f full">ملاحظات للتوصيل (اختياري)<textarea name="notes" rows="2" maxlength="500"></textarea></label>
        <label class="f full">طريقة الدفع *<select name="payment_method">${methods.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
      </div>
      <div class="totals" id="co-totals"></div>
      <div class="notice info">بعد الضغط على الزر سيتم حفظ طلبك ثم فتح واتساب برسالة جاهزة، اضغط "إرسال" داخل واتساب. يظل طلبك <b>بانتظار تأكيد المتجر</b> حتى يرد عليك.</div>
      <div class="notice bad" id="co-error" hidden></div>
      <button class="btn wa block" type="submit" id="co-submit">إرسال الطلب عبر واتساب</button>
    </form>`, { title: 'مراجعة الطلب وإتمامه' });

  const form = $('#co-form', m.el);
  const ful = () => form.fulfillment.value;
  const paint = () => {
    const t = totals(ful());
    $('#co-totals', m.el).innerHTML = lines.map(({ p, qty }) => `<div class="muted"><span>${esc(p.name)} × ${qtyFmt(qty)}</span><span>${money(Number(p.final_price) * qty)}</span></div>`).join('') +
      `<div><span>المجموع الفرعي</span><span>${money(t.subtotal)}</span></div>` +
      (t.discount > 0 ? `<div><span>الخصم</span><span>− ${money(t.discount)}</span></div>` : '') +
      `<div><span>رسوم التوصيل</span><span>${t.fee ? money(t.fee) : 'مجانا'}</span></div><div class="grand"><span>الإجمالي</span><span>${money(t.total)}</span></div>`;
    $('#addr-box', m.el).hidden = ful() === 'pickup';
  };
  form.querySelectorAll('[name=fulfillment]').forEach((r) => r.addEventListener('change', paint));
  const pick = $('#addr-pick', m.el); if (pick) pick.onchange = () => { if (pick.value) form.address.value = pick.value; };
  if (addrs[0]) form.address.value = addrs[0].address;
  paint();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errs = {};
    const v = (n) => form[n].value.trim();
    if (v('name').length < 2) errs.name = 'يرجى إدخال الاسم';
    if (!validPhone(v('phone'))) errs.phone = 'يرجى إدخال رقم هاتف صحيح';
    if (v('email') && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email'))) errs.email = 'البريد الإلكتروني غير صحيح';
    if (ful() === 'delivery' && v('address').length < 5) errs.address = 'يرجى كتابة عنوان التوصيل بالتفصيل';
    form.querySelectorAll('[data-err]').forEach((e) => { e.textContent = errs[e.dataset.err] || ''; });
    if (Object.keys(errs).length) { form.querySelector(`[name=${Object.keys(errs)[0]}]`).focus(); return; }

    const items = Object.entries(cart.items).map(([product_id, qty]) => ({ product_id, qty }));
    const customer = { name: v('name'), phone: v('phone'), email: v('email'), address: v('address'), notes: v('notes'), payment_method: form.payment_method.value, fulfillment: ful() };

    // Same cart + same details => same idempotency key, so double taps / retries cannot create two orders.
    const sig = JSON.stringify([items.sort((a, b) => a.product_id.localeCompare(b.product_id)), customer]);
    let ck; try { ck = JSON.parse(localStorage.getItem('market.ck') || 'null'); } catch { ck = null; }
    if (!ck || ck.sig !== sig) { ck = { sig, key: uuid() }; try { localStorage.setItem('market.ck', JSON.stringify(ck)); } catch { /* ignore */ } }

    const btn = $('#co-submit', m.el), errBox = $('#co-error', m.el);
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> جارٍ حفظ الطلب…'; errBox.hidden = true;
    // Open the WhatsApp tab synchronously inside the click so mobile popup blockers allow it.
    const waWin = window.open('about:blank', '_blank');
    try {
      const { data: order, error } = await sb.rpc('create_order', { p_items: items, p_customer: customer, p_idempotency_key: ck.key });
      if (error) throw error;
      rememberOrder(order.order_number, order.access_token);
      try { localStorage.removeItem('market.ck'); } catch { /* ignore */ }
      cart.clear();
      const url = waLink(state.settings.whatsapp_number, orderMessage(order));
      if (waWin) waWin.location.href = url;
      // Optional official API notification to the store (only if the owner enabled it after configuring secrets).
      if (state.settings.whatsapp_api_enabled) {
        sb.functions.invoke('whatsapp-notify', { body: { order_number: order.order_number, token: order.access_token } }).catch(() => {});
      }
      m.close(); closeCart();
      sessionStorage.setItem('market.wa.' + order.order_number, url);
      location.hash = `#/order/${order.order_number}/${order.access_token}`;
    } catch (e) {
      if (waWin) waWin.close();
      errBox.textContent = arabicError(e); errBox.hidden = false;
      btn.disabled = false; btn.textContent = 'إرسال الطلب عبر واتساب';
      if (/متاح|متوفر|غير متاح|الكمية/.test(errBox.textContent)) renderCart();
    }
  });
}
