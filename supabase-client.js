// Supabase への接続と、テーブルの読み書き。
// 読み込む順番：supabase-js（vendor/ に置いたもの）→ supabase-config.js → このファイル
//
// どの関数も、結果を { data, error } の形で返す。
// - 成功：error が null で、data に結果が入る
// - 失敗：data が null で、error に { message, code, details, hint } が入る（あわせて console.error にも出す）

// 1回の読み込みで頼む行数（Supabase は1回に最大1000行までしか返さないため、それを超えるときは分けて読む）
const SUPABASE_PAGE_SIZE = 1000;
// 1回の保存で送る行数・1回の削除で指定する番号の数（多すぎると送れないため、分けて送る）
const SUPABASE_UPSERT_CHUNK = 500;
const SUPABASE_DELETE_CHUNK = 100;

// 接続の準備ができているかを確かめる。問題があれば、その説明（日本語）を返す。問題がなければ ""
function findSupabaseSetupProblem() {
  if (typeof window.supabase === "undefined" || typeof window.supabase.createClient !== "function") {
    return "supabase-js（vendor/supabase-js-2.117.2.js）を読み込めませんでした。ファイルがそろっているか、ページを開き直して確かめてください。";
  }
  if (typeof SUPABASE_URL === "undefined" || typeof SUPABASE_PUBLISHABLE_KEY === "undefined") {
    return "supabase-config.js を読み込めませんでした。supabase-config.example.js をコピーして supabase-config.js を作り、値を入れてください。";
  }
  if (typeof SUPABASE_URL !== "string" || typeof SUPABASE_PUBLISHABLE_KEY !== "string") {
    return "supabase-config.js の値は、\"（ダブルクォーテーション）で囲んでください。";
  }
  // コピーのときに前後へ空白や改行が入ると、値が入っているのに「入っていない」と言われて分かりにくいため、先に知らせる
  if (SUPABASE_URL !== SUPABASE_URL.trim() || SUPABASE_PUBLISHABLE_KEY !== SUPABASE_PUBLISHABLE_KEY.trim()) {
    return "supabase-config.js の SUPABASE_URL か SUPABASE_PUBLISHABLE_KEY の前後に、空白や改行が入っています。\" のすぐ内側に空白が無いように直してください。";
  }
  if (!/^https:\/\/\S+$/.test(SUPABASE_URL)) {
    return "supabase-config.js の SUPABASE_URL に、Project URL（https:// で始まるもの）が入っていません。";
  }
  // 「https://〜.supabase.co/rest/v1/」のように余計な部分まで貼り付けると、あとで分かりにくいエラーになるため、ここで止める
  if (/\/rest\/v1|\/$/.test(SUPABASE_URL)) {
    return "supabase-config.js の SUPABASE_URL の最後に、余計な部分（/rest/v1 や / など）が付いています。「https://〜.supabase.co」までにしてください。";
  }
  // ダッシュボードの画面の URL（https://supabase.com/dashboard/…）などを貼り付けたときも、ここで止める
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL)) {
    return "supabase-config.js の SUPABASE_URL が、Project URL（「https://〜.supabase.co」の形）になっていません。Supabase の画面の Project URL をコピーし直してください。";
  }
  // Publishable key 以外（ブラウザに置いてはいけないキー）が入っていたら、使わずに止める
  if (!SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_")) {
    return "supabase-config.js の SUPABASE_PUBLISHABLE_KEY に、Publishable key（sb_publishable_ で始まるもの）が入っていません。それ以外のキーはブラウザに置かないでください。";
  }
  return "";
}

const supabaseSetupProblem = findSupabaseSetupProblem();
// 準備に問題があるときは null のまま（各関数はエラーを返す）
const supabaseClient = supabaseSetupProblem ? null : window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// エラーを console.error に出し、呼び出し元に返す形にそろえる
function supabaseFailure(where, err) {
  const error = {
    message: String((err && err.message) || err || "原因の分からないエラー"),
    code: (err && err.code) || "",
    details: (err && err.details) || "",
    hint: (err && err.hint) || ""
  };
  console.error(`[Supabase] ${where}に失敗しました`, err);
  return { data: null, error };
}

function setupFailure(where) {
  return supabaseFailure(where, { message: supabaseSetupProblem, code: "SETUP" });
}

// テーブルの行をすべて読む。orderColumns の順（小さい順）に並べ、多いときは分けて読む。
// Supabase の設定で1回に返す行数が1000より少ないこともあるため、0行が返るまで読み続ける
async function fetchAllSupabaseRows(table, orderColumns) {
  const where = `${table} の読み込み`;
  if (!supabaseClient) return setupFailure(where);
  try {
    const rows = [];
    for (;;) {
      let query = supabaseClient.from(table).select("*");
      orderColumns.forEach(column => query = query.order(column, { ascending: true }));
      const { data, error } = await query.range(rows.length, rows.length + SUPABASE_PAGE_SIZE - 1);
      if (error) return supabaseFailure(where, error);
      if (!data || !data.length) break;
      rows.push(...data);
    }
    return { data: rows, error: null };
  } catch (err) {
    return supabaseFailure(where, err);
  }
}

// 行を保存する（keyColumn が同じ行があれば、確かめずに書きかえ、無ければ追加する）。多いときは分けて送る。
// バックアップの読み込みのように、まとめて置きかえるときだけ使う。
// data には、保存した行の { keyColumn の値, updated_at } の一覧を返す
async function upsertSupabaseRows(table, rows, keyColumn) {
  const where = `${table} の保存`;
  if (!supabaseClient) return setupFailure(where);
  try {
    const saved = [];
    for (let i = 0; i < rows.length; i += SUPABASE_UPSERT_CHUNK) {
      const { data, error } = await supabaseClient.from(table).upsert(rows.slice(i, i + SUPABASE_UPSERT_CHUNK), { onConflict: keyColumn }).select(`${keyColumn},updated_at`);
      if (error) return supabaseFailure(where, error);
      saved.push(...(data || []));
    }
    return { data: saved, error: null };
  } catch (err) {
    return supabaseFailure(where, err);
  }
}

// 行を追加する。多いときは分けて送る。data には、追加した行の { keyColumn の値, updated_at } の一覧を返す
// （同じ番号の行がもうあるときは、エラー（コード 23505）になる）
async function insertSupabaseRows(table, rows, keyColumn) {
  const where = `${table} の追加`;
  if (!supabaseClient) return setupFailure(where);
  try {
    const saved = [];
    for (let i = 0; i < rows.length; i += SUPABASE_UPSERT_CHUNK) {
      const { data, error } = await supabaseClient.from(table).insert(rows.slice(i, i + SUPABASE_UPSERT_CHUNK)).select(`${keyColumn},updated_at`);
      if (error) return supabaseFailure(where, error);
      saved.push(...(data || []));
    }
    return { data: saved, error: null };
  } catch (err) {
    return supabaseFailure(where, err);
  }
}

// 1行を書きかえる。ただし、読み込んだときから誰も変えていない（updated_at が同じ）ときだけ。
// 書きかえたら data に新しい updated_at、ほかで変えられていた（または消されていた）ら data に null を返す
async function updateSupabaseRowIfUnchanged(table, keyColumn, key, updatedAt, row) {
  const where = `${table} の保存`;
  if (!supabaseClient) return setupFailure(where);
  try {
    const { data, error } = await supabaseClient.from(table).update(row).eq(keyColumn, key).eq("updated_at", updatedAt).select("updated_at");
    if (error) return supabaseFailure(where, error);
    return { data: data && data.length ? data[0].updated_at : null, error: null };
  } catch (err) {
    return supabaseFailure(where, err);
  }
}

// 1行を消す。ただし、読み込んだときから誰も変えていない（updated_at が同じ）ときだけ。
// 消したら data に true、ほかで変えられていた（または先に消されていた）ら false を返す
async function deleteSupabaseRowIfUnchanged(table, keyColumn, key, updatedAt) {
  const where = `${table} の削除`;
  if (!supabaseClient) return setupFailure(where);
  try {
    const { data, error } = await supabaseClient.from(table).delete().eq(keyColumn, key).eq("updated_at", updatedAt).select(keyColumn);
    if (error) return supabaseFailure(where, error);
    return { data: !!(data && data.length), error: null };
  } catch (err) {
    return supabaseFailure(where, err);
  }
}

// keyColumn が keys のどれかに当たる行を読む（保存の返事が届かなかったときに、本当は保存できていたかを確かめるため）
async function fetchSupabaseRowsByKeys(table, keyColumn, keys) {
  const where = `${table} の確認`;
  if (!supabaseClient) return setupFailure(where);
  try {
    const rows = [];
    for (let i = 0; i < keys.length; i += SUPABASE_DELETE_CHUNK) {
      const { data, error } = await supabaseClient.from(table).select("*").in(keyColumn, keys.slice(i, i + SUPABASE_DELETE_CHUNK));
      if (error) return supabaseFailure(where, error);
      rows.push(...(data || []));
    }
    return { data: rows, error: null };
  } catch (err) {
    return supabaseFailure(where, err);
  }
}

// keyColumn が keys のどれかに当たる行を、確かめずに消す。多いときは分けて送る（まとめて置きかえるときだけ使う）
async function deleteSupabaseRows(table, keyColumn, keys) {
  const where = `${table} の削除`;
  if (!supabaseClient) return setupFailure(where);
  try {
    for (let i = 0; i < keys.length; i += SUPABASE_DELETE_CHUNK) {
      const { error } = await supabaseClient.from(table).delete().in(keyColumn, keys.slice(i, i + SUPABASE_DELETE_CHUNK));
      if (error) return supabaseFailure(where, error);
    }
    return { data: keys.length, error: null };
  } catch (err) {
    return supabaseFailure(where, err);
  }
}

// ---------- ログイン ----------

// 今ログインしているかを確かめる（ブラウザに残っているログインを使う）。ログインしていれば data に { email }、していなければ null
async function getSupabaseUser() {
  if (!supabaseClient) return setupFailure("ログインの確認");
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) return supabaseFailure("ログインの確認", error);
    const user = data && data.session && data.session.user;
    return { data: user ? { email: user.email || "" } : null, error: null };
  } catch (err) {
    return supabaseFailure("ログインの確認", err);
  }
}

// メールアドレスとパスワードでログインする。できたら data に { email }
async function signInSupabase(email, password) {
  if (!supabaseClient) return setupFailure("ログイン");
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) return supabaseFailure("ログイン", error);
    return { data: { email: (data.user && data.user.email) || email }, error: null };
  } catch (err) {
    return supabaseFailure("ログイン", err);
  }
}

// ログアウトする（この端末のログインを消す。インターネットにつながっていなくても消せる）
async function signOutSupabase() {
  if (!supabaseClient) return setupFailure("ログアウト");
  try {
    const { error } = await supabaseClient.auth.signOut({ scope: "local" });
    if (error) return supabaseFailure("ログアウト", error);
    return { data: true, error: null };
  } catch (err) {
    return supabaseFailure("ログアウト", err);
  }
}

// ログインしている人が、使う人のリスト（app_members）に入っているか。入っていれば data に true
// （データベースのルールと同じ関数 is_app_member で確かめる）
async function isSupabaseMember() {
  if (!supabaseClient) return setupFailure("使う人の確認");
  try {
    const { data, error } = await supabaseClient.rpc("is_app_member");
    if (error) return supabaseFailure("使う人の確認", error);
    return { data: data === true, error: null };
  } catch (err) {
    return supabaseFailure("使う人の確認", err);
  }
}

// ログインが切れた（ログアウトした・期限が切れて延長できなかった）ときに、onSignedOut を呼ぶ
function watchSupabaseSignOut(onSignedOut) {
  if (!supabaseClient) return;
  supabaseClient.auth.onAuthStateChange(event => {
    if (event === "SIGNED_OUT") onSignedOut();
  });
}
