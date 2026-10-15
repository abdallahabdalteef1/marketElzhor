-- Run ONCE, manually, in Supabase Dashboard > SQL Editor (runs as a trusted admin; never from the website).
-- 1) The owner first signs up normally on the website (or is invited from Dashboard > Authentication > Users).
-- 2) Replace the email below with the owner's real email, then run this script.
-- The partial unique index guarantees there can only ever be ONE owner.

do $$
declare v_id uuid;
begin
  select id into v_id from auth.users where email = 'OWNER_EMAIL_HERE';
  if v_id is null then
    raise exception 'No user with that email. Sign up first, then re-run.';
  end if;
  delete from user_roles where user_id = v_id and role = 'customer';
  insert into user_roles (user_id, role) values (v_id, 'owner');
end $$;
