create schema tst; grant usage on schema tst to anon, authenticated;
create function tst.fails(q text) returns text language plpgsql as $$
begin execute q; return 'NOT BLOCKED'; exception when others then return 'blocked'; end $$;
create function tst.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', coalesce(u::text,''), false) $$;
create function tst.rows_changed(q text) returns text language plpgsql as $$
declare n int; begin execute q; get diagnostics n = row_count; return case when n = 0 then 'blocked (0 rows)' else 'NOT BLOCKED ('||n||' rows)' end;
exception when others then return 'blocked (error)'; end $$;
grant execute on all functions in schema tst to anon, authenticated;

insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-0000000000a1','owner@x.com'),
 ('00000000-0000-0000-0000-0000000000b1','cust@x.com'),
 ('00000000-0000-0000-0000-0000000000c1','staff@x.com');
-- bootstrap owner (as bootstrap_owner.sql does)
delete from user_roles where user_id='00000000-0000-0000-0000-0000000000a1' and role='customer';
insert into user_roles(user_id,role) values ('00000000-0000-0000-0000-0000000000a1','owner');
select 'second owner blocked?', tst.fails($$insert into user_roles(user_id,role) values ('00000000-0000-0000-0000-0000000000b1','owner')$$);

-- owner creates products
select tst.as_user('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
insert into products(id,name,price,stock,unit,category_id) values
 ('10000000-0000-0000-0000-000000000001','سكر 1 كجم',40,10,'كيس',(select id from categories limit 1)),
 ('10000000-0000-0000-0000-000000000002','زيت 1 لتر',100,3,'زجاجة',(select id from categories limit 1));
insert into product_costs values ('10000000-0000-0000-0000-000000000001',30);
insert into offers(product_id,discount_type,discount_value) values ('10000000-0000-0000-0000-000000000002','percent',10);
update store_settings set delivery_fee=20, free_delivery_over=500, min_order_amount=50;
reset role;

-- anonymous guest orders
select tst.as_user(null); set role anon;
select 'anon sees cost?', count(*) from product_costs;
select 'anon cols', string_agg(column_name,',') filter (where column_name='cost_price') from information_schema.columns where table_name='store_products';
select 'price tamper blocked?', tst.rows_changed($$update products set price=1$$);
select 'direct order insert blocked?', tst.fails($$insert into orders(order_number,idempotency_key,customer_name,customer_phone,payment_method,subtotal,total) values ('x','k12345678','a','0100000000','x',1,1)$$);
select 'owner-func blocked?', tst.fails($$select owner_set_staff('00000000-0000-0000-0000-0000000000b1',true,'{}')$$);

select create_order(
  '[{"product_id":"10000000-0000-0000-0000-000000000001","qty":2},{"product_id":"10000000-0000-0000-0000-000000000002","qty":1},{"product_id":"10000000-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  '{"name":"أحمد","phone":"01012345678","address":"شارع الجمهورية الفيوم","payment_method":"الدفع عند الاستلام","fulfillment":"delivery","price":1}'::jsonb,
  'idem-key-0001') ->> 'total' as total_expected_230;   -- 3*40 + 90 + 20 fee
select 'idempotent same order?', (create_order('[{"product_id":"10000000-0000-0000-0000-000000000001","qty":1}]'::jsonb,'{}'::jsonb,'idem-key-0001') ->> 'order_number') = (select order_number from orders limit 1);
reset role;
select 'stock after (sugar 7, oil 2)', (select stock from products where name like 'سكر%'), (select stock from products where name like 'زيت%');
set role anon;
select 'overstock blocked?', tst.fails($$select create_order('[{"product_id":"10000000-0000-0000-0000-000000000002","qty":5}]'::jsonb,'{"name":"أحمد","phone":"01012345678","address":"شارع الجمهورية","payment_method":"الدفع عند الاستلام"}'::jsonb,'idem-key-0002')$$);
select 'below min order blocked?', tst.fails($$select create_order('[{"product_id":"10000000-0000-0000-0000-000000000001","qty":1}]'::jsonb,'{"name":"أحمد","phone":"01012345678","address":"شارع الجمهورية","payment_method":"الدفع عند الاستلام"}'::jsonb,'idem-key-0003')$$);
select 'bad payment blocked?', tst.fails($$select create_order('[{"product_id":"10000000-0000-0000-0000-000000000001","qty":2}]'::jsonb,'{"name":"أحمد","phone":"01012345678","address":"شارع الجمهورية","payment_method":"bitcoin"}'::jsonb,'idem-key-0004')$$);
select 'negative qty blocked?', tst.fails($$select create_order('[{"product_id":"10000000-0000-0000-0000-000000000001","qty":-3}]'::jsonb,'{"name":"أحمد","phone":"01012345678","address":"شارع الجمهورية","payment_method":"الدفع عند الاستلام"}'::jsonb,'idem-key-0005')$$);
select 'anon reads orders?', count(*) from orders;
select 'guest lookup w/ wrong token', get_order_public((select 'x'),gen_random_uuid());
reset role;

-- customer + staff
select tst.as_user('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select 'customer edit product blocked?', tst.rows_changed($$update products set price=1$$);
select 'customer unblock self blocked?', tst.fails($$update profiles set is_blocked=false where id=auth.uid()$$);
select 'customer self-promote blocked?', tst.fails($$insert into user_roles(user_id,role) values (auth.uid(),'owner')$$);
select 'customer owner-func blocked?', tst.fails($$select owner_set_staff(auth.uid(),true,'{}')$$);
select 'customer sees others orders?', count(*) from orders;
reset role;

select tst.as_user('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select owner_set_staff('00000000-0000-0000-0000-0000000000c1', true, '{"orders":true,"reports":false,"products":true,"prices":true}');
reset role;
select 'staff perms stored', permissions from user_roles where role='staff';

select tst.as_user('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select 'staff edit product blocked?', tst.rows_changed($$update products set price=1$$);
select 'staff insert category blocked?', tst.fails($$insert into categories(name) values ('x')$$);
select 'staff sees orders?', count(*) from orders;
select 'staff stats blocked (no reports)?', tst.fails($$select admin_dashboard_stats(current_date-7,current_date)$$);
select 'staff set staff blocked?', tst.fails($$select owner_set_staff(auth.uid(),true,'{}')$$);
select 'staff logs blocked?', count(*) from admin_activity_logs;
select 'staff cancel order ok', admin_update_order((select id from orders limit 1),'canceled') ->> 'status';
reset role;
select 'stock restored (10,3)', (select stock from products where name like 'سكر%'), (select stock from products where name like 'زيت%');
select tst.as_user('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select 'uncancel blocked?', tst.fails($$select admin_update_order((select id from orders limit 1),'pending')$$);
reset role;

select tst.as_user('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select 'owner stats', admin_dashboard_stats(current_date-7,current_date) ->> 'canceled' as canceled, jsonb_array_length(admin_dashboard_stats(current_date-7,current_date)->'low_stock') low;
select 'owner sees logs', count(*)>0 from admin_activity_logs;
select 'movement rows', count(*) from inventory_movements;
reset role;
select 'order snapshot kept after product change', (select unit_price from order_items where product_name like 'زيت%');
