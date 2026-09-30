# Supabase 接続テストの手順

米予約管理アプリから Supabase の `reservations` テーブルに、テスト予約の追加と一覧の取得ができるかを確かめる手順です。

- テストには `supabase-test.html` を使います。いつもの予約管理の画面（`index.html`）とは別のページで、アプリのデータ（ブラウザに保存している予約など）には影響しません。
- 関係するファイル
  - `supabase-config.js`：接続先（Project URL と Publishable key）。GitHub には上げません（`.gitignore` に入っています）
  - `supabase-config.example.js`：上のファイルの見本（値は空）
  - `supabase-client.js`：Supabase への接続と、予約の追加・一覧取得の処理
  - `supabase-test.html`：接続テスト用のページ

---

## 0. 作業ブランチをパソコンに取ってくる

テスト用のファイルは、GitHub の作業ブランチ **`claude/agents-review-role-q24u6q`** に入っています（main にはまだ入っていません）。次のどれか1つの方法で、パソコンに取ってきてください。はじめての場合は「方法A」がいちばん簡単です。

### 方法A：ZIP でダウンロードする（Git を使わない）
1. ブラウザで GitHub のリポジトリ（`Owlkayac/rice-management`）を開きます。
2. ファイル一覧の左上にある、ブランチ名のボタン（ふだんは `main` と出ている）を押します。
3. 出てきた一覧から `claude/agents-review-role-q24u6q` を選びます（見つからないときは、検索欄に `agents-review` と入れます）。
4. 緑色の **Code** ボタン → **Download ZIP** を押します。
5. ダウンロードした ZIP ファイルを展開（解凍）します。
   - Mac：ZIP ファイルをダブルクリックします。
   - Windows：ZIP ファイルを右クリック → **すべて展開** を選びます（ダブルクリックだけでは中が見えるだけで、展開されません。この状態ではテストできません）。
6. 展開したフォルダ（`rice-management-claude-agents-review-role-q24u6q` のような名前です。Windows では同じ名前のフォルダが二重になっていることがあります）を開き、`supabase-test.html` が見えるところまで進みます。**このフォルダが、この先の手順でいう「rice-management フォルダ」です。**
- ファイルがあとで更新されたときは、同じ手順でもう一度ダウンロードしてください。新しくできたフォルダには `supabase-config.js` が入っていないので、もう一度作るか、前のフォルダからコピーしてください。

### 方法B：GitHub Desktop を使う
1. GitHub Desktop を開き、このリポジトリをまだ取ってきていなければ **File → Clone repository** で `Owlkayac/rice-management` を選んで取ってきます。
2. 上の **Fetch origin** を押します（これをしないと、新しいブランチが一覧に出てきません）。
3. 上の **Current Branch** を押し、`claude/agents-review-role-q24u6q` を選びます。
4. **Pull origin** と出ていれば押して、最新の内容にします。
5. **Repository → Show in Finder**（Windows は **Show in Explorer**）で、フォルダを開きます。

### 方法C：ターミナル（コマンド）を使う
すでに Git を使っている人向けです。

- はじめて取ってくるとき
  ```
  git clone https://github.com/Owlkayac/rice-management.git
  cd rice-management
  git switch claude/agents-review-role-q24u6q
  ```
- すでに取ってきてあるとき（rice-management フォルダの中で）
  ```
  git fetch origin
  git switch claude/agents-review-role-q24u6q
  git pull
  ```

---

## 1. 準備：接続先の設定ファイル（supabase-config.js）を作る

`supabase-config.js` は GitHub には上げていないので、**取ってきたフォルダには入っていません。** 見本の `supabase-config.example.js` をコピーして作ります。

### コピーして名前を変える
- **Mac（Finder）**
  1. `supabase-config.example.js` を右クリック → **複製** を選びます。「supabase-config.example のコピー.js」のようなファイルができます。
  2. できたファイルを右クリック → **名前を変更** で、`supabase-config.js` にします。
  3. 「拡張子を変更しますか？」と聞かれたら、**".js"を使用** を選びます。
- **Windows（エクスプローラー）**
  1. 先に、上の **表示** → **表示** → **ファイル名拡張子** にチェックを入れます（Windows 10 は **表示** タブの **ファイル名拡張子**）。こうしないと、名前の最後の「.js」が見えず、間違えやすくなります。
  2. `supabase-config.example.js` をクリックして選び、`Ctrl + C` → `Ctrl + V` を押します。「supabase-config.example - コピー.js」ができます。
  3. できたファイルを右クリック → **名前の変更** で、`supabase-config.js` にします（最後が `.js.txt` などになっていないか確かめます）。Windows 11 では「名前の変更」が文字ではなくアイコンで出るので、ファイルを選んで **F2 キー** を押すほうが簡単です。
- **ターミナルを使う場合**（rice-management フォルダの中で）
  - Mac：`cp supabase-config.example.js supabase-config.js`
  - Windows（コマンドプロンプト）：`copy supabase-config.example.js supabase-config.js`

### 値を入れる
1. `supabase-config.js` をテキストエディタで開きます。**`.js` のファイルをダブルクリックしないでください。**（Windows ではファイルが実行されてエラーの画面が出ます。Mac でも別のアプリが開くことがあります）
   - Visual Studio Code（おすすめ）：VS Code のウィンドウに、ファイルをドラッグします。
   - Windows の「メモ帳」：ファイルを右クリック → **プログラムから開く** → **メモ帳**。
   - Mac の「テキストエディット」：ファイルを右クリック → **このアプリケーションで開く** → **テキストエディット**。
2. `""` の間に、2つの値を入れて保存します。

```js
const SUPABASE_URL = "https://xxxxxxxx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_xxxxxxxx";
```

- 値は Supabase のダッシュボードで確認できます。
  - **Project URL**：Project Settings → Data API（`https://〜.supabase.co` の形。最後に `/` や `/rest/v1` を付けない）
  - **Publishable key**：Project Settings → API Keys（`sb_publishable_` で始まるキー）
  - `sb_publishable_` で始まるキーが見当たらないときは、API Keys の画面で Publishable key を新しく作ってください。
- 値の前後の `"`（ダブルクォーテーション）は消さないでください。
  - Mac の「テキストエディット」で `"` を打ち直すと、自動で `“ ”`（形の違う引用符）に変わり、ファイルが読めなくなることがあります。消してしまったときは、VS Code で開いて直すか、テキストエディットの **編集 → 自動置換 → スマート引用符** のチェックを外してから打ち直してください。
- **入れてよいのは Publishable key だけです。** このファイルはブラウザで動くので、それ以外のキーは絶対に書かないでください（`sb_publishable_` で始まらないキーが入っていると、テストページは接続せずに止まります）。
- `supabase-config.js` は `.gitignore` に入っているので、Git でコミットしても GitHub には上がりません。見本の `supabase-config.example.js` には値を入れないでください（こちらは GitHub に上がります）。

---

## 2. テストページを開く

どちらの方法でも開けます。まずは「かんたんな方法」を試してください。

### かんたんな方法：ダブルクリック
1. フォルダの中の `supabase-test.html` をダブルクリックします。
2. ブラウザ（Chrome・Edge・Safari など）でページが開きます。

### うまくいかないとき：簡易サーバーで開く
ダブルクリックで開いたときにエラーになる場合は、パソコンの中で小さなサーバーを動かして開きます。この方法には Python が必要です（入っていないときは、下の「Live Server」を使ってください）。

1. ターミナル（Mac）またはコマンドプロンプト（Windows）を開きます。
2. アプリのフォルダに移動します。
   ```
   cd （rice-management フォルダの場所）
   ```
   ※ `cd ` と入力したあとに、フォルダをウィンドウへドラッグすると場所が入ります。
3. 次のどちらかを入力して Enter を押します。
   - Mac：`python3 -m http.server 8000`
   - Windows：`py -m http.server 8000`
4. ブラウザで `http://localhost:8000/supabase-test.html` を開きます。
5. 終わったら、ターミナル（コマンドプロンプト）で `Ctrl + C` を押すとサーバーが止まります。

※ Visual Studio Code を使っている場合は、拡張機能「Live Server」で `supabase-test.html` を開いても同じです。

---

## 3. テストする

1. **「一覧を取得」** を押します。
   - 成功すると、緑の枠に「成功：接続できましたが、予約は0件でした。」（または「成功：○件の予約を取得しました（新しい順）。」）と出ます。
2. **「テスト予約を追加」** を押します。
   - 成功すると、緑の枠に「成功：テスト予約を追加しました。」と出て、その下の表に追加した予約（id・name＝テスト予約・variety＝A・amount_kg＝5・status＝received・created_at）が1行出ます。
3. もう一度 **「一覧を取得」** を押します。
   - 追加したテスト予約が、表のいちばん上（新しい順）に出れば、接続テストは成功です。

- 失敗したときは、赤い枠に「失敗：〜」と、エラーの内容・考えられる原因と直し方が出ます。次の「4. よくあるエラーと対処法」も見てください。
- 詳しい内容は、ブラウザの開発者ツール（F12 キー、または右クリック →「検証」）の「Console」にも `[Supabase] 〜に失敗しました` として出ます。

---

## 4. よくあるエラーと対処法

| 画面に出る内容 | 原因 | 対処法 |
|---|---|---|
| 「準備ができていません：supabase-config.js の SUPABASE_URL に、Project URL（https:// で始まるもの）が入っていません。」 | `supabase-config.js` に URL が入っていない | 「1. 準備」のとおりに URL を入れて保存し、ページを再読み込みする |
| 「準備ができていません：… SUPABASE_PUBLISHABLE_KEY に、Publishable key（sb_publishable_ で始まるもの）が入っていません。…」 | キーが入っていない、または Publishable key 以外のキーが入っている | Supabase の API Keys から `sb_publishable_` で始まるキーをコピーし直す |
| 「準備ができていません：… SUPABASE_URL の最後に、余計な部分（/rest/v1 や / など）が付いています。…」 | URL の後ろに余計な部分まで貼り付けている | `https://〜.supabase.co` までにする |
| 「準備ができていません：supabase-config.js を読み込めませんでした。…」 | `supabase-config.js` が無い、または名前が違う | `supabase-config.example.js` をコピーして `supabase-config.js` を作る |
| 「準備ができていません：supabase-js（CDN）を読み込めませんでした。…」 | インターネットにつながっていない | 接続を確かめて、ページを再読み込みする |
| 「Failed to fetch」 | Project URL が間違っている、またはインターネットにつながっていない | URL を Supabase の画面からコピーし直す（最後に余計な文字や空白が無いか確かめる） |
| 「Invalid API key」 | Publishable key が間違っている（別のプロジェクトのキー、一部だけコピーした、など） | キーをコピーし直す。Supabase からの英語のヒントに別の種類のキーの名前が出ることがありますが、使ってよいのは `sb_publishable_` で始まる Publishable key だけです |
| エラーは出ないのに一覧が0件（Table Editor では行が見えるのに） | RLS で読み取り（SELECT）が許されていない（この場合、Supabase はエラーではなく0件を返します） | Authentication → Policies で、`reservations` テーブルに読み取りを許すポリシーがあるか確かめる |
| 「permission denied」「row-level security」（コード 42501） | RLS（行ごとのアクセス制限）で止められている | Supabase の Authentication → Policies で、`reservations` テーブルに読み書きを許すポリシー（temp all）があるか確かめる。無ければ作り直す |
| 「Could not find the table」（コード PGRST205） | テーブル名が違う | テーブル名が `reservations`（すべて小文字）になっているか確かめる |
| 「Could not find the ○○ column」（コード PGRST204）、「column ○○ does not exist」（コード 42703） | 列の名前が違う、または列が無い | `name`・`variety`・`amount_kg`・`status`・`created_at` の列があるか確かめる |
| コード 22P02 | 列の型と値が合っていない | `amount_kg` が数値の列（numeric など）になっているか確かめる |
| コード 23502 | 入れなければいけない列に値が入っていない | Table Editor で列の設定（Is Nullable・既定値）を確かめる。`id` と `created_at` は自動で入る設定になっているか |

- 設定を直したあとは、ページを **再読み込み**（F5、Mac は ⌘+R）してから、もう一度ボタンを押してください。

---

## 5. Supabase の Table Editor でテストデータを確かめる・消す

### 確かめる
1. Supabase のダッシュボードで、対象のプロジェクトを開きます。
2. 左のメニューの **Table Editor** を開きます。
3. テーブルの一覧から **reservations** を選びます。
4. テストページで追加した行（name が「テスト予約」）が表に出ていれば成功です。出ていないときは、右上の再読み込み（Refresh）を押してください。

### 消す
1. 消したい行の左端のチェックボックスにチェックを入れます（複数選べます）。
2. 上に出る **Delete ○ rows**（○行を削除）を押します。
3. 確認の画面で削除を押します。
- 消した行は元に戻せません。「テスト予約」以外の行を選んでいないか、よく確かめてから消してください。

---

## 6. テストが終わったら（大事）

- 今は動作確認のため、RLS のポリシーが「全部許可（temp all）」になっています。このままだと、Project URL と Publishable key を知っている人なら誰でも、予約を読んだり、書き換えたり、消したりできます。
- テストが終わったら、本番で使う前に、必要な人だけが読み書きできるポリシーに変えてください。
