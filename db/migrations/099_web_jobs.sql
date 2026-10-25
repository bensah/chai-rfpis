-- Migration 099 — background jobs for the React app.
-- =========================================================================
-- Work that cannot run inside the Supabase Edge Function (scans, PDF rendering, backups,
-- Excel sync) runs on GitHub Actions. The API records each request here, dispatches
-- .github/workflows/web-job.yml with the row's id, and scripts/run_web_job.py writes
-- status, progress and the result back. The browser polls the row through the API.
--
-- SERVICE ROLE ONLY, like the tables migration 098 closed: the API and the runner both use
-- the service key, and a job's message can hold error text that is for the API to filter.
-- anon and authenticated get no grants and no policies.
--
-- A private Storage bucket, web-job-files, holds files a job produces (backup ZIPs, report
-- PDFs). The API hands out short-lived signed URLs after its own permission check.
-- =========================================================================

begin;

create table if not exists public.web_jobs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  params      jsonb not null default '{}'::jsonb,
  status      text not null default 'queued'
              check (status in ('queued', 'dispatched', 'running', 'done', 'failed', 'cancelled')),
  progress    jsonb,                    -- {pct, message}
  message     text,                     -- failure detail, read by the API only
  result      jsonb,
  tenant_id   uuid references public.tenants(id) on delete set null,
  created_by  uuid references public.users(id) on delete set null,
  run_url     text,                     -- the Actions run, for a super_user to follow
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);

create index if not exists web_jobs_tenant_created on public.web_jobs (tenant_id, created_at desc);
create index if not exists web_jobs_kind_status on public.web_jobs (kind, status);

alter table public.web_jobs enable row level security;
revoke all on public.web_jobs from anon, authenticated;
grant all on public.web_jobs to service_role;

insert into storage.buckets (id, name, public)
values ('web-job-files', 'web-job-files', false)
on conflict (id) do nothing;

commit;

-- VERIFY:
--   select grantee, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'web_jobs' and grantee in ('anon', 'authenticated');
--   -- expect no rows
--   select id, public from storage.buckets where id = 'web-job-files';   -- expect public = false
--
-- ROLLBACK:
--   drop table if exists public.web_jobs;
--   delete from storage.buckets where id = 'web-job-files';   -- only while it is empty
