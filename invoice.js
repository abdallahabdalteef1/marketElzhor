// Printable Arabic invoice. Access: guest link (order number + secret token) or signed-in owner/staff/customer via RLS.
import { sb, IS_CONFIGURED, loadSettings, applyBrand, loadOrderForInvoice, invoiceMessage, waLink, getMyRoles } from './api.js';
import { $, esc, money, qtyFmt, dateFmt, waNumber, arabicError } from './util.js';

const PAY = { unpaid: 'غير مدفوع', paid: 'مدفوع', refunded: 'مسترد' };
const ST = { pending: 'بانتظار التأكيد', confirmed: 'تم التأكيد', preparing: 'جارٍ التجهيز', out_for_delivery: 'في الطريق', completed: 'مكتمل', canceled: 'ملغي' };
const root = $('#inv-root');

(async function () {
  if (!IS_CONFIGURED) { root.innerHTML = '<div class="config-error">الموقع غير متصل بقاعدة البيانات.</div>'; return; }
  const p = new URLSearchParams(location.search);
  try {
    const [s, o, roles] = await Promise.all([
      loadSettings(),
      loadOrderForInvoice({ number: p.get('o'), token: p.get('t'), id: p.get('id') }),
      getMyRoles(),
    ]);
    if (!o) { root.innerHTML = '<div class="empty">تعذر العثور على الفاتورة.</div>'; return; }
    applyBrand(s); document.title = 'فاتورة ' + (o.invoice_number || o.order_number);
    const isStaff = roles.owner || roles.staff;
    const items = o.items || [];
    root.innerHTML = `
      <div class="inv-actions no-print">
        <button class="btn primary" id="b-print">🖨️ طباعة</button>
        <button class="btn ghost" id="b-pdf">⬇️ حفظ كملف PDF</button>
        <button class="btn wa" id="b-wa">إرسال ملخص الفاتورة عبر واتساب</button>
        ${isStaff ? '<button class="btn ghost" id="b-cust">إرسال للعميل على واتساب</button>' : ''}
      </div>
      <p class="muted no-print" style="max-width:820px;margin:6px auto 0;font-size:.85rem">لحفظ PDF اختر "حفظ كـ PDF" من نافذة الطباعة. زر واتساب يفتح رسالة جاهزة فقط، ولا يعني أنها أُرسلت.</p>
      <article class="invoice" id="invoice">
        <div class="inv-head"><div class="row gap">${s.logo_url ? `<img src="${esc(s.logo_url)}" alt="" style="height:56px">` : ''}<div><h1>${esc(s.store_name)}</h1><div class="muted">${esc(s.address || '')}</div><div class="muted" dir="ltr" style="text-align:right">${esc(s.phone || '')}</div></div></div>
          <div style="text-align:end"><h2 style="margin:0">فاتورة</h2><div dir="ltr"><b>${esc(o.invoice_number || '')}</b></div><div class="muted">${dateFmt(o.created_at)}</div></div></div>
        <div class="inv-meta">
          <div><b>رقم الطلب:</b> <span dir="ltr">${esc(o.order_number)}</span></div><div><b>حالة الطلب:</b> ${esc(ST[o.status] || o.status)}</div>
          <div><b>العميل:</b> ${esc(o.customer_name)}</div><div><b>حالة الدفع:</b> ${esc(PAY[o.payment_status] || o.payment_status || '—')}</div>
          <div><b>الهاتف:</b> <span dir="ltr">${esc(o.customer_phone)}</span></div><div><b>طريقة الدفع:</b> ${esc(o.payment_method)}</div>
          <div style="grid-column:1/-1"><b>${o.fulfillment === 'pickup' ? 'الاستلام:' : 'العنوان:'}</b> ${o.fulfillment === 'pickup' ? 'من المتجر' : esc(o.address || '')}</div>
        </div>
        <table class="inv-table"><thead><tr><th>#</th><th>المنتج</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead><tbody>
          ${items.map((it, i) => { const eff = Number(it.unit_price) - Number(it.discount_per_unit || 0); return `<tr><td>${i + 1}</td><td>${esc(it.product_name)}</td><td>${qtyFmt(it.quantity)} ${esc(it.unit)}</td><td>${money(eff)}${Number(it.discount_per_unit) > 0 ? ` <s class="muted">${money(it.unit_price)}</s>` : ''}</td><td>${money(it.line_total)}</td></tr>`; }).join('')}
        </tbody></table>
        <div class="inv-totals"><div><span>المجموع الفرعي</span><span>${money(o.subtotal)}</span></div>
          ${Number(o.discount_total) > 0 ? `<div><span>الخصم</span><span>− ${money(o.discount_total)}</span></div>` : ''}
          <div><span>رسوم التوصيل</span><span>${Number(o.delivery_fee) ? money(o.delivery_fee) : 'مجانا'}</span></div>
          <div class="grand"><span>الإجمالي النهائي</span><span>${money(o.total)}</span></div></div>
        ${o.notes ? `<p><b>ملاحظات:</b> ${esc(o.notes)}</p>` : ''}
        <p class="muted center" style="margin-top:20px">شكرا لتسوقكم من ${esc(s.store_name)}</p>
      </article>`;
    $('#b-print').onclick = () => window.print();
    $('#b-pdf').onclick = () => window.print();
    const msg = invoiceMessage(o, s.store_name);
    $('#b-wa').onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
    const bc = $('#b-cust'); if (bc) bc.onclick = () => window.open(waLink(waNumber(o.customer_phone), msg), '_blank', 'noopener');
  } catch (e) {
    root.innerHTML = `<div class="empty">${esc(arabicError(e))}</div>`;
  }
})();
