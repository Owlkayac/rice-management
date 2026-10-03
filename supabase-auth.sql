-- 米予約管理アプリ：ログインした「使う人」だけが読み書きできるようにする SQL
-- 実行のしかたは SUPABASE_LOGIN.md の「1. SQL を実行する」を見てください。
--
-- ・Supabase の SQL Editor に、このファイルの中身をすべて貼り付けて実行します。
-- ・テーブルの中のデータ（予約・出荷・顧客・在庫・単価）は消しません。
-- ・もう一度実行しても、同じ状態になるだけです（使う人のリストも消えません）。
-- ・一度実行してログインできているなら、ふだんはもう実行しなくて大丈夫です（中身を変えたと案内されたときだけ、もう一度実行します）。
-- ・【2段階認証の追加（2026年10月）】このとき中身を変え、2026年10月3日に実行しました（データは消えません）。
--   実行したかの確かめ方（読むだけ）：select to_regclass('public.app_security');
--   → app_security と出たら実行済みなので、もう実行しなくて大丈夫です。NULL なら、まだです。
--   初めて実行したときは、2段階認証の守り（mfa_required）は「入っていない（false）」です。守りを入れるのは、
--   使う人全員が認証アプリの登録を済ませたあとで、手順書（SUPABASE_MFA.md）の「切り替えの SQL」で行います。
--   一度 true にしたあとで、このファイルをもう一度実行しても、false には戻りません（今の値のままです）。
--   （2026年10月3日：この版を実行済みで、守りも入れました（true）。）

-- ① 使う人のリスト（ここにメールアドレスがある人だけが、データを読み書きできる）
create table if not exists public.app_members (
  email text primary key,                  -- 使う人のメールアドレス（Supabase に登録したものと同じ）
  created_at timestamptz not null default now()
);
alter table public.app_members enable row level security;

-- ② ログインしている人が、リストに入っているかを確かめる関数
--    （security definer：リストそのものは見せずに、入っているかどうかだけを答える）
create or replace function public.is_app_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_members
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke execute on function public.is_app_member() from public, anon;
grant execute on function public.is_app_member() to authenticated;

-- 使う人は、リストのうち自分の行だけを見られる（アプリが「リストに入っているか」を確かめるため）
drop policy if exists "read own member row" on public.app_members;
create policy "read own member row" on public.app_members
  for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
revoke all on public.app_members from anon, authenticated;
grant select on public.app_members to authenticated;

-- ③ 更新日時の列（2人が同じ行を同時に直したとき、あとの人の保存で前の人の変更を消さないために使う）
alter table public.reservations add column if not exists updated_at timestamptz not null default now();
alter table public.customers add column if not exists updated_at timestamptz not null default now();
alter table public.shipments add column if not exists updated_at timestamptz not null default now();
alter table public.variety_settings add column if not exists updated_at timestamptz not null default now();

-- 行を書きかえるたびに、更新日時を自動で今の時刻にする
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
drop trigger if exists touch_updated_at on public.reservations;
create trigger touch_updated_at before update on public.reservations for each row execute function public.touch_updated_at();
drop trigger if exists touch_updated_at on public.customers;
create trigger touch_updated_at before update on public.customers for each row execute function public.touch_updated_at();
drop trigger if exists touch_updated_at on public.shipments;
create trigger touch_updated_at before update on public.shipments for each row execute function public.touch_updated_at();
drop trigger if exists touch_updated_at on public.variety_settings;
create trigger touch_updated_at before update on public.variety_settings for each row execute function public.touch_updated_at();

-- ④ 2段階認証の守りの切り替え（app_security）と、守りを確かめる関数（mfa_satisfied）
--    守りを入れる（mfa_required = true）と、認証アプリのコードまで済ませたログイン（aal2）だけが、4つのテーブルを読み書きできる。
--    表は1行だけ（id は true だけ）。アプリ（anon・authenticated）からは、読むことも書くこともできない
create table if not exists public.app_security (
  id boolean primary key default true check (id),
  mfa_required boolean not null default false
);
alter table public.app_security enable row level security;
revoke all on public.app_security from anon, authenticated;
-- 行を作る（もう行があるときは何もしない。すでに true にしてある値を false に戻さない）
insert into public.app_security (id) values (true) on conflict (id) do nothing;

-- 守りを満たしているか。行が無い・値が NULL のときは「守りあり」として扱う（aal2 を求める）。
-- 守りなし（mfa_required = false）のときだけ、コードなしのログインでも true
create or replace function public.mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when (select mfa_required from public.app_security where id) is false then true
    else coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
  end;
$$;
-- 両方必要（grant が無いと、ルールを確かめるときに permission denied になり、全員が読み書きできなくなる）
revoke execute on function public.mfa_satisfied() from public, anon;
grant execute on function public.mfa_satisfied() to authenticated;

-- ⑤ 仮のルール「temp all（誰でも読み書きできる）」を消して、「使う人だけ（守りを入れたあとは、コードまで済ませた人だけ）読み書きできる」ルールに変える
--    途中でエラーが出たとき、ルールが消えただけの状態で止まらないよう、begin 〜 commit で囲む
--    （エラーが出たら、この中の変更はすべて取り消される）
begin;
drop policy if exists "temp all" on public.reservations;
drop policy if exists "temp all" on public.customers;
drop policy if exists "temp all" on public.shipments;
drop policy if exists "temp all" on public.variety_settings;

drop policy if exists "members only" on public.reservations;
drop policy if exists "members only" on public.customers;
drop policy if exists "members only" on public.shipments;
drop policy if exists "members only" on public.variety_settings;

create policy "members only" on public.reservations for all to authenticated
  using ((select public.is_app_member()) and (select public.mfa_satisfied()))
  with check ((select public.is_app_member()) and (select public.mfa_satisfied()));
create policy "members only" on public.customers for all to authenticated
  using ((select public.is_app_member()) and (select public.mfa_satisfied()))
  with check ((select public.is_app_member()) and (select public.mfa_satisfied()));
create policy "members only" on public.shipments for all to authenticated
  using ((select public.is_app_member()) and (select public.mfa_satisfied()))
  with check ((select public.is_app_member()) and (select public.mfa_satisfied()));
create policy "members only" on public.variety_settings for all to authenticated
  using ((select public.is_app_member()) and (select public.mfa_satisfied()))
  with check ((select public.is_app_member()) and (select public.mfa_satisfied()));
commit;

-- 実行したあと、各テーブルのルールが「members only」の1つだけかを確かめる（読むだけ）：
--   select tablename, policyname from pg_policies where schemaname = 'public';

-- ⑥ ログインしていない人（anon）からは、4つのテーブルを読み書きできないようにする
revoke all on public.reservations from anon;
revoke all on public.customers from anon;
revoke all on public.shipments from anon;
revoke all on public.variety_settings from anon;
grant select, insert, update, delete on public.reservations to authenticated;
grant select, insert, update, delete on public.customers to authenticated;
grant select, insert, update, delete on public.shipments to authenticated;
grant select, insert, update, delete on public.variety_settings to authenticated;
