// Storefront entry: header/footer, hash router, home page, catalog, product dialog, order confirmation.
import { sb, IS_CONFIGURED, loadSettings, applyBrand, loadOrderForInvoice } from './api.js';
import { state, bus } from './state.js';
import { cart, addToCart, stepFor, maxFor, openCart, closeCart } from './cart.js';
import { initAuth, openAuth, renderAccount, statusAr } from './auth.js';
import { $, $$, esc, money, qtyFmt, toast, modal, debounce, safeUrl, arabicError, PLACEHOLDER, waNumber } from './util.js';

const app = $('#app');
const PAGE = 24;
let heroTimer = null;

// ---------------- boot ----------------
(async function boot() {
  if (!IS_CONFIGURED) { $('#config-error').hidden = false; app.innerHTML = '<div class="empty">الموقع غير متصل بقاعدة البيانات بعد.</div>'; return; }
  try {
    const [settings, cats, brands] = await Promise.all([
      loadSettings(),
      sb.from('categories').select('*').eq('is_visible', true).order('sort_order'),
      sb.from('brands').select('*').order('name'),
    ]);
    state.settings = settings; applyBrand(settings);
    if (cats.error) throw cats.error;
    state.cats = cats.data || [];
    (brands.data || []).forEach((b) => state.brands.set(b.id, b));
  } catch (e) {
    app.innerHTML = `<div class="empty"><div class="big">⚠️</div><p>${esc(arabicError(e))}</p><button class="btn primary" onclick="location.reload()">إعادة المحاولة</button></div>`;
    return;
  }
  renderChrome();
  await initAuth();
  bindGlobal();
  bus.on('cart', updateBadge);
  bus.on('auth', () => { if (/^#\/account/.test(location.hash)) route(); });
  updateBadge();
  window.addEventListener('hashchange', route);
  route();
})();

// ---------------- chrome ----------------
function renderChrome() {
  const s = state.settings;
  const logo = s.logo_url
    ? `<img src="${esc(s.logo_url)}" alt="" width="44" height="44"><span>${esc(s.store_name)}</span>`
    : `<span class="logo-mark" aria-hidden="true"><svg viewBox="0 0 32 32" width="26" height="26" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h22l-2.4 13.5a2 2 0 0 1-2 1.5H9.400a2 2 0 0 1-2-1.500L5 12z"/><path d="M11 12c0-4 2.200-7 5-7s5 3 5 7"/></svg></span><span>${esc(s.store_name)}</span>`;
  $('#logo').innerHTML = logo;
  const ann = $('#announce'); ann.hidden = !s.announcement; ann.textContent = s.announcement || '';
  const ph = $('#header-phone'); ph.textContent = s.phone || ''; ph.href = 'tel:' + (s.phone || '').replace(/[^\d+]/g, ''); ph.hidden = !s.phone;
  $('#wa-float').href = `https://wa.me/${s.whatsapp_number}`;
  $('#cat-nav').innerHTML = `<li><a href="#/all" data-nav="all">كل المنتجات</a></li>` +
    state.cats.map((c) => `<li><a href="#/c/${c.id}" data-nav="${c.id}">${esc(c.name)}</a></li>`).join('');
  renderFooter();
}

function renderFooter() {
  const s = state.settings, soc = s.social_links || {};
  const names = { facebook: 'فيسبوك', instagram: 'إنستجرام', tiktok: 'تيك توك', youtube: 'يوتيوب', x: 'X' };
  const links = Object.entries(soc).filter(([, u]) => safeUrl(u)).map(([k, u]) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(names[k] || k)}</a>`).join(' · ');
  $('#footer').innerHTML = `<div class="container"><div class="footer-grid">
    <div><h3>${esc(s.store_name)}</h3>${s.address ? `<p>📍 ${esc(s.address)}</p>` : ''}${s.phone ? `<p>📞 <a href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}" dir="ltr">${esc(s.phone)}</a></p>` : ''}
      <p>💬 <a href="https://wa.me/${esc(s.whatsapp_number)}" target="_blank" rel="noopener">واتساب</a></p>${s.email ? `<p>✉️ <a href="mailto:${esc(s.email)}">${esc(s.email)}</a></p>` : ''}${links ? `<p>${links}</p>` : ''}</div>
    <div><h3>مواعيد العمل</h3><p style="white-space:pre-line">${esc(s.store_hours || 'يرجى التواصل معنا لمعرفة المواعيد')}</p></div>
    <div><h3>التوصيل</h3><p style="white-space:pre-line">${esc(s.delivery_info || `رسوم التوصيل ${money(s.delivery_fee)}${s.free_delivery_over != null ? ` — مجانا للطلبات من ${money(s.free_delivery_over)}` : ''}`)}</p>
      ${Number(s.min_order_amount) > 0 ? `<p>الحد الأدنى للطلب ${money(s.min_order_amount)}</p>` : ''}</div>
    <div><h3>المتجر</h3><p><button class="link" data-policy>سياسات المتجر</button></p><p><a href="#/account">حسابي وطلباتي</a></p></div>
  </div><div class="copy">© ${new Date().getFullYear()} ${esc(s.store_name)} — جميع الحقوق محفوظة</div></div>`;
  const pb = $('[data-policy]');
  if (pb) pb.onclick = () => modal(`<p style="white-space:pre-line">${esc(s.policies || 'لم يتم إضافة سياسات بعد.')}</p>`, { title: 'سياسات المتجر' });
}

function updateBadge() { const n = cart.count(); const b = $('#cart-badge'); b.hidden = !n; b.textContent = n; }

function bindGlobal() {
  $('#btn-cart').onclick = openCart; $('#drawer-close').onclick = closeCart; $('#drawer-shade').onclick = closeCart;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCart(); });
  $('#btn-account').onclick = () => { location.hash = '#/account'; };
  $('#search-form').onsubmit = (e) => { e.preventDefault(); const q = $('#q').value.trim(); location.hash = q ? '#/search/' + encodeURIComponent(q) : '#/all'; };
  document.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]'); if (o) { e.preventDefault(); openProduct(o.dataset.open); }
  });
}

// ---------------- router ----------------
const cache = new Map();            // product id -> product row
let pageToken = 0;
async function route() {
  clearInterval(heroTimer);
  const h = location.hash || '#/';
  const tok = ++pageToken;
  window.scrollTo({ top: 0 });
  $$('#cat-nav a').forEach((a) => a.classList.remove('active'));
  let m;
  if ((m = h.match(/^#\/order\/([^/]+)\/([^/]+)/))) return renderConfirmation(m[1], m[2]);
  if (h.startsWith('#/account')) return renderAccount(app);
  if ((m = h.match(/^#\/c\/([0-9a-f-]{36})/))) { setActive(m[1]); return renderCatalog({ cat: m[1] }); }
  if ((m = h.match(/^#\/search\/(.+)/))) { $('#q').value = decodeURIComponent(m[1]); return renderCatalog({ q: decodeURIComponent(m[1]) }); }
  if (h.startsWith('#/all')) { setActive('all'); return renderCatalog({}); }
  return renderHome(tok);
}
function setActive(id) { const a = $(`#cat-nav a[data-nav="${id}"]`); if (a) { a.classList.add('active'); a.scrollIntoView({ inline: 'center', block: 'nearest' }); } }

// ---------------- product card ----------------
const SEL = '*';
function remember(list) { (list || []).forEach((p) => cache.set(p.id, p)); return list || []; }

function card(p) {
  const out = Number(p.stock) <= 0, disc = Number(p.discount_amount) > 0;
  const oldP = disc ? Number(p.price) : (p.old_price && Number(p.old_price) > Number(p.price) ? Number(p.old_price) : null);
  const pct = oldP ? Math.round((1 - Number(p.final_price) / oldP) * 100) : 0;
  const brand = p.brand_id && state.brands.get(p.brand_id)?.name;
  const tag = out ? '<span class="tag out">نفدت الكمية</span>' : pct > 0 ? `<span class="tag">وفّر ${qtyFmt(pct)}٪</span>` : p.is_new ? '<span class="tag new">جديد</span>' : '';
  return `<article class="card">${tag}
    <button class="pic" data-open="${p.id}" aria-label="عرض ${esc(p.name)}"><img src="${esc(p.image_url || PLACEHOLDER)}" alt="" loading="lazy" width="300" height="300"></button>
    <div class="info"><h3><button data-open="${p.id}">${esc(p.name)}</button></h3>
      <div class="unit">${esc(p.unit)}${brand ? ' · ' + esc(brand) : ''}</div>
      <div class="price-row"><span class="price">${money(p.final_price)}</span>${oldP ? `<span class="old-price">${money(oldP)}</span>` : ''}</div>
      <button class="btn primary sm add" data-open="${p.id}" ${out ? 'disabled' : ''}>${out ? 'غير متوفر' : 'أضف للسلة'}</button></div></article>`;
}

// ---------------- product dialog ----------------
async function openProduct(id) {
  let p = cache.get(id);
  if (!p) { const { data } = await sb.from('store_products').select(SEL).eq('id', id).maybeSingle(); if (data) { cache.set(id, data); p = data; } }
  if (!p) return toast('المنتج غير متاح', 'err');
  // always re-read price/stock so the dialog never shows stale data
  const { data: fresh } = await sb.from('store_products').select(SEL).eq('id', id).maybeSingle();
  if (fresh) { p = fresh; cache.set(id, fresh); }
  const [{ data: imgs }] = await Promise.all([sb.from('product_images').select('url').eq('product_id', id).order('sort_order')]);
  const gallery = [p.image_url, ...(imgs || []).map((i) => i.url)].filter(Boolean);
  const cat = state.cats.find((c) => c.id === p.category_id), brand = p.brand_id && state.brands.get(p.brand_id);
  const out = Number(p.stock) <= 0, mx = maxFor(p), st = stepFor(p), mn = Number(p.min_qty);
  const disc = Number(p.discount_amount) > 0;
  const oldP = disc ? Number(p.price) : (p.old_price && Number(p.old_price) > Number(p.price) ? Number(p.old_price) : null);
  const low = !out && Number(p.stock) <= Number(p.low_stock_threshold);
  const inCart = cart.items[id] || 0;
  const m = modal(`<div class="pd">
    <div><div class="pd-img"><img id="pd-main" src="${esc(gallery[0] || PLACEHOLDER)}" alt="${esc(p.name)}"></div>
      ${gallery.length > 1 ? `<div class="row gap" style="margin-top:8px">${gallery.slice(0, 5).map((u) => `<button class="btn ghost sm" data-thumb="${esc(u)}" style="padding:2px;min-height:0"><img src="${esc(u)}" alt="" width="52" height="52" style="border-radius:6px;object-fit:cover"></button>`).join('')}</div>` : ''}</div>
    <div><h3>${esc(p.name)}</h3>
      <div class="meta">${cat ? `<span class="chip">${esc(cat.name)}</span>` : ''}${brand ? `<span class="chip">${esc(brand.name)}</span>` : ''}<span class="chip">${esc(p.unit)}</span>
        ${out ? '<span class="chip bad">نفدت الكمية</span>' : low ? `<span class="chip warn">متبقي ${qtyFmt(p.stock)} فقط</span>` : '<span class="chip">متوفر</span>'}</div>
      <div class="price-row" style="margin:6px 0 10px"><span class="price" style="font-size:1.6rem">${money(p.final_price)}</span>${oldP ? `<span class="old-price">${money(oldP)}</span>` : ''}</div>
      ${disc && p.offer_ends_at ? `<div class="notice">العرض ساري حتى ${new Date(p.offer_ends_at).toLocaleDateString('ar-EG', { dateStyle: 'long', timeZone: 'Africa/Cairo' })}</div>` : ''}
      ${p.description ? `<p style="white-space:pre-line">${esc(p.description)}</p>` : ''}
      ${p.sku || p.barcode ? `<p class="muted" style="font-size:.85rem" dir="ltr">${esc(p.sku ? 'SKU: ' + p.sku : '')} ${esc(p.barcode ? 'Barcode: ' + p.barcode : '')}</p>` : ''}
      ${mn > 1 || p.max_qty ? `<p class="muted" style="font-size:.85rem">${mn > 1 ? 'الحد الأدنى ' + qtyFmt(mn) : ''} ${p.max_qty ? 'الحد الأقصى ' + qtyFmt(p.max_qty) : ''}</p>` : ''}
      ${inCart ? `<div class="notice info">في سلتك حاليا: ${qtyFmt(inCart)}</div>` : ''}
      ${out ? '' : `<div class="row gap wrap" style="margin:10px 0"><div class="qty"><button id="q-dec" aria-label="إنقاص">−</button><input id="q-in" type="number" inputmode="decimal" min="${mn}" max="${mx}" step="${st}" value="${Math.max(mn, st)}" aria-label="الكمية"><button id="q-inc" aria-label="زيادة">+</button></div>
        <strong id="q-sub"></strong></div>
        <button class="btn primary block" id="q-add">أضف إلى السلة</button>`}
    </div></div>`, { title: 'تفاصيل المنتج', wide: true });
  m.el.querySelectorAll('[data-thumb]').forEach((b) => (b.onclick = () => { $('#pd-main', m.el).src = b.dataset.thumb; }));
  if (out) return;
  const inp = $('#q-in', m.el), sub = $('#q-sub', m.el), room = Math.max(0, mx - inCart);
  const clamp = (q) => {
    if (!(q >= mn)) q = mn;
    q = Math.round(q / st) * st;
    if (q > room) { q = room; }
    return Math.max(q, 0);
  };
  const paint = () => { const q = clamp(Number(inp.value)); inp.value = q; sub.textContent = 'الإجمالي: ' + money(q * Number(p.final_price)); $('#q-add', m.el).disabled = q <= 0 || q < mn; };
  $('#q-inc', m.el).onclick = () => { if (Number(inp.value) + st > room) toast(`المتاح لك ${qtyFmt(room)} فقط`, 'err'); inp.value = Number(inp.value) + st; paint(); };
  $('#q-dec', m.el).onclick = () => { inp.value = Math.max(mn, Number(inp.value) - st); paint(); };
  inp.onchange = paint; paint();
  if (room < mn) { $('#q-add', m.el).disabled = true; sub.textContent = 'وصلت للحد الأقصى المتاح في السلة'; }
  $('#q-add', m.el).onclick = () => {
    const q = clamp(Number(inp.value)); if (q < mn || q <= 0) return;
    addToCart(p, q); toast(`تمت إضافة ${qtyFmt(q)} × ${p.name} إلى السلة`); m.close();
  };
}

// ---------------- home ----------------
const sectionHTML = (id, title, html, more) => `<section class="section" id="${id}"><div class="section-head"><h2>${esc(title)}</h2>${more ? `<a href="${more}">عرض الكل ←</a>` : ''}</div>${html}</section>`;
const hscroll = (list) => `<div class="hscroll">${list.map(card).join('')}</div>`;

async function renderHome(tok) {
  app.innerHTML = `<div class="section"><div class="skeleton" style="min-height:240px"></div></div><div class="grid">${'<div class="skeleton"></div>'.repeat(4)}</div>`;
  const base = () => sb.from('store_products').select(SEL).eq('is_active', true);
  const [banners, offers, feat, best, fresh, any] = await Promise.all([
    sb.from('homepage_banners').select('*').eq('is_active', true).order('sort_order'),
    base().gt('discount_amount', 0).gt('stock', 0).order('discount_amount', { ascending: false }).limit(20),
    base().eq('is_featured', true).gt('stock', 0).limit(12),
    base().gt('sales_count', 0).gt('stock', 0).order('sales_count', { ascending: false }).limit(12),
    base().gt('stock', 0).order('created_at', { ascending: false }).limit(12),
    base().limit(1),
  ]);
  if (tok !== pageToken) return;
  for (const r of [offers, feat, best, fresh]) remember(r.data);
  const s = state.settings;
  let html = '';
  const bs = (banners.data || []).filter((b) => b.image_url);
  if (bs.length) {
    html += `<div class="hero" id="hero">${bs.map((b, i) => {
      const href = safeUrl(b.link_url);
      const inner = `<img src="${esc(b.image_url)}" alt="${esc(b.title || '')}" ${i ? 'loading="lazy"' : ''}>${b.title || b.subtitle ? `<div class="hero-caption">${b.title ? `<h2>${esc(b.title)}</h2>` : ''}${b.subtitle ? `<p>${esc(b.subtitle)}</p>` : ''}</div>` : ''}`;
      return `<div class="hero-slide ${i ? '' : 'on'}">${href ? `<a href="${esc(href)}">${inner}</a>` : inner}</div>`;
    }).join('')}${bs.length > 1 ? `<div class="hero-dots">${bs.map((_, i) => `<button class="${i ? '' : 'on'}" aria-label="شريحة ${i + 1}"></button>`).join('')}</div>` : ''}</div>`;
  } else {
    html += `<div class="hero default"><div><h1>أهلا بك في ${esc(s.store_name)}</h1><p>اطلب احتياجات بيتك اليومية بسهولة، ونوصلها لك${s.free_delivery_over != null ? ` — توصيل مجاني للطلبات من ${money(s.free_delivery_over)}` : ''}.</p><a class="btn accent" href="#/all">تسوق الآن</a></div></div>`;
  }
  if (s.show_offers !== false && (offers.data || []).length) html += sectionHTML('offers', '🔥 عروض خاصة', hscroll(offers.data));
  const homeCats = state.cats.filter((c) => c.show_on_home);
  if (homeCats.length) html += sectionHTML('cats', 'تسوق حسب القسم', `<div class="cat-grid">${homeCats.map((c) => `<a class="cat-tile" href="#/c/${c.id}"><span class="ic">${c.image_url ? `<img src="${esc(c.image_url)}" alt="" loading="lazy">` : esc(c.icon || '🛍️')}</span>${esc(c.name)}</a>`).join('')}</div>`);
  if ((feat.data || []).length) html += sectionHTML('featured', 'منتجات مميزة', hscroll(feat.data));
  if ((best.data || []).length) html += sectionHTML('best', 'الأكثر مبيعا', hscroll(best.data));
  if ((fresh.data || []).length) html += sectionHTML('fresh', 'وصل حديثا', hscroll(fresh.data), '#/all');
  const shownBrands = [...state.brands.values()].filter((b) => b.show_on_home);
  if (s.show_brands && shownBrands.length) html += sectionHTML('brands', 'ماركات نثق بها', `<div class="brands">${shownBrands.map((b) => `<div class="brand-chip">${b.logo_url ? `<img src="${esc(b.logo_url)}" alt="${esc(b.name)}" loading="lazy">` : esc(b.name)}</div>`).join('')}</div>`);
  if (!(any.data || []).length) html += `<div class="empty" style="margin-top:20px"><div class="big">🧺</div><p>لم تتم إضافة منتجات بعد. سيظهر هنا كل ما يضيفه المتجر.</p></div>`;
  app.innerHTML = html;
  const slides = $$('.hero-slide'), dots = $$('.hero-dots button');
  if (slides.length > 1) {
    let i = 0; const go = (n) => { i = n; slides.forEach((s2, k) => s2.classList.toggle('on', k === i)); dots.forEach((d, k) => d.classList.toggle('on', k === i)); };
    dots.forEach((d, k) => (d.onclick = () => go(k)));
    heroTimer = setInterval(() => go((i + 1) % slides.length), 5500);
  }
}

// ---------------- catalog ----------------
// Arabic-friendly search: alef/hamza, ta-marbuta/ha and ya/alef-maqsura variants all match each other.
const arPattern = (t) => t.replace(/[%_\\,()*]/g, ' ').trim().replace(/[اأإآ]/g, '_').replace(/[ةه]/g, '_').replace(/[يى]/g, '_');

async function renderCatalog(f) {
  const cat = f.cat && state.cats.find((c) => c.id === f.cat);
  const f0 = { sort: 'newest', avail: false, min: '', max: '', ...f };
  let page = 0, total = 0;
  app.innerHTML = `<div class="crumbs"><a href="#/">الرئيسية</a> / <span>${cat ? esc(cat.name) : f.q ? 'نتائج البحث' : 'كل المنتجات'}</span><h1>${cat ? esc(cat.name) : f.q ? `نتائج البحث عن "${esc(f.q)}"` : 'كل المنتجات'}</h1></div>
    <form class="toolbar" id="tb">
      <label>الترتيب<select name="sort"><option value="newest">الأحدث</option><option value="popular">الأكثر مبيعا</option><option value="price_asc">السعر: الأقل أولا</option><option value="price_desc">السعر: الأعلى أولا</option></select></label>
      <label>السعر من<input class="num" name="min" type="number" min="0" inputmode="decimal" dir="ltr"></label>
      <label>إلى<input class="num" name="max" type="number" min="0" inputmode="decimal" dir="ltr"></label>
      <label style="grid-auto-flow:column;align-items:center;gap:6px"><input type="checkbox" name="avail" style="width:20px;min-height:20px"> المتوفر فقط</label>
    </form>
    <div class="grid" id="res"></div><p class="center" id="more-box"></p><p class="muted center" id="count"></p>`;
  const form = $('#tb'), res = $('#res');
  async function load(append) {
    if (!append) { page = 0; res.innerHTML = '<div class="skeleton"></div>'.repeat(4); }
    let q = sb.from('store_products').select(SEL, { count: 'exact' }).eq('is_active', true);
    if (f0.cat) q = q.eq('category_id', f0.cat);
    if (f0.q) q = q.ilike('name', `%${arPattern(f0.q)}%`);
    if (form.avail.checked) q = q.gt('stock', 0);
    if (form.min.value !== '') q = q.gte('final_price', Number(form.min.value));
    if (form.max.value !== '') q = q.lte('final_price', Number(form.max.value));
    const sort = form.sort.value;
    q = sort === 'price_asc' ? q.order('final_price', { ascending: true })
      : sort === 'price_desc' ? q.order('final_price', { ascending: false })
      : sort === 'popular' ? q.order('sales_count', { ascending: false }) : q.order('created_at', { ascending: false });
    const { data, count, error } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) { res.innerHTML = `<div class="empty" style="grid-column:1/-1">${esc(arabicError(error))}</div>`; return; }
    remember(data); total = count || 0;
    const html = (data || []).map(card).join('');
    if (!append) res.innerHTML = html || `<div class="empty" style="grid-column:1/-1"><div class="big">🔎</div><p>لا توجد منتجات مطابقة. جرّب تغيير البحث أو الفلاتر.</p></div>`;
    else res.insertAdjacentHTML('beforeend', html);
    const shown = res.querySelectorAll('.card').length;
    $('#count').textContent = total ? `عرض ${qtyFmt(shown)} من ${qtyFmt(total)} منتج` : '';
    $('#more-box').innerHTML = shown < total ? '<button class="btn ghost" id="more">عرض المزيد</button>' : '';
    const mb = $('#more'); if (mb) mb.onclick = () => { page++; mb.disabled = true; load(true); };
  }
  form.addEventListener('input', debounce(() => load(false), 350));
  form.addEventListener('submit', (e) => e.preventDefault());
  load(false);
}

// ---------------- order confirmation ----------------
async function renderConfirmation(number, token) {
  app.innerHTML = '<div class="confirm panel"><span class="spinner"></span></div>';
  let o;
  try { o = await loadOrderForInvoice({ number, token }); } catch (e) { o = null; }
  if (!o) { app.innerHTML = '<div class="empty"><div class="big">🔒</div><p>تعذر العثور على هذا الطلب.</p><a class="btn primary" href="#/">العودة للتسوق</a></div>'; return; }
  const waUrl = sessionStorage.getItem('market.wa.' + number) || '';
  app.innerHTML = `<div class="confirm panel">
    <div class="check">✅</div><h1 style="margin:4px 0">تم حفظ طلبك</h1>
    <div class="order-no">${esc(o.order_number)}</div>
    <p>الحالة: <span class="status ${o.status}">${esc(statusAr(o.status))}</span></p>
    <div class="notice" style="text-align:start"><b>مهم:</b> طلبك محفوظ لدينا لكنه <b>بانتظار تأكيد المتجر عبر واتساب</b>. تأكد من الضغط على "إرسال" داخل رسالة واتساب الجاهزة. إذا لم يفتح واتساب تلقائيا استخدم الزر التالي.</div>
    ${waUrl ? `<p><a class="btn wa block" href="${esc(waUrl)}" target="_blank" rel="noopener">فتح واتساب وإرسال الطلب</a></p>` : ''}
    <div class="totals" style="text-align:start">${(o.items || []).map((it) => `<div><span>${esc(it.product_name)} × ${qtyFmt(it.quantity)}</span><span>${money(it.line_total)}</span></div>`).join('')}
      <div><span>رسوم التوصيل</span><span>${Number(o.delivery_fee) ? money(o.delivery_fee) : 'مجانا'}</span></div><div class="grand"><span>الإجمالي</span><span>${money(o.total)}</span></div></div>
    <div class="row gap wrap" style="justify-content:center"><a class="btn ghost" target="_blank" rel="noopener" href="invoice.html?o=${encodeURIComponent(o.order_number)}&t=${encodeURIComponent(token)}">عرض الفاتورة</a>
    <a class="btn primary" href="#/">العودة للتسوق</a></div>
    <p class="muted" style="font-size:.85rem">احتفظ بهذه الصفحة أو برقم الطلب لمتابعة طلبك.</p></div>`;
}
