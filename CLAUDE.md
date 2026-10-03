# 米予約管理Webアプリ

米の直販の受注（予約・出荷・顧客・在庫）を管理する Web アプリ。HTML / CSS / JavaScript だけで作っていて、データは Supabase に保存する（ログインした「使う人」だけが読み書きできる）。ブラウザ（localStorage）には、並び順などの画面の設定だけを保存する。GitHub Pages で公開している。

- `index.html`：画面
- `style.css`：見た目（スマホ表示を含む）
- `app.js`：処理のすべて
- `supabase-client.js`・`supabase-config.js`：Supabase への接続（Publishable key だけ。secret key・service_role key は書かない）
- `vendor/`：外のサイトから読み込まないよう、リポジトリに置いた部品（supabase-js）
- `supabase-*.sql`：Supabase の設定（ユーザーが SQL Editor で実行する。どれを実行してよいかは、下の「ユーザーにファイルを実行してもらうときのルール」の表を見る。`supabase-schema.sql` は実行させない）。`SECURITY.md`：セキュリティの対策と運用の手順

## ユーザーにファイルを実行してもらうときのルール（必ず守る）

ユーザーはプログラミング初心者で、言われたファイルをそのまま実行する。間違ったファイルを実行させると、データが消えたり守りが外れたりするため、次を守る。

| ファイル | ユーザーが実行するか |
|---|---|
| `supabase-schema.sql` | **実行させない。** 最初の準備のときだけのファイル。4つのテーブルを消して作り直すので、データがすべて消えるうえ、ルールが「誰でも読み書きできる」に戻る（中で止まるようにしてあるが、頼りにしない） |
| `supabase-auth.sql`・`supabase-hardening.sql`・`supabase-yield.sql` | 実行済み、または実行済みかもしれない。中身を変えたときや、まだ実行していないと分かったときだけ実行してもらう（どれも、もう一度実行してもデータは消えない）。順番は auth → hardening（hardening は auth で作る表を使う）。実行したかは、ユーザーの記憶より、読むだけの select（auth：`select to_regclass('public.app_members');`、hardening：`select to_regclass('public.audit_log');`、yield：`select column_name from information_schema.columns where table_name = 'variety_settings' and column_name = 'yield_percent';`。空なら未実行）で確かめてもらう。最初から準備し直すときの順番は schema → auth → hardening → yield |
| `app.js`・`supabase-client.js`・`supabase-config*.js`・`vendor/` の中 | ユーザーが実行するものではない（ブラウザがアプリを開いたときに読み込む） |
| 上の表にない SQL や、SQL Editor に貼る1行の SQL | 読むだけの `select` は、目的を伝えて実行してもらってよい。データや設定を変える SQL は、手順書にあるもの（`SECURITY.md` の「4.」の年1回の記録の削除など）でも、ないものでも、下の最後の決まりのとおり、何が変わるかを伝えて同意をもらってから |

- 実行してもらうときは、**ファイル名を1つずつはっきり書き**、なぜ必要か・何が変わるか・データが消えないかを伝える。「`supabase-*.sql` を実行する」のように、まとめて書かない。
- 「念のため全部実行し直す」「最初の手順書（`SUPABASE_SWITCH.md`・`SUPABASE_LOGIN.md`）をもう一度上から行う」とは言わない。
- データベースを変えるときは、データを消さず、何度実行しても同じになる新しい `supabase-*.sql` を作り、上の表と手順書に足す（`supabase-schema.sql` も、最初の準備用として同じ内容に合わせてよいが、ユーザーには実行させない）。そのファイルの1行目近くに「いつ実行するか／もう実行しなくてよいのはいつか」を書く。
- `drop table`・`delete`・`truncate`・`drop policy` など、データや守りが消える・変わる SQL は、ユーザーに実行させる前に、消えるもの・変わるものと件数の確かめ方を伝え、同意をもらう。

## コードを変更したときのルール（必ず守る）

このプロジェクトでコードを変更したときは、コミットする前に必ず次の手順を行う。

1. code-reviewer サブエージェント（`.claude/agents/code-reviewer.md`）に、変更した内容を点検させる。
2. 重要度「高」の指摘があれば直し、もう一度 code-reviewer に点検させる。
3. 重要度「高」の指摘がなくなるまで 2 を繰り返す。
4. 重要度「高」がなくなってからコミットする。

- 重要度「中」「低」の指摘は、その場で直すか、ユーザーに報告して判断を仰ぐ。
- 報告では、何を変えたか、code-reviewer の最終結果、残っている重要度「中」の指摘を伝える。

## プルリクエストを作るときのルール（必ず守る）

プルリクエストを作る前に、毎回必ず次の手順を行う。

1. code-reviewer に、プルリクエストに入るすべての変更（main との差分。前に入れたコミットも含む）を点検させる。
2. 重要度「高」の指摘があれば直してコミットし、もう一度 code-reviewer に点検させる。重要度「高」がなくなるまで繰り返す。
3. 重要度「高」がなくなってからプルリクエストを作る。
4. プルリクエストの説明には、code-reviewer の最終結果と、残っている重要度「中」「低」の指摘を書く。
