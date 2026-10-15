// Supabase client + data access shared by the storefront, invoice page and admin dashboard.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, IS_CONFIGURED } from './config.js';

export { IS_CONFIGURED };
export const sb = createClient(IS_CONFIGURED ? SUPABASE_URL : 'https://placeholder.supabase.co', IS_CONFIGURED ? SUPABASE_ANON_KEY : 'placeholder', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export async function getSession() {
  const { data } = await sb.auth.getSession();
  return data.session;
}

// Roles come from the server (RLS lets a user read only their own role rows).
export async function getMyRoles() {
  const s = await getSession();
  if (!s) return { owner: false, staff: false, permissions: {} };
  const { data } = await sb.from('user_roles').select('role,permissions').eq('user_id', s.user.id);
  const rows = data || [];
  const staff = rows.find((r) => r.role === 'staff');
  return { owner: rows.some((r) => r.role === 'owner'), staff: !!staff, permissions: staff?.permissions || {} };
}

export async function loadSettings() {
  const { data, error } = await sb.from('store_settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return data;
}

export function applyBrand(settings) {
  const r = document.documentElement.style;
  if (settings.primary_color) r.setProperty('--primary', settings.primary_color);
  if (settings.accent_color) r.setProperty('--accent', settings.accent_color);
  document.title = settings.store_name + ' | سوبر ماركت أونلاين';
}

// Order loading for invoice: guests use (order_number, token); signed-in users read via RLS.
export async function loadOrderForInvoice({ number, token, id }) {
  if (number && token) {
    const { data, error } = await sb.rpc('get_order_public', { p_order_number: number, p_token: token });
    if (error) throw error;
    return data;
  }
  if (id) {
    const { data, error } = await sb.from('orders')
      .select('*, order_items(*), invoices(invoice_number)').eq('id', id).single();
    if (error) throw error;
    return { ...data, items: data.order_items, invoice_number: data.invoices?.invoice_number };
  }
  return null;
}

// ---- WhatsApp message builders (data comes from the SERVER-calculated order) ----
const L = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

export function orderMessage(o) {
  const lines = (o.items || []).map((it, i) => {
    const unit = Number(it.unit_price) - Number(it.discount_per_unit || 0);
    return `${i + 1}. ${it.product_name} — ${L(it.quantity)} ${it.unit} × ${L(unit)} = ${L(it.line_total)} ج.م`;
  });
  return [
    `*طلب جديد رقم ${o.order_number}*`,
    `الاسم: ${o.customer_name}`,
    `الهاتف: ${o.customer_phone}`,
    o.fulfillment === 'pickup' ? 'الاستلام: من المتجر' : `التوصيل إلى: ${o.address}`,
    '',
    '*المنتجات:*',
    ...lines,
    '',
    `المجموع الفرعي: ${L(o.subtotal)} ج.م`,
    Number(o.discount_total) > 0 ? `الخصم: ${L(o.discount_total)} ج.م` : null,
    `رسوم التوصيل: ${L(o.delivery_fee)} ج.م`,
    `*الإجمالي: ${L(o.total)} ج.م*`,
    `طريقة الدفع: ${o.payment_method}`,
    o.notes ? `ملاحظات: ${o.notes}` : null,
  ].filter((x) => x !== null).join('\n');
}

export function invoiceMessage(o, storeName) {
  return [
    `*فاتورة ${o.invoice_number || ''} — ${storeName}*`,
    `رقم الطلب: ${o.order_number}`,
    `العميل: ${o.customer_name}`,
    ...(o.items || []).map((it) => `• ${it.product_name} × ${L(it.quantity)} = ${L(it.line_total)} ج.م`),
    `رسوم التوصيل: ${L(o.delivery_fee)} ج.م`,
    `*الإجمالي: ${L(o.total)} ج.م*`,
  ].join('\n');
}

export const waLink = (number, text) => `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
