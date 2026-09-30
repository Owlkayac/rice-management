// Supabase への接続と、予約テーブル（reservations）の追加・一覧取得。
// 読み込む順番：supabase-js（CDN）→ supabase-config.js → このファイル
//
// どの関数も、結果を { data, error } の形で返す。
// - 成功：error が null で、data に結果が入る
// - 失敗：data が null で、error に { message, code, details, hint } が入る（あわせて console.error にも出す）

const SUPABASE_TABLE = "reservations";

// 接続の準備ができているかを確かめる。問題があれば、その説明（日本語）を返す。問題がなければ ""
function findSupabaseSetupProblem() {
  if (typeof window.supabase === "undefined" || typeof window.supabase.createClient !== "function") {
    return "supabase-js（CDN）を読み込めませんでした。インターネットにつながっているか確かめてください。";
  }
  if (typeof SUPABASE_URL === "undefined" || typeof SUPABASE_PUBLISHABLE_KEY === "undefined") {
    return "supabase-config.js を読み込めませんでした。supabase-config.example.js をコピーして supabase-config.js を作り、値を入れてください。";
  }
  if (!/^https:\/\/\S+$/.test(SUPABASE_URL)) {
    return "supabase-config.js の SUPABASE_URL に、Project URL（https:// で始まるもの）が入っていません。";
  }
  // 「https://〜.supabase.co/rest/v1/」のように余計な部分まで貼り付けると、あとで分かりにくいエラーになるため、ここで止める
  if (/\/rest\/v1|\/$/.test(SUPABASE_URL)) {
    return "supabase-config.js の SUPABASE_URL の最後に、余計な部分（/rest/v1 や / など）が付いています。「https://〜.supabase.co」までにしてください。";
  }
  // Publishable key 以外（ブラウザに置いてはいけないキー）が入っていたら、使わずに止める
  if (!SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_")) {
    return "supabase-config.js の SUPABASE_PUBLISHABLE_KEY に、Publishable key（sb_publishable_ で始まるもの）が入っていません。それ以外のキーはブラウザに置かないでください。";
  }
  return "";
}

const supabaseSetupProblem = findSupabaseSetupProblem();
// 準備に問題があるときは null のまま（各関数はエラーを返す）
const sb = supabaseSetupProblem ? null : window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

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

// 予約を1件追加する。追加した行（id・created_at を含む）を data で返す
// reservation：{ name, variety, amountKg, status }
async function addSupabaseReservation(reservation) {
  if (!sb) return supabaseFailure("予約の追加", { message: supabaseSetupProblem, code: "SETUP" });
  try {
    const row = {
      name: reservation.name,
      variety: reservation.variety,
      amount_kg: reservation.amountKg,
      status: reservation.status
    };
    const { data, error } = await sb.from(SUPABASE_TABLE).insert(row).select();
    if (error) return supabaseFailure("予約の追加", error);
    return { data, error: null };
  } catch (err) {
    return supabaseFailure("予約の追加", err);
  }
}

// 予約の一覧を、created_at の新しい順に取得する
async function fetchSupabaseReservations() {
  if (!sb) return supabaseFailure("一覧の取得", { message: supabaseSetupProblem, code: "SETUP" });
  try {
    const { data, error } = await sb.from(SUPABASE_TABLE).select("*").order("created_at", { ascending: false });
    if (error) return supabaseFailure("一覧の取得", error);
    return { data, error: null };
  } catch (err) {
    return supabaseFailure("一覧の取得", err);
  }
}
