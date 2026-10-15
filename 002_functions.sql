-- 002_functions.sql : auth helpers, triggers, secure order/admin RPCs

-- ===== role helpers (SECURITY DEFINER so RLS policies can call them safely) =====
create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role = 'owner');
$$;

create or replace function is_staff_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_roles
    where user_id = auth.uid() and role = 'staff' and permissions ->> p = 'true'
  );
$$;

-- ===== new user -> profile + customer role (nobody can self-assign owner/staff) =====
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles(id, full_name, phone, email)
  values (new.id, nullif(new.raw_user_meta_data ->> 'full_name',''), nullif(new.phone,''), nullif(new.email,''))
  on conflict (id) do nothing;
  insert into user_roles(user_id, role) values (new.id, 'customer') on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ===== audit logging =====
create or replace function log_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  v_id := coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'id',
                   (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'user_id', '');
  insert into admin_activity_logs(actor_id, action, entity, entity_id, details)
  values (auth.uid(), lower(tg_op), tg_table_name, v_id,
          case when tg_op = 'UPDATE' then jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new))
               when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end);
  return null;
end $$;

create trigger log_products after insert or update or delete on products for each row execute function log_change();
create trigger log_categories after insert or update or delete on categories for each row execute function log_change();
create trigger log_offers after insert or update or delete on offers for each row execute function log_change();
create trigger log_settings after update on store_settings for each row execute function log_change();
create trigger log_banners after insert or update or delete on homepage_banners for each row execute function log_change();
create trigger log_roles after insert or update or delete on user_roles for each row execute function log_change();

-- ===== stock movements recorded automatically for manual stock edits =====
create or replace function track_stock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.stock <> 0 then
      insert into inventory_movements(product_id, change, reason, created_by)
      values (new.id, new.stock, 'initial', auth.uid());
    end if;
  elsif new.stock <> old.stock and coalesce(current_setting('app.skip_stock_log', true), '') <> 'on' then
    insert into inventory_movements(product_id, change, reason, created_by)
    values (new.id, new.stock - old.stock, 'adjustment', auth.uid());
  end if;
  return null;
end $$;
create trigger track_stock_ins after insert on products for each row execute function track_stock();
create trigger track_stock_upd after update of stock on products for each row execute function track_stock();

-- ===== pricing =====
create or replace function current_discount(p_product uuid, p_price numeric) returns numeric
language sql stable as $$
  select coalesce(max(case when o.discount_type = 'percent'
                           then round(p_price * o.discount_value / 100, 2)
                           else least(o.discount_value, p_price) end), 0)
  from offers o
  where o.product_id = p_product and o.is_active
    and o.starts_at <= now() and (o.ends_at is null or o.ends_at > now());
$$;

-- storefront view: never exposes cost; respects RLS of the caller
create or replace view store_products with (security_invoker = true) as
select p.id, p.name, p.description, p.category_id, p.brand_id, p.price, p.old_price, p.unit,
       p.stock, p.low_stock_threshold, p.sku, p.barcode, p.image_url, p.is_active, p.is_featured,
       p.is_new, p.min_qty, p.max_qty, p.sales_count, p.created_at, p.archived_at,
       current_discount(p.id, p.price) as discount_amount,
       p.price - current_discount(p.id, p.price) as final_price,
       (select min(o.ends_at) from offers o
         where o.product_id = p.id and o.is_active and o.starts_at <= now()
           and (o.ends_at is null or o.ends_at > now())) as offer_ends_at
from products p
where p.archived_at is null;

-- ===== order JSON builder (internal only) =====
create or replace function order_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id, 'order_number', o.order_number, 'access_token', o.access_token,
    'status', o.status, 'payment_status', o.payment_status, 'payment_method', o.payment_method,
    'customer_name', o.customer_name, 'customer_phone', o.customer_phone,
    'customer_email', o.customer_email, 'fulfillment', o.fulfillment, 'address', o.address,
    'notes', o.notes, 'subtotal', o.subtotal, 'discount_total', o.discount_total,
    'delivery_fee', o.delivery_fee, 'total', o.total, 'created_at', o.created_at,
    'invoice_number', (select invoice_number from invoices i where i.order_id = o.id),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'product_name', i.product_name, 'unit', i.unit, 'quantity', i.quantity,
        'unit_price', i.unit_price, 'discount_per_unit', i.discount_per_unit,
        'line_total', i.line_total) order by i.product_name)
      from order_items i where i.order_id = o.id), '[]'::jsonb))
  from orders o where o.id = p_id;
$$;
revoke all on function order_json(uuid) from public, anon, authenticated;

-- ===== create_order: the ONLY way orders are created =====
create or replace function create_order(p_items jsonb, p_customer jsonb, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s store_settings%rowtype;
  v_existing uuid;
  v_item record;
  v_line record;
  v_p products%rowtype;
  v_disc numeric; v_lines jsonb := '[]'::jsonb;
  v_subtotal numeric := 0; v_discount numeric := 0; v_fee numeric := 0; v_total numeric;
  v_name text; v_phone text; v_email text; v_addr text; v_notes text; v_pay text;
  v_ful fulfillment_type;
  v_id uuid := gen_random_uuid();
  v_num text; v_seq bigint;
begin
  if p_idempotency_key is null or length(p_idempotency_key) < 8 or length(p_idempotency_key) > 100 then
    raise exception 'طلب غير صالح';
  end if;

  select id into v_existing from orders where idempotency_key = p_idempotency_key;
  if found then return order_json(v_existing); end if;

  if auth.uid() is not null and exists (select 1 from profiles where id = auth.uid() and is_blocked) then
    raise exception 'هذا الحساب غير مسموح له بإنشاء طلبات';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'سلة المشتريات فارغة';
  end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'عدد الأصناف أكبر من المسموح'; end if;

  select * into s from store_settings where id = 1;

  v_name  := btrim(coalesce(p_customer ->> 'name', ''));
  v_phone := btrim(coalesce(p_customer ->> 'phone', ''));
  v_email := nullif(btrim(coalesce(p_customer ->> 'email', '')), '');
  v_addr  := nullif(btrim(coalesce(p_customer ->> 'address', '')), '');
  v_notes := nullif(btrim(coalesce(p_customer ->> 'notes', '')), '');
  v_pay   := btrim(coalesce(p_customer ->> 'payment_method', ''));
  v_ful   := case when p_customer ->> 'fulfillment' = 'pickup' then 'pickup' else 'delivery' end;

  if length(v_name) < 2 or length(v_name) > 100 then raise exception 'يرجى إدخال الاسم'; end if;
  if v_phone !~ '^[0-9+ ()-]{8,20}$' then raise exception 'رقم الهاتف غير صحيح'; end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'البريد الإلكتروني غير صحيح'; end if;
  if v_ful = 'delivery' and (v_addr is null or length(v_addr) < 5) then raise exception 'يرجى إدخال عنوان التوصيل'; end if;
  if length(coalesce(v_notes, '')) > 500 or length(coalesce(v_addr, '')) > 400 then raise exception 'النص المدخل طويل جدا'; end if;
  if not (s.payment_methods ? v_pay) then raise exception 'طريقة الدفع غير متاحة'; end if;

  -- price + stock verification; rows locked in key order to avoid deadlocks
  for v_item in
    select (e ->> 'product_id')::uuid as pid, sum((e ->> 'qty')::numeric) as qty
    from jsonb_array_elements(p_items) e
    group by 1 order by 1
  loop
    select * into v_p from products
     where id = v_item.pid and is_active and archived_at is null for update;
    if not found then raise exception 'أحد المنتجات لم يعد متاحا'; end if;
    if v_item.qty <= 0 then raise exception 'كمية غير صحيحة'; end if;
    if v_item.qty < v_p.min_qty then
      raise exception 'الحد الأدنى للطلب من % هو %', v_p.name, v_p.min_qty;
    end if;
    if v_p.max_qty is not null and v_item.qty > v_p.max_qty then
      raise exception 'الحد الأقصى للطلب من % هو %', v_p.name, v_p.max_qty;
    end if;
    if v_item.qty > v_p.stock then
      raise exception 'الكمية المتاحة من % هي % فقط', v_p.name, v_p.stock;
    end if;
    v_disc := current_discount(v_p.id, v_p.price);
    v_subtotal := v_subtotal + v_p.price * v_item.qty;
    v_discount := v_discount + v_disc * v_item.qty;
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_p.id, 'name', v_p.name, 'unit', v_p.unit, 'image', v_p.image_url,
      'qty', v_item.qty, 'price', v_p.price, 'disc', v_disc,
      'line', round((v_p.price - v_disc) * v_item.qty, 2));
  end loop;

  if (v_subtotal - v_discount) < s.min_order_amount then
    raise exception 'الحد الأدنى للطلب هو % ج.م', s.min_order_amount;
  end if;

  if v_ful = 'delivery' then
    v_fee := case when s.free_delivery_over is not null and (v_subtotal - v_discount) >= s.free_delivery_over
                  then 0 else s.delivery_fee end;
  end if;
  v_total := round(v_subtotal - v_discount + v_fee, 2);

  v_seq := nextval('order_number_seq');
  v_num := 'ORD-' || to_char(now() at time zone 'Africa/Cairo', 'YYMMDD') || '-' || v_seq;

  begin
    insert into orders(id, order_number, user_id, idempotency_key, customer_name, customer_phone,
                       customer_email, fulfillment, address, notes, payment_method,
                       subtotal, discount_total, delivery_fee, total)
    values (v_id, v_num, auth.uid(), p_idempotency_key, v_name, v_phone, v_email, v_ful,
            case when v_ful = 'delivery' then v_addr end, v_notes, v_pay,
            round(v_subtotal, 2), round(v_discount, 2), v_fee, v_total);
  exception when unique_violation then
    select id into v_existing from orders where idempotency_key = p_idempotency_key;
    if found then return order_json(v_existing); end if;
    raise;
  end;

  perform set_config('app.skip_stock_log', 'on', true);
  for v_line in
    select * from jsonb_to_recordset(v_lines)
      as x(product_id uuid, name text, unit text, image text, qty numeric, price numeric, disc numeric, line numeric)
  loop
    insert into order_items(order_id, product_id, product_name, unit, image_url, quantity,
                            unit_price, discount_per_unit, line_total)
    values (v_id, v_line.product_id, v_line.name, v_line.unit, v_line.image, v_line.qty,
            v_line.price, v_line.disc, v_line.line);
    update products set stock = stock - v_line.qty,
                        sales_count = sales_count + ceil(v_line.qty)::int
     where id = v_line.product_id;
    insert into inventory_movements(product_id, change, reason, order_id, created_by)
    values (v_line.product_id, -v_line.qty, 'order', v_id, auth.uid());
  end loop;

  insert into invoices(order_id, invoice_number)
  values (v_id, 'INV-' || substr(v_num, 5));
  insert into order_status_history(order_id, status) values (v_id, 'pending');

  return order_json(v_id);
end $$;

-- ===== guest/customer lookup by order number + secret token =====
create or replace function get_order_public(p_order_number text, p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from orders where order_number = p_order_number and access_token = p_token;
  if not found then return null; end if;
  return order_json(v_id);
end $$;

-- ===== admin: order status/payment (staff need the 'orders' permission) =====
create or replace function admin_update_order(p_order uuid, p_status order_status default null,
                                              p_payment payment_status default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; r record;
begin
  if not (is_owner() or is_staff_perm('orders')) then raise exception 'غير مصرح'; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;

  if p_status is not null and p_status <> o.status then
    if o.status = 'canceled' then raise exception 'لا يمكن تغيير حالة طلب ملغي'; end if;
    if p_status = 'canceled' then
      perform set_config('app.skip_stock_log', 'on', true);
      for r in select product_id, quantity from order_items where order_id = o.id and product_id is not null loop
        update products set stock = stock + r.quantity,
                            sales_count = greatest(sales_count - ceil(r.quantity)::int, 0)
         where id = r.product_id;
        insert into inventory_movements(product_id, change, reason, order_id, created_by)
        values (r.product_id, r.quantity, 'order_cancel', o.id, auth.uid());
      end loop;
    end if;
    update orders set status = p_status where id = o.id;
    insert into order_status_history(order_id, status, changed_by) values (o.id, p_status, auth.uid());
  end if;
  if p_payment is not null then update orders set payment_status = p_payment where id = o.id; end if;

  insert into admin_activity_logs(actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'update_order', 'orders', o.id::text,
          jsonb_build_object('status', p_status, 'payment_status', p_payment, 'order_number', o.order_number));
  return order_json(o.id);
end $$;

-- ===== owner: staff + customer management =====
create or replace function owner_set_staff(p_user uuid, p_enabled boolean, p_permissions jsonb default '{}')
returns void
language plpgsql security definer set search_path = public as $$
declare k text; clean jsonb := '{}'::jsonb;
begin
  if not is_owner() then raise exception 'غير مصرح'; end if;
  if exists (select 1 from user_roles where user_id = p_user and role = 'owner') then
    raise exception 'لا يمكن تعديل حساب المالك';
  end if;
  -- whitelist: staff can NEVER receive product/price/category/staff-management rights
  foreach k in array array['orders','reports'] loop
    clean := clean || jsonb_build_object(k, coalesce(p_permissions ->> k, 'false') = 'true');
  end loop;
  if p_enabled then
    insert into user_roles(user_id, role, permissions, granted_by)
    values (p_user, 'staff', clean, auth.uid())
    on conflict (user_id, role) do update set permissions = excluded.permissions, granted_by = auth.uid();
  else
    delete from user_roles where user_id = p_user and role = 'staff';
  end if;
end $$;

create or replace function owner_set_blocked(p_user uuid, p_blocked boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'غير مصرح'; end if;
  if exists (select 1 from user_roles where user_id = p_user and role = 'owner') then
    raise exception 'لا يمكن حظر المالك';
  end if;
  update profiles set is_blocked = p_blocked where id = p_user;
  insert into admin_activity_logs(actor_id, action, entity, entity_id, details)
  values (auth.uid(), case when p_blocked then 'block_user' else 'unblock_user' end, 'profiles', p_user::text, null);
end $$;

-- ===== dashboard statistics =====
create or replace function admin_dashboard_stats(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare today date := (now() at time zone 'Africa/Cairo')::date;
begin
  if not (is_owner() or is_staff_perm('reports')) then raise exception 'غير مصرح'; end if;
  return jsonb_build_object(
    'total_orders', (select count(*) from orders),
    'today_orders', (select count(*) from orders where (created_at at time zone 'Africa/Cairo')::date = today),
    'today_sales', (select coalesce(sum(total), 0) from orders
                     where (created_at at time zone 'Africa/Cairo')::date = today and status <> 'canceled'),
    'pending', (select count(*) from orders where status = 'pending'),
    'completed', (select count(*) from orders where status = 'completed'),
    'canceled', (select count(*) from orders where status = 'canceled'),
    'range_orders', (select count(*) from orders
                      where (created_at at time zone 'Africa/Cairo')::date between p_from and p_to),
    'range_sales', (select coalesce(sum(total), 0) from orders
                     where status <> 'canceled'
                       and (created_at at time zone 'Africa/Cairo')::date between p_from and p_to),
    'low_stock', coalesce((select jsonb_agg(x) from (
        select id, name, stock, unit from products
         where archived_at is null and stock <= low_stock_threshold order by stock limit 20) x), '[]'),
    'best_sellers', coalesce((select jsonb_agg(x) from (
        select i.product_name as name, sum(i.quantity) as qty, sum(i.line_total) as revenue
          from order_items i join orders o on o.id = i.order_id
         where o.status <> 'canceled'
           and (o.created_at at time zone 'Africa/Cairo')::date between p_from and p_to
         group by i.product_name order by sum(i.quantity) desc limit 10) x), '[]'),
    'daily', coalesce((select jsonb_agg(x order by x.day) from (
        select (created_at at time zone 'Africa/Cairo')::date as day, count(*) as orders, sum(total) as sales
          from orders
         where status <> 'canceled'
           and (created_at at time zone 'Africa/Cairo')::date between p_from and p_to
         group by 1) x), '[]')
  );
end $$;

-- ===== execute privileges =====
revoke all on function create_order(jsonb, jsonb, text) from public;
revoke all on function get_order_public(text, uuid) from public;
revoke all on function admin_update_order(uuid, order_status, payment_status) from public;
revoke all on function owner_set_staff(uuid, boolean, jsonb) from public;
revoke all on function owner_set_blocked(uuid, boolean) from public;
revoke all on function admin_dashboard_stats(date, date) from public;
grant execute on function create_order(jsonb, jsonb, text) to anon, authenticated;
grant execute on function get_order_public(text, uuid) to anon, authenticated;
grant execute on function admin_update_order(uuid, order_status, payment_status) to authenticated;
grant execute on function owner_set_staff(uuid, boolean, jsonb) to authenticated;
grant execute on function owner_set_blocked(uuid, boolean) to authenticated;
grant execute on function admin_dashboard_stats(date, date) to authenticated;
grant execute on function is_owner() to anon, authenticated;
grant execute on function is_staff_perm(text) to anon, authenticated;
grant execute on function current_discount(uuid, numeric) to anon, authenticated;
