-- Auto-create a profile row whenever a new auth user signs up.
-- Reads username from the metadata passed during signUp().
-- Runs as SECURITY DEFINER so RLS doesn't block the insert.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, chip_balance)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'Player_' || substr(new.id::text, 1, 6)),
    1000
  );
  return new;
end;
$$;

-- Drop the trigger first in case you're re-running this
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
