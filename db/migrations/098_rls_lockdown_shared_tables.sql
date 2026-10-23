-- Migration 098 — close the permissive 023/066 RLS baseline on the SHARED tables.
-- =========================================================================
-- 023 and 066 gave each table a `for all using (true) with check (true)` policy that applies
-- to EVERY Postgres role. 085 replaced it on the per-tenant tables; on the SHARED tables it is
-- still in place, so anyone holding the anon (publishable) key — or any authenticated JWT —
-- can read the bcrypt password hashes in `users`, list the emails in password_reset_requests,
-- and rewrite donor intel, the source catalogue and the app config. Three later tables were
-- created with no RLS at all (scan_blacklist 024, tenant_settings 075, user_password_tokens
-- 093), which under Supabase's default grants leaves them just as open.
--
-- AFTER THIS MIGRATION
--   SERVICE-ONLY — anon and authenticated: no grants, no policies (denied)
--     users · password_reset_requests · user_password_tokens · app_settings · tenant_settings
--   READ-ONLY for authenticated — anon: nothing; writes only through the service role
--     donor_intel · donor_sources · donor_source_seeds · source_registry ·
--     extracted_solicitations · scan_logs · scan_blacklist
--   login_logs (084) — the open `insert with check (true)` policy is dropped (the app already
--     records logins on the service client). A user still reads their OWN rows (login_logs_sel).
--
-- NOT TOUCHED: the 085 tenant-scoped tables (rfp_submissions, meeting_logs, meeting_schedule,
--   engagement_logs, applied_funding, narrative_logs, scan_decisions, donor_contacts,
--   rfp_seen), tenants / tenant_memberships (085), resource_suggestions (080).
--
-- PRECONDITIONS
--   1. The matching code is deployed FIRST: db/supabase_client.py routes _SERVICE_ONLY_TABLES
--      and the writes to _SERVICE_WRITE_TABLES to the service client, and auth/authenticator.py
--      uses service_client(). Before that code, a logged-in session reads `users` and writes
--      the shared tables through its tenant JWT (role=authenticated), so this migration would
--      lock users out at the credential check and break every admin edit and scan log.
--   2. SUPABASE_KEY is the SERVICE-ROLE key in EVERY runtime that talks to the database:
--        * the deployed Streamlit app — Settings → Accounts → Deployment shows the key kind
--          (or run `python scripts/env_report.py` with the deployed secrets);
--        * the GitHub Actions secret SUPABASE_KEY used by scan.yml and backup.yml (scan.yml's
--          header still allows an anon key there — after this, an anon key cannot log a scan);
--        * local .env (.env.example already says service-role).
--      Any runtime left on the anon key can no longer log anyone in.
--   3. SNAPSHOT the live policies and grants first. The live database may not match the repo:
--      views/account_sections.py notes that an authenticated UPDATE on `users` is "silently
--      blocked", which the permissive 023 policy cannot do, so some policy was likely changed
--      in the dashboard. This migration drops every policy on these tables, and the ROLLBACK
--      below restores only the 023/066 baseline. Save the output of the two VERIFY queries
--      at the bottom (run them BEFORE applying) so an exact restore is possible.
--
-- SAFE TO RE-RUN: every policy on each listed table is dropped and the intended ones are
-- recreated; enable-rls, revoke and grant are idempotent. Tables absent here are skipped.
-- =========================================================================

begin;

-- ── 1) The shared tables — drop the baseline, revoke anon/authenticated, re-grant reads ──────
do $$
declare
  _t   text;
  _pol record;
  -- Must mirror db.supabase_client._SERVICE_ONLY_TABLES.
  _service_only text[] := array[
    'users','password_reset_requests','user_password_tokens','app_settings','tenant_settings'];
  -- Must mirror db.supabase_client._SERVICE_WRITE_TABLES.
  _read_only text[] := array[
    'donor_intel','donor_sources','donor_source_seeds','source_registry',
    'extracted_solicitations','scan_logs','scan_blacklist'];
begin
  foreach _t in array _service_only || _read_only loop
    if to_regclass('public.' || _t) is null then
      raise notice 'skip (absent): %', _t;
      continue;
    end if;

    -- replace ALL existing policies (the 023/066 baseline, the 042/043 rebuilds, any added
    -- by hand in the dashboard) so what's left is exactly what this file says
    for _pol in
      select policyname from pg_policies where schemaname = 'public' and tablename = _t
    loop
      execute format('drop policy if exists %I on public.%I', _pol.policyname, _t);
    end loop;

    execute format('alter table public.%I enable row level security', _t);
    execute format('revoke all on public.%I from anon, authenticated', _t);
    execute format('grant all on public.%I to service_role', _t);

    if _t = any(_read_only) then
      execute format('grant select on public.%I to authenticated', _t);
      execute format('create policy %I on public.%I for select to authenticated using (true)',
                     _t || '_read', _t);
      raise notice 'locked: % (authenticated read, service-role write)', _t;
    else
      raise notice 'locked: % (service role only)', _t;
    end if;
  end loop;
end $$;

-- ── 2) login_logs — no more anonymous inserts; own-row reads stay ───────────────────────────
do $$
begin
  if to_regclass('public.login_logs') is null then
    raise notice 'skip (absent): login_logs';
    return;
  end if;
  drop policy if exists login_logs_ins on public.login_logs;
  revoke all on public.login_logs from anon, authenticated;
  grant select on public.login_logs to authenticated;
  grant all on public.login_logs to service_role;
  raise notice 'locked: login_logs (own-row read, service-role write)';
end $$;

commit;

-- =========================================================================
-- VERIFY — expect: no anon rows at all; authenticated holds SELECT on the read-only tables
-- and login_logs only; one `<table>_read` policy per read-only table, plus login_logs_sel.
--   select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type)
--   from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon', 'authenticated')
--     and table_name in ('users','password_reset_requests','user_password_tokens',
--       'app_settings','tenant_settings','donor_intel','donor_sources','donor_source_seeds',
--       'source_registry','extracted_solicitations','scan_logs','scan_blacklist','login_logs')
--   group by 1, 2 order by 1, 2;
--
--   select tablename, policyname, roles, cmd from pg_policies
--   where schemaname = 'public'
--     and tablename in ('users','password_reset_requests','user_password_tokens',
--       'app_settings','tenant_settings','donor_intel','donor_sources','donor_source_seeds',
--       'source_registry','extracted_solicitations','scan_logs','scan_blacklist','login_logs')
--   order by 1, 2;
--
-- Then sign in to the deployed app as a regular user and as an admin, open Admin → Users and
-- Settings, and edit one donor. A failure shows as "permission denied for table …" (42501).
-- =========================================================================

-- =========================================================================
-- ROLLBACK — restore the permissive 023/066 baseline (open to every role) instantly:
--   begin;
--   do $$ declare _t text; _pol record;
--     _tables text[] := array['users','password_reset_requests','user_password_tokens',
--       'app_settings','tenant_settings','donor_intel','donor_sources','donor_source_seeds',
--       'source_registry','extracted_solicitations','scan_logs','scan_blacklist'];
--   begin foreach _t in array _tables loop
--     if to_regclass('public.'||_t) is null then continue; end if;
--     for _pol in select policyname from pg_policies where schemaname='public' and tablename=_t loop
--       execute format('drop policy if exists %I on public.%I', _pol.policyname, _t); end loop;
--     execute format('grant all on public.%I to anon, authenticated', _t);
--     execute format('create policy %I on public.%I for all using (true) with check (true)',
--                    _t||'_rfpis_baseline', _t);
--   end loop; end $$;
--   do $$ begin if to_regclass('public.login_logs') is not null then
--     drop policy if exists login_logs_ins on login_logs;
--     create policy login_logs_ins on login_logs for insert with check (true);
--     grant select, insert on login_logs to anon, authenticated;
--   end if; end $$;
--   commit;
-- This restores the REPO's baseline. If the pre-apply snapshot (precondition 3) shows other
-- policies, recreate those from the snapshot instead. scan_blacklist, tenant_settings and
-- user_password_tokens had no RLS before; the permissive policy has the same effect. The
-- code changes need no revert: the service role reaches these tables with or without 098.
-- =========================================================================
