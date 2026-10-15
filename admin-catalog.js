// Owner-only admin sections: products (+CSV), categories, offers, banners, brands, store settings.
// All writes are additionally enforced by RLS (is_owner()) — these screens are a convenience, not the security boundary.
import { sb } from './api.js';
import { $, $$, esc, money, qtyFmt, dateFmt, toast, modal, confirmDialog, arabicError, debounce, PLACEHOLDER } from './util.js';
import { uploadImage, numOrNull, strOrNull, parseCSV, toCSV, download, UNITS } from './admin-common.js';

const REASON = { order: 'طلب', order_cancel: 'إلغاء طلب', restock: 'توريد', adjustment: 'تعديل يدوي', initial: 'رصيد افتتاحي' };
const sel = (list, cur, blank) => (blank ? `<option value="">${blank}</option>` : '') + list.map((x) => `<option value="${x.id}" ${x.id === cur ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
const bool = (v) => /^(1|true|yes|نعم|y)$/i.test(String(v).trim());
const CSV_COLS = ['sku', 'barcode', 'name', 'category', 'brand', 'unit', 'price', 'old_price', 'cost_price', 'stock', 'low_stock_threshold', 'min_qty', 'max_qty', 'is_active', 'is_featured', 'is_new', 'description', 'image_url'];

// =============== PRODUCTS ===============
const P = { q: '', cat: '', status: 'active', page: 0 };
export async function renderProducts(v) {
  const [{ data: cats }, { data: brands }] = await Promise.all([sb.from('categories').select('id,name').order('sort_order'), sb.from('brands').select('id,name').order('name')]);
  v.innerHTML = `<h2>المنتجات</h2>
    <div class="row gap wrap" style="margin-bottom:10px"><button class="btn primary" id="np">+ منتج جديد</button><button class="btn ghost" id="ex">تصدير CSV</button><button class="btn ghost" id="im">استيراد CSV</button><button class="btn ghost" id="tp">تحميل قالب CSV</button><input type="file" id="imf" accept=".csv,text/csv" hidden></div>
    <form class="filters" id="pf"><label>بحث<input name="q" placeholder="الاسم / SKU / الباركود" value="${esc(P.q)}"></label>
      <label>القسم<select name="cat">${sel(cats || [], P.cat, 'الكل')}</select></label>
      <label>الحالة<select name="status"><option value="active">نشط</option><option value="inactive">معطّل</option><option value="archived">مؤرشف</option><option value="all">الكل</option></select></label></form>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th>المنتج</th><th>القسم</th><th>السعر (ج.م)</th><th>المخزون</th><th>الحالة</th><th></th></tr></thead><tbody id="pb"></tbody></table></div><div class="pager" id="pp"></div>`;
  const f = $('#pf'); f.status.value = P.status;
  const load = async () => {
    P.q = f.q.value; P.cat = f.cat.value; P.status = f.status.value;
    $('#pb').innerHTML = '<tr><td colspan="7" class="center"><span class="spinner"></span></td></tr>';
    let q = sb.from('products').select('*, categories(name)', { count: 'exact' }).order('created_at', { ascending: false });
    const t = P.q.replace(/[%,()*\\]/g, ' ').trim();
    if (t) q = q.or(`name.ilike.%${t.replace(/[,()%*\\]/g, " ").trim()}%,sku.ilike.%${t.replace(/[,()%*\\]/g, " ").trim()}%,barcode.ilike.%${t.replace(/[,()%*\\]/g, " ").trim()}%`);
    if (P.cat) q = q.eq('category_id', P.cat);
    if (P.status === 'active') q = q.eq('is_active', true).is('archived_at', null);
    else if (P.status === 'inactive') q = q.eq('is_active', false).is('archived_at', null);
    else if (P.status === 'archived') q = q.not('archived_at', 'is', null);
    const { data, count, error } = await q.range(P.page * 25, P.page * 25 + 24);
    if (error) { $('#pb').innerHTML = `<tr><td colspan="7">${esc(arabicError(error))}</td></tr>`; return; }
    $('#pb').innerHTML = (data || []).map((p) => `<tr data-id="${p.id}"><td><img class="th" src="${esc(p.image_url || PLACEHOLDER)}" alt=""></td>
      <td><b>${esc(p.name)}</b><div class="muted" dir="ltr" style="text-align:right">${esc(p.sku || '')}</div></td><td>${esc(p.categories?.name || '—')}</td>
      <td><input class="mini" type="number" min="0" step="0.01" value="${p.price}" data-f="price" aria-label="السعر"></td>
      <td><input class="mini" type="number" min="0" step="0.5" value="${p.stock}" data-f="stock" aria-label="المخزون"> <span class="muted">${esc(p.unit)}</span></td>
      <td>${p.archived_at ? '<span class="status canceled">مؤرشف</span>' : p.is_active ? '<span class="status completed">نشط</span>' : '<span class="status">معطّل</span>'}${Number(p.stock) <= Number(p.low_stock_threshold) ? ' <span class="status pending">مخزون منخفض</span>' : ''}</td>
      <td class="row gap" style="flex-wrap:wrap"><button class="btn ghost sm" data-edit>تعديل</button><button class="btn ghost sm" data-arch>${p.archived_at ? 'استعادة' : 'أرشفة'}</button><button class="btn ghost sm" data-del style="color:var(--danger)">حذف</button></td></tr>`).join('') || '<tr><td colspan="7" class="center muted">لا توجد منتجات</td></tr>';
    const pages = Math.max(1, Math.ceil((count || 0) / 25));
    $('#pp').innerHTML = `<button class="btn ghost sm" id="a1" ${P.page <= 0 ? 'disabled' : ''}>السابق</button><span>${P.page + 1} / ${pages} (${qtyFmt(count || 0)})</span><button class="btn ghost sm" id="a2" ${P.page + 1 >= pages ? 'disabled' : ''}>التالي</button>`;
    $('#a1').onclick = () => { P.page--; load(); }; $('#a2').onclick = () => { P.page++; load(); };
    $$('#pb tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id, p = data.find((x) => x.id === id);
      $$('input[data-f]', tr).forEach((inp) => (inp.onchange = async () => {
        const val = Number(inp.value); if (!(val >= 0)) { inp.value = p[inp.dataset.f]; return toast('قيمة غير صحيحة', 'err'); }
        const { error: e } = await sb.from('products').update({ [inp.dataset.f]: val }).eq('id', id);
        if (e) { inp.value = p[inp.dataset.f]; return toast(arabicError(e), 'err'); }
        p[inp.dataset.f] = val; toast('تم الحفظ');
      }));
      $('[data-edit]', tr).onclick = () => productForm(p, cats || [], brands || [], load);
      $('[data-arch]', tr).onclick = async () => {
        const arch = !p.archived_at;
        if (arch && !(await confirmDialog(`أرشفة "${p.name}"؟ سيختفي من المتجر وتبقى الطلبات السابقة كما هي.`, 'أرشفة', false))) return;
        const { error: e } = await sb.from('products').update(arch ? { archived_at: new Date().toISOString(), is_active: false } : { archived_at: null }).eq('id', id);
        if (e) return toast(arabicError(e), 'err'); toast(arch ? 'تمت الأرشفة' : 'تمت الاستعادة (المنتج معطّل حتى تفعّله)'); load();
      };
      $('[data-del]', tr).onclick = async () => {
        if (!(await confirmDialog(`حذف "${p.name}" نهائيا؟ إذا كان له حركة مخزون فسيتعذر الحذف ويُفضّل الأرشفة.`, 'حذف نهائي'))) return;
        const { error: e } = await sb.from('products').delete().eq('id', id);
        if (e) return toast(arabicError(e) + ' — استخدم الأرشفة.', 'err'); toast('تم الحذف'); load();
      };
    });
  };
  f.addEventListener('input', debounce(() => { P.page = 0; load(); }, 300)); f.addEventListener('submit', (e) => e.preventDefault());
  $('#np').onclick = () => productForm(null, cats || [], brands || [], load);
  $('#ex').onclick = exportCSV;
  $('#tp').onclick = () => download('products-template.csv', toCSV([{ sku: 'SUG-001', barcode: '', name: 'سكر ١ كجم', category: (cats && cats[0]?.name) || 'منتجات أخرى', brand: '', unit: 'كيس', price: '40', old_price: '', cost_price: '33', stock: '100', low_stock_threshold: '10', min_qty: '1', max_qty: '', is_active: '1', is_featured: '0', is_new: '0', description: '', image_url: '' }], CSV_COLS));
  $('#im').onclick = () => $('#imf').click();
  $('#imf').onchange = async (e) => { const file = e.target.files[0]; e.target.value = ''; if (file) importCSV(await file.text(), cats || [], brands || [], load); };
  load();
}

async function productForm(p, cats, brands, reload) {
  const isNew = !p; p = p || { is_active: true, unit: 'قطعة', stock: 0, low_stock_threshold: 5, min_qty: 1 };
  let cost = null, offer = null, gallery = [];
  if (!isNew) {
    const [c, o, g] = await Promise.all([
      sb.from('product_costs').select('cost_price').eq('product_id', p.id).maybeSingle(),
      sb.from('offers').select('*').eq('product_id', p.id).eq('is_active', true).order('created_at', { ascending: false }).limit(1),
      sb.from('product_images').select('*').eq('product_id', p.id).order('sort_order'),
    ]);
    cost = c.data?.cost_price ?? null; offer = o.data?.[0] || null; gallery = g.data || [];
  }
  const dt = (d) => (d ? new Date(new Date(d).getTime() - new Date(d).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  const m = modal(`<form id="prf" novalidate><div class="field-grid">
    <label class="f full">اسم المنتج *<input name="name" required maxlength="200" value="${esc(p.name || '')}"></label>
    <label class="f">القسم *<select name="category_id" required>${sel(cats, p.category_id, 'اختر القسم')}</select></label>
    <label class="f">الماركة<select name="brand_id">${sel(brands, p.brand_id, 'بدون')}</select></label>
    <label class="f">سعر البيع (ج.م) *<input name="price" type="number" step="0.01" min="0" required value="${p.price ?? ''}"></label>
    <label class="f">السعر السابق (اختياري)<input name="old_price" type="number" step="0.01" min="0" value="${p.old_price ?? ''}"></label>
    <label class="f">سعر التكلفة (للمالك فقط)<input name="cost_price" type="number" step="0.01" min="0" value="${cost ?? ''}"></label>
    <label class="f">الوحدة<input name="unit" list="units" value="${esc(p.unit)}" required><datalist id="units">${UNITS.map((u) => `<option>${u}</option>`).join('')}</datalist></label>
    <label class="f">المخزون *<input name="stock" type="number" step="0.01" min="0" required value="${p.stock}"></label>
    <label class="f">تنبيه المخزون المنخفض عند<input name="low_stock_threshold" type="number" step="0.01" min="0" value="${p.low_stock_threshold}"></label>
    <label class="f">أقل كمية للطلب<input name="min_qty" type="number" step="0.01" min="0.01" value="${p.min_qty}"></label>
    <label class="f">أقصى كمية للطلب<input name="max_qty" type="number" step="0.01" min="0.01" value="${p.max_qty ?? ''}"></label>
    <label class="f">SKU<input name="sku" dir="ltr" maxlength="60" value="${esc(p.sku || '')}"></label>
    <label class="f">الباركود<input name="barcode" dir="ltr" maxlength="60" value="${esc(p.barcode || '')}"></label>
    <label class="f full">الوصف<textarea name="description" rows="3" maxlength="2000">${esc(p.description || '')}</textarea></label>
    <div class="full"><label class="f">الصورة الرئيسية<input type="file" id="img-file" accept="image/png,image/jpeg,image/webp"></label><input type="hidden" name="image_url" value="${esc(p.image_url || '')}"><img id="img-prev" src="${esc(p.image_url || PLACEHOLDER)}" alt="" style="width:96px;height:96px;object-fit:cover;border-radius:12px"></div>
    <div class="full perm-box"><label><input type="checkbox" name="is_active" ${p.is_active ? 'checked' : ''}> معروض في المتجر</label><label><input type="checkbox" name="is_featured" ${p.is_featured ? 'checked' : ''}> منتج مميز</label><label><input type="checkbox" name="is_new" ${p.is_new ? 'checked' : ''}> وصل حديثا</label></div>
    <fieldset class="full" style="border:1px solid var(--line);border-radius:12px;padding:10px 12px"><legend><b>العرض الترويجي</b></legend>
      ${offer ? `<p class="notice info">عرض حالي: ${offer.discount_type === 'percent' ? offer.discount_value + '٪' : money(offer.discount_value)} ${offer.ends_at ? 'حتى ' + dateFmt(offer.ends_at) : 'بدون تاريخ انتهاء'}</p>` : ''}
      <div class="field-grid"><label class="f">النوع<select name="offer_type"><option value="">${offer ? 'إبقاء العرض الحالي' : 'بدون عرض'}</option><option value="percent">نسبة خصم ٪</option><option value="fixed">مبلغ خصم (ج.م)</option>${offer ? '<option value="remove">إلغاء العرض الحالي</option>' : ''}</select></label>
      <label class="f">قيمة الخصم<input name="offer_value" type="number" step="0.01" min="0"></label>
      <label class="f">يبدأ في<input name="offer_start" type="datetime-local"></label><label class="f">ينتهي في<input name="offer_end" type="datetime-local" value="${dt(offer?.ends_at)}"></label></div></fieldset>
    ${isNew ? '<p class="muted full">احفظ المنتج أولا لإضافة صور إضافية وعرض سجل المخزون.</p>' : `<div class="full"><b>معرض الصور</b><div class="thumb-row" id="gal"></div><input type="file" id="gal-file" accept="image/png,image/jpeg,image/webp" multiple> <button type="button" class="btn ghost sm" id="mv">سجل حركة المخزون</button></div>`}
  </div><div class="notice bad" id="pe" hidden></div><button class="btn primary block" id="psave">${isNew ? 'إضافة المنتج' : 'حفظ التعديلات'}</button></form>`, { title: isNew ? 'منتج جديد' : 'تعديل المنتج', wide: true });
  const f = $('#prf', m.el), err = $('#pe', m.el), fail = (t) => { err.textContent = t; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); };
  $('#img-file', m.el).onchange = async (e) => {
    try { toast('جارٍ رفع الصورة…'); const url = await uploadImage(e.target.files[0], 'products', 900); f.image_url.value = url; $('#img-prev', m.el).src = url; toast('تم رفع الصورة'); } catch (x) { toast(arabicError(x), 'err'); }
  };
  const drawGallery = () => {
    const g = $('#gal', m.el); if (!g) return;
    g.innerHTML = gallery.map((i) => `<figure><img src="${esc(i.url)}" alt=""><button type="button" data-rm="${i.id}" aria-label="حذف">✕</button></figure>`).join('') || '<span class="muted">لا توجد صور إضافية</span>';
    $$('[data-rm]', g).forEach((b) => (b.onclick = async () => { const { error } = await sb.from('product_images').delete().eq('id', b.dataset.rm); if (error) return toast(arabicError(error), 'err'); gallery = gallery.filter((x) => x.id !== b.dataset.rm); drawGallery(); }));
  };
  drawGallery();
  const gf = $('#gal-file', m.el); if (gf) gf.onchange = async (e) => {
    for (const file of e.target.files) {
      try { const url = await uploadImage(file, 'products', 900); const { data, error } = await sb.from('product_images').insert({ product_id: p.id, url, sort_order: gallery.length }).select().single(); if (error) throw error; gallery.push(data); } catch (x) { toast(arabicError(x), 'err'); }
    }
    e.target.value = ''; drawGallery();
  };
  const mv = $('#mv', m.el); if (mv) mv.onclick = async () => {
    const { data } = await sb.from('inventory_movements').select('*').eq('product_id', p.id).order('created_at', { ascending: false }).limit(60);
    modal(`<div class="tbl-wrap"><table class="tbl" style="min-width:0"><thead><tr><th>التاريخ</th><th>السبب</th><th>التغيير</th></tr></thead><tbody>${(data || []).map((x) => `<tr><td>${dateFmt(x.created_at)}</td><td>${esc(REASON[x.reason] || x.reason)}</td><td dir="ltr" style="text-align:right;color:${Number(x.change) < 0 ? 'var(--danger)' : 'var(--primary-dark)'}"><b>${Number(x.change) > 0 ? '+' : ''}${qtyFmt(x.change)}</b></td></tr>`).join('') || '<tr><td colspan="3" class="muted center">لا توجد حركة</td></tr>'}</tbody></table></div>`, { title: 'حركة المخزون: ' + p.name });
  };
  f.onsubmit = async (e) => {
    e.preventDefault(); err.hidden = true; const g = (n) => f[n].value.trim();
    if (g('name').length < 1) return fail('اسم المنتج مطلوب');
    if (!g('category_id')) return fail('اختر القسم');
    if (!(Number(g('price')) >= 0) || g('price') === '') return fail('سعر البيع غير صحيح');
    if (!g('unit')) return fail('الوحدة مطلوبة');
    const maxq = numOrNull(g('max_qty')), minq = numOrNull(g('min_qty')) ?? 1;
    if (maxq != null && maxq < minq) return fail('أقصى كمية يجب ألا تقل عن أقل كمية');
    const ot = f.offer_type.value, ov = numOrNull(g('offer_value'));
    if ((ot === 'percent' || ot === 'fixed') && !(ov > 0)) return fail('أدخل قيمة الخصم');
    if (ot === 'percent' && ov > 100) return fail('نسبة الخصم لا تتجاوز ١٠٠٪');
    if (ot === 'fixed' && ov >= Number(g('price'))) return fail('مبلغ الخصم يجب أن يقل عن السعر');
    const start = g('offer_start') ? new Date(g('offer_start')) : new Date(), end = g('offer_end') ? new Date(g('offer_end')) : null;
    if (end && end <= start) return fail('تاريخ انتهاء العرض يجب أن يكون بعد بدايته');
    const row = { name: g('name'), description: strOrNull(g('description')), category_id: g('category_id'), brand_id: g('brand_id') || null, price: Number(g('price')), old_price: numOrNull(g('old_price')), unit: g('unit'),
      stock: Number(g('stock') || 0), low_stock_threshold: Number(g('low_stock_threshold') || 0), min_qty: minq, max_qty: maxq, sku: strOrNull(g('sku')), barcode: strOrNull(g('barcode')), image_url: strOrNull(g('image_url')),
      is_active: f.is_active.checked, is_featured: f.is_featured.checked, is_new: f.is_new.checked };
    const btn = $('#psave', m.el); btn.disabled = true;
    try {
      let id = p.id;
      if (isNew) { const { data, error } = await sb.from('products').insert(row).select('id').single(); if (error) throw error; id = data.id; }
      else { const { error } = await sb.from('products').update(row).eq('id', id); if (error) throw error; }
      const cp = numOrNull(g('cost_price'));
      if (cp == null) await sb.from('product_costs').delete().eq('product_id', id); else { const { error } = await sb.from('product_costs').upsert({ product_id: id, cost_price: cp }); if (error) throw error; }
      if (ot) {
        await sb.from('offers').update({ is_active: false }).eq('product_id', id).eq('is_active', true);
        if (ot === 'percent' || ot === 'fixed') { const { error } = await sb.from('offers').insert({ product_id: id, discount_type: ot, discount_value: ov, starts_at: start.toISOString(), ends_at: end ? end.toISOString() : null }); if (error) throw error; }
      }
      toast('تم الحفظ'); m.close(); reload();
    } catch (x) { btn.disabled = false; fail(arabicError(x)); }
  };
}

// ---------- CSV ----------
async function exportCSV() {
  toast('جارٍ تجهيز الملف…');
  const rows = []; let from = 0;
  const [{ data: cats }, { data: brands }] = await Promise.all([sb.from('categories').select('id,name'), sb.from('brands').select('id,name')]);
  const cn = Object.fromEntries((cats || []).map((c) => [c.id, c.name])), bn = Object.fromEntries((brands || []).map((b) => [b.id, b.name]));
  for (;;) {
    const { data, error } = await sb.from('products').select('*, product_costs(cost_price)').is('archived_at', null).order('name').range(from, from + 999);
    if (error) return toast(arabicError(error), 'err');
    rows.push(...data.map((p) => ({ ...p, category: cn[p.category_id] || '', brand: bn[p.brand_id] || '', cost_price: p.product_costs?.cost_price ?? '', is_active: p.is_active ? 1 : 0, is_featured: p.is_featured ? 1 : 0, is_new: p.is_new ? 1 : 0 })));
    if (data.length < 1000) break; from += 1000;
  }
  download(`products-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(rows, CSV_COLS)); toast(`تم تصدير ${rows.length} منتج`);
}

async function importCSV(text, cats, brands, reload) {
  const rows = parseCSV(text), errors = [], ok = [];
  const cmap = new Map(cats.map((c) => [c.name.trim(), c.id])), bmap = new Map(brands.map((b) => [b.name.trim(), b.id]));
  const seen = new Set();
  rows.forEach((r, i) => {
    const line = i + 2, bad = (t) => errors.push(`سطر ${line}: ${t}`);
    if (!r.name) return bad('الاسم مطلوب');
    const price = Number(r.price); if (r.price === '' || !(price >= 0)) return bad('السعر غير صحيح');
    const cid = cmap.get((r.category || '').trim()); if (!cid) return bad(`القسم "${r.category}" غير موجود`);
    const stock = r.stock === '' ? 0 : Number(r.stock); if (!(stock >= 0)) return bad('المخزون غير صحيح');
    const minq = r.min_qty === '' ? 1 : Number(r.min_qty), maxq = r.max_qty === '' ? null : Number(r.max_qty);
    if (!(minq > 0) || (maxq != null && !(maxq >= minq))) return bad('حدود الكمية غير صحيحة');
    if (r.sku) { if (seen.has(r.sku)) return bad('SKU مكرر داخل الملف'); seen.add(r.sku); }
    ok.push({ _cost: r.cost_price === '' ? null : Number(r.cost_price), _brand: (r.brand || '').trim(), row: {
      sku: r.sku || null, barcode: r.barcode || null, name: r.name, category_id: cid, unit: r.unit || 'قطعة', price, old_price: numOrNull(r.old_price), stock,
      low_stock_threshold: r.low_stock_threshold === '' ? 5 : Number(r.low_stock_threshold), min_qty: minq, max_qty: maxq, description: r.description || null, image_url: r.image_url || null,
      is_active: r.is_active === '' ? true : bool(r.is_active), is_featured: bool(r.is_featured), is_new: bool(r.is_new) } });
  });
  const m = modal(`<p>تم قراءة <b>${rows.length}</b> سطر: <b>${ok.length}</b> صالح و<b style="color:var(--danger)">${errors.length}</b> به أخطاء.</p>
    ${errors.length ? `<div class="notice bad" style="max-height:160px;overflow:auto">${errors.slice(0, 30).map(esc).join('<br>')}${errors.length > 30 ? '<br>…' : ''}</div>` : ''}
    <p class="muted">الصفوف التي لها SKU موجود سيتم <b>تحديثها</b> (بما فيها السعر والمخزون)، والباقي يُضاف كمنتجات جديدة. الصفوف الخاطئة تُتجاهل.</p>
    <button class="btn primary block" id="go" ${ok.length ? '' : 'disabled'}>استيراد ${ok.length} منتج</button>`, { title: 'استيراد منتجات' });
  $('#go', m.el).onclick = async () => {
    const b = $('#go', m.el); b.disabled = true; b.innerHTML = '<span class="spinner"></span> جارٍ الاستيراد…';
    try {
      for (const name of new Set(ok.map((x) => x._brand).filter((n) => n && !bmap.has(n)))) {
        const { data, error } = await sb.from('brands').insert({ name }).select('id').single(); if (error) throw error; bmap.set(name, data.id);
      }
      ok.forEach((x) => { if (x._brand) x.row.brand_id = bmap.get(x._brand); });
      let done = 0;
      for (let i = 0; i < ok.length; i += 100) {
        const chunk = ok.slice(i, i + 100), withSku = chunk.filter((x) => x.row.sku), noSku = chunk.filter((x) => !x.row.sku), costs = [];
        if (withSku.length) { const { data, error } = await sb.from('products').upsert(withSku.map((x) => x.row), { onConflict: 'sku' }).select('id,sku'); if (error) throw error; const idBy = new Map(data.map((d) => [d.sku, d.id])); withSku.forEach((x) => x._cost != null && costs.push({ product_id: idBy.get(x.row.sku), cost_price: x._cost })); }
        if (noSku.length) { const { data, error } = await sb.from('products').insert(noSku.map((x) => x.row)).select('id'); if (error) throw error; noSku.forEach((x, k) => x._cost != null && costs.push({ product_id: data[k].id, cost_price: x._cost })); }
        if (costs.length) { const { error } = await sb.from('product_costs').upsert(costs); if (error) throw error; }
        done += chunk.length; b.textContent = `تم ${done} / ${ok.length}`;
      }
      toast(`تم استيراد ${done} منتج`); m.close(); reload();
    } catch (x) { b.disabled = false; b.textContent = 'إعادة المحاولة'; toast(arabicError(x), 'err'); }
  };
}

// =============== CATEGORIES ===============
export async function renderCategories(v) {
  const load = async () => {
    const { data, error } = await sb.from('categories').select('*').order('sort_order');
    if (error) { v.innerHTML = `<div class="notice bad">${esc(arabicError(error))}</div>`; return; }
    v.innerHTML = `<h2>الأقسام</h2><p><button class="btn primary" id="nc">+ قسم جديد</button></p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الترتيب</th><th>القسم</th><th>ظاهر</th><th>في الرئيسية</th><th></th></tr></thead><tbody>
      ${data.map((c, i) => `<tr data-id="${c.id}"><td><button class="btn ghost sm" data-up ${i === 0 ? 'disabled' : ''} aria-label="أعلى">▲</button> <button class="btn ghost sm" data-dn ${i === data.length - 1 ? 'disabled' : ''} aria-label="أسفل">▼</button></td>
      <td>${c.image_url ? `<img class="th" src="${esc(c.image_url)}" alt="" style="vertical-align:middle">` : esc(c.icon || '')} <b>${esc(c.name)}</b></td>
      <td><input type="checkbox" data-vis ${c.is_visible ? 'checked' : ''} aria-label="ظاهر"></td><td><input type="checkbox" data-home ${c.show_on_home ? 'checked' : ''} aria-label="في الرئيسية"></td>
      <td><button class="btn ghost sm" data-edit>تعديل</button> <button class="btn ghost sm" data-del style="color:var(--danger)">حذف</button></td></tr>`).join('')}</tbody></table></div>`;
    $('#nc').onclick = () => catForm(null, data, load);
    $$('tr[data-id]', v).forEach((tr) => {
      const i = data.findIndex((x) => x.id === tr.dataset.id), c = data[i];
      const swap = async (j) => {
        const o = data[j];
        const r1 = await sb.from('categories').update({ sort_order: o.sort_order }).eq('id', c.id), r2 = await sb.from('categories').update({ sort_order: c.sort_order }).eq('id', o.id);
        if (r1.error || r2.error) return toast(arabicError(r1.error || r2.error), 'err'); load();
      };
      $('[data-up]', tr).onclick = () => swap(i - 1); $('[data-dn]', tr).onclick = () => swap(i + 1);
      $('[data-vis]', tr).onchange = async (e) => { const { error: er } = await sb.from('categories').update({ is_visible: e.target.checked }).eq('id', c.id); toast(er ? arabicError(er) : 'تم الحفظ', er ? 'err' : 'ok'); };
      $('[data-home]', tr).onchange = async (e) => { const { error: er } = await sb.from('categories').update({ show_on_home: e.target.checked }).eq('id', c.id); toast(er ? arabicError(er) : 'تم الحفظ', er ? 'err' : 'ok'); };
      $('[data-edit]', tr).onclick = () => catForm(c, data, load);
      $('[data-del]', tr).onclick = async () => {
        if (!(await confirmDialog(`حذف قسم "${c.name}"؟`, 'حذف'))) return;
        const { error: er } = await sb.from('categories').delete().eq('id', c.id);
        if (er) return toast(/foreign key/i.test(er.message) ? 'يوجد منتجات داخل هذا القسم. انقلها لقسم آخر أو أخفِ القسم بدلا من حذفه.' : arabicError(er), 'err'); toast('تم الحذف'); load();
      };
    });
  };
  await load();
}
function catForm(c, all, reload) {
  const isNew = !c; c = c || { is_visible: true, show_on_home: true };
  const m = modal(`<form id="cf" novalidate><label class="f">اسم القسم *<input name="name" required maxlength="80" value="${esc(c.name || '')}"></label>
    <label class="f">أيقونة (إيموجي)<input name="icon" maxlength="4" value="${esc(c.icon || '')}"></label>
    <label class="f">صورة القسم<input type="file" id="cimg" accept="image/png,image/jpeg,image/webp"></label><input type="hidden" name="image_url" value="${esc(c.image_url || '')}"><img id="cprev" src="${esc(c.image_url || PLACEHOLDER)}" alt="" style="width:72px;height:72px;border-radius:12px;object-fit:cover;margin-bottom:10px">
    <div class="perm-box"><label><input type="checkbox" name="is_visible" ${c.is_visible ? 'checked' : ''}> ظاهر في المتجر</label><label><input type="checkbox" name="show_on_home" ${c.show_on_home ? 'checked' : ''}> يظهر في الصفحة الرئيسية</label></div>
    <button class="btn primary block">حفظ</button></form>`, { title: isNew ? 'قسم جديد' : 'تعديل القسم' });
  const f = $('#cf', m.el);
  $('#cimg', m.el).onchange = async (e) => { try { const u = await uploadImage(e.target.files[0], 'categories', 400); f.image_url.value = u; $('#cprev', m.el).src = u; } catch (x) { toast(arabicError(x), 'err'); } };
  f.onsubmit = async (e) => {
    e.preventDefault(); if (!f.name.value.trim()) return toast('اسم القسم مطلوب', 'err');
    const row = { name: f.name.value.trim(), icon: strOrNull(f.icon.value), image_url: strOrNull(f.image_url.value), is_visible: f.is_visible.checked, show_on_home: f.show_on_home.checked };
    if (isNew) row.sort_order = Math.max(0, ...all.map((x) => x.sort_order)) + 1;
    const { error } = isNew ? await sb.from('categories').insert(row) : await sb.from('categories').update(row).eq('id', c.id);
    if (error) return toast(arabicError(error), 'err'); toast('تم الحفظ'); m.close(); reload();
  };
}

// =============== CONTENT: settings / offers / banners / brands ===============
export async function renderContent(v, ctx) {
  v.innerHTML = `<h2>العروض والمحتوى</h2><div class="sub-tabs"><button data-s="settings">إعدادات المتجر</button><button data-s="offers">العروض</button><button data-s="banners">البنرات</button><button data-s="brands">الماركات</button></div><div id="sub"></div>`;
  const go = (k) => { $$('[data-s]', v).forEach((b) => b.classList.toggle('on', b.dataset.s === k)); $('#sub').innerHTML = '<span class="spinner"></span>'; ({ settings: settingsView, offers: offersView, banners: bannersView, brands: brandsView })[k]($('#sub'), ctx).catch((e) => { $('#sub').innerHTML = `<div class="notice bad">${esc(arabicError(e))}</div>`; }); };
  $$('[data-s]', v).forEach((b) => (b.onclick = () => go(b.dataset.s))); go('settings');
}

async function settingsView(box, ctx) {
  const { data: s, error } = await sb.from('store_settings').select('*').eq('id', 1).single(); if (error) throw error;
  const soc = s.social_links || {};
  box.innerHTML = `<form id="sf" class="panel" novalidate><div class="field-grid">
    <label class="f">اسم المتجر *<input name="store_name" required maxlength="80" value="${esc(s.store_name)}"></label>
    <label class="f">رقم واتساب لاستقبال الطلبات *<input name="whatsapp_number" dir="ltr" required value="${esc(s.whatsapp_number)}"><span class="hint">بالصيغة الدولية بدون + (مثال: 201008927372)</span></label>
    <label class="f">هاتف العرض<input name="phone" dir="ltr" value="${esc(s.phone || '')}"></label><label class="f">البريد<input name="email" type="email" dir="ltr" value="${esc(s.email || '')}"></label>
    <label class="f full">العنوان<input name="address" value="${esc(s.address || '')}"></label>
    <label class="f full">شريط الإعلانات (أعلى الموقع)<input name="announcement" maxlength="200" value="${esc(s.announcement || '')}"></label>
    <div class="full"><label class="f">الشعار<input type="file" id="logo-f" accept="image/png,image/jpeg,image/webp,image/svg+xml"></label><input type="hidden" name="logo_url" value="${esc(s.logo_url || '')}"><img id="logo-p" src="${esc(s.logo_url || PLACEHOLDER)}" alt="" style="height:56px;border-radius:10px"></div>
    <label class="f">اللون الأساسي<input name="primary_color" type="color" value="${esc(s.primary_color)}"></label><label class="f">لون التمييز<input name="accent_color" type="color" value="${esc(s.accent_color)}"></label>
    <label class="f">رسوم التوصيل (ج.م)<input name="delivery_fee" type="number" min="0" step="0.5" value="${s.delivery_fee}"></label><label class="f">توصيل مجاني للطلبات من (اختياري)<input name="free_delivery_over" type="number" min="0" step="1" value="${s.free_delivery_over ?? ''}"></label>
    <label class="f">الحد الأدنى للطلب (ج.م)<input name="min_order_amount" type="number" min="0" step="1" value="${s.min_order_amount}"></label>
    <label class="f">طرق الدفع (كل طريقة في سطر)<textarea name="payment_methods" rows="3">${esc((s.payment_methods || []).join('\n'))}</textarea></label>
    <label class="f full">مواعيد العمل<textarea name="store_hours" rows="2">${esc(s.store_hours || '')}</textarea></label>
    <label class="f full">معلومات التوصيل<textarea name="delivery_info" rows="2">${esc(s.delivery_info || '')}</textarea></label>
    <label class="f full">سياسات المتجر (الاسترجاع، الخصوصية…)<textarea name="policies" rows="4">${esc(s.policies || '')}</textarea></label>
    ${['facebook', 'instagram', 'tiktok', 'youtube'].map((k) => `<label class="f">${{ facebook: 'فيسبوك', instagram: 'إنستجرام', tiktok: 'تيك توك', youtube: 'يوتيوب' }[k]} (رابط https)<input name="soc_${k}" dir="ltr" value="${esc(soc[k] || '')}"></label>`).join('')}
    <div class="full perm-box"><label><input type="checkbox" name="show_offers" ${s.show_offers !== false ? 'checked' : ''}> إظهار قسم العروض</label><label><input type="checkbox" name="show_brands" ${s.show_brands ? 'checked' : ''}> إظهار قسم الماركات</label>
      <label><input type="checkbox" name="whatsapp_api_enabled" ${s.whatsapp_api_enabled ? 'checked' : ''}> تفعيل واتساب Cloud API (بعد ضبط المفاتيح — راجع SETUP.md)</label></div>
  </div><button class="btn primary">حفظ الإعدادات</button></form>`;
  const f = $('#sf');
  $('#logo-f').onchange = async (e) => { try { const u = await uploadImage(e.target.files[0], 'branding', 400); f.logo_url.value = u; $('#logo-p').src = u; } catch (x) { toast(arabicError(x), 'err'); } };
  f.onsubmit = async (e) => {
    e.preventDefault(); const g = (n) => f[n].value.trim();
    const wa = g('whatsapp_number').replace(/\D/g, ''); if (!/^\d{10,15}$/.test(wa)) return toast('رقم واتساب غير صحيح', 'err');
    if (!g('store_name')) return toast('اسم المتجر مطلوب', 'err');
    const methods = g('payment_methods').split('\n').map((x) => x.trim()).filter(Boolean); if (!methods.length) return toast('أضف طريقة دفع واحدة على الأقل', 'err');
    const social = {}; for (const k of ['facebook', 'instagram', 'tiktok', 'youtube']) { const u = g('soc_' + k); if (u) { if (!/^https?:\/\//i.test(u)) return toast('روابط التواصل يجب أن تبدأ بـ https://', 'err'); social[k] = u; } }
    const row = { store_name: g('store_name'), whatsapp_number: wa, phone: strOrNull(g('phone')), email: strOrNull(g('email')), address: strOrNull(g('address')), announcement: strOrNull(g('announcement')), logo_url: strOrNull(g('logo_url')),
      primary_color: g('primary_color'), accent_color: g('accent_color'), delivery_fee: Number(g('delivery_fee') || 0), free_delivery_over: numOrNull(g('free_delivery_over')), min_order_amount: Number(g('min_order_amount') || 0),
      payment_methods: methods, store_hours: strOrNull(g('store_hours')), delivery_info: strOrNull(g('delivery_info')), policies: strOrNull(g('policies')), social_links: social,
      show_offers: f.show_offers.checked, show_brands: f.show_brands.checked, whatsapp_api_enabled: f.whatsapp_api_enabled.checked };
    const { error: er } = await sb.from('store_settings').update(row).eq('id', 1);
    if (er) return toast(arabicError(er), 'err'); Object.assign(ctx.settings, row); toast('تم حفظ الإعدادات');
  };
}

async function offersView(box) {
  const { data, error } = await sb.from('offers').select('*, products(name,price)').order('created_at', { ascending: false }).limit(100); if (error) throw error;
  box.innerHTML = `<p><button class="btn primary" id="no">+ عرض جديد</button></p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>المنتج</th><th>الخصم</th><th>الفترة</th><th>مفعّل</th><th></th></tr></thead><tbody>
    ${data.map((o) => `<tr data-id="${o.id}"><td>${esc(o.products?.name || '—')}</td><td>${o.discount_type === 'percent' ? qtyFmt(o.discount_value) + '٪' : money(o.discount_value)}</td><td>${dateFmt(o.starts_at)}${o.ends_at ? ' ← ' + dateFmt(o.ends_at) : ' (بدون انتهاء)'}${o.ends_at && new Date(o.ends_at) < new Date() ? ' <span class="status canceled">منتهي</span>' : ''}</td>
    <td><input type="checkbox" data-on ${o.is_active ? 'checked' : ''} aria-label="مفعّل"></td><td><button class="btn ghost sm" data-del style="color:var(--danger)">حذف</button></td></tr>`).join('') || '<tr><td colspan="5" class="center muted">لا توجد عروض</td></tr>'}</tbody></table></div>`;
  $$('tr[data-id]', box).forEach((tr) => {
    $('[data-on]', tr).onchange = async (e) => { const { error: er } = await sb.from('offers').update({ is_active: e.target.checked }).eq('id', tr.dataset.id); toast(er ? arabicError(er) : 'تم الحفظ', er ? 'err' : 'ok'); };
    $('[data-del]', tr).onclick = async () => { if (!(await confirmDialog('حذف هذا العرض؟', 'حذف'))) return; const { error: er } = await sb.from('offers').delete().eq('id', tr.dataset.id); if (er) return toast(arabicError(er), 'err'); offersView(box); };
  });
  $('#no').onclick = () => {
    const m = modal(`<form id="of" novalidate><label class="f">ابحث عن المنتج<input id="os" placeholder="اكتب اسم المنتج"></label><select id="op" class="input" size="5" style="margin-bottom:10px" aria-label="المنتج"></select>
      <div class="field-grid"><label class="f">النوع<select name="t"><option value="percent">نسبة ٪</option><option value="fixed">مبلغ (ج.م)</option></select></label><label class="f">القيمة<input name="v" type="number" step="0.01" min="0" required></label>
      <label class="f">يبدأ<input name="s" type="datetime-local"></label><label class="f">ينتهي<input name="e" type="datetime-local"></label></div><button class="btn primary block">إنشاء العرض</button></form>`, { title: 'عرض جديد' });
    const op = $('#op', m.el), search = debounce(async () => {
      const t = $('#os', m.el).value.replace(/[%,()*\\]/g, ' ').trim();
      let q = sb.from('products').select('id,name,price').is('archived_at', null).limit(15); if (t) q = q.ilike('name', `%${t}%`);
      const { data: ps } = await q; op.innerHTML = (ps || []).map((p) => `<option value="${p.id}" data-price="${p.price}">${esc(p.name)} — ${money(p.price)}</option>`).join('');
    }, 250);
    $('#os', m.el).oninput = search; search();
    $('#of', m.el).onsubmit = async (e) => {
      e.preventDefault(); const f = e.target, pid = op.value; if (!pid) return toast('اختر منتجا', 'err');
      const val = Number(f.v.value), price = Number(op.selectedOptions[0].dataset.price);
      if (!(val > 0)) return toast('أدخل قيمة الخصم', 'err'); if (f.t.value === 'percent' && val > 100) return toast('النسبة لا تتجاوز ١٠٠', 'err'); if (f.t.value === 'fixed' && val >= price) return toast('الخصم يجب أن يقل عن السعر', 'err');
      const st = f.s.value ? new Date(f.s.value) : new Date(), en = f.e.value ? new Date(f.e.value) : null; if (en && en <= st) return toast('تاريخ الانتهاء يجب أن يكون بعد البداية', 'err');
      const { error: er } = await sb.from('offers').insert({ product_id: pid, discount_type: f.t.value, discount_value: val, starts_at: st.toISOString(), ends_at: en ? en.toISOString() : null });
      if (er) return toast(arabicError(er), 'err'); toast('تم إنشاء العرض'); m.close(); offersView(box);
    };
  };
}

async function bannersView(box) {
  const { data, error } = await sb.from('homepage_banners').select('*').order('sort_order'); if (error) throw error;
  box.innerHTML = `<p><button class="btn primary" id="nb">+ بنر جديد</button> <span class="muted">يُفضّل صور عريضة (١٦٠٠×٦٠٠ تقريبا). إن لم توجد بنرات يظهر بنر افتراضي بالألوان.</span></p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الصورة</th><th>العنوان</th><th>الترتيب</th><th>مفعّل</th><th></th></tr></thead><tbody>
    ${data.map((b) => `<tr data-id="${b.id}"><td><img class="th" src="${esc(b.image_url)}" alt="" style="width:90px"></td><td>${esc(b.title || '—')}</td><td>${b.sort_order}</td><td>${b.is_active ? '✔' : '—'}</td><td><button class="btn ghost sm" data-edit>تعديل</button> <button class="btn ghost sm" data-del style="color:var(--danger)">حذف</button></td></tr>`).join('') || '<tr><td colspan="5" class="center muted">لا توجد بنرات</td></tr>'}</tbody></table></div>`;
  const form = (b) => {
    const isNew = !b; b = b || { is_active: true, sort_order: data.length };
    const m = modal(`<form id="bf" novalidate><label class="f">الصورة *<input type="file" id="bimg" accept="image/png,image/jpeg,image/webp"></label><input type="hidden" name="image_url" value="${esc(b.image_url || '')}"><img id="bp" src="${esc(b.image_url || PLACEHOLDER)}" alt="" style="max-height:110px;border-radius:10px;margin-bottom:10px">
      <label class="f">العنوان<input name="title" maxlength="100" value="${esc(b.title || '')}"></label><label class="f">نص فرعي<input name="subtitle" maxlength="160" value="${esc(b.subtitle || '')}"></label>
      <label class="f">رابط عند الضغط (https://… اختياري)<input name="link_url" dir="ltr" value="${esc(b.link_url || '')}"></label><label class="f">الترتيب<input name="sort_order" type="number" value="${b.sort_order}"></label>
      <label class="f" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="is_active" ${b.is_active ? 'checked' : ''} style="width:20px;min-height:20px"> مفعّل</label><button class="btn primary block">حفظ</button></form>`, { title: isNew ? 'بنر جديد' : 'تعديل بنر' });
    const f = $('#bf', m.el);
    $('#bimg', m.el).onchange = async (e) => { try { const u = await uploadImage(e.target.files[0], 'banners', 1600); f.image_url.value = u; $('#bp', m.el).src = u; } catch (x) { toast(arabicError(x), 'err'); } };
    f.onsubmit = async (e) => {
      e.preventDefault(); if (!f.image_url.value) return toast('ارفع صورة البنر', 'err');
      const l = f.link_url.value.trim(); if (l && !/^https?:\/\//i.test(l)) return toast('الرابط يجب أن يبدأ بـ https://', 'err');
      const row = { image_url: f.image_url.value, title: strOrNull(f.title.value), subtitle: strOrNull(f.subtitle.value), link_url: strOrNull(l), sort_order: Number(f.sort_order.value) || 0, is_active: f.is_active.checked };
      const { error: er } = isNew ? await sb.from('homepage_banners').insert(row) : await sb.from('homepage_banners').update(row).eq('id', b.id);
      if (er) return toast(arabicError(er), 'err'); toast('تم الحفظ'); m.close(); bannersView(box);
    };
  };
  $('#nb').onclick = () => form(null);
  $$('tr[data-id]', box).forEach((tr) => {
    const b = data.find((x) => x.id === tr.dataset.id);
    $('[data-edit]', tr).onclick = () => form(b);
    $('[data-del]', tr).onclick = async () => { if (!(await confirmDialog('حذف هذا البنر؟', 'حذف'))) return; const { error: er } = await sb.from('homepage_banners').delete().eq('id', b.id); if (er) return toast(arabicError(er), 'err'); bannersView(box); };
  });
}

async function brandsView(box) {
  const { data, error } = await sb.from('brands').select('*').order('name'); if (error) throw error;
  box.innerHTML = `<p><button class="btn primary" id="nbr">+ ماركة جديدة</button></p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الماركة</th><th>في الرئيسية</th><th></th></tr></thead><tbody>
    ${data.map((b) => `<tr data-id="${b.id}"><td>${b.logo_url ? `<img class="th" src="${esc(b.logo_url)}" alt="" style="vertical-align:middle">` : ''} <b>${esc(b.name)}</b></td><td>${b.show_on_home ? '✔' : '—'}</td><td><button class="btn ghost sm" data-edit>تعديل</button> <button class="btn ghost sm" data-del style="color:var(--danger)">حذف</button></td></tr>`).join('') || '<tr><td colspan="3" class="center muted">لا توجد ماركات</td></tr>'}</tbody></table></div>`;
  const form = (b) => {
    const isNew = !b; b = b || {};
    const m = modal(`<form id="brf" novalidate><label class="f">اسم الماركة *<input name="name" required maxlength="80" value="${esc(b.name || '')}"></label><label class="f">الشعار<input type="file" id="blg" accept="image/png,image/jpeg,image/webp,image/svg+xml"></label><input type="hidden" name="logo_url" value="${esc(b.logo_url || '')}">
      <label class="f" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="show_on_home" ${b.show_on_home ? 'checked' : ''} style="width:20px;min-height:20px"> إظهار في الصفحة الرئيسية</label><button class="btn primary block">حفظ</button></form>`, { title: isNew ? 'ماركة جديدة' : 'تعديل الماركة' });
    const f = $('#brf', m.el);
    $('#blg', m.el).onchange = async (e) => { try { f.logo_url.value = await uploadImage(e.target.files[0], 'brands', 300); toast('تم رفع الشعار'); } catch (x) { toast(arabicError(x), 'err'); } };
    f.onsubmit = async (e) => {
      e.preventDefault(); if (!f.name.value.trim()) return toast('اسم الماركة مطلوب', 'err');
      const row = { name: f.name.value.trim(), logo_url: strOrNull(f.logo_url.value), show_on_home: f.show_on_home.checked };
      const { error: er } = isNew ? await sb.from('brands').insert(row) : await sb.from('brands').update(row).eq('id', b.id);
      if (er) return toast(arabicError(er), 'err'); toast('تم الحفظ'); m.close(); brandsView(box);
    };
  };
  $('#nbr').onclick = () => form(null);
  $$('tr[data-id]', box).forEach((tr) => {
    const b = data.find((x) => x.id === tr.dataset.id);
    $('[data-edit]', tr).onclick = () => form(b);
    $('[data-del]', tr).onclick = async () => { if (!(await confirmDialog(`حذف ماركة "${b.name}"؟ ستبقى منتجاتها بدون ماركة.`, 'حذف'))) return; const { error: er } = await sb.from('brands').delete().eq('id', b.id); if (er) return toast(arabicError(er), 'err'); brandsView(box); };
  });
}
