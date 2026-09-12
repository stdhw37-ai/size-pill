-- Supabase SQL Editor에서 실행. 브라우저는 이 테이블에 직접 접근하지 않습니다.
create table if not exists public.medicine_search_cache (
  cache_key text primary key,
  payload jsonb not null,
  expires_at timestamptz not null
);
alter table public.medicine_search_cache enable row level security;
revoke all on public.medicine_search_cache from anon, authenticated;
grant select, insert, update, delete on public.medicine_search_cache to service_role;
create index if not exists medicine_search_cache_expiry on public.medicine_search_cache(expires_at);
-- 정기 정리(선택): delete from public.medicine_search_cache where expires_at < now();
      