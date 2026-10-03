-- 米予約管理アプリ：品種ごとの「歩留まり（%）」を保存する列を足す SQL
-- 一度実行して「Success」と出ていれば、ふだんはもう実行しなくてよい（中身を変えたと案内されたときだけ、もう一度実行する）。
--
-- 在庫量は精米する前の量です。精米すると約1割が米粉などになって減るため、
-- アプリは「在庫量 × 歩留まり」を出荷できる量として、予約・出荷とくらべます。
--
-- 実行のしかた（SECURITY.md の「1. SQL を実行する」と同じ手順です）
-- 1. このファイルを全部コピーします。
-- 2. Supabase の SQL Editor を開き、＋ で新しい入力欄を出して貼り付けます。
-- 3. Run を押し、「Success. No rows returned」と出れば完了です。
-- 4. アプリを開き直すと、在庫管理の「歩留まり(%)」の欄に入力できるようになります。
--
-- ・データは消しません。
-- ・最初に実行したときだけ、どの品種も90%で始まります（あとからアプリで変えられます）。
--   もう一度実行しても、設定した歩留まりは変わりません。
-- ・アプリより先に実行しても、あとに実行しても大丈夫です（実行するまでは、アプリはどの品種も90%で計算します）。

begin;

-- 歩留まり（%）。50〜100 の範囲だけ（アプリが受け付ける範囲と同じ）
alter table public.variety_settings add column if not exists yield_percent numeric not null default 90;
alter table public.variety_settings drop constraint if exists variety_settings_yield;
alter table public.variety_settings add constraint variety_settings_yield check (yield_percent >= 50 and yield_percent <= 100);

commit;
