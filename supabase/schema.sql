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

-- 회원 프로필: 로그인(Google/Kakao 등, Supabase Auth) 후 처방 용량 분석에 쓰이는 최소 정보만 저장한다.
-- 나이 자체는 저장하지 않는다 - birth_date만 저장하고 나이는 매번 현재 날짜 기준으로 계산한다(앱 쪽
-- public/auth.js의 ageYearsFromBirthDate). 브라우저는 여기 직접 접근하지 않고 anon/publishable 키 +
-- 로그인한 사용자 자신의 access token으로만 PostgREST를 통해 접근하며, RLS가 본인 행만 허용한다.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  birth_date date,
  sex text check (sex in ('male', 'female', 'prefer_not_to_say')),
  weight_kg numeric check (weight_kg is null or (weight_kg > 0 and weight_kg <= 500)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;
-- service_role은 RLS를 우회하지만(관리 작업용) 프런트엔드는 절대 service_role을 쓰지 않는다.
drop policy if exists "select own profile" on public.profiles;
create policy "select own profile" on public.profiles for select using (auth.uid() = user_id);
drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles for insert with check (auth.uid() = user_id);
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();

-- 처방전 분석 결과 저장: 로그인한 사용자가 "처방전 저장" 버튼을 눌렀을 때만 저장된다(자동 저장 없음 -
-- 기존 내 약 보관함과 동일한 원칙). 원본 처방전 이미지와 OCR 전체 문장은 저장하지 않는다 - 항목별로
-- 이미 화면에 보이는 최소 구조화 필드(약 이름/1회량/단위/횟수/일수, 선택한 공식 품목기준코드)만 저장한다.
-- 다시 열 때는 이 행들 + item_seq로 기존 /api/medicines·/api/liquids(캐시 포함)를 다시 조회해 최신
-- 공식 정보를 복원한다 - Google Vision OCR은 다시 호출하지 않는다(앱 쪽 public/prescriptions.js 참고).
create table if not exists public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text,
  created_at timestamptz not null default now()
);
alter table public.prescriptions enable row level security;
revoke all on public.prescriptions from anon;
grant select, insert, delete on public.prescriptions to authenticated;
drop policy if exists "select own prescriptions" on public.prescriptions;
create policy "select own prescriptions" on public.prescriptions for select using (auth.uid() = user_id);
drop policy if exists "insert own prescriptions" on public.prescriptions;
create policy "insert own prescriptions" on public.prescriptions for insert with check (auth.uid() = user_id);
drop policy if exists "delete own prescriptions" on public.prescriptions;
create policy "delete own prescriptions" on public.prescriptions for delete using (auth.uid() = user_id);
create index if not exists prescriptions_user_created on public.prescriptions(user_id, created_at desc);

create table if not exists public.prescription_items (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references public.prescriptions(id) on delete cascade,
  position integer not null default 0,
  raw_name text,
  drug_name text not null,
  item_seq text,
  kind text check (kind in ('pill', 'liquid')),
  dose_amount numeric,
  dose_unit text,
  frequency_per_day numeric,
  duration_days numeric,
  needs_review boolean not null default false
);
alter table public.prescription_items enable row level security;
revoke all on public.prescription_items from anon;
grant select, insert, delete on public.prescription_items to authenticated;
-- prescription_items 자신에는 user_id가 없다 - 부모 prescriptions 행의 소유자인지 매 행마다 확인한다.
drop policy if exists "select own prescription items" on public.prescription_items;
create policy "select own prescription items" on public.prescription_items for select
  using (exists (select 1 from public.prescriptions p where p.id = prescription_id and p.user_id = auth.uid()));
drop policy if exists "insert own prescription items" on public.prescription_items;
create policy "insert own prescription items" on public.prescription_items for insert
  with check (exists (select 1 from public.prescriptions p where p.id = prescription_id and p.user_id = auth.uid()));
drop policy if exists "delete own prescription items" on public.prescription_items;
create policy "delete own prescription items" on public.prescription_items for delete
  using (exists (select 1 from public.prescriptions p where p.id = prescription_id and p.user_id = auth.uid()));
create index if not exists prescription_items_prescription on public.prescription_items(prescription_id, position);
