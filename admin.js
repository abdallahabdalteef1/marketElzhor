// Admin dashboard shell: access gate, navigation, overview, orders, users and activity log.
// NOTE: hiding tabs is only UX. Every write is enforced by Row Level Security / SECURITY DEFINER functions.
import { sb, IS_CONFIGURED, getSession, getMyRoles, loadSettings, applyBrand, orderMessage, waLink } from './api.js';
import { $, $$, esc, money, qtyFmt, dateFmt, toast, modal, confirmDialog, arabicError, validPhone, waNumber } from './util.js';
import { renderProducts, renderCategories, renderContent } from './admin-catalog.js';

const root = $('#root');
const ST = { pending: 'بانتظار التأكيد', confirmed: 'تم التأكيد', preparing: 'جارٍ التجهيز', out_for_delivery: 'في الطريق', completed: 'مكتمل', canceled: 'ملغي' };
const PAY = { unpaid: 'غير مدفوع', paid: 'مدفوع', refunded: 'مسترد' };
const opts = (o, cur) => Object.entries(o).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('');
let ctx = { roles: null, settings: null, session: null };

(async function boot() {
  if (!IS_CONFIGURED) { $('#config-error').hidden = false; root.innerHTML = ''; return; }
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') location.reload(); });
  await gate();
})();

async function gate() {
  ctx.session = await getSession();
  if (!ctx.session) return renderLogin();
  ctx.roles = await getMyRoles();
  if (!ctx.roles.owner && !ctx.roles.staff) {
    root.innerHTML = `<div class="adm-login panel center"><h2>غير مصرح</h2><p>هذا الحساب ليس لديه صلاحية الدخول إلى لوحة الإدارة.</p><button class="btn ghost" id="so">تسجيل الخروج</button> <a class="btn primary" href="index.html">العودة للمتجر</a></div>`;
    $('#so').onclick = async () => { await sb.auth.signOut(); location.reload(); };
    return;
  }
  ctx.settings = await loadSettings(); applyBrand(ctx.settings); document.title = 'لوحة الإدارة — ' + ctx.settings.store_name;
  shell();
}

function renderLogin() {
  root.innerHTML = `<div class="adm-login panel"><h2 style="margin-top:0">دخول الإدارة</h2>
    <form id="lf" novalidate><label class="f">البريد الإلكتروني<input name="email" type="email" dir="ltr" autocomplete="username" required></label>
    <label class="f">كلمة المرور<input name="password" type="password" autocomplete="current-password" required></label>
    <div class="notice bad" id="le" hidden></div><button class="btn primary block">دخول</button>
    <p class="center"><button type="button" class="btn ghost sm" id="fp">نسيت كلمة المرور؟</button></p></form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; const le = $('#le');
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    if (error) { le.textContent = arabicError(error); le.hidden = false; return; }
    location.reload();
  };
  $('#fp').onclick = async () => {
    const email = $('#lf').email.value.trim(); if (!email) return toast('اكتب بريدك أولا', 'err');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname.replace('admin.html', 'index.html') });
    toast(error ? arabicError(error) : 'إذا كان البريد مسجلا فقد أرسلنا رابط إعادة التعيين', error ? 'err' : 'ok');
  };
}

function shell() {
  const r = ctx.roles, p = r.permissions || {};
  const tabs = [
    ['overview', '📊 نظرة عامة', r.owner || p.reports],
    ['orders', '🧾 الطلبات', r.owner || p.orders],
    ['products', '📦 المنتجات', r.owner],
    ['categories', '🗂️ الأقسام', r.owner],
    ['content', '🎨 العروض والمحتوى', r.owner],
    ['users', '👥 المستخدمون والسجل', r.owner],
  ].filter((t) => t[2]);
  root.innerHTML = `<div class="adm-shell"><aside class="adm-side"><h1>${esc(ctx.settings.store_name)}</h1>
    <nav>${tabs.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}<a href="index.html" style="color:#fff;padding:10px 12px;font-weight:700;display:block">↩ المتجر</a><button id="so">تسجيل الخروج</button></nav>
    <div class="who">${esc(ctx.session.user.email || ctx.session.user.phone || '')}<br>${r.owner ? 'المالك' : 'موظف'}</div></aside>
    <main class="adm-main" id="view"></main></div>`;
  $('#so').onclick = async () => { await sb.auth.signOut(); location.reload(); };
  const go = (k) => {
    $$('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    location.hash = k; const v = $('#view'); v.innerHTML = '<p class="center"><span class="spinner"></span></p>';
    ({ overview, orders, products: renderProducts, categories: renderCategories, content: renderContent, users })[k](v, ctx).catch((e) => { v.innerHTML = `<div class="notice bad">${esc(arabicError(e))}</div>`; });
  };
  $$('[data-tab]').forEach((b) => (b.onclick = () => go(b.dataset.tab)));
  const want = location.hash.slice(1); go(tabs.find((t) => t[0] === want) ? want : tabs[0][0]);
}

// ---------------- overview ----------------
async function overview(v) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const to = new Date(), from = new Date(Date.now() - 29 * 864e5);
  v.innerHTML = `<h2>نظرة عامة</h2><form class="filters" id="rf"><label>من<input type="date" name="from" value="${iso(from)}"></label><label>إلى<input type="date" name="to" value="${iso(to)}"></label><button class="btn ghost sm">تحديث</button></form><div id="ov"></div>`;
  const load = async () => {
    const f = $('#rf'); const { data: s, error } = await sb.rpc('admin_dashboard_stats', { p_from: f.from.value, p_to: f.to.value });
    if (error) { $('#ov').innerHTML = `<div class="notice bad">${esc(arabicError(error))}</div>`; return; }
    const card = (n, l, c = '') => `<div class="stat ${c}"><b>${n}</b><span>${l}</span></div>`;
    $('#ov').innerHTML = `<div class="cards">${card(qtyFmt(s.total_orders), 'إجمالي الطلبات')}${card(qtyFmt(s.today_orders), 'طلبات اليوم')}${card(money(s.today_sales), 'مبيعات اليوم')}
      ${card(qtyFmt(s.pending), 'طلبات معلّقة', s.pending ? 'warn' : '')}${card(qtyFmt(s.completed), 'مكتملة')}${card(qtyFmt(s.canceled), 'ملغاة', s.canceled ? 'bad' : '')}
      ${card(qtyFmt(s.range_orders), 'طلبات الفترة')}${card(money(s.range_sales), 'مبيعات الفترة (بدون الملغي)')}</div>
      <div class="two-col"><div class="chart"><h3 style="margin-top:0">المبيعات اليومية</h3>${barChart(s.daily)}</div>
      <div class="panel"><h3 style="margin-top:0">الأكثر مبيعا</h3>${s.best_sellers.length ? `<table class="tbl" style="min-width:0"><tbody>${s.best_sellers.map((b) => `<tr><td>${esc(b.name)}</td><td>${qtyFmt(b.qty)}</td><td>${money(b.revenue)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">لا توجد مبيعات في هذه الفترة.</p>'}
      <h3>مخزون منخفض</h3>${s.low_stock.length ? `<table class="tbl" style="min-width:0"><tbody>${s.low_stock.map((l) => `<tr><td>${esc(l.name)}</td><td><b style="color:var(--danger)">${qtyFmt(l.stock)}</b> ${esc(l.unit)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">لا توجد منتجات منخفضة المخزون.</p>'}</div></div>`;
  };
  $('#rf').onsubmit = (e) => { e.preventDefault(); load(); };
  load();
}

function barChart(daily) {
  if (!daily.length) return '<p class="muted">لا توجد بيانات في هذه الفترة.</p>';
  const W = 700, H = 220, pad = 34, max = Math.max(...daily.map((d) => Number(d.sales)), 1);
  const bw = Math.max(4, Math.min(40, (W - pad * 2) / daily.length - 4));
  const step = (W - pad * 2) / daily.length;
  const bars = daily.map((d, i) => {
    const h = (Number(d.sales) / max) * (H - pad * 2), x = W - pad - (i + 1) * step + (step - bw) / 2, y = H - pad - h;
    const lbl = new Date(d.day).toLocaleDateString('ar-EG', { day: 'numeric', month: 'numeric' });
    return `<g><title>${lbl}: ${money(d.sales)} (${d.orders} طلب)</title><rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="3" fill="var(--primary)"/>${daily.length <= 15 || i % Math.ceil(daily.length / 12) === 0 ? `<text x="${x + bw / 2}" y="${H - 14}" font-size="10" text-anchor="middle" fill="#5f6f64">${lbl}</text>` : ''}</g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="مبيعات يومية"><line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#d8ded5"/><text x="${W - pad}" y="14" font-size="11" text-anchor="end" fill="#5f6f64">الأعلى: ${money(max)}</text>${bars}</svg>`;
}

// ---------------- orders ----------------
const F = { q: '', status: '', from: '', to: '', page: 0 };
async function orders(v) {
  v.innerHTML = `<h2>الطلبات</h2><form class="filters" id="of"><label>بحث<input name="q" placeholder="رقم الطلب / الاسم / الهاتف" value="${esc(F.q)}"></label>
    <label>الحالة<select name="status"><option value="">الكل</option>${opts(ST, F.status)}</select></label>
    <label>من<input type="date" name="from" value="${F.from}"></label><label>إلى<input type="date" name="to" value="${F.to}"></label><button class="btn ghost sm">بحث</button></form>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>الطلب</th><th>العميل</th><th>الإجمالي</th><th>الحالة</th><th>الدفع</th><th></th></tr></thead><tbody id="ob"><tr><td colspan="6" class="center"><span class="spinner"></span></td></tr></tbody></table></div><div class="pager" id="op"></div>`;
  const f = $('#of');
  const load = async () => {
    F.q = f.q.value; F.status = f.status.value; F.from = f.from.value; F.to = f.to.value;
    let q = sb.from('orders').select('id,order_number,customer_name,customer_phone,status,payment_status,total,created_at,fulfillment', { count: 'exact' }).order('created_at', { ascending: false });
    const t = F.q.replace(/[%,()*\\]/g, ' ').trim();
    if (t) q = q.or(`order_number.ilike.%${t.replace(/[,()%*\\]/g, " ").trim()}%,customer_name.ilike.%${t.replace(/[,()%*\\]/g, " ").trim()}%,customer_phone.ilike.%${t.replace(/[,()%*\\]/g, " ").trim()}%`);
    if (F.status) q = q.eq('status', F.status);
    if (F.from) q = q.gte('created_at', new Date(F.from + 'T00:00:00').toISOString());
    if (F.to) q = q.lte('created_at', new Date(F.to + 'T23:59:59').toISOString());
    const { data, count, error } = await q.range(F.page * 25, F.page * 25 + 24);
    if (error) { $('#ob').innerHTML = `<tr><td colspan="6">${esc(arabicError(error))}</td></tr>`; return; }
    $('#ob').innerHTML = (data || []).map((o) => `<tr data-id="${o.id}"><td><b dir="ltr">${esc(o.order_number)}</b><div class="muted">${dateFmt(o.created_at)}</div></td>
      <td>${esc(o.customer_name)}<div class="muted" dir="ltr" style="text-align:right">${esc(o.customer_phone)}</div></td><td><b>${money(o.total)}</b></td>
      <td><select class="mini" data-st>${opts(ST, o.status)}</select></td><td><select class="mini" data-pay>${opts(PAY, o.payment_status)}</select></td>
      <td><button class="btn ghost sm" data-view>تفاصيل</button></td></tr>`).join('') || '<tr><td colspan="6" class="center muted">لا توجد طلبات مطابقة</td></tr>';
    const pages = Math.max(1, Math.ceil((count || 0) / 25));
    $('#op').innerHTML = `<button class="btn ghost sm" id="pp" ${F.page <= 0 ? 'disabled' : ''}>السابق</button><span>${F.page + 1} / ${pages} (${qtyFmt(count || 0)} طلب)</span><button class="btn ghost sm" id="pn" ${F.page + 1 >= pages ? 'disabled' : ''}>التالي</button>`;
    $('#pp').onclick = () => { F.page--; load(); }; $('#pn').onclick = () => { F.page++; load(); };
    $$('#ob tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id, st = $('[data-st]', tr), pay = $('[data-pay]', tr);
      const upd = async (args, sel, prev) => {
        const { error: e } = await sb.rpc('admin_update_order', { p_order: id, ...args });
        if (e) { toast(arabicError(e), 'err'); sel.value = prev; return false; }
        toast('تم التحديث'); return true;
      };
      let prevSt = st.value, prevPay = pay.value;
      st.onchange = async () => {
        if (st.value === 'canceled' && !(await confirmDialog('إلغاء الطلب سيعيد الكميات للمخزون ولا يمكن التراجع عنه. متابعة؟', 'إلغاء الطلب'))) { st.value = prevSt; return; }
        if (await upd({ p_status: st.value }, st, prevSt)) { prevSt = st.value; if (st.value === 'canceled') load(); }
      };
      pay.onchange = async () => { if (await upd({ p_payment: pay.value }, pay, prevPay)) prevPay = pay.value; };
      $('[data-view]', tr).onclick = () => orderDetail(id, load);
    });
  };
  f.onsubmit = (e) => { e.preventDefault(); F.page = 0; load(); };
  load();
}

async function orderDetail(id, reload) {
  const [{ data: o, error }, { data: hist }] = await Promise.all([
    sb.from('orders').select('*, order_items(*), invoices(invoice_number)').eq('id', id).single(),
    sb.from('order_status_history').select('*').eq('order_id', id).order('created_at'),
  ]);
  if (error) return toast(arabicError(error), 'err');
  const items = o.order_items || [];
  const full = { ...o, items, invoice_number: o.invoices?.invoice_number };
  const msg = `مرحبا ${o.customer_name}،\nطلبك رقم ${o.order_number} الآن: ${ST[o.status]}.\nالإجمالي: ${Number(o.total).toLocaleString('en-US')} ج.م\nشكرا لتسوقك من ${ctx.settings.store_name}`;
  const m = modal(`<div class="two-col" style="grid-template-columns:1fr">
    <p><b dir="ltr">${esc(o.order_number)}</b> — <span class="status ${o.status}">${ST[o.status]}</span> — ${esc(PAY[o.payment_status])}<br><span class="muted">${dateFmt(o.created_at)}</span></p>
    <p><b>${esc(o.customer_name)}</b> <span dir="ltr">${esc(o.customer_phone)}</span>${o.customer_email ? `<br>${esc(o.customer_email)}` : ''}<br>${o.fulfillment === 'pickup' ? 'استلام من المتجر' : esc(o.address || '')}${o.notes ? `<br><i>${esc(o.notes)}</i>` : ''}<br>طريقة الدفع: ${esc(o.payment_method)}</p>
    <div class="tbl-wrap"><table class="tbl" style="min-width:0"><thead><tr><th>المنتج</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead><tbody>${items.map((i) => `<tr><td>${esc(i.product_name)}</td><td>${qtyFmt(i.quantity)} ${esc(i.unit)}</td><td>${money(Number(i.unit_price) - Number(i.discount_per_unit))}</td><td>${money(i.line_total)}</td></tr>`).join('')}</tbody></table></div>
    <div class="totals"><div><span>المجموع الفرعي</span><span>${money(o.subtotal)}</span></div><div><span>الخصم</span><span>${money(o.discount_total)}</span></div><div><span>التوصيل</span><span>${money(o.delivery_fee)}</span></div><div class="grand"><span>الإجمالي</span><span>${money(o.total)}</span></div></div>
    <div><b>سجل الحالة</b>${(hist || []).map((h) => `<div class="log-row">${ST[h.status]} — ${dateFmt(h.created_at)}</div>`).join('')}</div>
    <p class="muted">رسالة واتساب عبر الواجهة الرسمية: <b>${o.whatsapp_api_status === 'sent' ? 'أُرسلت' : o.whatsapp_api_status === 'failed' ? 'فشلت' : 'لم تُرسل'}</b> (فتح الرابط اليدوي لا يُحتسب كإرسال).</p>
    <div class="row gap wrap"><a class="btn primary" target="_blank" rel="noopener" href="invoice.html?id=${o.id}">الفاتورة / طباعة</a>
      <a class="btn wa" target="_blank" rel="noopener" href="${waLink(waNumber(o.customer_phone), msg)}">مراسلة العميل على واتساب</a>
      ${ctx.settings.whatsapp_api_enabled ? '<button class="btn ghost" id="api-send">إرسال إشعار عبر واتساب API</button>' : ''}</div></div>`, { title: 'تفاصيل الطلب', wide: true });
  const ab = $('#api-send', m.el);
  if (ab) ab.onclick = async () => {
    ab.disabled = true;
    const { data, error: e } = await sb.functions.invoke('whatsapp-notify', { body: { order_id: o.id, to: 'customer' } });
    ab.disabled = false;
    if (e || !data?.sent) toast(data?.error || (e && arabicError(e)) || 'لم يتم الإرسال: راجع إعدادات واتساب API', 'err');
    else toast('تم الإرسال عبر واجهة واتساب الرسمية');
  };
}

// ---------------- users + activity log ----------------
async function users(v) {
  v.innerHTML = `<h2>المستخدمون والسجل</h2><div class="notice info">لإضافة موظف: اطلب منه إنشاء حساب عادي من المتجر، ثم ابحث عنه هنا واضغط "صلاحيات الموظف". صلاحيات الموظف تقتصر على الطلبات والتقارير؛ تعديل المنتجات والأسعار والأقسام للمالك فقط ولا يمكن منحه لغيره.</div>
    <form class="filters" id="uf"><label>بحث<input name="q" placeholder="الاسم / البريد / الهاتف"></label><button class="btn ghost sm">بحث</button></form>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>الاسم</th><th>البريد / الهاتف</th><th>الدور</th><th>الحالة</th><th></th></tr></thead><tbody id="ub"></tbody></table></div>
    <h3>سجل نشاط الإدارة (آخر ١٠٠ عملية)</h3><div class="panel" id="lg"><span class="spinner"></span></div>`;
  const load = async () => {
    const t = $('#uf').q.value.replace(/[%,()*\\]/g, ' ').trim();
    let q = sb.from('profiles').select('*').order('created_at', { ascending: false }).limit(200);
    if (t) q = q.or(`full_name.ilike.%${t.replace(/[,()%*\\]/g, " ").trim()}%,email.ilike.%${t.replace(/[,()%*\\]/g, " ").trim()}%,phone.ilike.%${t.replace(/[,()%*\\]/g, " ").trim()}%`);
    const [{ data: ps, error }, { data: rs }] = await Promise.all([q, sb.from('user_roles').select('user_id,role,permissions')]);
    if (error) { $('#ub').innerHTML = `<tr><td colspan="5">${esc(arabicError(error))}</td></tr>`; return; }
    const roleOf = (id) => (rs || []).filter((r) => r.user_id === id);
    $('#ub').innerHTML = (ps || []).map((p) => {
      const rl = roleOf(p.id), isOwner = rl.some((r) => r.role === 'owner'), staff = rl.find((r) => r.role === 'staff');
      return `<tr data-id="${p.id}"><td>${esc(p.full_name || '—')}</td><td dir="ltr" style="text-align:right">${esc(p.email || p.phone || '')}</td>
        <td>${isOwner ? 'المالك' : staff ? 'موظف' : 'عميل'}</td><td>${p.is_blocked ? '<span class="status canceled">محظور</span>' : 'نشط'}</td>
        <td>${isOwner ? '' : `<button class="btn ghost sm" data-staff>صلاحيات الموظف</button> <button class="btn ghost sm" data-block>${p.is_blocked ? 'إلغاء الحظر' : 'حظر'}</button>`}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="center muted">لا يوجد مستخدمون</td></tr>';
    $$('#ub tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id, p = ps.find((x) => x.id === id), staff = roleOf(id).find((r) => r.role === 'staff');
      const b = $('[data-block]', tr); if (b) b.onclick = async () => {
        if (!(await confirmDialog(p.is_blocked ? 'إلغاء حظر هذا المستخدم؟' : 'حظر هذا المستخدم من إنشاء الطلبات؟', p.is_blocked ? 'إلغاء الحظر' : 'حظر', !p.is_blocked))) return;
        const { error: e } = await sb.rpc('owner_set_blocked', { p_user: id, p_blocked: !p.is_blocked }); if (e) return toast(arabicError(e), 'err'); load();
      };
      const s = $('[data-staff]', tr); if (s) s.onclick = () => {
        const perm = staff?.permissions || {};
        const m = modal(`<form id="sf"><p>${esc(p.full_name || p.email || '')}</p><label class="f" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="enabled" ${staff ? 'checked' : ''} style="width:20px;min-height:20px"> حساب موظف مفعّل</label>
          <div class="perm-box"><label><input type="checkbox" name="orders" ${perm.orders ? 'checked' : ''}> إدارة الطلبات</label><label><input type="checkbox" name="reports" ${perm.reports ? 'checked' : ''}> عرض التقارير</label></div>
          <p class="muted">لا يمكن منح صلاحيات المنتجات أو الأسعار أو الأقسام أو الموظفين.</p><button class="btn primary block">حفظ</button></form>`, { title: 'صلاحيات الموظف' });
        $('#sf', m.el).onsubmit = async (e) => {
          e.preventDefault(); const f = e.target;
          const { error: er } = await sb.rpc('owner_set_staff', { p_user: id, p_enabled: f.enabled.checked, p_permissions: { orders: f.orders.checked, reports: f.reports.checked } });
          if (er) return toast(arabicError(er), 'err'); toast('تم الحفظ'); m.close(); load();
        };
      };
    });
  };
  $('#uf').onsubmit = (e) => { e.preventDefault(); load(); };
  load();
  const { data: logs } = await sb.from('admin_activity_logs').select('*').order('created_at', { ascending: false }).limit(100);
  const ids = [...new Set((logs || []).map((l) => l.actor_id).filter(Boolean))];
  const { data: names } = ids.length ? await sb.from('profiles').select('id,full_name,email').in('id', ids) : { data: [] };
  const nm = Object.fromEntries((names || []).map((n) => [n.id, n.full_name || n.email]));
  const AC = { insert: 'إضافة', update: 'تعديل', delete: 'حذف', update_order: 'تحديث طلب', block_user: 'حظر مستخدم', unblock_user: 'إلغاء حظر' };
  const changed = (d) => d && d.before && d.after ? Object.keys(d.after).filter((k) => k !== 'updated_at' && JSON.stringify(d.after[k]) !== JSON.stringify(d.before[k])).join('، ') : '';
  $('#lg').innerHTML = (logs || []).map((l) => `<div class="log-row">${dateFmt(l.created_at)} — <b>${esc(nm[l.actor_id] || 'النظام')}</b> — ${esc(AC[l.action] || l.action)} <code>${esc(l.entity || '')}</code> ${esc(changed(l.details))}</div>`).join('') || '<p class="muted">لا يوجد نشاط مسجل.</p>';
}
