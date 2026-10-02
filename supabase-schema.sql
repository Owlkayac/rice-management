-- 米予約管理アプリ：Supabase のテーブルを作る SQL
-- 実行のしかたは SUPABASE_SWITCH.md の「1. テーブルを作る」を見てください。
--
-- ・Supabase の SQL Editor に、このファイルの中身をすべて貼り付けて、1回だけ実行します。
-- ・まだデータが入っていないときだけ、4つのテーブルを空の状態で作り直します。
-- ・【大事】ログイン機能（supabase-auth.sql）を入れたあとは、このファイルを実行しないでください。
--   データが消えるうえ、ルールが「誰でも読み書きできる」に戻ります。
-- ・行ごとのアクセス制限（RLS）は、ログイン機能を付けるまでの仮の設定で「誰でも読み書きできる」です。
--   この間は、実際のお客様のデータを入れないでください。
-- ・ログイン機能を入れたあと、またはデータ（予約・顧客・出荷、0 でない在庫・単価）が入っているときは、
--   何も変えずにエラーで止まります（下の ⓪）。

begin;

-- ⓪ 安全のための確認：ログイン機能やセキュリティの SQL を入れたあと、またはデータが入っているときは、
--    何も消さずにここで止める（間違えて実行しても、データと守りを失わないため）
do $$
declare
  t text;
  has_rows boolean;
begin
  -- ログイン機能（supabase-auth.sql）やセキュリティ（supabase-hardening.sql）を入れた印が、1つでもあれば止める
  if to_regclass('public.app_members') is not null
     or to_regclass('public.audit_log') is not null
     or to_regprocedure('public.is_app_member()') is not null
     or exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'members only') then
    raise exception 'このファイルは実行できません。ログイン機能を入れたあとに実行すると、データが消え、ルールが「誰でも読み書きできる」に戻るためです。何も変わっていません。歩留まりの列を足すときは supabase-yield.sql を実行してください。';
  end if;
  foreach t in array array['reservations', 'customers', 'shipments'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select exists (select 1 from public.%I)', t) into has_rows;
      if has_rows then
        raise exception 'このファイルは実行できません。テーブル % にデータが入っていて、実行すると消えてしまうためです。何も変わっていません。', t;
      end if;
    end if;
  end loop;
  -- 在庫・単価は、A〜F の6行が必ずあるため、0 でない値が入っているかで確かめる
  if to_regclass('public.variety_settings') is not null then
    execute 'select exists (select 1 from public.variety_settings where stock_kg <> 0 or price <> 0)' into has_rows;
    if has_rows then
      raise exception 'このファイルは実行できません。在庫・単価に値が入っていて、実行すると消えてしまうためです。何も変わっていません。';
    end if;
  end if;
end
$$;

-- ① 前のテーブルを消す（接続テストで作った reservations も、ここで消えます）
drop table if exists public.reservations;
drop table if exists public.customers;
drop table if exists public.shipments;
drop table if exists public.variety_settings;

-- ② 予約
create table public.reservations (
  id text primary key,                     -- 予約の番号（アプリが「reservation-…」の形で付ける）
  name text,                               -- 名前
  customer_id text,                        -- 顧客の番号（顧客を選ばなかった古い予約は空）
  variety text,                            -- 品種（A〜F）
  month text,                              -- 月（「1月」〜「12月」）
  amount_kg numeric,                       -- 予約の量（kg。小数も入る）
  channel text,                            -- 申込経路
  status text default 'received',          -- 状態（received：受付済み / preparing：出荷準備中 / shipped：出荷済み）
  created_at timestamptz not null default now()  -- 登録した日時（一覧の並び順に使う）
);

-- ③ 顧客
create table public.customers (
  id text primary key,                     -- 顧客の番号（アプリが「customer-…」の形で付ける）
  name text,                               -- 名前
  furigana text,                           -- ふりがな
  phone text,                              -- 電話番号
  address text,                            -- 住所
  memo text,                               -- メモ
  created_at timestamptz not null default now()
);

-- ④ 出荷
create table public.shipments (
  id text primary key,                     -- 出荷の番号（アプリが「shipment-…」の形で付ける）
  reservation_id text,                     -- 紐づけた予約の番号（紐づけないときは空）
  customer_id text,                        -- 顧客の番号
  name text,                               -- 名前
  variety text,                            -- 品種
  ship_date text,                          -- 出荷日（「2026-10-01」の形の文字）
  amount_kg numeric,                       -- 出荷した量（kg）
  memo text,                               -- メモ
  created_at timestamptz not null default now()
);

-- ⑤ 品種ごとの在庫・単価・歩留まり（A〜F の1品種につき1行）
create table public.variety_settings (
  variety text primary key,                -- 品種（A〜F）
  stock_kg numeric not null default 0,     -- 在庫（kg・精米する前の量）
  price numeric not null default 0,        -- 1kg あたりの単価（円）
  yield_percent numeric not null default 90, -- 歩留まり（%）。出荷できる量 ＝ 在庫 × 歩留まり
  constraint variety_settings_yield check (yield_percent >= 50 and yield_percent <= 100)
);

-- 品種 A〜F の行を、在庫0・単価0で先に作っておく
insert into public.variety_settings (variety) values ('A'), ('B'), ('C'), ('D'), ('E'), ('F');

-- ⑥ 行ごとのアクセス制限（RLS）を有効にして、仮の「全部許可」のルールを付ける
--    ※ ログイン機能を付けるときに、このルールを作り直します
alter table public.reservations enable row level security;
alter table public.customers enable row level security;
alter table public.shipments enable row level security;
alter table public.variety_settings enable row level security;

create policy "temp all" on public.reservations for all to anon, authenticated using (true) with check (true);
create policy "temp all" on public.customers for all to anon, authenticated using (true) with check (true);
create policy "temp all" on public.shipments for all to anon, authenticated using (true) with check (true);
create policy "temp all" on public.variety_settings for all to anon, authenticated using (true) with check (true);

-- ⑦ アプリ（Publishable key）から、4つのテーブルを読み書きできるようにする
grant select, insert, update, delete on public.reservations to anon, authenticated;
grant select, insert, update, delete on public.customers to anon, authenticated;
grant select, insert, update, delete on public.shipments to anon, authenticated;
grant select, insert, update, delete on public.variety_settings to anon, authenticated;

commit;
