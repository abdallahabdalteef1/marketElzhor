-- 003_rls.sql : Row Level Security. Default = deny; every allowance is explicit.

alter table profiles enable row level security;
alter table user_roles enable row level security;
alter table categories enable row level security;
alter table brands enable row level security;
alter table products enable row level security;
alter table product_costs enable row level security;
alter table product_images enable row level security;
alter table offers enable row level security;
alter table inventory_movements enable row level security;
alter table store_settings enable row level security;
alter table homepage_banners enable row level security;
alter table customer_addresses enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table order_status_history enable row level security;
alter table invoices enable row level security;
alter table admin_activity_logs enable row level security;

-- ----- profiles -----
create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or is_owner());
create policy profiles_update_own on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- customers may edit only these columns (cannot unblock themselves)
revoke update on profiles from authenticated, anon;
grant update (full_name, phone, email) on profiles to authenticated;
revoke insert, delete on profiles from authenticated, anon;

-- ----- user_roles: read-only for clients; all writes go through owner_set_staff -----
create policy roles_select on user_roles for select to authenticated
  using (user_id = auth.uid() or is_owner());
revoke insert, update, delete on user_roles from authenticated, anon;

-- ----- catalog: public read, OWNER-only write -----
create policy categories_read on categories for select to anon, authenticated
  using (is_visible or is_owner());
create policy categories_owner_write on categories for all to authenticated
  using (is_owner()) with check (is_owner());

create policy brands_read on brands for select to anon, authenticated using (true);
create policy brands_owner_write on brands for all to authenticated
  using (is_owner()) with check (is_owner());

create policy products_read on products for select to anon, authenticated
  using ((is_active and archived_at is null) or is_owner());
create policy products_owner_write on products for all to authenticated
  using (is_owner()) with check (is_owner());

create policy costs_owner on product_costs for all to authenticated
  using (is_owner()) with check (is_owner());

create policy images_read on product_images for select to anon, authenticated using (true);
create policy images_owner_write on product_images for all to authenticated
  using (is_owner()) with check (is_owner());

create policy offers_read on offers for select to anon, authenticated
  using ((is_active and starts_at <= now() and (ends_at is null or ends_at > now())) or is_owner());
create policy offers_owner_write on offers for all to authenticated
  using (is_owner()) with check (is_owner());

create policy inv_owner_read on inventory_movements for select to authenticated using (is_owner());
-- no write policies: movements are written only by trusted triggers/functions

-- ----- store config -----
create policy settings_read on store_settings for select to anon, authenticated using (true);
create policy settings_owner_update on store_settings for update to authenticated
  using (is_owner()) with check (is_owner());

create policy banners_read on homepage_banners for select to anon, authenticated
  using (is_active or is_owner());
create policy banners_owner_write on homepage_banners for all to authenticated
  using (is_owner()) with check (is_owner());

-- ----- customer addresses -----
create policy addr_own on customer_addresses for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----- orders: no client insert/update/delete at all (RPCs only) -----
create policy orders_read on orders for select to authenticated
  using (user_id = auth.uid() or is_owner() or is_staff_perm('orders'));
create policy order_items_read on order_items for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id));
create policy order_history_read on order_status_history for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id));
create policy invoices_read on invoices for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id));

-- ----- logs -----
create policy logs_owner_read on admin_activity_logs for select to authenticated using (is_owner());

-- ----- storage bucket for logos, banners, product and category images -----
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 3145728, array['image/jpeg','image/png','image/webp','image/svg+xml'])
on conflict (id) do nothing;

create policy media_public_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'media');
create policy media_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and is_owner());
create policy media_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and is_owner());
create policy media_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and is_owner());
