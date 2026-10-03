-- 米予約管理アプリ：データベースの守りを強くする SQL（入れてよい値の決まりと、変更の記録を足す）
-- 実行のしかたは SECURITY.md の「1. SQL を実行する」を見てください。
--
-- ・データは消しません。もう一度実行しても、同じ状態になるだけです。
-- ・一度実行して「Success」と出ていれば、ふだんはもう実行しなくて大丈夫です（中身を変えたと案内されたときだけ、もう一度実行します）。
-- ・今入っているデータが決まりに合わないときは、エラーになり、何も変わりません（そのときは、エラーの画面を送ってください）。
-- ・アプリの画面からふつうに入れた値は、すべてこの決まりに合います。

begin;

-- ① 番号（id）は、英数字・「_」「-」だけ、100文字まで（アプリが付ける番号と同じ形）
alter table public.reservations drop constraint if exists reservations_id_format;
alter table public.reservations add constraint reservations_id_format check (id ~ '^[A-Za-z0-9_-]{1,100}$');
alter table public.customers drop constraint if exists customers_id_format;
alter table public.customers add constraint customers_id_format check (id ~ '^[A-Za-z0-9_-]{1,100}$');
alter table public.shipments drop constraint if exists shipments_id_format;
alter table public.shipments add constraint shipments_id_format check (id ~ '^[A-Za-z0-9_-]{1,100}$');

-- ② 予約：量は0以上、状態は3種類のどれか（または空）、文字の長さに上限
alter table public.reservations drop constraint if exists reservations_values;
alter table public.reservations add constraint reservations_values check (
  (amount_kg is null or (amount_kg >= 0 and amount_kg <= 1000000))
  and (status is null or status in ('received', 'preparing', 'shipped'))
  and coalesce(length(name), 0) <= 200
  and coalesce(length(customer_id), 0) <= 100
  and coalesce(length(variety), 0) <= 20
  and coalesce(length(month), 0) <= 10
  and coalesce(length(channel), 0) <= 50
);

-- ③ 顧客：文字の長さに上限
alter table public.customers drop constraint if exists customers_values;
alter table public.customers add constraint customers_values check (
  coalesce(length(name), 0) <= 200
  and coalesce(length(furigana), 0) <= 200
  and coalesce(length(phone), 0) <= 50
  and coalesce(length(address), 0) <= 1000
  and coalesce(length(memo), 0) <= 5000
);

-- ④ 出荷：量は0以上、文字の長さに上限
alter table public.shipments drop constraint if exists shipments_values;
alter table public.shipments add constraint shipments_values check (
  (amount_kg is null or (amount_kg >= 0 and amount_kg <= 1000000))
  and coalesce(length(reservation_id), 0) <= 100
  and coalesce(length(customer_id), 0) <= 100
  and coalesce(length(name), 0) <= 200
  and coalesce(length(variety), 0) <= 20
  and coalesce(length(ship_date), 0) <= 20
  and coalesce(length(memo), 0) <= 5000
);

-- ⑤ 在庫・単価：0以上
alter table public.variety_settings drop constraint if exists variety_settings_values;
alter table public.variety_settings add constraint variety_settings_values check (
  stock_kg >= 0 and stock_kg <= 100000000
  and price >= 0 and price <= 100000000
  and length(variety) <= 20
);

-- ⑥ 使う人のリスト：メールアドレスの長さに上限
alter table public.app_members drop constraint if exists app_members_email_length;
alter table public.app_members add constraint app_members_email_length check (length(email) <= 320);

-- ⑦ 変更の記録（誰が・いつ・どの行を・どう変えたか）を残す表
--    使う人のパスワードが漏れて、データを消されたり書きかえられたりしたときに、元の内容を探す手がかりにする。
--    アプリからは読めず、書きかえることもできない（Supabase の画面の Table Editor だけで見られる）
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),   -- 変えた日時
  changed_by text,                                  -- 変えた人のメールアドレス
  table_name text not null,                         -- 表の名前
  action text not null,                             -- INSERT（追加）・UPDATE（書きかえ）・DELETE（削除）
  old_row jsonb,                                    -- 変える前の行
  new_row jsonb                                     -- 変えたあとの行
);
alter table public.audit_log enable row level security;
-- ルール（policy）を1つも作らないので、アプリ（anon・authenticated）からは読めず、書けない
revoke all on public.audit_log from anon, authenticated;

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log (changed_by, table_name, action, old_row, new_row)
  values (
    auth.jwt() ->> 'email',
    tg_table_name,
    tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end;
$$;
revoke execute on function public.write_audit_log() from public, anon, authenticated;

drop trigger if exists write_audit_log on public.reservations;
create trigger write_audit_log after insert or update or delete on public.reservations for each row execute function public.write_audit_log();
drop trigger if exists write_audit_log on public.customers;
create trigger write_audit_log after insert or update or delete on public.customers for each row execute function public.write_audit_log();
drop trigger if exists write_audit_log on public.shipments;
create trigger write_audit_log after insert or update or delete on public.shipments for each row execute function public.write_audit_log();
drop trigger if exists write_audit_log on public.variety_settings;
create trigger write_audit_log after insert or update or delete on public.variety_settings for each row execute function public.write_audit_log();

commit;
