-- 001_schema.sql : core tables, constraints, indexes
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ===== enums =====
create type app_role as enum ('owner','staff','customer');
create type order_status as enum ('pending','confirmed','preparing','out_for_delivery','completed','canceled');
create type payment_status as enum ('unpaid','paid','refunded');
create type fulfillment_type as enum ('delivery','pickup');

-- ===== helpers =====
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ===== profiles / roles =====
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  email text,
  is_blocked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role app_role not null,
  -- explicit staff permissions, e.g. {"orders":true,"view_reports":false}
  permissions jsonb not null default '{}'::jsonb,
  granted_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);
-- only one owner may exist
create unique index one_owner_only on user_roles (role) where role = 'owner';

-- ===== catalog =====
create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  image_url text,
  icon text,
  sort_order int not null default 0,
  is_visible boolean not null default true,
  show_on_home boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table brands (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  logo_url text,
  show_on_home boolean not null default false,
  created_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  description text,
  category_id uuid references categories(id) on delete restrict,
  brand_id uuid references brands(id) on delete set null,
  price numeric(10,2) not null check (price >= 0),
  old_price numeric(10,2) check (old_price >= 0),
  unit text not null default 'قطعة',
  stock numeric(10,2) not null default 0 check (stock >= 0),
  low_stock_threshold numeric(10,2) not null default 5,
  sku text unique,
  barcode text unique,
  image_url text,
  is_active boolean not null default true,
  is_featured boolean not null default false,
  is_new boolean not null default false,
  min_qty numeric(10,2) not null default 1 check (min_qty > 0),
  max_qty numeric(10,2) check (max_qty is null or max_qty >= min_qty),
  sales_count int not null default 0,
  archived_at timestamptz,                                    -- soft delete
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_category_idx on products(category_id) where archived_at is null;
create index products_name_trgm on products using gin (name gin_trgm_ops);
create index products_active_idx on products(is_active, archived_at);

-- purchase cost lives in its own owner-only table so it can never leak through public reads
create table product_costs (
  product_id uuid primary key references products(id) on delete cascade,
  cost_price numeric(10,2) not null check (cost_price >= 0)
);

create table product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  url text not null,
  sort_order int not null default 0
);
create index product_images_product_idx on product_images(product_id);

create table offers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  discount_type text not null check (discount_type in ('percent','fixed')),
  discount_value numeric(10,2) not null check (discount_value > 0),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at),
  check (discount_type <> 'percent' or discount_value <= 100)
);
create index offers_product_idx on offers(product_id, is_active);

create table inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete restrict,
  change numeric(10,2) not null,
  reason text not null check (reason in ('order','order_cancel','restock','adjustment','initial')),
  order_id uuid,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index inv_mov_product_idx on inventory_movements(product_id, created_at desc);

-- ===== store config =====
create table store_settings (
  id int primary key default 1 check (id = 1),               -- single row
  store_name text not null default 'ماركت الواحة',
  logo_url text,
  primary_color text not null default '#1f7a3f',
  accent_color text not null default '#f2a900',
  phone text default '+20 10 08927372',
  whatsapp_number text not null default '201008927372',
  email text,
  address text,
  announcement text,
  delivery_fee numeric(10,2) not null default 20 check (delivery_fee >= 0),
  free_delivery_over numeric(10,2),
  min_order_amount numeric(10,2) not null default 0,
  payment_methods jsonb not null default '["الدفع عند الاستلام","الدفع عند الاستلام من الفرع"]',
  store_hours text,
  policies text,
  delivery_info text,
  social_links jsonb not null default '{}'::jsonb,
  show_brands boolean not null default true,
  -- owner switches this on ONLY after WhatsApp Cloud API secrets are configured (see docs/SETUP.md)
  whatsapp_api_enabled boolean not null default false,
  show_offers boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into store_settings(id) values (1);

create table homepage_banners (
  id uuid primary key default gen_random_uuid(),
  title text,
  subtitle text,
  image_url text not null,
  link_url text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ===== customers / orders =====
create table customer_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text,
  address text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create sequence order_number_seq start 1001;

create table orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  user_id uuid references auth.users(id) on delete set null,
  idempotency_key text not null unique,                       -- prevents duplicate orders
  access_token uuid not null default gen_random_uuid(),       -- lets a guest view only their own order
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  fulfillment fulfillment_type not null default 'delivery',
  address text,
  notes text,
  payment_method text not null,
  payment_status payment_status not null default 'unpaid',
  status order_status not null default 'pending',
  subtotal numeric(10,2) not null,
  discount_total numeric(10,2) not null default 0,
  delivery_fee numeric(10,2) not null default 0,
  total numeric(10,2) not null,
  whatsapp_api_status text not null default 'not_sent' check (whatsapp_api_status in ('not_sent','sent','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_user_idx on orders(user_id, created_at desc);
create index orders_status_idx on orders(status, created_at desc);
create index orders_phone_idx on orders(customer_phone);

create table order_items (                                    -- immutable snapshot
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  product_name text not null,
  unit text not null,
  image_url text,
  quantity numeric(10,2) not null check (quantity > 0),
  unit_price numeric(10,2) not null,
  discount_per_unit numeric(10,2) not null default 0,
  line_total numeric(10,2) not null
);
create index order_items_order_idx on order_items(order_id);

create table order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  status order_status not null,
  changed_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders(id) on delete restrict,
  invoice_number text not null unique,
  issued_at timestamptz not null default now()
);

create table admin_activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id),
  action text not null,
  entity text,
  entity_id text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index activity_created_idx on admin_activity_logs(created_at desc);

-- updated_at triggers
create trigger t_profiles_u before update on profiles for each row execute function set_updated_at();
create trigger t_categories_u before update on categories for each row execute function set_updated_at();
create trigger t_products_u before update on products for each row execute function set_updated_at();
create trigger t_orders_u before update on orders for each row execute function set_updated_at();
create trigger t_settings_u before update on store_settings for each row execute function set_updated_at();
