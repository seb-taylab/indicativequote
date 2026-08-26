-- =====================================================================
-- 0010  Repair: register_currency took smallint
--
-- 0009 originally declared p_minor_units as `smallint`. A caller passing the
-- literal 2 sends an `integer`, and Postgres will not implicitly narrow it
-- during function resolution, so EVERY call failed with
--   "function public.register_currency(unknown, unknown, unknown, integer)
--    does not exist"
-- which reads like a missing deployment rather than a type mismatch.
--
-- 0009's file now declares `integer` directly, so a fresh database is correct
-- after 0009 alone. This migration exists to repair databases that already
-- applied the earlier form, and is a no-op elsewhere.
--
-- Rule this establishes: every parameter on the RPC boundary takes the widest
-- natural type and narrows inside.
-- =====================================================================

drop function if exists public.register_currency(text, text, text, smallint);

create or replace function public.register_currency(
  p_code text, p_name text, p_kind text, p_minor_units integer default 2
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a app.actor_t; v_code text;
begin
  a := app.require_staff(array['backbone_admin']);
  v_code := upper(trim(p_code));
  if p_kind not in ('fiat','stablecoin') then
    raise exception 'kind must be fiat or stablecoin' using errcode = '22023';
  end if;
  insert into public.currencies (code, name, kind, minor_units)
  values (v_code, p_name, p_kind, p_minor_units::smallint)
  on conflict (code) do nothing;
  if not found then
    raise exception 'currency % already registered', v_code using errcode = '23505';
  end if;
  perform app.audit(a, 'registry.add_currency', 'currency', v_code, null,
                    jsonb_build_object('code', v_code, 'kind', p_kind));
  return jsonb_build_object('code', v_code);
end $$;

grant execute on function public.register_currency(text, text, text, integer) to authenticated;
