const LOW_STOCK_THRESHOLD = 100;
const INVENTORY_STORAGE_KEY = "inventory";
const SHIPMENTS_STORAGE_KEY = "shipments";
const CUSTOMERS_STORAGE_KEY = "customers";
const LAST_BACKUP_STORAGE_KEY = "lastBackupAt";
const BACKUP_APP_NAME = "rice-reservation-backup";
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
// 前に使っていたスプレッドシート連携の設定（URL・合言葉など）が、ブラウザに残っていれば消す
// （連携は削除済み。使っていた端末すべてで一度アプリを開いたあとなら、この後片付けは消してよい）
const OLD_SHEET_KEYS = ["sheetUrl", "sheetToken", "sheetSavedAt", "sheetSyncedData"];
// 予約・出荷・顧客の id として受け付ける文字（英数字・「_」「-」）
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const RESERVATION_SORT_KEY = "reservationSort";
const SHIPMENT_SORT_KEY = "shipmentSort";
const RESERVATION_SORTS = ["recent", "month", "variety", "name", "kg"];
const SHIPMENT_SORTS = ["recent", "dateDesc", "dateAsc", "name"];
const CHANNELS = ["ウェブフォーム", "Instagram", "LINE", "電話・対面", "その他"];
const STATUSES = { received: "受付済み", preparing: "出荷準備中", shipped: "出荷済み" };
const STATUS_KEYS = ["received", "preparing", "shipped"];
const PRICES_STORAGE_KEY = "varietyPrices";
const STOCK_MODE_KEY = "stockMode";
const STOCK_MODES = {
  shipped: {
    basis: "出荷後",
    help: "出荷済みの分を引いた残りで判定します。実際に手元へ残っているお米の量を確かめるときに向いています。"
  },
  reserved: {
    basis: "予約後",
    help: "予約している分を引いた残りで判定します。予約を受けすぎていないかを確かめるときに向いています。"
  }
};
const varieties = ["A", "B", "C", "D", "E", "F"];
const months = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
const STORAGE_KEYS = ["reservations", SHIPMENTS_STORAGE_KEY, CUSTOMERS_STORAGE_KEY, INVENTORY_STORAGE_KEY, PRICES_STORAGE_KEY];
// 予約・出荷・顧客・在庫・単価（STORAGE_KEYS）は、ブラウザ（localStorage）ではなく Supabase に保存する。
// 画面を開いている間は、保存した内容をここに JSON の文字で持っておき、変わった行だけを Supabase へ送る。
// （並べ替えの選び方など、それ以外の設定は今までどおり localStorage に保存する）
const cloudStore = {};
// Supabase から読み込み終わったら true（読み込みが終わるまでは、データを変える操作をさせない）
let cloudReady = false;
// Supabase へ送っている途中なら true
let cloudSaving = false;
// まだ送っていない変更があれば true
let cloudSaveQueued = false;
// 最後に送れなかったときのエラー（送れたら null に戻す）
let cloudSaveError = null;
// 最後に Supabase から読み込んだ時刻と、読み直している途中かどうか
let cloudLoadedAt = 0;
let cloudRefreshing = false;
// 最後の読み直しに失敗したときのエラー（読み直せたら null に戻す）。この間は、データを変える操作を止める
let cloudRefreshError = null;
// 読み直しの様子を画面の上に出すか（30秒ごとの読み直しのたびに表示が変わって、ちらつかないように。
// 操作の前の読み直しと、エラーからのやり直しのときだけ出す）
let cloudRefreshShown = false;
// 読み直しを待つ最長の時間（返事が来ないまま、いつまでも操作できなくならないように）
const CLOUD_REFRESH_TIMEOUT_MS = 20 * 1000;
// 操作の前（またはエラーの赤い枠のボタン）で読み直しを頼まれたら true（終わったときに「もう一度操作してください」を出すため）
let cloudRefreshAsked = false;
// この画面で予約・出荷・顧客・在庫・単価を保存した回数（読み直している間に保存があったかを見分けるため）
let cloudChangeCount = 0;
// 画面を開いている間に、Supabase から読み直す間隔
const CLOUD_REFRESH_MS = 30 * 1000;
// 最後に読み込んでからこれより長くたっていたら、操作の前に読み直す（スリープから戻ったときなど）
const CLOUD_STALE_MS = 90 * 1000;
const lastSeen = {};
STORAGE_KEYS.forEach(k => lastSeen[k] = rawGet(k));
let reservations = read("reservations", []);
let shipments = read(SHIPMENTS_STORAGE_KEY, []);
let customers = read(CUSTOMERS_STORAGE_KEY, []);
let inventory = loadInventory();
let prices = loadPrices();
let stockMode = loadStockMode();
// 編集中の予約・出荷は、配列の番号ではなく id で覚える（削除で番号がずれても別のデータを上書きしないため）
let editingReservationId = null;
// 予約の編集を始めたときにフォームに入れた顧客（紐づく出荷がある予約の顧客変更を止めるため）
let editStartCustomer = null;
let editingShipmentId = null;
let editingCustomerId = null;
// 他のタブの変更を取り込んだ回数（確認ダイアログの間に取り込みがあったかを見分けるため）
let reloadCount = 0;

function read(k, f) {
  try {
    return JSON.parse(rawGet(k)) ?? f;
  } catch {
    return f;
  }
}

function rawGet(k) {
  if (STORAGE_KEYS.includes(k)) return cloudStore[k] ?? null;
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

// 保存する。予約・出荷・顧客・在庫・単価は cloudStore に入れて Supabase へ送る（送るのは少しあと）。
// それ以外は localStorage に保存する（容量不足などで失敗すると、例外が出る）
function storeItem(k, text) {
  if (STORAGE_KEYS.includes(k)) {
    cloudStore[k] = text;
    cloudChangeCount++;
    scheduleCloudSave();
    return;
  }
  localStorage.setItem(k, text);
}

function notify(message, type = "info", duration = 5000) {
  const area = document.getElementById("toastArea");
  if (!area) return;
  while (area.children.length >= 4) area.firstChild.remove();
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  el.onclick = () => el.remove();
  area.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

let lastSaveWarningAt = 0;
// 起動時などに付けた id を、まだ保存できていないとき true（予約・出荷・顧客のつながりを切らないため、
// この間は3つのどれを保存するときも、3つまとめて保存する）
let idsNotSaved = false;
const ID_LINKED_KEYS = ["reservations", SHIPMENTS_STORAGE_KEY, CUSTOMERS_STORAGE_KEY];

function warnSaveFailed() {
  const now = Date.now();
  if (now - lastSaveWarningAt < 3000) return;
  lastSaveWarningAt = now;
  notify("保存できませんでした。この変更は保存されていません。\nブラウザの保存容量がいっぱいか、プライベートブラウズ中の可能性があります。「データを書き出す」でバックアップを取ってください。", "error", 10000);
}

// 予約・出荷・顧客は、必ず画面のデータ（reservations・shipments・customers）に反映してから、その変数を渡して保存すること。
// id の保存待ちの間は、渡した v ではなく、この3つの変数がまとめて保存されるため
function save(k, v) {
  // 付けた id がまだ保存できていない間は、予約・出荷・顧客をまとめて保存する（1つだけ保存して、つながりが切れないように）
  if (idsNotSaved && ID_LINKED_KEYS.includes(k)) {
    if (saveIdLinkedData()) return true;
    warnSaveFailed();
    return false;
  }
  const text = JSON.stringify(v);
  try {
    storeItem(k, text);
    lastSeen[k] = text;
    return true;
  } catch {
    warnSaveFailed();
    return false;
  }
}

// 予約・出荷・顧客・在庫・単価のうち、複数をまとめて保存する（画面の中の控えに入れてから、まとめて Supabase へ送る）。
// 控えに入れるだけなので失敗しない。Supabase へ送れなかったときは、画面の上に赤いお知らせを出す（showCloudStatus）
function saveAll(entries) {
  entries.forEach(([k, v]) => {
    const text = JSON.stringify(v);
    storeItem(k, text);
    lastSeen[k] = text;
  });
  return true;
}

// 予約・出荷・顧客をまとめて保存する。保存できたら、付けた id の保存待ちを解く
function saveIdLinkedData() {
  if (!saveAll([["reservations", reservations], [SHIPMENTS_STORAGE_KEY, shipments], [CUSTOMERS_STORAGE_KEY, customers]])) return false;
  idsNotSaved = false;
  return true;
}

function formatKg(v) {
  return `${Math.round((Number(v) || 0) * 100) / 100}kg`;
}

// 予約量から出荷量を引いた「まだ出荷していない量」（小数の誤差を丸める）。マイナスなら、予約より多く出荷している
function unshippedKg(reserved, shipped) {
  return Math.round(((Number(reserved) || 0) - (Number(shipped) || 0)) * 100) / 100;
}

// 品種ごと（A〜F と「品種なし」）に「予約−出荷」を出し、残っている分（0未満は0）の合計と、予約より多く出荷した分の合計を返す。
// 品種をまたいで差し引くと、ある品種の出しすぎが別の品種の残りを打ち消し、残りを見落とすため、品種ごとに数える
// items には、残りがある品種ごとの { label: 品種名, kg: 残り } が入る
function unshippedByVariety(reservationList, shipmentList) {
  // A〜F の7つめとして、A〜F 以外（品種なし・不明）のグループも数える
  const groups = [
    ...varieties.map(v => ({ label: v, match: x => x.variety === v })),
    { label: "品種なし", match: x => !varieties.includes(x.variety) }
  ];
  let remaining = 0;
  let over = 0;
  const items = [];
  groups.forEach(({ label, match }) => {
    const rest = unshippedKg(sumKg(reservationList.filter(match)), sumKg(shipmentList.filter(match)));
    if (rest > 0) {
      remaining += rest;
      items.push({ label, kg: rest });
    } else {
      over -= rest;
    }
  });
  return { remaining: roundKg(remaining), over: roundKg(over), items };
}

// 表のマスに入れる未出荷量（HTML）。マイナスにはせず0kgと出し、予約より多く出荷した分を下に小さく添える
// （予約に紐づけていない出荷などで、出荷が予約を超えることがあるため。中身は数字だけなので innerHTML に入れてよい）
function unshippedCellHtml(reserved, shipped) {
  const rest = unshippedKg(reserved, shipped);
  return rest >= 0 ? formatKg(rest) : `0kg<small class="over-shipped">${formatKg(-rest)}多く出荷</small>`;
}

// 品種を表示用の文字にする（古いデータで品種が無いときに「undefined」と出ないように）。
// 品種が無い（undefined・null）ときも空文字のときも「品種なし」と表示する。表示専用で、保存には使わない
function varietyLabel(v) {
  return v || "品種なし";
}

// 月を表示用の文字にする（古いデータで月が無いときに「undefined」と出ないように）。表示専用で、保存には使わない
function monthLabel(m) {
  return m || "月なし";
}

// 2つの品種が同じかどうか。品種が無い（undefined・null）ものと空文字は同じ「品種なし」として扱う
// （表示では同じ「品種なし」なのに「違う」と判定して、矛盾したメッセージが出ないように）
function sameVariety(a, b) {
  return (a || "") === (b || "");
}

function uid(prefix = "customer") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// id が無い古いデータに id を付ける（保存はしない。付けたら true を返す）
function fillMissingIds(list, prefix) {
  let changed = false;
  list.forEach(x => {
    if (!x.id) {
      x.id = uid(prefix);
      changed = true;
    }
  });
  return changed;
}

// 顧客の id が無い、または使えない値なら、使える文字列の id に直す
// （id が無いと、編集で顧客が2件に増えたり、削除で id の無い顧客がまとめて消えたりするため）。
// 0以上の整数の id は文字列に直す（選択欄の値は文字列なので、数値のままだと選んでも見つからないため）
// 保存はしない。直したら true を返す
function fixCustomerIds() {
  let changed = false;
  customers.forEach(c => {
    if (typeof c.customerId === "string" && SAFE_ID_PATTERN.test(c.customerId)) return;
    replaceCustomerId(c, isLegacyNumericId(c.customerId) ? String(c.customerId) : uid());
    changed = true;
  });
  return changed;
}

// 古いデータの数値の id として受け付ける値（0以上で、正確に表せる範囲の整数）
function isLegacyNumericId(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

// 顧客の id を newId に置き換え、その顧客を指していた予約・出荷の customerId も合わせる
function replaceCustomerId(c, newId) {
  const oldId = c.customerId;
  // 「id が無い」は undefined・null・空文字・false だけ（0 は古いデータの数値の id として扱う）
  const hasId = v => v !== undefined && v !== null && v !== "" && v !== false;
  const linked = [...reservations, ...shipments].filter(x => {
    if (hasId(oldId)) {
      return x.customerId === oldId;
    }
    // id が無かった顧客は、今この顧客に名前でつながっている予約・出荷に id を書き込む（あとで名前を変えてもつながりが切れないように）
    return !hasId(x.customerId) && customerFor(x) === c;
  });
  c.customerId = newId;
  linked.forEach(x => {
    x.customerId = newId;
  });
}

// 予約・出荷・顧客に足りない id を付ける。persist が true なら、3つをまとめて保存する。
// 保存に失敗しても、画面のデータには付けた id を残す（id が無いと、編集・削除で別のデータを操作してしまうため）。
// その代わり idsNotSaved を立て、次にどれかを保存するときに3つまとめて保存し直す
function ensureAllIds(persist = true) {
  const reservationsChanged = fillMissingIds(reservations, "reservation");
  const shipmentsChanged = fillMissingIds(shipments, "shipment");
  const customersChanged = fixCustomerIds();
  if (!persist) return;
  if (!(reservationsChanged || shipmentsChanged || customersChanged)) {
    // 読み込んだばかりの保存データに直すところが無い＝画面と保存の id はそろっている
    idsNotSaved = false;
    return;
  }
  idsNotSaved = true;
  if (!saveIdLinkedData()) warnSaveFailed();
}

ensureAllIds();

function normalizeInventory(x) {
  x = x || {};
  const r = {};
  varieties.forEach(v => r[v] = Number.isFinite(Number(x[v])) && Number(x[v]) >= 0 ? Number(x[v]) : 0);
  return r;
}

function loadInventory() {
  return normalizeInventory(read(INVENTORY_STORAGE_KEY, {}));
}

function loadChoice(key, allowed, fallback) {
  const v = read(key, fallback);
  return allowed.includes(v) ? v : fallback;
}

function statusOf(r) {
  return r && STATUS_KEYS.includes(r.status) ? r.status : "received";
}

function channelOf(r) {
  return r && CHANNELS.includes(r.channel) ? r.channel : "";
}

function shippedForReservation(r) {
  return shipments.reduce((a, s) => a + (s.reservationId === r.id ? Number(s.kg) || 0 : 0), 0);
}

function remainingForReservation(r) {
  return (Number(r.kg) || 0) - shippedForReservation(r);
}

function openReservationsFor(customerId, excludeShipmentId) {
  return reservations.map((r, i) => ({ r, i })).filter(({ r }) => customerFor(r)?.customerId === customerId).map(({ r, i }) => ({
    r, i, shipped: shipments.reduce((a, s) => a + (s.reservationId === r.id && s.id !== excludeShipmentId ? Number(s.kg) || 0 : 0), 0)
  })).map(x => ({ ...x, remaining: (Number(x.r.kg) || 0) - x.shipped }));
}

function refreshShipmentReservationOptions(selectedReservationId) {
  const sel = document.getElementById("shipmentReservation");
  if (!sel) return;
  const customerId = shipmentCustomerSelect.value;
  const list = customerId ? openReservationsFor(customerId, editingShipmentId) : [];
  const opts = ['<option value="">特定の予約に紐づけない</option>'];
  list.forEach(({ r, remaining }) => {
    if (remaining > 0 || r.id === selectedReservationId) {
      opts.push(`<option value="${esc(r.id)}">${esc(varietyLabel(r.variety))}・${esc(monthLabel(r.month))}・${formatKg(r.kg)}（残り${formatKg(Math.max(remaining, 0))}）</option>`);
    }
  });
  sel.innerHTML = opts.join("");
  sel.value = list.some(({ r }) => r.id === selectedReservationId) ? selectedReservationId : "";
  sel.disabled = !customerId;
  syncShipmentVarietyWithReservation();
}

// 「対象の予約」を選んでいる間は、品種をその予約の品種にそろえて変えられないようにする。
// 予約の選択を外したら、品種はまた選べるようにする
function syncShipmentVarietyWithReservation() {
  const reservationId = document.getElementById("shipmentReservation").value;
  const linked = reservations.find(x => x.id === reservationId);
  if (linked) shipmentVariety.value = linked.variety;
  // 品種が無い予約や古い出荷の後で品種欄が空のまま選べる状態に戻ったら、先頭の品種にする
  if (!linked && !varieties.includes(shipmentVariety.value)) shipmentVariety.value = varieties[0];
  shipmentVariety.disabled = !!linked;
}

// 紐づけた予約と品種が違う出荷を探す（見つけるだけで、直さない）
function findVarietyMismatches() {
  return shipments.map(s => ({ s, r: s.reservationId ? reservations.find(x => x.id === s.reservationId) : null }))
    .filter(({ s, r }) => r && !sameVariety(r.variety, s.variety));
}

function displayVarietyMismatches() {
  const box = document.getElementById("varietyMismatchNotice");
  if (!box) return;
  const list = findVarietyMismatches();
  box.hidden = !list.length;
  box.innerHTML = "";
  if (!list.length) return;
  const title = document.createElement("p");
  title.textContent = `予約と品種が違う出荷が${list.length}件あります。内容を確かめて、必要なら出荷を編集してください。`;
  box.appendChild(title);
  const ul = document.createElement("ul");
  list.forEach(({ s, r }) => {
    const li = document.createElement("li");
    li.textContent = `${s.date || "日付なし"}・${customerName(s)}・${formatKg(s.kg)}：出荷の品種「${varietyLabel(s.variety)}」／予約の品種「${varietyLabel(r.variety)}」（予約：${monthLabel(r.month)}・${formatKg(r.kg)}）`;
    ul.appendChild(li);
  });
  box.appendChild(ul);
}

function stockWarning(r, ignoreId) {
  const stock = Number(inventory[r.variety]) || 0;
  const already = reservations.reduce((a, x) => a + (x.id !== ignoreId && x.variety === r.variety ? Number(x.kg) || 0 : 0), 0);
  const total = already + r.kg;
  if (total <= stock) return "";
  let text = `${r.variety}の予約が在庫を${formatKg(total - stock)}超えます。\n\n在庫：${formatKg(stock)}\nこれまでの予約：${formatKg(already)}\n今回の予約：${formatKg(r.kg)}\n予約の合計：${formatKg(total)}\n\nこのまま登録しますか？`;
  if (stock === 0) text += "\n（在庫が未入力の場合は、先に「在庫管理」で入力してください）";
  return text;
}

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function monthNumber(m) {
  return parseInt(m, 10) || 99;
}

function customerSortKey(item) {
  const c = customerFor(item);
  return String(c?.furigana || customerName(item));
}

function reservationComparator(mode) {
  const byIndex = (a, b) => a.i - b.i;
  const byVariety = (a, b) => varieties.indexOf(a.r.variety) - varieties.indexOf(b.r.variety);
  const byMonth = (a, b) => monthNumber(a.r.month) - monthNumber(b.r.month);
  if (mode === "month") return (a, b) => byMonth(a, b) || byVariety(a, b) || byIndex(a, b);
  if (mode === "variety") return (a, b) => byVariety(a, b) || byMonth(a, b) || byIndex(a, b);
  if (mode === "name") return (a, b) => customerSortKey(a.r).localeCompare(customerSortKey(b.r), "ja") || byMonth(a, b) || byIndex(a, b);
  if (mode === "kg") return (a, b) => (Number(b.r.kg) || 0) - (Number(a.r.kg) || 0) || byIndex(a, b);
  return byIndex;
}

function shipmentComparator(mode) {
  const byIndex = (a, b) => a.i - b.i;
  if (mode === "dateDesc") return (a, b) => String(b.s.date).localeCompare(String(a.s.date)) || b.i - a.i;
  if (mode === "dateAsc") return (a, b) => String(a.s.date).localeCompare(String(b.s.date)) || byIndex(a, b);
  if (mode === "name") return (a, b) => customerSortKey(a.s).localeCompare(customerSortKey(b.s), "ja") || String(a.s.date).localeCompare(String(b.s.date)) || byIndex(a, b);
  return byIndex;
}

function loadPricesFrom(x) {
  const r = {};
  varieties.forEach(v => r[v] = Number.isFinite(Number(x?.[v])) && Number(x[v]) >= 0 ? Number(x[v]) : 0);
  return r;
}

function loadPrices() {
  return loadPricesFrom(read(PRICES_STORAGE_KEY, {}));
}

function loadStockMode() {
  const m = read(STOCK_MODE_KEY, "shipped");
  return m === "reserved" ? "reserved" : "shipped";
}

function setStockMode(mode) {
  if (mode !== "shipped" && mode !== "reserved") return;
  stockMode = mode;
  save(STOCK_MODE_KEY, mode);
  displayInventory();
}

function fillOptions() {
  ["variety", "shipmentVariety"].forEach(id => {
    const e = document.getElementById(id);
    e.innerHTML = varieties.map(v => `<option>${v}</option>`).join("");
  });
  document.getElementById("filterVariety").innerHTML = '<option value="">すべて</option>' + varieties.map(v => `<option>${v}</option>`).join("");
  document.getElementById("month").innerHTML = months.map(m => `<option>${m}</option>`).join("");
  document.getElementById("filterMonth").innerHTML = '<option value="">すべて</option>' + months.map(m => `<option>${m}</option>`).join("");
  document.getElementById("channel").innerHTML = '<option value="">未選択</option>' + CHANNELS.map(c => `<option>${c}</option>`).join("");
  document.getElementById("filterChannel").innerHTML = '<option value="">すべて</option>' + CHANNELS.map(c => `<option>${c}</option>`).join("") + '<option value="__none">未設定</option>';
  document.getElementById("filterStatus").innerHTML = '<option value="">すべて</option>' + STATUS_KEYS.map(k => `<option value="${k}">${STATUSES[k]}</option>`).join("");
  refreshCustomerSelects();
}

function customerFor(item) {
  return item.customerId ? customers.find(c => c.customerId === item.customerId) : customers.find(c => c.name === item.name);
}

function customerName(item) {
  return customerFor(item)?.name || item.name || "未登録";
}

// 同じ顧客かどうかを判定するためのキー（customerFor で顧客が見つかればその id、見つからなければ前後の空白を除いた名前）
function customerKey(item) {
  return customerFor(item)?.customerId || `name:${String(item.name || "").trim()}`;
}

function findCustomer(customerId) {
  return customerId ? customers.find(c => c.customerId === customerId) : undefined;
}

// 顧客の選択と名前欄が食い違っていれば、利用者に見せる説明を返す（問題なければ ""）。
// 食い違ったまま保存すると、別の人の予約・出荷が、選んでいる顧客のものとして数えられてしまう。
function customerNameMismatch(customerId, name) {
  if (!customerId) return "";
  const c = findCustomer(customerId);
  if (!c) return "選んでいる顧客が見つかりません。顧客を選び直してください";
  if (String(name || "").trim() === String(c.name || "").trim()) return "";
  return `選んでいる顧客「${c.name}」と名前欄「${name}」が違います。別の人なら顧客の選択を外してください`;
}

// 顧客を選んだまま名前欄に別の名前を入力したら、顧客の選択を外して知らせる。外したら true を返す
function detachCustomerIfRenamed(selectId, nameId) {
  const select = document.getElementById(selectId);
  const c = findCustomer(select.value);
  const typed = document.getElementById(nameId).value.trim();
  if (!c || typed === String(c.name || "").trim()) return false;
  select.value = "";
  notify(`名前欄が「${c.name}」と違うため、顧客の選択を外しました`, "info");
  return true;
}

// 同じ人かもしれない名前・住所を見つけるための比べ方。
// compareKey：全角・半角の違い（NFKC という変換でそろえる）と空白をなくした形。「山田 太郎」と「山田太郎」、「ﾔﾏﾀﾞ」と「ヤマダ」を同じとみなす
function compareKey(t) {
  return String(t || "").normalize("NFKC").replace(/\s+/g, "");
}

// addressKey：住所用。compareKey に加えて、ハイフンに似た文字（－ − ‐ ― ー など）を「-」にそろえる。
// 「1−2−3」と「1-2-3」は同じとみなすが、「1丁目2番3号」と「1-2-3」のような書き方の違いは拾えない。
// 長音「ー」もハイフンとみなすので、名前には使わない（カタカナの名前が変わってしまうため）
function addressKey(t) {
  return compareKey(t).replace(/[‐‑‒–—―−ーｰ]/g, "-");
}

// 確認文に並べる顧客の一覧（スマホの確認ダイアログが長くなりすぎないよう、3人まで・住所は20文字まで）
function customerListText(list) {
  // 1文字ずつに分けてから数える（「𠮷」や絵文字などが途中で割れて文字化けしないように）
  const short = t => {
    const chars = Array.from(t);
    return chars.length > 20 ? `${chars.slice(0, 20).join("")}…` : t;
  };
  const lines = list.slice(0, 3).map(x => `・${short(String(x.name || ""))}（${short(String(x.address || "")) || "住所なし"}）`);
  if (list.length > 3) lines.push(`ほか${list.length - 3}人`);
  return lines.join("\n");
}

// 前後の空白を除いて、名前が同じ顧客の一覧
function customersNamed(name) {
  const n = String(name || "").trim();
  return n ? customers.filter(c => String(c.name || "").trim() === n) : [];
}

// 名前欄を離れたときの確認で「キャンセル」された（別の人だと答えた）名前。保存のときに同じ確認をくり返さず、案内を出して止める
const declinedSameNames = new Set();

// 同じ名前の顧客につなぐ前に見せる確認文（同姓同名の別人の予約が、既存の顧客に混ざらないように）
function sameNameConfirmText(c) {
  return `顧客管理に登録済みの「${customerDisplayNames().get(c.customerId).label}」につなぎます。\n\n同じ人なら「OK」を押してください。\n同姓同名の別の人なら「キャンセル」を押し、先に「顧客管理」でその人を登録してから、顧客の欄で選んでください。`;
}

// 顧客を選ばずに名前欄へ登録済みの顧客と同じ名前を入れたら、確認してからその顧客を選ぶ（同じ名前の顧客が1人だけのとき）。
// 選べば、出荷では「対象の予約」も選べるようになる。選んだら true を返す
function selectCustomerByTypedName(selectId, nameId) {
  const select = document.getElementById(selectId);
  if (select.value) return false;
  const found = customersNamed(document.getElementById(nameId).value);
  if (found.length !== 1) return false;
  // ここではフォームの欄を変えるだけで保存はしないので、confirmThen（保存前の最新確認つき）ではなく confirm で聞く
  const name = String(found[0].name || "").trim();
  if (!confirm(sameNameConfirmText(found[0]))) {
    declinedSameNames.add(name);
    return false;
  }
  declinedSameNames.delete(name);
  select.value = found[0].customerId;
  document.getElementById(nameId).value = found[0].name;
  notify(`顧客管理の「${found[0].name}」を選びました`, "info");
  return true;
}

// 名前欄だけで入力した予約・出荷を、保存する直前に顧客と結びつける。
// 前後の空白を除いて同じ名前の顧客がいればその顧客に、いなければ名前だけの顧客を新しく登録して結びつける。
// 新しく登録した顧客を返す（登録しなかったときは null）
function linkOrCreateCustomer(item) {
  if (item.customerId) return null;
  const name = String(item.name || "").trim();
  if (!name) return null;
  item.name = name;
  const same = customersNamed(name)[0];
  if (same) {
    item.customerId = same.customerId;
    return null;
  }
  const c = { customerId: uid(), name, furigana: "", phone: "", address: "", memo: "" };
  customers.push(c);
  item.customerId = c.customerId;
  return c;
}

// 名前欄だけで入力したときの確認をしてから進める。
// 同じ名前の顧客が2人以上いれば、どちらか分からないので止める。
// 空白や全角・半角の違いだけで名前が同じになる顧客がいれば（入力の揺れで別人として登録されないように）確かめる
function confirmNewCustomerThen(item, action) {
  const name = String(item.name || "").trim();
  if (!item.customerId && customersNamed(name).length > 1) {
    notify(`「${name}」という名前の顧客が複数登録されています。顧客の欄でどの人かを選んでください`, "warn", 8000);
    return;
  }
  if (item.customerId || !name) {
    action();
    return;
  }
  // 同じ名前の顧客が1人いれば、その人につなぐ前に確かめる（同姓同名の別人が混ざらないように）
  const same = customersNamed(name);
  if (same.length && declinedSameNames.has(name)) {
    notify(`「${name}」は、登録済みの顧客とは別の人として入力されています。先に「顧客管理」でその人を登録してから、顧客の欄で選んでください（同じ人なら、顧客の欄で「${name}」を選んでください）`, "warn", 12000);
    return;
  }
  if (same.length) {
    confirmThen(sameNameConfirmText(same[0]), action);
    return;
  }
  const similar = customers.filter(c => compareKey(c.name) === compareKey(name));
  if (!similar.length) {
    action();
    return;
  }
  confirmThen(`よく似た名前の顧客が登録されています。\n${customerListText(similar)}\n\n同じ人なら「キャンセル」を押して、顧客の欄でその人を選んでください。\n別の人として「${name}」を新しく顧客に登録して保存しますか？`, action);
}

// 新しく顧客を登録したことを知らせる
function notifyNewCustomer(c) {
  if (c) notify(`「${c.name}」を新しい顧客として顧客管理に登録しました。電話番号・住所などは「顧客管理」の「編集」で追加できます（名前を間違えたときも、そこで直せます）`, "info", 8000);
}

// 顧客を見分けるための表示名（顧客の id → { label：表示名, number：「同じ名前のN人目」の印（無ければ ""） }）。
// 名前がよく似た顧客（空白・全角半角の違いだけ）がほかにもいるときだけ、
// 電話番号の下4桁・住所の頭・ふりがな（同じ名前の人どうしで読みが違うときだけ）を添える。
// （メモはお店側だけで見る内容のことがあるので、お客さんの前で開く予約・出荷の欄には出さない）
// それでも見分けられない人には「同じ名前のN人目」（顧客の並び順）を添えて、必ず見分けられるようにする
function customerDisplayNames() {
  const head = t => {
    const chars = Array.from(String(t || "").trim());
    return chars.length > 10 ? `${chars.slice(0, 10).join("")}…` : chars.join("");
  };
  const groups = new Map();
  customers.forEach(c => {
    const key = compareKey(c.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  });
  const names = new Map();
  groups.forEach(group => {
    if (group.length < 2) {
      names.set(group[0].customerId, { label: group[0].name, number: "" });
      return;
    }
    const readings = new Set(group.map(c => compareKey(c.furigana)));
    const hintTexts = group.map(c => {
      const phone = String(c.phone || "").normalize("NFKC").replace(/\D/g, "");
      return [
        phone.length >= 4 ? `電話…${phone.slice(-4)}` : "",
        head(c.address),
        readings.size > 1 ? head(c.furigana) : ""
      ].filter(Boolean).join("・");
    });
    group.forEach((c, n) => {
      // 名前は空白の違いが画面では見えにくいので、添える情報だけで重なりを判定する（同じグループの名前は compareKey で同じ）
      const clash = hintTexts.filter(h => compareKey(h) === compareKey(hintTexts[n])).length > 1;
      const number = clash ? `［同じ名前の${n + 1}人目］` : "";
      const label = `${c.name}${hintTexts[n] ? `（${hintTexts[n]}）` : ""}${number}`;
      names.set(c.customerId, { label, number });
    });
  });
  return names;
}

// 顧客の選択肢を作り直す。選んでいた顧客の名前が変わっていたら名前欄も今の名前にそろえ、
// 選んでいた顧客が消えていたら名前欄も空にする（名前欄と選択の食い違いを残さないため）
function refreshCustomerSelects() {
  const placeholder = "新しい顧客（名前欄に入力）";
  const names = customerDisplayNames();
  const opts = `<option value="">${placeholder}</option>` + customers.map(c => `<option value="${esc(c.customerId)}">${esc(names.get(c.customerId).label)}</option>`).join("");
  [["customerSelect", "name"], ["shipmentCustomerSelect", "shipmentName"]].forEach(([id, nameId]) => {
    const e = document.getElementById(id);
    const nameInput = document.getElementById(nameId);
    const old = e.value;
    e.innerHTML = opts;
    const c = findCustomer(old);
    if (c) {
      e.value = old;
      nameInput.value = c.name;
    } else if (old) {
      nameInput.value = "";
    }
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function getFormValues() {
  const s = document.getElementById("customerSelect");
  const legacy = document.getElementById("name").value.trim();
  return {
    variety: variety.value, month: month.value, name: legacy || customers.find(c => c.customerId === s.value)?.name || "", customerId: s.value || undefined, kg: Number(document.getElementById("kg").value), channel: document.getElementById("channel").value
  };
}

function addReservation() {
  if (!ensureFresh()) return;
  const r = getFormValues();
  if (!r.name) {
    notify("顧客を選択するか、名前を入力してください", "warn");
    return;
  }
  const mismatch = customerNameMismatch(r.customerId, r.name);
  if (mismatch) {
    notify(mismatch, "warn");
    return;
  }
  if (!r.kg || r.kg <= 0) {
    notify("kgを入力してください", "warn");
    return;
  }
  // 品種が空のまま保存すると、在庫や集計に入らず、請求書の単価も0円になるため止める
  if (!varieties.includes(r.variety)) {
    notify("品種を選んでください", "warn");
    return;
  }
  // 月が空のまま保存すると、ダッシュボードの月別の表や合計に入らないため止める
  if (!months.includes(r.month)) {
    notify("月を選んでください", "warn");
    return;
  }
  const linked = linkedShipmentCount(editingReservationId);
  const before = reservations.find(x => x.id === editingReservationId);
  // 顧客の登録が見つからない予約は、出荷が紐づいていても顧客を選び直せる（紐づいた出荷も一緒に移す。commitReservation）
  const customerMissing = !!before && !customerFor(before);
  // 紐づいた出荷を編集中だと、出荷のフォームに古い顧客が残って混乱するので、先に終わらせてもらう（確認を出す前に止める）
  if (linked && customerMissing && editingShipmentId !== null && linkedShipments(before.id).some(x => x.id === editingShipmentId)) {
    notify("この予約に紐づいている出荷を編集中です。出荷の編集を保存するかキャンセルしてから、予約を保存してください", "warn", 8000);
    return;
  }
  if (linked && before && !customerMissing && customerChangedSinceEditStart()) {
    notify(`この予約には出荷が${linked}件紐づいているため、顧客は変更できません。${customerRestoreHint()}顧客を変えるには、先に紐づいた出荷を編集して、対象の予約を「特定の予約に紐づけない」にしてください。`, "warn", 12000);
    return;
  }
  const checkStock = () => {
    const warning = stockWarning(r, editingReservationId);
    if (warning) {
      confirmThen(warning, () => commitReservation(r));
    } else {
      commitReservation(r);
    }
  };
  const checkVariety = () => {
    if (linked && before && !sameVariety(before.variety, r.variety)) {
      confirmThen(`この予約には出荷が${linked}件紐づいています。\n\n品種：${varietyLabel(before.variety)} → ${varietyLabel(r.variety)}\n\n紐づいた出荷の品種は変わらないため、予約と出荷の品種が食い違います。このまま保存しますか？`, checkStock);
    } else {
      checkStock();
    }
  };
  const checkMoveShipments = () => {
    if (!linked || !customerMissing) {
      checkVariety();
      return;
    }
    const linkedList = linkedShipments(before.id);
    // 選んだ顧客（いなければ、保存のときに新しく登録される）
    const chosen = r.customerId ? findCustomer(r.customerId) : customersNamed(r.name)[0];
    // 紐づいた出荷の中に、登録済みの別の顧客の出荷があれば止める（その人の正しい出荷を、別の人に移さないため）
    const others = [...new Set(linkedList.map(customerFor).filter(c => c && c !== chosen))];
    if (others.length) {
      const labels = customerDisplayNames();
      const list = others.map(c => `「${labels.get(c.customerId).label}」`).join("");
      // 別の人が1人なら、その人を選べば保存できる。2人以上なら、どの人を選んでもほかの人の出荷が残るので、先に紐づけを外してもらう
      const next = others.length === 1
        ? `同じ人なら、顧客の欄で${list}を選んでください`
        : "先に「出荷管理」で、この予約の顧客にしない人の出荷を「編集」し、対象の予約を「特定の予約に紐づけない」にしてください";
      notify(`紐づいている出荷に、${list}の出荷があります。その人の出荷を別の顧客に移さないよう、保存を止めました。${next}`, "warn", 12000);
      return;
    }
    const chosenText = chosen ? `「${customerDisplayNames().get(chosen.customerId).label}」` : `「${r.name}」（新しい顧客として顧客管理に登録します）`;
    const reason = before.customerId ? "この予約の顧客の登録が見つからないため" : "この予約は顧客管理に登録されていない名前のため";
    const nowNames = [...new Set(linkedList.map(x => customerFor(x)?.name || `${x.name || "名前なし"}（登録なし）`))].join("、");
    confirmThen(`${reason}、顧客を${chosenText}にします。\n\n紐づいている出荷${linked}件の顧客も同じ顧客にそろえ、予約との紐づけはそのまま残します（今の出荷の顧客：${nowNames}）。\nこのまま保存しますか？`, checkVariety);
  };
  confirmNewCustomerThen(r, checkMoveShipments);
}

// 編集を始めたときから、利用者が顧客を変えたか（フォームの値で判定する。保存データの顧客の引き当て方の違いで誤判定しないため）
function customerChangedSinceEditStart() {
  if (!editStartCustomer) return false;
  const id = document.getElementById("customerSelect").value;
  if (editStartCustomer.id || id) return id !== editStartCustomer.id;
  return document.getElementById("name").value.trim() !== editStartCustomer.name;
}

// 顧客の変更を止めたときに、どう戻せばよいかを伝える文
function customerRestoreHint() {
  const before = editStartCustomer.id;
  const now = document.getElementById("customerSelect").value;
  const label = id => findCustomer(id)?.name || editStartCustomer.name;
  if (!before && now) return `変えるつもりがなければ、顧客の選択を外して（未選択に戻して）、名前欄を「${editStartCustomer.name}」にしてください。`;
  if (before && !now) return `顧客の選択が外れています。変えるつもりがなければ、顧客を「${label(before)}」に選び直してください。`;
  if (before) return `（顧客：${label(before)} → ${label(now)}）変えるつもりがなければ、顧客を「${label(before)}」に選び直してください。`;
  return `（名前：${editStartCustomer.name} → ${document.getElementById("name").value.trim()}）変えるつもりがなければ、名前欄を「${editStartCustomer.name}」に戻してください。`;
}

function commitReservation(r) {
  if (editingReservationId !== null && !reservations.some(x => x.id === editingReservationId)) {
    notify("編集中の予約が見つかりません（削除された可能性があります）。編集を取り消しました。", "warn");
    cancelEdit();
    refreshAll();
    return;
  }
  // 顧客の登録が見つからない予約だったかを、顧客を結びつける前に調べておく
  const before = reservations.find(x => x.id === editingReservationId);
  const customerWasMissing = !!before && !customerFor(before);
  const newCustomer = linkOrCreateCustomer(r);
  // 顧客の登録が見つからなかった予約の顧客を選び直したら、紐づいた出荷も同じ顧客に移す
  // （予約と出荷の顧客がそろっていないと、出荷の編集で「対象の予約」を選べなくなるため）
  // 移すのは、登録が見つからない出荷と、名前だけで同じ顧客につながっている出荷だけ（登録済みの別の顧客の出荷は動かさない。addReservation で止めている）
  const moved = customerWasMissing && r.customerId ? linkedShipments(before.id).filter(x => !customerFor(x) || customerFor(x).customerId === r.customerId) : [];
  const owner = findCustomer(r.customerId);
  moved.forEach(s => {
    s.customerId = r.customerId;
    s.name = owner ? owner.name : r.name;
  });
  if (editingReservationId === null) {
    r.id = uid("reservation");
    r.status = "received";
    reservations.push(r);
  } else {
    const i = reservations.findIndex(x => x.id === editingReservationId);
    r.id = editingReservationId;
    r.status = statusOf(reservations[i]);
    reservations[i] = r;
    cancelEdit();
  }
  if (newCustomer || moved.length) {
    saveIdLinkedData();
  } else {
    save("reservations", reservations);
  }
  if (moved.length) notify(`紐づいている出荷${moved.length}件の顧客も「${owner ? owner.name : r.name}」に変えました`, "info", 8000);
  clearReservation();
  refreshAll();
  notifyNewCustomer(newCustomer);
}

function editReservation(i) {
  const r = reservations[i];
  editingReservationId = r.id;
  document.getElementById("variety").value = r.variety;
  document.getElementById("month").value = r.month;
  document.getElementById("kg").value = r.kg;
  document.getElementById("channel").value = channelOf(r);
  const customer = findCustomer(r.customerId || customerFor(r)?.customerId);
  document.getElementById("customerSelect").value = customer ? customer.customerId : "";
  // 顧客が選ばれるときは名前欄を今の顧客名にそろえる（顧客名を後から変えていても保存で止まらないように）
  document.getElementById("name").value = customer ? customer.name : r.name || "";
  editStartCustomer = { id: document.getElementById("customerSelect").value, name: document.getElementById("name").value.trim() };
  updateCustomerLockNote();
  document.getElementById("submitButton").textContent = "変更を保存";
  document.getElementById("cancelEditButton").hidden = false;
}

function cancelEdit() {
  editingReservationId = null;
  editStartCustomer = null;
  clearReservation();
  document.getElementById("channel").value = "";
  document.getElementById("submitButton").textContent = "予約を追加";
  document.getElementById("cancelEditButton").hidden = true;
  updateCustomerLockNote();
}

// 予約の顧客の登録が見つからない（顧客の id はあるのにその顧客がいない、または名前だけで同じ名前の顧客がいない）か
function reservationCustomerMissing(reservationId) {
  const r = reservations.find(x => x.id === reservationId);
  return !!r && !customerFor(r);
}

// 出荷が紐づいている予約を編集している間は、顧客欄の下に「顧客は変更できません」と出しておく
function updateCustomerLockNote() {
  const note = document.getElementById("customerLockNote");
  // 古い index.html が残っていて要素が無いときは何もしない（ここで止まると予約の保存まで止まるため）
  if (!note) return;
  const count = linkedShipmentCount(editingReservationId);
  note.hidden = !count;
  note.textContent = "";
  if (!count) return;
  if (reservationCustomerMissing(editingReservationId)) {
    const r = reservations.find(x => x.id === editingReservationId);
    const reason = r.customerId ? "顧客の登録が見つからないため" : "顧客管理に登録されていない名前のため";
    note.textContent = `${reason}、顧客を選び直せます（紐づいた出荷${count}件の顧客も一緒に変わります）`;
    return;
  }
  // 画面が狭いときは「、」のところで折り返すように、2つに分けて入れる
  [`出荷が${count}件紐づいているため、`, "顧客は変更できません"].forEach(text => {
    const span = document.createElement("span");
    span.textContent = text;
    note.appendChild(span);
  });
}

function clearReservation() {
  // 入力をやり直すときは、名前欄の確認で「別の人」と答えた記録も消す
  declinedSameNames.clear();
  document.getElementById("name").value = "";
  document.getElementById("kg").value = "";
  document.getElementById("customerSelect").value = "";
  // 品種が無い古い予約を編集した後は品種欄が空になっているので、先頭の品種に戻す
  if (!varieties.includes(variety.value)) variety.value = varieties[0];
  // 月が無い古い予約を編集した後は月の欄が空になっているので、先頭の月に戻す
  const monthSelect = document.getElementById("month");
  if (!months.includes(monthSelect.value)) monthSelect.value = months[0];
}

// 予約に紐づいている出荷の一覧と件数（予約の顧客変更・削除を止めるかどうかの判断に使う）
function linkedShipments(reservationId) {
  return reservationId ? shipments.filter(s => s.reservationId === reservationId) : [];
}

function linkedShipmentCount(reservationId) {
  return linkedShipments(reservationId).length;
}

// 出荷が紐づいている予約は削除できないことを知らせる。削除できないときは true を返す
function blockDeleteIfLinked(reservationId) {
  const linked = linkedShipments(reservationId);
  if (!linked.length) return false;
  // どの出荷を直せばよいか分かるように、出荷日・品種・kg を並べる（多いときは先頭の5件まで）
  const list = linked.slice(0, 5).map(s => `${s.date || "日付なし"}・${varietyLabel(s.variety)}・${formatKg(s.kg)}`).join("、");
  const more = linked.length > 5 ? `ほか${linked.length - 5}件` : "";
  notify(`この予約には出荷が${linked.length}件紐づいているため、削除できません（${list}${more}）。削除するには、先に「出荷管理」でこれらの出荷を編集して対象の予約を「特定の予約に紐づけない」にするか、その出荷を削除してください。`, "warn", 15000);
  return true;
}

function deleteReservation(i) {
  if (!ensureFresh()) return;
  const targetId = reservations[i].id;
  // 出荷が紐づいた予約を消すと、出荷に存在しない予約の id が残り、紐づけが知らないうちに外れてしまうため止める
  if (blockDeleteIfLinked(targetId)) return;
  confirmThen("この予約を削除しますか？", () => {
    const index = reservations.findIndex(x => x.id === targetId);
    if (index === -1) return;
    // 念のための再確認（今は、確認中に別のタブで変わった場合は confirmThen が先に止める）
    if (blockDeleteIfLinked(targetId)) return;
    reservations.splice(index, 1);
    if (targetId === editingReservationId) cancelEdit();
    save("reservations", reservations);
    refreshAll();
  });
}

function totals(list, filter) {
  const r = {};
  list.filter(filter || (() => true)).forEach(x => {
    const key = x.variety || "";
    r[key] = (r[key] || 0) + (Number(x.kg) || 0);
  });
  return r;
}

function getReservedTotals() {
  return totals(reservations);
}

function getShippedTotals() {
  return totals(shipments);
}

function getVisibleReservations() {
  const q = document.getElementById("searchName").value.trim();
  const fv = document.getElementById("filterVariety").value;
  const fm = document.getElementById("filterMonth").value;
  const fc = document.getElementById("filterChannel").value;
  const fs = document.getElementById("filterStatus").value;
  const sortMode = document.getElementById("reservationSort").value;
  return reservations.map((r, i) => ({ r, i })).filter(({ r }) => !(q && !customerName(r).includes(q) && !(r.name || "").includes(q) || fv && r.variety !== fv || fm && r.month !== fm || fc && channelOf(r) !== (fc === "__none" ? "" : fc) || fs && statusOf(r) !== fs)).sort(reservationComparator(sortMode));
}

function displayReservations() {
  const body = document.getElementById("reservationList");
  body.innerHTML = "";
  getVisibleReservations().forEach(({ r, i }) => {
    const tr = document.createElement("tr");
    [varietyLabel(r.variety), monthLabel(r.month), customerName(r), formatKg(r.kg)].forEach((v, n) => {
      const td = document.createElement("td");
      td.textContent = v;
      td.dataset.label = ["品種", "月", "名前", "kg"][n];
      tr.appendChild(td);
    });
    const linkTd = document.createElement("td");
    linkTd.dataset.label = "紐づく出荷";
    const linkedKg = shippedForReservation(r);
    linkTd.textContent = shipments.some(x => x.reservationId === r.id) ? `${formatKg(linkedKg)} / ${formatKg(r.kg)}` : "－";
    tr.appendChild(linkTd);
    const channelTd = document.createElement("td");
    channelTd.dataset.label = "受付経路";
    channelTd.textContent = channelOf(r) || "未設定";
    tr.appendChild(channelTd);
    const statusTd = document.createElement("td");
    statusTd.dataset.label = "状態";
    const sel = document.createElement("select");
    sel.className = `status-select status-${statusOf(r)}`;
    sel.setAttribute("aria-label", "予約の状態");
    STATUS_KEYS.forEach(k => {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = STATUSES[k];
      sel.appendChild(o);
    });
    sel.value = statusOf(r);
    sel.onchange = e => {
      // 止めたときは、選択欄を保存してある状態に戻す（変えたあとの値のまま残ると、保存できたように見えるため）
      if (!ensureFresh()) {
        refreshAll();
        return;
      }
      reservations[i].status = e.target.value;
      save("reservations", reservations);
      refreshAll();
    };
    statusTd.appendChild(sel);
    tr.appendChild(statusTd);
    const td = document.createElement("td");
    td.className = "action-cell";
    td.innerHTML = '<button class="edit-button">編集</button><button class="delete-button">削除</button>';
    td.children[0].onclick = () => editReservation(i);
    td.children[1].onclick = () => deleteReservation(i);
    tr.appendChild(td);
    body.appendChild(tr);
  });
  if (!body.children.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty-message">${reservations.length ? "条件に合う予約がありません" : "まだ予約がありません"}</td></tr>`;
  }
  const sums = {};
  reservations.forEach(r => {
    const k = `${r.variety || ""}_${r.month || ""}`;
    sums[k] = (sums[k] || 0) + (Number(r.kg) || 0);
  });
  document.getElementById("summary").innerHTML = Object.entries(sums).sort(([a], [b]) => {
    const [va, ma] = a.split("_");
    const [vb, mb] = b.split("_");
    return varieties.indexOf(va) - varieties.indexOf(vb) || monthNumber(ma) - monthNumber(mb);
  }).map(([k, v]) => {
    const [variety, month] = k.split("_");
    return `<div class="summary-item">${esc(varietyLabel(variety))}　${esc(monthLabel(month))}　${formatKg(v)}</div>`;
  }).join("") || '<div class="empty-message">まだ予約がありません</div>';
}

// 予約・出荷の kg の合計
function sumKg(list) {
  return list.reduce((a, x) => a + (Number(x.kg) || 0), 0);
}

// 品種が入っていない（または A〜F 以外の不明な）予約・出荷を抜き出す。
// ダッシュボード・在庫管理・出荷集計で同じ数え方にするため、ここにまとめる
function unknownVarietyItems(list) {
  return list.filter(x => !varieties.includes(x.variety));
}

function displayDashboard() {
  // 合計は、品種や月が入っていない古い予約も含めて、すべての予約から数える
  // （以前は A〜F・1月〜12月の予約だけを数えていたため、未出荷量が少なく出たり、在庫管理の予約量と合わなかったりした）
  const rows = varieties.map(v => ({ label: v, list: reservations.filter(r => r.variety === v) }));
  const unknownVariety = unknownVarietyItems(reservations);
  if (unknownVariety.length) rows.push({ label: "品種なし・不明", list: unknownVariety });
  let html = rows.map(({ label, list }) => `<tr><th>${esc(label)}</th>` + months.map(m => `<td>${formatKg(sumKg(list.filter(r => r.month === m)))}</td>`).join("") + `<td>${formatKg(sumKg(list))}</td></tr>`).join("");
  const grand = sumKg(reservations);
  html += `<tr class="grand-total-row"><th>全体</th>${months.map(m => `<td>${formatKg(sumKg(reservations.filter(r => r.month === m)))}</td>`).join("")}<td>${formatKg(grand)}</td></tr>`;
  document.getElementById("dashboardTableBody").innerHTML = html;
  // 月が入っていない予約は月別の欄には出せないので、合計にだけ入っていることを知らせる
  const noMonth = reservations.filter(r => !months.includes(r.month));
  const note = document.getElementById("dashboardNote");
  if (note) {
    note.hidden = !noMonth.length;
    note.textContent = noMonth.length ? `月が入っていない予約が${noMonth.length}件（${formatKg(sumKg(noMonth))}）あります。月別の欄には入らず、合計にだけ入っています。予約一覧で「月なし」の予約を編集して月を選んでください。` : "";
  }
  document.getElementById("dashboardTotal").textContent = formatKg(grand);
  const rc = new Set(reservations.map(customerKey));
  const sc = new Set(shipments.map(customerKey));
  document.getElementById("dashboardCustomers").textContent = `${customers.length}人`;
  document.getElementById("dashboardReservationCustomerCount").textContent = `${rc.size}人`;
  document.getElementById("dashboardShipmentCustomerCount").textContent = `${sc.size}人`;
  document.getElementById("dashboardInventory").textContent = formatKg(varieties.reduce((a, v) => a + (Number(inventory[v]) || 0), 0));
  document.getElementById("dashboardShipments").textContent = formatKg(getShippedTotalsAll());
  // 未出荷量は品種ごとの残りの合計（出荷集計の「未出荷」列の合計と同じ）
  const unshipped = unshippedByVariety(reservations, shipments);
  document.getElementById("dashboardUnshippedTotal").textContent = formatKg(unshipped.remaining);
  const unshippedNote = document.getElementById("dashboardUnshippedNote");
  if (unshippedNote) {
    unshippedNote.hidden = unshipped.over <= 0;
    unshippedNote.textContent = unshipped.over > 0 ? `予約より多く出荷した品種があります（合計${formatKg(unshipped.over)}）` : "";
  }
  document.getElementById("dashboardChannelBody").innerHTML = [...CHANNELS, ""].map(ch => {
    const list = reservations.filter(r => channelOf(r) === ch);
    return `<tr><td>${ch ? esc(ch) : "未設定"}</td><td>${list.length}件</td><td>${formatKg(sumKg(list))}</td></tr>`;
  }).join("");
  document.getElementById("dashboardStatusBody").innerHTML = STATUS_KEYS.map(k => {
    const list = reservations.filter(r => statusOf(r) === k);
    return `<tr><td><span class="badge badge-${k}">${STATUSES[k]}</span></td><td>${list.length}件</td><td>${formatKg(sumKg(list))}</td></tr>`;
  }).join("");
}

function getShippedTotalsAll() {
  return shipments.reduce((a, s) => a + (Number(s.kg) || 0), 0);
}

function displayInventory() {
  const reserved = getReservedTotals();
  const shipped = getShippedTotals();
  const used = stockMode === "reserved" ? reserved : shipped;
  const info = STOCK_MODES[stockMode];
  document.querySelectorAll(".mode-button").forEach(btn => {
    const on = btn.dataset.mode === stockMode;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  document.getElementById("stockRemainHeader").innerHTML = `残り在庫<br><small>${info.basis}</small>`;
  document.getElementById("stockModeHelp").textContent = `${info.help}残りが${LOW_STOCK_THRESHOLD}kg未満で「在庫少」、0kg未満で「在庫不足」と表示します。`;
  document.getElementById("priceHelp").textContent = "納品書・請求書に使う、品種ごとの単価（1kgあたりの金額）です。0円のままでも記録できます。";
  const body = document.getElementById("inventoryList");
  body.innerHTML = "";
  varieties.forEach(v => {
    const remain = inventory[v] - (used[v] || 0);
    const tr = document.createElement("tr");
    tr.className = remain < 0 ? "stock-shortage" : remain < LOW_STOCK_THRESHOLD ? "stock-low" : "";
    tr.innerHTML = `<th>${v}</th><td data-label="在庫量"><input type="number" min="0" value="${inventory[v]}" aria-label="${v}の在庫量(kg)"></td><td data-label="予約量">${formatKg(reserved[v])}</td><td data-label="単価(円/kg)"><input type="number" min="0" step="0.01" value="${prices[v]}" class="price-input" aria-label="${v}の単価(円/kg)"></td><td data-label="残り在庫">${formatKg(remain)}</td><td>${remain < 0 ? '<span class="badge badge-shortage">在庫不足</span>' : remain < LOW_STOCK_THRESHOLD ? '<span class="badge badge-low">在庫少</span>' : '<span class="badge badge-ok">在庫あり</span>'}</td>`;
    // 止めたときは、欄を保存してある値に戻す（入れた値のまま残ると、保存できたように見えるため）
    tr.querySelector("input").onchange = e => {
      if (!ensureFresh()) {
        refreshAll();
        return;
      }
      inventory[v] = Math.max(0, Number(e.target.value) || 0);
      save(INVENTORY_STORAGE_KEY, inventory);
      refreshAll();
    };
    tr.querySelector(".price-input").onchange = e => {
      if (!ensureFresh()) {
        refreshAll();
        return;
      }
      prices[v] = Math.max(0, Number(e.target.value) || 0);
      save(PRICES_STORAGE_KEY, prices);
      refreshAll();
    };
    body.appendChild(tr);
  });
  displayUnknownVarietyStock(body);
}

// 品種が入っていない（または不明な）予約・出荷は、どの品種の在庫とも結びつけられない。
// 表から消えてしまわないように「品種なし」の行（不明な品種も含む）を足し、表の下で理由と直し方を知らせる
function displayUnknownVarietyStock(body) {
  const unknownReservations = unknownVarietyItems(reservations);
  const unknownShipments = unknownVarietyItems(shipments);
  if (unknownReservations.length) {
    const tr = document.createElement("tr");
    tr.className = "stock-unknown";
    tr.innerHTML = '<th>品種なし</th><td data-label="在庫量">—</td><td data-label="予約量"></td><td data-label="単価(円/kg)">—</td><td data-label="残り在庫">—</td><td><span class="badge badge-low">要確認</span></td>';
    tr.querySelector('[data-label="予約量"]').textContent = formatKg(sumKg(unknownReservations));
    body.appendChild(tr);
  }
  const note = document.getElementById("inventoryNote");
  if (!note) return;
  const lines = [];
  if (unknownReservations.length) lines.push(`品種が入っていない（または不明な）予約が${unknownReservations.length}件（${formatKg(sumKg(unknownReservations))}）あり、表の「品種なし」の行にまとめています。どの品種の在庫とも結びつけられないため、A〜F の行の予約量や残り在庫には入っていません。「予約登録・一覧」でこれらの予約を編集して品種を選んでください。`);
  if (unknownShipments.length) lines.push(`品種が入っていない（または不明な）出荷が${unknownShipments.length}件（${formatKg(sumKg(unknownShipments))}）あります。品種ごとの出荷量に入らないため、出荷ベースの残り在庫にも反映されていません。「出荷管理」でこれらの出荷を編集して品種を選んでください。`);
  note.hidden = !lines.length;
  note.textContent = lines.join("\n");
}

function shipmentValues() {
  const s = document.getElementById("shipmentCustomerSelect");
  const legacy = document.getElementById("shipmentName").value.trim();
  return {
    variety: shipmentVariety.value, date: shipmentDate.value, name: legacy || customers.find(c => c.customerId === s.value)?.name || "", customerId: s.value || undefined, kg: Number(shipmentKg.value), memo: shipmentMemo.value.trim(), reservationId: document.getElementById("shipmentReservation").value || undefined
  };
}

function addShipment() {
  if (!ensureFresh()) return;
  const s = shipmentValues();
  if (!s.date || !s.name || !s.kg || s.kg <= 0) {
    notify("出荷日・顧客・出荷kgを入力してください", "warn");
    return;
  }
  const mismatch = customerNameMismatch(s.customerId, s.name);
  if (mismatch) {
    notify(mismatch, "warn");
    return;
  }
  if (s.reservationId) {
    const linked = reservations.find(x => x.id === s.reservationId);
    if (!linked || !s.customerId || customerFor(linked)?.customerId !== s.customerId) {
      notify("選んだ「対象の予約」がこの顧客の予約ではありません。顧客と対象の予約を選び直してください", "warn");
      refreshShipmentReservationOptions();
      return;
    }
    if (!varieties.includes(linked.variety)) {
      notify("この予約には品種がありません。先に「予約登録・一覧」で予約を編集して品種を設定してください", "warn");
      return;
    }
    if (!sameVariety(linked.variety, s.variety)) {
      notify(`出荷の品種「${varietyLabel(s.variety)}」が、選んだ予約の品種「${varietyLabel(linked.variety)}」と違います。品種か対象の予約を確かめてください`, "warn");
      return;
    }
  }
  // 品種が空のまま保存すると、在庫や集計に入らず、請求書の単価も0円になるため止める
  if (!varieties.includes(s.variety)) {
    notify("品種を選んでください", "warn");
    return;
  }
  // 編集で品種が変わるときは、保存する前に必ず確かめる（予約に合わせて自動で変わった場合に気づけるように）
  const original = editingShipmentId === null ? null : shipments.find(x => x.id === editingShipmentId);
  // 確認が要るものを、後ろから順に重ねていく（実行は 名前 → 予約の紐づけ → 品種 → 保存 の順）
  let proceed = () => commitShipment(s);
  if (original && !sameVariety(original.variety, s.variety)) {
    const hint = s.reservationId ? "\n\n品種は、紐づけた予約に合わせています。元の品種のままにするなら「キャンセル」を押し、対象の予約を「特定の予約に紐づけない」にしてから品種を選び直してください。" : "";
    const next = proceed;
    proceed = () => confirmThen(`この出荷の品種を「${varietyLabel(original.variety)}」から「${varietyLabel(s.variety)}」に変えて保存しますか？${hint}`, next);
  }
  // 編集で予約との紐づけが外れる・変わるときは、黙って外さずに確かめる（予約の「出荷済みの量」が変わるため）
  if (original && original.reservationId && original.reservationId !== s.reservationId) {
    const next = proceed;
    const message = reservations.some(x => x.id === original.reservationId)
      ? `${reservationLinkText(original.reservationId)}\n\nこの出荷と予約との紐づけが${s.reservationId ? "別の予約に変わります" : "外れます"}。その予約の「出荷済みの量」から、この出荷の分が減ります。このまま保存しますか？`
      : "この出荷が紐づいていた予約は見つかりません（削除された可能性があります）。見つからない予約との紐づけを外して保存しますか？";
    proceed = () => confirmThen(message, next);
  }
  confirmNewCustomerThen(s, proceed);
}

// 出荷の編集で、紐づいていた予約を「対象の予約」に選べなかった理由を説明する文
function unselectableReservationReason(reservationId) {
  const r = reservations.find(x => x.id === reservationId);
  if (!r) return "この出荷が紐づいていた予約が見つかりません（削除された可能性があります）。";
  const where = `（${reservationLinkText(reservationId)}）`;
  if (!shipmentCustomerSelect.value) return `この出荷の顧客の登録が見つからないため、紐づいていた予約を「対象の予約」に選べません${where}。`;
  const owner = customerFor(r);
  // 予約側を直すときに選ぶべき顧客（この出荷の顧客。ほかの人を選ぶと、この出荷を動かさないよう予約の保存で止まる）
  const fix = `直すには、この編集をキャンセルし、先に予約を「編集」して顧客を「${customerDisplayNames().get(shipmentCustomerSelect.value)?.label || ""}」にしてください（紐づけは残ります）。`;
  if (!owner && !r.customerId) return `紐づいていた予約は、顧客管理に登録されていない名前「${r.name || "名前なし"}」の予約のため、「対象の予約」に選べません${where}。${fix}`;
  if (!owner) return `紐づいていた予約の顧客の登録が見つからないため、その予約を「対象の予約」に選べません${where}。${fix}`;
  return `紐づいていた予約の顧客「${owner.name}」が、この出荷の顧客と違うため、その予約を「対象の予約」に選べません${where}。`;
}

// 出荷が今紐づいている予約を、確認文や案内で見せるための文
function reservationLinkText(reservationId) {
  const r = reservations.find(x => x.id === reservationId);
  return r ? `今の紐づけ先の予約：${varietyLabel(r.variety)}・${monthLabel(r.month)}・${formatKg(r.kg)}` : "今の紐づけ先の予約は見つかりません（削除された可能性があります）";
}

function commitShipment(s) {
  if (editingShipmentId !== null && !shipments.some(x => x.id === editingShipmentId)) {
    notify("編集中の出荷が見つかりません（削除された可能性があります）。編集を取り消しました。", "warn");
    cancelShipmentEdit();
    refreshAll();
    return;
  }
  const newCustomer = linkOrCreateCustomer(s);
  if (editingShipmentId === null) {
    s.id = uid("shipment");
    shipments.push(s);
  } else {
    const i = shipments.findIndex(x => x.id === editingShipmentId);
    s.id = editingShipmentId;
    shipments[i] = s;
    cancelShipmentEdit();
  }
  if (newCustomer) {
    saveIdLinkedData();
    // 新しい顧客を選択肢に入れてから、下でその顧客を選んだままにする
    refreshCustomerSelects();
    notifyNewCustomer(newCustomer);
  } else {
    save(SHIPMENTS_STORAGE_KEY, shipments);
  }
  if (s.reservationId) {
    const linked = reservations.find(x => x.id === s.reservationId);
    if (linked && statusOf(linked) !== "shipped" && remainingForReservation(linked) <= 0) {
      const linkedId = linked.id;
      confirmThen(`「${varietyLabel(linked.variety)}・${monthLabel(linked.month)}・${formatKg(linked.kg)}」の予約は、紐づけられた出荷の合計で出荷し終えたようです。\n状態を「出荷済み」にしますか？`, () => {
        const target = reservations.find(x => x.id === linkedId);
        if (!target) return;
        target.status = "shipped";
        save("reservations", reservations);
        refreshAll();
      });
    }
  }
  // 同じ顧客の出荷を続けて登録しやすいように、顧客の選択は残す
  clearShipmentForm(s.customerId);
  refreshAll();
}

function editShipment(i) {
  const s = shipments[i];
  editingShipmentId = s.id;
  shipmentVariety.value = s.variety;
  shipmentDate.value = s.date;
  shipmentKg.value = s.kg;
  shipmentMemo.value = s.memo || "";
  const customer = findCustomer(s.customerId || customerFor(s)?.customerId);
  shipmentCustomerSelect.value = customer ? customer.customerId : "";
  // 顧客が選ばれるときは名前欄を今の顧客名にそろえる（顧客名を後から変えていても保存で止まらないように）
  shipmentName.value = customer ? customer.name : s.name || "";
  refreshShipmentReservationOptions(s.reservationId);
  // 顧客の登録が見つからないなどで、紐づいていた予約を「対象の予約」に選べないときは、先に知らせる
  if (s.reservationId && document.getElementById("shipmentReservation").value !== s.reservationId) {
    notify(`${unselectableReservationReason(s.reservationId)}このまま保存すると紐づけが外れます（保存の前に確認が出ます）。`, "warn", 12000);
  }
  // 予約に紐づいている（品種欄が予約に合わせて固定されている）ときだけ、品種の食い違いを知らせる
  if (shipmentVariety.disabled && !sameVariety(shipmentVariety.value, s.variety)) {
    notify(`この出荷は、紐づけた予約と品種が違います（出荷「${varietyLabel(s.variety)}」／予約「${varietyLabel(shipmentVariety.value)}」）。品種を予約に合わせて「${varietyLabel(shipmentVariety.value)}」にしました。元の品種のままにするなら、対象の予約を「特定の予約に紐づけない」にしてから品種を選び直してください`, "warn", 12000);
  }
  shipmentSubmitButton.textContent = "変更を保存";
  cancelShipmentEditButton.hidden = false;
}

function cancelShipmentEdit() {
  editingShipmentId = null;
  clearShipmentForm();
  shipmentSubmitButton.textContent = "出荷を登録";
  cancelShipmentEditButton.hidden = true;
}

// keepCustomerId を渡すと、その顧客を選んだままにする（省略すると顧客の選択も空にする）
function clearShipmentForm(keepCustomerId = "") {
  declinedSameNames.clear();
  ["shipmentKg", "shipmentMemo"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("shipmentDate").value = todayString();
  // 先に顧客の選択を決めてから、予約の選択肢をその顧客の最新の予約で作り直す（前の顧客の予約を残さない）
  const customer = findCustomer(keepCustomerId);
  shipmentCustomerSelect.value = customer ? customer.customerId : "";
  shipmentName.value = customer ? customer.name : "";
  refreshShipmentReservationOptions();
}

function deleteShipment(i) {
  if (!ensureFresh()) return;
  const targetId = shipments[i].id;
  confirmThen("この出荷データを削除しますか？", () => {
    const index = shipments.findIndex(x => x.id === targetId);
    if (index === -1) return;
    shipments.splice(index, 1);
    if (targetId === editingShipmentId) cancelShipmentEdit();
    save(SHIPMENTS_STORAGE_KEY, shipments);
    refreshAll();
  });
}

function getVisibleShipments() {
  const mode = document.getElementById("shipmentSort").value;
  return shipments.map((s, i) => ({ s, i })).sort(shipmentComparator(mode));
}

function displayShipments() {
  displayVarietyMismatches();
  const b = document.getElementById("shipmentList");
  b.innerHTML = "";
  getVisibleShipments().forEach(({ s, i }) => {
    const tr = document.createElement("tr");
    [s.date, varietyLabel(s.variety), customerName(s), formatKg(s.kg), s.memo || ""].forEach((v, n) => {
      const td = document.createElement("td");
      td.textContent = v;
      td.dataset.label = ["出荷日", "品種", "顧客", "kg", "メモ"][n];
      tr.appendChild(td);
    });
    const td = document.createElement("td");
    td.className = "action-cell";
    td.innerHTML = '<button class="edit-button">編集</button><button class="delete-button">削除</button>';
    td.children[0].onclick = () => editShipment(i);
    td.children[1].onclick = () => deleteShipment(i);
    tr.appendChild(td);
    b.appendChild(tr);
  });
  if (!b.children.length) {
    b.innerHTML = '<tr><td colspan="6" class="empty-message">まだ出荷の記録がありません</td></tr>';
  }
  const r = getReservedTotals();
  const s = getShippedTotals();
  const body = document.getElementById("shipmentSummaryBody");
  const rows = varieties.map(v => `<tr><th>${v}</th><td>${formatKg(inventory[v])}</td><td>${formatKg(r[v])}</td><td>${formatKg(s[v])}</td><td>${unshippedCellHtml(r[v], s[v])}</td></tr>`);
  // 品種が入っていない（または不明な）予約・出荷も、表から消えないように「品種なし」の行にまとめる（在庫とは結びつけられないので在庫量は「—」）
  const unknownReservations = unknownVarietyItems(reservations);
  const unknownShipments = unknownVarietyItems(shipments);
  if (unknownReservations.length || unknownShipments.length) {
    const unknownReserved = sumKg(unknownReservations);
    const unknownShipped = sumKg(unknownShipments);
    rows.push(`<tr class="stock-unknown"><th>品種なし</th><td>—</td><td>${formatKg(unknownReserved)}</td><td>${formatKg(unknownShipped)}</td><td>${unshippedCellHtml(unknownReserved, unknownShipped)}</td></tr>`);
  }
  body.innerHTML = rows.join("");
}

// 顧客の未出荷の表示。出荷し終えていれば「出荷完了」、予約より多く出荷していればその量も添える
// 未出荷は品種ごとの残りの合計。残りがあれば「未完」と残りの kg、すべての品種で残りが0なら「出荷完了」を出す。
// スマホの表ではマスの中身が横に並ぶので、1つの span にまとめて、補足がバッジや数字の下に来るようにする
function unshippedCell(stats) {
  const main = stats.unshipped > 0
    ? `<span class="badge badge-pending">未完</span> ${formatKg(stats.unshipped)}`
    : '<span class="badge badge-done">出荷完了</span>';
  const note = stats.overShipped > 0
    ? `<small class="over-shipped">${stats.unshipped > 0 ? "ほかに" : ""}予約より${formatKg(stats.overShipped)}多く出荷した品種あり</small>`
    : "";
  return `<span class="unshipped-value">${main}${note}</span>`;
}

function customerStats(c) {
  const rs = reservations.filter(r => customerFor(r)?.customerId === c.customerId);
  const ss = shipments.filter(s => customerFor(s)?.customerId === c.customerId);
  const byV = totals(rs);
  const shipV = totals(ss);
  const month = {};
  rs.forEach(r => {
    const key = r.month || "";
    month[key] = (month[key] || 0) + (Number(r.kg) || 0);
  });
  const reserved = sumKg(rs);
  const shipped = sumKg(ss);
  const { remaining, over, items } = unshippedByVariety(rs, ss);
  return {
    rs, ss, byV, shipV, month, reserved, shipped, unshipped: remaining, overShipped: over, unshippedItems: items
  };
}

function getVisibleCustomers() {
  const q = document.getElementById("customerSearch").value.trim();
  const sort = document.getElementById("customerSort").value;
  const arr = customers.map((c, i) => ({
    c, s: customerStats(c), originalIndex: i
  })).filter(({ c }) => [c.name, c.phone, c.address].join(" ").includes(q));
  arr.sort((a, b) => {
    if (sort === "recent") {
      return a.originalIndex - b.originalIndex;
    }
    if (sort === "reservations") {
      return b.s.reserved - a.s.reserved || String(a.c.furigana || a.c.name || "").localeCompare(String(b.c.furigana || b.c.name || ""), "ja");
    }
    return String(a.c.furigana || a.c.name || "").localeCompare(String(b.c.furigana || b.c.name || ""), "ja") || String(a.c.name || "").localeCompare(String(b.c.name || ""), "ja");
  });
  return arr;
}

function displayCustomers() {
  const arr = getVisibleCustomers();
  // 同じ名前の人を番号で見分けているときは、予約・出荷の顧客の欄と同じ番号を付ける（電話・住所は一覧の別の欄にあるので添えない）
  const names = customerDisplayNames();
  document.getElementById("customerList").innerHTML = arr.map(({ c, s }) => `<tr><td data-label="顧客名">${esc(c.name + names.get(c.customerId).number)}</td><td data-label="電話番号">${esc(c.phone)}</td><td data-label="住所">${esc(c.address)}</td><td data-label="メモ">${esc(c.memo)}</td><td data-label="予約合計">${formatKg(s.reserved)}</td><td data-label="出荷済み">${formatKg(s.shipped)}</td><td data-label="未出荷">${unshippedCell(s)}</td><td class="action-td"><button class="detail-button">詳細</button></td><td class="action-td"><button class="edit-button">編集</button></td><td class="action-td"><button class="delete-button">削除</button></td></tr>`).join("") || `<tr><td colspan="10" class="empty-message">${customers.length ? "条件に合う顧客がいません" : "まだ顧客が登録されていません"}</td></tr>`;
  // ボタンの処理は onclick 属性に顧客の id を書き込まず、ここで結びつける
  // （読み込んだバックアップの id に細工があっても、スクリプトとして動かないようにするため）
  const rows = document.getElementById("customerList").querySelectorAll("tr");
  arr.forEach(({ c }, n) => {
    const tr = rows[n];
    tr.querySelector(".detail-button").onclick = () => showCustomerDetail(c.customerId);
    tr.querySelector(".edit-button").onclick = () => editCustomer(c.customerId);
    tr.querySelector(".delete-button").onclick = () => deleteCustomer(c.customerId);
  });
}

// 「未出荷の顧客」タブ：顧客ごとの未出荷（品種ごとの残りの合計）が0より大きい顧客を、多い順に並べる
function displayUnshippedCustomers() {
  const body = document.getElementById("unshippedCustomerList");
  if (!body) return;
  const list = customers.map(c => ({ c, s: customerStats(c) })).filter(({ s }) => s.unshipped > 0).sort((a, b) => b.s.unshipped - a.s.unshipped);
  // 同じ名前の人を番号で見分けているときは、顧客一覧と同じ番号を付ける
  const names = customerDisplayNames();
  body.innerHTML = list.map(({ c, s }) => `<tr><td data-label="顧客名">${esc(c.name + names.get(c.customerId).number)}</td><td data-label="未出荷">${formatKg(s.unshipped)}</td><td data-label="内訳">${esc(s.unshippedItems.map(i => `${i.label} ${formatKg(i.kg)}`).join("、"))}</td><td data-label="電話番号">${esc(c.phone)}</td><td class="action-td"><button class="detail-button">詳細</button></td></tr>`).join("") || '<tr><td colspan="5" class="empty-message">未出荷の顧客はいません</td></tr>';
  // 「詳細」は顧客管理タブの詳細を開く（顧客の id は onclick 属性に書き込まず、ここで結びつける）
  const rows = body.querySelectorAll("tr");
  list.forEach(({ c }, n) => {
    rows[n].querySelector(".detail-button").onclick = () => {
      switchView("customersView");
      showCustomerDetail(c.customerId);
    };
  });
  const summary = document.getElementById("unshippedCustomerSummary");
  const total = roundKg(list.reduce((a, { s }) => a + s.unshipped, 0));
  if (summary) summary.textContent = list.length ? `未出荷の顧客：${list.length}人（合計${formatKg(total)}）` : "";
}

// 顧客に結びついていない予約・出荷を、「未出荷の顧客」タブに出す。予約・出荷ごとに「編集」「削除」を付ける。
// 名前だけのもの（同じ名前の顧客がいない）は名前ごとに、顧客の id はあるのにその顧客が見つからないものは顧客の id ごとにまとめ、
// 未出荷が残っているまとまりだけを出す
function displayUnlinkedUnshipped() {
  const section = document.getElementById("unlinkedSection");
  const box = document.getElementById("unlinkedList");
  if (!section || !box) return;
  const groups = new Map();
  const add = (item, kind) => {
    if (customerFor(item)) return;
    // 顧客の id が入っているのに、その顧客がいない（削除された・別の端末のデータなど）ものは、名前だけのものと分ける
    // （同じ名前の顧客を登録しても、id で探すため結びつかない）。判定は customerFor と同じく「id に中身があるか」で行う。
    // 別の人どうしの予約と出荷が差し引きされないよう、顧客の id ごとにまとめる
    const missingCustomer = Boolean(item.customerId);
    const rawName = String(item.name || "");
    const trimmed = rawName.trim();
    const key = missingCustomer ? `id:${item.customerId}` : `name:${trimmed}`;
    if (!groups.has(key)) {
      groups.set(key, { name: trimmed || "（名前なし）", noName: !trimmed, names: new Set(), missingCustomer, hasSpacedName: false, rs: [], ss: [] });
    }
    const g = groups.get(key);
    // 顧客の id ごとのまとまりでは、予約・出荷によって名前の書き方が違うことがあるので、出てきた名前をすべて覚えておく
    if (trimmed) g.names.add(trimmed);
    // 見出しの名前がまだ無ければ、名前の入った件で入れ直す（顧客の id ごとのまとまりで、最初の1件だけ名前が空の場合など）
    if (g.noName && trimmed) {
      g.name = trimmed;
      g.noName = false;
    }
    // 名前の前後に空白があると、顧客として登録しても（登録時に空白が取られるため）結びつかない
    if (rawName !== rawName.trim()) g.hasSpacedName = true;
    g[kind].push(item);
  };
  reservations.forEach(r => add(r, "rs"));
  shipments.forEach(s => add(s, "ss"));
  const list = [...groups.values()].map(g => ({ ...g, unshipped: unshippedByVariety(g.rs, g.ss) })).filter(g => g.unshipped.remaining > 0).sort((a, b) => b.unshipped.remaining - a.unshipped.remaining);
  box.innerHTML = "";
  section.hidden = !list.length;
  list.forEach(g => box.appendChild(unlinkedGroupElement(g)));
  // 上の一覧だけを見て「未出荷なし」と思わないように、未登録の分があることを上にも出す
  if (list.length) {
    const total = roundKg(list.reduce((a, g) => a + g.unshipped.remaining, 0));
    const note = `ほかに、顧客に結びついていない予約・出荷の未出荷が合計${formatKg(total)}あります（下に表示）`;
    const summary = document.getElementById("unshippedCustomerSummary");
    if (summary) summary.textContent = summary.textContent ? `${summary.textContent}／${note}` : note;
    const empty = document.querySelector("#unshippedCustomerList .empty-message");
    if (empty) empty.textContent = "登録済みの顧客には未出荷がありません";
  }
}

// 顧客が登録されていない名前1つ分の表示（利用者の入力は textContent で入れる）
function unlinkedGroupElement(g) {
  const wrap = document.createElement("section");
  wrap.className = "unlinked-group";
  const head = document.createElement("div");
  head.className = "unlinked-head";
  const title = document.createElement("strong");
  // 名前が何通りかあるときは、3つまで並べて、それより多ければ「ほか」を付ける
  const names = [...g.names];
  const shownName = names.length > 1 ? `${names.slice(0, 3).join("・")}${names.length > 3 ? " ほか" : ""}` : g.name;
  title.textContent = g.missingCustomer ? `${shownName}（顧客の登録が見つかりません）` : `${shownName}（顧客未登録）`;
  const amount = document.createElement("span");
  amount.textContent = `未出荷 ${formatKg(g.unshipped.remaining)}（${g.unshipped.items.map(i => `${i.label} ${formatKg(i.kg)}`).join("、")}）`;
  head.append(title, amount);
  // 空白や全角・半角の違いだけで同じ名前になる顧客がすでにいれば、その人の可能性が高いので、新しく登録せず編集で選んでもらう
  const similar = customers.filter(c => compareKey(c.name) === compareKey(g.name));
  let guide = "";
  if (g.missingCustomer) {
    guide = "登録されていた顧客が見つかりません（削除された可能性があります）。「編集」で顧客を選び直してください。予約を先に直すと、その予約に紐づいている出荷も一緒にその顧客に移ります（紐づけは残ります）。";
  } else if (g.noName) {
    guide = "名前が入っていません。「編集」で顧客を選んでください。";
  } else if (similar.length) {
    guide = `顧客管理に${similar.map(c => `「${c.name}」`).join("")}が登録されています。同じ人なら、「編集」でその顧客を選んでください。`;
  } else if (g.hasSpacedName) {
    guide = "名前の前後に空白が入っているため、顧客として登録しても結びつきません。「編集」で顧客を選ぶか、名前を直してください。";
  } else {
    const register = document.createElement("button");
    register.type = "button";
    register.className = "tool-button no-print";
    register.textContent = "顧客として登録";
    register.onclick = () => startCustomerRegistration(g.name);
    head.appendChild(register);
  }
  wrap.appendChild(head);
  if (guide) {
    const p = document.createElement("p");
    p.className = "section-help";
    p.textContent = guide;
    wrap.appendChild(p);
  }
  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrapper";
  const table = document.createElement("table");
  table.className = "card-table";
  table.innerHTML = '<thead><tr><th>種類</th><th>品種</th><th>月・出荷日</th><th>kg</th><th class="no-print">編集</th><th class="no-print">削除</th></tr></thead>';
  const body = document.createElement("tbody");
  const row = (kind, item) => {
    const tr = document.createElement("tr");
    [["種類", kind === "rs" ? "予約" : "出荷"], ["品種", varietyLabel(item.variety)], ["月・出荷日", kind === "rs" ? monthLabel(item.month) : (item.date || "日付なし")], ["kg", formatKg(item.kg)]].forEach(([label, text]) => {
      const td = document.createElement("td");
      td.dataset.label = label;
      td.textContent = text;
      tr.appendChild(td);
    });
    const editTd = document.createElement("td");
    editTd.className = "action-td";
    editTd.innerHTML = '<button type="button" class="edit-button">編集</button>';
    editTd.firstChild.onclick = () => (kind === "rs" ? openReservationEdit(item.id) : openShipmentEdit(item.id));
    const deleteTd = document.createElement("td");
    deleteTd.className = "action-td";
    deleteTd.innerHTML = '<button type="button" class="delete-button">削除</button>';
    deleteTd.firstChild.onclick = () => (kind === "rs" ? deleteReservationById(item.id) : deleteShipmentById(item.id));
    tr.append(editTd, deleteTd);
    body.appendChild(tr);
  };
  g.rs.forEach(r => row("rs", r));
  g.ss.forEach(s => row("ss", s));
  table.appendChild(body);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);
  return wrap;
}

// id で予約・出荷を探して、編集フォームを開く（押したあとに一覧の並びが変わっていても、押したものを開くため）
// 別のタブで変わっていたら、最新にしてから押し直してもらう（古い内容を編集させないため）
function openReservationEdit(id) {
  if (!ensureFresh()) return;
  const i = reservations.findIndex(x => x.id === id);
  if (i === -1) return;
  switchView("reservationsView");
  editReservation(i);
  // 上に固定されたタブの帯に隠れないよう、フォームを画面の中ほどに出す
  document.getElementById("reservationForm").scrollIntoView({ behavior: "smooth", block: "center" });
}

function openShipmentEdit(id) {
  if (!ensureFresh()) return;
  const i = shipments.findIndex(x => x.id === id);
  if (i === -1) return;
  switchView("shipmentsView");
  editShipment(i);
  document.getElementById("shipmentForm").scrollIntoView({ behavior: "smooth", block: "center" });
}

function deleteReservationById(id) {
  const i = reservations.findIndex(x => x.id === id);
  if (i !== -1) deleteReservation(i);
}

function deleteShipmentById(id) {
  const i = shipments.findIndex(x => x.id === id);
  if (i !== -1) deleteShipment(i);
}

// 顧客管理の登録フォームに名前を入れて開く（保存はしない。ふりがなを入れて「顧客を登録」を押してもらう）
function startCustomerRegistration(name) {
  if (!ensureFresh()) return;
  // 別の顧客を編集している途中なら、入力を消してよいか確かめる
  if (editingCustomerId !== null && !confirm("顧客の編集中です。編集中の内容を取り消して、新しい顧客の登録に切り替えますか？")) return;
  switchView("customersView");
  cancelCustomerEdit();
  document.getElementById("customerName").value = name;
  const furigana = document.getElementById("customerFurigana");
  furigana.scrollIntoView({ behavior: "smooth", block: "center" });
  furigana.focus();
  notify(`ふりがな・電話番号などを入れて（空のままでも可）「顧客を登録」を押すと、「${name}」の予約・出荷がこの顧客に結びつきます`, "info", 8000);
}

function saveCustomer() {
  if (!ensureFresh()) return;
  const name = document.getElementById("customerName").value.trim();
  const furigana = document.getElementById("customerFurigana").value.trim();
  if (!name) {
    notify("顧客名を入力してください", "warn");
    return;
  }
  const address = document.getElementById("customerAddress").value.trim();
  const warning = duplicateCustomerWarning(name, address);
  if (warning) {
    confirmThen(warning, () => commitCustomer(name, furigana, address));
  } else {
    commitCustomer(name, furigana, address);
  }
}

// 名前か住所が同じ顧客がほかにいれば、保存してよいか確かめる文を返す（いなければ ""）。
// 編集で名前・住所を変えていないときは、前から同じだったものなので聞かない
function duplicateCustomerWarning(name, address) {
  const original = editingCustomerId ? customers.find(x => x.customerId === editingCustomerId) : null;
  const others = customers.filter(x => x.customerId !== editingCustomerId);
  const nameChanged = !original || compareKey(original.name) !== compareKey(name);
  const addressChanged = !original || addressKey(original.address) !== addressKey(address);
  const sameName = nameChanged ? others.filter(x => compareKey(x.name) === compareKey(name)) : [];
  const sameAddress = addressChanged && addressKey(address) ? others.filter(x => addressKey(x.address) === addressKey(address)) : [];
  if (!sameName.length && !sameAddress.length) return "";
  // 同じ人が両方に出ないように、名前も住所も同じ顧客は1回だけ並べる
  const matches = [...new Set([...sameName, ...sameAddress])];
  const reasons = [sameName.length ? "名前" : "", sameAddress.length ? "住所" : ""].filter(Boolean).join("・");
  const head = `${reasons}が同じ顧客がすでに登録されています。\n${customerListText(matches)}\n\n`;
  // 編集のときは、家族で同じ住所などもよくあるので、「間違いなら直す」案内にする
  if (original) return `${head}入力を間違えたなら「キャンセル」を押して直してください。\n別の人で間違いなければ、このまま保存しますか？`;
  return `${head}同じ人なら「キャンセル」を押して、新しく登録せず既存の顧客を使ってください。\n別の人として、このまま登録しますか？`;
}

function commitCustomer(name, furigana, address) {
  const c = {
    customerId: editingCustomerId || uid(), name, furigana, phone: document.getElementById("customerPhone").value.trim(), address, memo: document.getElementById("customerMemo").value.trim()
  };
  // 名前だけでこの顧客につながっている予約・出荷（顧客の id が入っていないもの）を、名前を変える前に探しておく。
  // あとで id を書き込み、名前を直してもつながりが切れないようにする
  const nameLinkedTo = target => (target ? [...reservations, ...shipments].filter(x => !x.customerId && customerFor(x) === target) : []);
  let nameLinked;
  if (editingCustomerId) {
    nameLinked = nameLinkedTo(customers.find(x => x.customerId === editingCustomerId));
    customers = customers.map(x => x.customerId === editingCustomerId ? c : x);
  } else {
    customers.push(c);
    nameLinked = nameLinkedTo(c);
  }
  nameLinked.forEach(x => {
    x.customerId = c.customerId;
  });
  if (nameLinked.length) {
    saveIdLinkedData();
  } else {
    save(CUSTOMERS_STORAGE_KEY, customers);
  }
  cancelCustomerEdit();
  refreshAll();
  // 同じ名前の人と見分けがつかず番号で区別しているときは、見分けるための情報を足してもらう（番号は顧客の削除などでずれるため）
  if (customerDisplayNames().get(c.customerId).number) {
    notify(`「${c.name}」という名前の顧客がほかにもいます。見分けられるように、電話番号か住所を入れてください（「顧客管理」の「編集」から）`, "warn", 10000);
  }
}

function cancelCustomerEdit() {
  editingCustomerId = null;
  ["customerName", "customerFurigana", "customerPhone", "customerAddress", "customerMemo"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("customerSubmitButton").textContent = "顧客を登録";
  document.getElementById("cancelCustomerEditButton").hidden = true;
}

function deleteCustomer(id) {
  if (!ensureFresh()) return;
  const c = customers.find(x => x.customerId === id);
  if (!c) {
    return;
  }
  const s = customerStats(c);
  if (s.rs.length || s.ss.length) {
    notify("この顧客には予約または出荷データが存在します。関連データを先に確認してください。", "warn");
    return;
  }
  confirmThen(`${c.name}を削除しますか？`, () => {
    customers = customers.filter(x => x.customerId !== id);
    save(CUSTOMERS_STORAGE_KEY, customers);
    refreshAll();
  });
}

function editCustomer(id) {
  const c = customers.find(x => x.customerId === id);
  editingCustomerId = id;
  document.getElementById("customerName").value = c.name;
  document.getElementById("customerFurigana").value = c.furigana || "";
  document.getElementById("customerPhone").value = c.phone || "";
  document.getElementById("customerAddress").value = c.address || "";
  document.getElementById("customerMemo").value = c.memo || "";
  document.getElementById("customerSubmitButton").textContent = "変更を保存";
  document.getElementById("cancelCustomerEditButton").hidden = false;
  switchView("customersView");
}

function showCustomerDetail(id) {
  const c = customers.find(x => x.customerId === id);
  const s = customerStats(c);
  const list = (o, label = k => k) => Object.entries(o).map(([k, v]) => `<li>${esc(label(k))}：${formatKg(v)}</li>`).join("") || "<li>なし</li>";
  const d = document.getElementById("customerDetail");
  d.hidden = false;
  d.innerHTML = `<h2>${esc(c.name + customerDisplayNames().get(c.customerId).number)} の詳細</h2><div class="detail-grid"><div class="detail-card"><p><b>電話番号：</b>${esc(c.phone) || "未登録"}</p><p><b>住所：</b>${esc(c.address) || "未登録"}</p><p><b>メモ：</b>${esc(c.memo) || "なし"}</p></div><div class="detail-card"><h3>取引状況</h3><p>予約合計：${formatKg(s.reserved)}</p><p>出荷済み：${formatKg(s.shipped)}</p><p>未出荷：${unshippedCell(s)}</p></div><div class="detail-card"><h3>予約（品種別）</h3><ul>${list(s.byV, varietyLabel)}</ul></div><div class="detail-card"><h3>予約（月別）</h3><ul>${list(s.month, monthLabel)}</ul></div><div class="detail-card"><h3>出荷（品種別）</h3><ul>${list(s.shipV, varietyLabel)}</ul></div></div><div class="doc-buttons"><button type="button" class="tool-button" data-doc="delivery">納品書を印刷</button><button type="button" class="tool-button" data-doc="invoice">請求書を印刷</button></div>${mergeFormHtml(c)}<button type="button" class="detail-close-button">詳細を閉じる</button>`;
  // 顧客の id は onclick 属性に書き込まず、ここで結びつける（id に細工があってもスクリプトとして動かないように）
  d.querySelectorAll("[data-doc]").forEach(btn => btn.onclick = () => printCustomerDoc(c.customerId, btn.dataset.doc));
  d.querySelector(".detail-close-button").onclick = () => d.hidden = true;
  const mergeButton = d.querySelector(".merge-button");
  if (mergeButton) mergeButton.onclick = () => mergeCustomer(c.customerId, document.getElementById("mergeTarget").value);
  d.scrollIntoView({ behavior: "smooth" });
}

// 顧客の詳細に出す「ほかの顧客とまとめる」欄。同じ人を2人分登録してしまったときに使う。
// まとめる先の候補は、名前がよく似た顧客を先に並べる（いちばん使う場面なので）
function mergeFormHtml(c) {
  const others = customers.filter(x => x.customerId !== c.customerId);
  if (!others.length) return "";
  const names = customerDisplayNames();
  // どちらも、顧客一覧と同じく、ふりがな（無ければ名前）の順に並べる
  const reading = x => String(x.furigana || x.name || "");
  const byReading = (a, b) => reading(a).localeCompare(reading(b), "ja");
  const similar = others.filter(x => compareKey(x.name) === compareKey(c.name)).sort(byReading);
  const rest = others.filter(x => compareKey(x.name) !== compareKey(c.name)).sort(byReading);
  const options = [...similar, ...rest].map(x => `<option value="${esc(x.customerId)}">${esc(names.get(x.customerId).label)}</option>`).join("");
  return `<div class="detail-card merge-card no-print"><h3>ほかの顧客とまとめる</h3><p class="section-help">同じ人を2人分登録してしまったときに使います。この顧客の予約・出荷をすべて、選んだ顧客に移してから、この顧客を削除します。</p><label for="mergeTarget">まとめる先の顧客</label><select id="mergeTarget"><option value="">選んでください</option>${options}</select><button type="button" class="tool-button merge-button">選んだ顧客にまとめる</button></div>`;
}

// まとめるときに、空いていれば引き継ぐ項目
const MERGE_FIELDS = [{ key: "phone", label: "電話番号" }, { key: "address", label: "住所" }, { key: "furigana", label: "ふりがな" }];

// 両方の顧客に入っていて中身が違う項目（まとめた先の値を残し、まとめる元の値はメモに書き写す）
function mergeKeptValues(from, to) {
  return MERGE_FIELDS.filter(({ key }) => {
    const a = String(to[key] || "").trim();
    const b = String(from[key] || "").trim();
    return a && b && compareKey(a) !== compareKey(b);
  });
}

// 顧客 fromId を顧客 toId にまとめる：from の予約・出荷を to に付け替え、to で空いている項目を from の内容で埋め、from を削除する
function mergeCustomer(fromId, toId) {
  if (!ensureFresh()) return;
  if (!toId) {
    notify("まとめる先の顧客を選んでください", "warn");
    return;
  }
  // 編集中の予約・出荷・顧客があると、まとめたあとの顧客と食い違うので、先に終わらせてもらう
  if (editingReservationId !== null || editingShipmentId !== null || editingCustomerId !== null) {
    notify("予約・出荷・顧客のどれかを編集中です。保存するかキャンセルしてから、まとめてください", "warn", 8000);
    return;
  }
  const from = findCustomer(fromId);
  const to = findCustomer(toId);
  if (!from || !to || from === to) {
    notify("まとめる顧客が見つかりません（削除された可能性があります）。もう一度選んでください", "warn");
    return;
  }
  const s = customerStats(from);
  const names = customerDisplayNames();
  const kept = mergeKeptValues(from, to);
  // スマホの確認ダイアログが長くなりすぎないよう、長い値は20文字で切って見せる（customerListText と同じ）
  const short = t => {
    const chars = Array.from(String(t || ""));
    return chars.length > 20 ? `${chars.slice(0, 20).join("")}…` : chars.join("");
  };
  // 名前も長いと何度も並んで読みにくいので切る（見分けるための表示名 label は、末尾の番号が消えないよう切らない）
  const fromName = short(from.name);
  const toName = short(to.name);
  const keptText = kept.length ? `\n\n次の内容は「${toName}」の内容を残し、「${fromName}」の内容はメモに書き写します。\n${kept.map(k => `・${k.label}：${short(to[k.key])}（${fromName}：${short(from[k.key])}）`).join("\n")}` : "";
  confirmThen(`「${names.get(from.customerId).label}」を「${names.get(to.customerId).label}」にまとめますか？\n\n予約${s.rs.length}件・出荷${s.ss.length}件を「${toName}」に移し、「${fromName}」は顧客管理から削除します。\n電話番号・住所・ふりがなが「${toName}」で空なら、「${fromName}」の内容を入れます。メモは両方をつなげます。${compareKey(from.name) !== compareKey(to.name) ? `\n名前が違うため、「${fromName}」という名前はメモに「旧名」として残します。` : ""}${keptText}\n\nこの操作は元に戻せません。`, () => {
    // 確認の間に変わっていないか、もう一度探し直す
    const fromNow = findCustomer(fromId);
    const toNow = findCustomer(toId);
    if (!fromNow || !toNow) {
      notify("まとめる顧客が見つかりません（削除された可能性があります）。もう一度選んでください", "warn");
      return;
    }
    const move = item => {
      if (customerFor(item)?.customerId !== fromId) return;
      item.customerId = toId;
      item.name = toNow.name;
    };
    reservations.forEach(move);
    shipments.forEach(move);
    // 両方に入っていて違う値は、まとめる元の値が消えないよう、メモに書き写す
    const keptNotes = mergeKeptValues(fromNow, toNow).map(k => `${k.label}（${fromNow.name}）：${String(fromNow[k.key]).trim()}`);
    // 名前が違う人をまとめたとき（旧姓・屋号など）は、まとめる元の名前が消えないよう、メモに残す
    // （空白や全角・半角の違いだけは入力の揺れとみなし、同じ名前として残さない）
    if (compareKey(fromNow.name) !== compareKey(toNow.name)) keptNotes.unshift(`旧名（まとめた顧客）：${String(fromNow.name || "").trim()}`);
    MERGE_FIELDS.forEach(({ key }) => {
      if (!String(toNow[key] || "").trim() && String(fromNow[key] || "").trim()) toNow[key] = fromNow[key];
    });
    // メモは、まとめた先のメモはそのまま残し、まとめる元から足す部分のうち、まだ入っていないものだけを「 / 」でつなぐ
    // （何度まとめても同じ内容が重ならないように）。
    // ・まとめる元のメモは「 / 」で区切り、区切った1つずつが、まとめた先のメモの区切りと同じなら足さない
    //   （「1/15配達」のようなメモの中の「/」では区切らない）
    // ・書き写す値（keptNotes）は区切らず、まとめた先のメモの中に、区切りから区切りまでまるごと同じ文があれば足さない
    //   （住所などに「 / 」が入っていても分かれないように。「東京都1-2」が「東京都1-2-3」の一部というだけで捨てないように）
    const toMemo = String(toNow.memo || "").trim();
    const existing = new Set(toMemo.split(" / ").map(m => m.trim()));
    const fromMemoParts = String(fromNow.memo || "").split(" / ").map(m => m.trim()).filter(m => m && !existing.has(m));
    const newNotes = keptNotes.map(m => m.trim()).filter(m => m && !` / ${toMemo} / `.includes(` / ${m} / `));
    const added = [...fromMemoParts, ...newNotes];
    toNow.memo = [toMemo, ...added].filter(Boolean).join(" / ");
    customers = customers.filter(x => x.customerId !== fromId);
    saveIdLinkedData();
    // 予約・出荷の入力欄でまとめる元の顧客を選んでいたら、まとめた先の顧客に選び直す（選択が黙って外れないように）
    ["customerSelect", "shipmentCustomerSelect"].forEach(id => {
      const select = document.getElementById(id);
      if (select.value === fromId) select.value = toId;
    });
    document.getElementById("customerDetail").hidden = true;
    // 出荷の「対象の予約」も refreshAll の中で、まとめた先の顧客の予約で作り直される（選んでいた予約は残る）
    refreshAll();
    notify(`「${fromNow.name}」を「${toNow.name}」にまとめました`, "info", 8000);
  });
}

function switchView(id) {
  document.querySelectorAll(".view-panel").forEach(e => e.hidden = e.id !== id);
  document.querySelectorAll(".view-tab").forEach(e => {
    const on = e.dataset.view === id;
    e.classList.toggle("active", on);
    e.setAttribute("aria-selected", on ? "true" : "false");
    if (on && e.scrollIntoView) e.scrollIntoView({ block: "nearest", inline: "center" });
  });
  if (id === "customersView") {
    displayCustomers();
  }
}

function refreshAll() {
  displayReservations();
  displayDashboard();
  displayInventory();
  displayShipments();
  displayCustomers();
  displayUnshippedCustomers();
  displayUnlinkedUnshipped();
  refreshCustomerSelects();
  // 出荷の追加・削除で紐づく件数が変わったら、予約フォームの注意書きも合わせる
  updateCustomerLockNote();
  // 予約の追加・削除や顧客の変更を、出荷フォームの「対象の予約」にも反映する（選んでいた予約は残す）
  refreshShipmentReservationOptions(document.getElementById("shipmentReservation").value);
  showBackupStatus();
}

// ---------- 複数タブ対策（他のタブでの更新を取り込む） ----------

function isStale() {
  return STORAGE_KEYS.some(k => rawGet(k) !== lastSeen[k]);
}

function reloadFromStorage() {
  reservations = read("reservations", []);
  shipments = read(SHIPMENTS_STORAGE_KEY, []);
  customers = read(CUSTOMERS_STORAGE_KEY, []);
  inventory = loadInventory();
  prices = loadPrices();
  STORAGE_KEYS.forEach(k => lastSeen[k] = rawGet(k));
  reloadCount++;
  ensureAllIds();
  if (editingReservationId !== null) cancelEdit();
  if (editingShipmentId !== null) cancelShipmentEdit();
  if (editingCustomerId !== null) cancelCustomerEdit();
  const detail = document.getElementById("customerDetail");
  detail.hidden = true;
  detail.innerHTML = "";
  refreshAll();
}

function ensureFresh() {
  if (!cloudReady) {
    notify("Supabase からの読み込みが終わっていないため、まだ操作できません。", "warn");
    return false;
  }
  // 保存できていない変更があるあいだは、新しい変更を受け付けない
  // （つながらないまま変更を重ねると、閉じたときに消える量が増え、あとで送るときにほかの端末の変更を上書きしやすくなるため）
  if (cloudSaveError) {
    notify("Supabase に保存できていない変更があるため、操作を止めています。画面のいちばん上の赤い枠の「もう一度保存する」を押してください。", "warn", 8000);
    return false;
  }
  // ほかのパソコンやタブの変更を消さないよう、古いままのデータでは操作させない
  // （最新のデータを読み込めていないとき＝インターネットにつながっていないときなども、操作を止める）
  if (needsCloudRefresh()) {
    const failed = cloudRefreshError && !cloudRefreshing;
    refreshFromCloud(true);
    notify(failed
      ? "Supabase から最新のデータを読み込めていないため、操作を止めています。画面のいちばん上の赤い枠を見てください。"
      : "最新のデータを Supabase から読み込んでいます。少し待ってから、もう一度操作してください。", "warn");
    return false;
  }
  if (!isStale()) return true;
  reloadFromStorage();
  notify("別のタブや画面でデータが更新されていたため、最新の内容に更新しました。もう一度操作してください。", "warn");
  return false;
}

// 確認ダイアログで「OK」が押されたら action を実行する。
// ダイアログを開いている間に別のタブで保存された内容は、ダイアログを閉じた直後にはまだ届いていない。
// そのため setTimeout で一呼吸おいてから最新かどうかを確かめ、古ければ保存しない（別のタブの変更を消さないため）。
// ※「一呼吸おけば届いている」は Chrome で試して確かめた動きで、どのブラウザでも必ずそうなるとは限らない。
// ダイアログの間に別のタブの変更を取り込んでいた場合（reloadCount が増えた場合）も、確認した内容と違うので保存しない。
function confirmThen(message, action, onStop) {
  const countBefore = reloadCount;
  if (!confirm(message)) {
    if (onStop) onStop();
    return;
  }
  setTimeout(() => {
    if (!ensureFresh()) {
      if (onStop) onStop();
      return;
    }
    if (reloadCount !== countBefore) {
      notify("確認中に別のタブでデータが更新されたため、この操作は実行しませんでした。内容を確かめて、もう一度操作してください。", "warn");
      if (onStop) onStop();
      return;
    }
    action();
  }, 0);
}

// ※ 予約・出荷・顧客・在庫・単価は Supabase に保存するようになったため、isStale はいつも false になり、今は何もしない。
// ほかの端末やタブの変更は、refreshFromCloud で取り込む
function syncFromOtherTab() {
  if (!isStale()) return;
  reloadFromStorage();
  notify("別のタブでデータが更新されたため、最新の内容に更新しました。", "info", 8000);
}

// 同じブラウザの別のタブで、localStorage に保存しているもの（在庫の判定の切りかえ）が変わったら合わせる
function onStorageChange(e) {
  if (e.storageArea !== localStorage) return;
  if (e.key === STOCK_MODE_KEY) {
    stockMode = loadStockMode();
    displayInventory();
    return;
  }
  syncFromOtherTab();
}

window.addEventListener("storage", onStorageChange);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncFromOtherTab();
});
window.addEventListener("pageshow", e => {
  if (e.persisted) syncFromOtherTab();
});

// ---------- Supabase との読み書き ----------

// 文字の項目：無いとき（undefined・null）は null にして送る
function cloudText(v) {
  return v === undefined || v === null ? null : String(v);
}

// 数の項目：数にできないときは null にして送る
function cloudNumber(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Supabase の値をアプリの値にする（null は「項目が無い」にそろえる。アプリの古いデータと同じ形にするため）
function fromCloud(v) {
  return v === null ? undefined : v;
}

function fromCloudNumber(v) {
  return v === null || v === undefined ? undefined : Number(v);
}

// 番号（id）として使える値なら、そのまま返す。使えない値なら undefined（画面に細工した文字を出さないため）
function cloudSafeId(v) {
  return typeof v === "string" && SAFE_ID_PATTERN.test(v) ? v : undefined;
}

// アプリのデータと、Supabase のテーブルの行との対応。
// key：cloudStore の中の名前、keyColumn：行を見分ける列、order：読み込むときの並び順、
// toRows：アプリのデータ → 行の一覧、fromRow：行 → アプリのデータ（使えない行なら null）
const CLOUD_TABLES = [
  {
    key: CUSTOMERS_STORAGE_KEY, table: "customers", label: "顧客", keyColumn: "id", order: ["created_at", "id"],
    toRows: list => list.map(c => ({
      id: cloudText(c.customerId), name: cloudText(c.name), furigana: cloudText(c.furigana), phone: cloudText(c.phone), address: cloudText(c.address), memo: cloudText(c.memo)
    })),
    fromRow: row => cloudSafeId(row.id) ? {
      customerId: row.id, name: fromCloud(row.name) ?? "", furigana: fromCloud(row.furigana), phone: fromCloud(row.phone), address: fromCloud(row.address), memo: fromCloud(row.memo)
    } : null
  },
  {
    key: "reservations", table: "reservations", label: "予約", keyColumn: "id", order: ["created_at", "id"],
    toRows: list => list.map(r => ({
      id: cloudText(r.id), name: cloudText(r.name), customer_id: cloudText(r.customerId), variety: cloudText(r.variety), month: cloudText(r.month), amount_kg: cloudNumber(r.kg), channel: cloudText(r.channel), status: cloudText(r.status)
    })),
    fromRow: row => cloudSafeId(row.id) ? {
      id: row.id, variety: fromCloud(row.variety), month: fromCloud(row.month), name: fromCloud(row.name), customerId: cloudSafeId(row.customer_id), kg: fromCloudNumber(row.amount_kg), channel: fromCloud(row.channel), status: fromCloud(row.status)
    } : null
  },
  {
    key: SHIPMENTS_STORAGE_KEY, table: "shipments", label: "出荷", keyColumn: "id", order: ["created_at", "id"],
    toRows: list => list.map(x => ({
      id: cloudText(x.id), reservation_id: cloudText(x.reservationId), customer_id: cloudText(x.customerId), name: cloudText(x.name), variety: cloudText(x.variety), ship_date: cloudText(x.date), amount_kg: cloudNumber(x.kg), memo: cloudText(x.memo)
    })),
    fromRow: row => cloudSafeId(row.id) ? {
      id: row.id, variety: fromCloud(row.variety), date: fromCloud(row.ship_date), name: fromCloud(row.name), customerId: cloudSafeId(row.customer_id), kg: fromCloudNumber(row.amount_kg), memo: fromCloud(row.memo), reservationId: cloudSafeId(row.reservation_id)
    } : null
  }
];

// 在庫と単価は、品種ごとに1行（variety_settings テーブル）にまとめて保存する
const CLOUD_VARIETY_TABLE = "variety_settings";

function varietySettingRows() {
  const stock = normalizeInventory(read(INVENTORY_STORAGE_KEY, {}));
  const price = loadPricesFrom(read(PRICES_STORAGE_KEY, {}));
  return varieties.map(v => ({ variety: v, stock_kg: stock[v], price: price[v] }));
}

// 最後に Supabase と合わせたときの行（テーブルごとに「行を見分ける値 → 行の JSON の文字」）。
// 今のデータとくらべて、変わった行・増えた行は保存し、無くなった行は消す
const cloudBaseline = {};
// 最後に Supabase と合わせたときの、行ごとの更新日時（テーブルごとに「行を見分ける値 → updated_at」）。
// 書きかえ・削除は「この更新日時から誰も変えていないとき」だけ行う（ほかの人の変更を上書きしないため）
const cloudVersions = {};
// バックアップの読み込みのあと、次に送るときは、更新日時を確かめずにまとめて置きかえる
let cloudReplaceAll = false;

// 今のデータから、テーブルごとの行の一覧を作る
function currentCloudRows() {
  return [
    ...CLOUD_TABLES.map(t => ({ table: t.table, label: t.label, keyColumn: t.keyColumn, rows: t.toRows(read(t.key, [])) })),
    { table: CLOUD_VARIETY_TABLE, label: "在庫・単価", keyColumn: "variety", rows: varietySettingRows() }
  ];
}

// 送った行の更新日時を覚える
function rememberCloudVersions(table, keyColumn, savedRows) {
  savedRows.forEach(row => cloudVersions[table].set(row[keyColumn], row.updated_at));
}

// Supabase の行が、こちらが送った内容と同じなら true（送った列だけをくらべる）
function sameAsSent(dbRow, sentRow) {
  return Object.keys(sentRow).every(c => {
    const a = dbRow[c] ?? null;
    const b = sentRow[c] ?? null;
    // 数の列（amount_kg など）は、Supabase から文字で返ってくることもあるので、数にしてくらべる
    if (typeof b === "number") return a !== null && Number(a) === b;
    return a === b;
  });
}

// 書きかえ・削除・追加が「ほかの人の変更とぶつかった」ように見えたとき、本当にぶつかったのかを確かめる。
// 前に送った保存が、返事だけ届かずに保存できていた場合は、ぶつかったのではなく保存できていた、と分かる。
// 保存できていた行は、更新日時を覚えて true を返す。本当にぶつかっていたら false。読めなかったらエラーを返す
async function confirmAlreadySaved(table, keyColumn, entries, deleted) {
  const keys = entries.map(([key]) => key);
  const { data, error } = await fetchSupabaseRowsByKeys(table, keyColumn, keys);
  if (error) return { error };
  const found = new Map(data.map(row => [row[keyColumn], row]));
  if (deleted) return { ok: keys.every(key => !found.has(key)) };
  const ok = entries.every(([key, json]) => found.has(key) && sameAsSent(found.get(key), JSON.parse(json)));
  if (ok) entries.forEach(([key]) => cloudVersions[table].set(key, found.get(key).updated_at));
  return { ok };
}

// 新しい行を追加する。同じ番号の行がもうある（23505）ときは、1行ずつ確かめる。
// 前の送信が届いていて内容が同じ行は「保存できていた」、まだ無い行はもう一度追加、内容が違う行は「ぶつかった」とする
// （行が多くて分けて送ったとき、前半だけ届いていた、という場合にも、後半の行を失わないため）
async function insertCloudRows(table, keyColumn, entries) {
  const { data, error } = await insertSupabaseRows(table, entries.map(([, json]) => JSON.parse(json)), keyColumn);
  if (!error) {
    rememberCloudVersions(table, keyColumn, data);
    return {};
  }
  if (error.code !== "23505") return { error };
  const found = await fetchSupabaseRowsByKeys(table, keyColumn, entries.map(([key]) => key));
  if (found.error) return { error: found.error };
  const byKey = new Map(found.data.map(row => [row[keyColumn], row]));
  const missing = [];
  for (const [key, json] of entries) {
    const row = byKey.get(key);
    if (!row) missing.push([key, json]);
    else if (!sameAsSent(row, JSON.parse(json))) return { conflict: true };
    else cloudVersions[table].set(key, row.updated_at);
  }
  if (!missing.length) return {};
  const again = await insertSupabaseRows(table, missing.map(([, json]) => JSON.parse(json)), keyColumn);
  if (again.error && again.error.code === "23505") return { conflict: true };
  if (again.error) return { error: again.error };
  rememberCloudVersions(table, keyColumn, again.data);
  return {};
}

// 前に合わせたときから変わった分だけ、Supabase へ送る。送れなかったらエラーを返す（送れたら null）。
// 途中で失敗しても、送れた分は控え（cloudBaseline）に入れるので、次はその続きから送り直す。
// ほかの人が先に同じ行を変えていた（または消していた）ときは、そこで止めて { conflict: 種類 } を返す
async function sendCloudChanges() {
  // バックアップの読み込みの印は、送り始めるときに一度だけ見る（送っている途中で変わっても、この送信には使わない）
  const replaceAll = cloudReplaceAll;
  // 行の削除は、すべての表の追加・書きかえが終わってから行う。
  // （顧客をまとめるときなど、予約・出荷を別の顧客に付け替えてから元の顧客を消す。先に顧客だけ消えて途中で止まると、
  //   予約・出荷がどの顧客にもつながらなくなるため）
  const deletions = [];
  for (const { table, label, keyColumn, rows } of currentCloudRows()) {
    const base = cloudBaseline[table];
    const versions = cloudVersions[table];
    const current = new Map();
    for (const row of rows) {
      const key = row[keyColumn];
      if (key === null || current.has(key)) {
        return { message: `${label}のデータに、番号（id）が無いものか、同じ番号のものが2件以上あります。`, code: "DUPLICATE" };
      }
      current.set(key, JSON.stringify(row));
    }
    const changed = [...current].filter(([key, json]) => base.get(key) !== json);
    const removed = [...base.keys()].filter(key => !current.has(key));
    if (replaceAll) {
      // バックアップの読み込み：確かめずに、まとめて置きかえる
      if (changed.length) {
        const { data, error } = await upsertSupabaseRows(table, changed.map(([, json]) => JSON.parse(json)), keyColumn);
        if (error) return error;
        changed.forEach(([key, json]) => base.set(key, json));
        rememberCloudVersions(table, keyColumn, data);
      }
      if (removed.length) deletions.push({ table, label, keyColumn, removed, base, versions });
      continue;
    }
    const added = changed.filter(([key]) => !base.has(key));
    const updated = changed.filter(([key]) => base.has(key));
    // 新しい行は追加する
    if (added.length) {
      const result = await insertCloudRows(table, keyColumn, added);
      if (result.error) return result.error;
      if (result.conflict) return { conflict: label };
      added.forEach(([key, json]) => base.set(key, json));
    }
    // 前からある行は、誰も変えていないときだけ書きかえる
    for (const entry of updated) {
      const [key, json] = entry;
      const { data, error } = await updateSupabaseRowIfUnchanged(table, keyColumn, key, versions.get(key), JSON.parse(json));
      if (error) return error;
      if (data === null) {
        const check = await confirmAlreadySaved(table, keyColumn, [entry], false);
        if (check.error) return check.error;
        if (!check.ok) return { conflict: label };
      } else {
        versions.set(key, data);
      }
      base.set(key, json);
    }
    if (removed.length) deletions.push({ table, label, keyColumn, removed, base, versions });
  }
  // 削除は、ほかの行から使われる側（顧客）を最後にするため、表の並びと逆の順（出荷 → 予約 → 顧客）で行う
  for (const { table, label, keyColumn, removed, base, versions } of deletions.reverse()) {
    if (replaceAll) {
      const { error } = await deleteSupabaseRows(table, keyColumn, removed);
      if (error) return error;
      removed.forEach(key => {
        base.delete(key);
        versions.delete(key);
      });
      continue;
    }
    // 無くなった行は、誰も変えていないときだけ消す
    for (const key of removed) {
      const { data, error } = await deleteSupabaseRowIfUnchanged(table, keyColumn, key, versions.get(key));
      if (error) return error;
      if (!data) {
        // もう消えているなら、前の送信が届いていた（または、ほかの人も消した）ので、消せている
        // （番号は時刻と乱数で付けるので、ほかの人が消したあとに同じ番号の行を作り直すことは、まず起きない）
        const check = await confirmAlreadySaved(table, keyColumn, [[key]], true);
        if (check.error) return check.error;
        if (!check.ok) return { conflict: label };
      }
      base.delete(key);
      versions.delete(key);
    }
  }
  // まとめて置きかえる送信が最後まで終わったときだけ、印を下ろす
  if (replaceAll) cloudReplaceAll = false;
  return null;
}

// ほかの人が先に同じデータを変えていたときは、この画面の残りの変更は送らずに、Supabase の最新の内容に入れかえる
function handleCloudConflict(label) {
  if (cloudReplaceAll) {
    notify("保存がぶつかったため、読み込んだバックアップは Supabase に入れられませんでした。最新の内容を確かめてから、もう一度バックアップを読み込んでください。", "error", 15000);
  }
  cloudSaveQueued = false;
  cloudSaveError = null;
  // 読み直すまで、データを変える操作を止める
  cloudLoadedAt = 0;
  notify(`ほかの人が先に同じ${label}のデータを変えていた（または消していた）ため、あなたの変更の一部は保存しませんでした。最新の内容を読み込みます。内容を確かめて、必要ならもう一度操作してください。`, "warn", 15000);
  setTimeout(() => refreshFromCloud(true), 0);
}

// 保存があったら、少しあとで（同じ操作の中の保存をまとめてから）Supabase へ送る。
// 送っている途中に保存があったら、送り終わってからもう一度送る
function scheduleCloudSave() {
  if (!cloudReady) return;
  cloudSaveQueued = true;
  if (cloudSaving) return;
  cloudSaving = true;
  showCloudStatus();
  Promise.resolve().then(runCloudSave);
}

async function runCloudSave() {
  try {
    while (cloudSaveQueued) {
      cloudSaveQueued = false;
      const error = await sendCloudChanges();
      if (error && error.conflict) {
        handleCloudConflict(error.conflict);
        break;
      }
      if (error) {
        // 送れなかった変更は、次の保存か「もう一度保存する」で送り直す
        cloudSaveQueued = true;
        cloudSaveError = error;
        // 画面の下のほうを操作していても気づけるよう、お知らせも出す
        notify("Supabase に保存できませんでした。画面のいちばん上の赤い枠を見てください。", "error", 10000);
        break;
      }
      cloudSaveError = null;
    }
  } catch (err) {
    cloudSaveQueued = true;
    cloudSaveError = { message: String((err && err.message) || err), code: "" };
  } finally {
    cloudSaving = false;
    showCloudStatus();
  }
}

// 操作の前に、Supabase から読み直す必要があれば true
// （送っていない変更があるときは読み直さない。読み直すと、その変更が消えるため）
function needsCloudRefresh() {
  if (hasUnsentCloudChanges()) return false;
  if (cloudRefreshError) return true;
  return Date.now() - cloudLoadedAt > CLOUD_STALE_MS;
}

// 赤い枠のボタン：保存できていない変更があれば送り直し、最新のデータを読み込めていなければ読み直す
function retryCloud() {
  if (!cloudReady || cloudSaving || cloudRefreshing) return;
  if (cloudSaveError) scheduleCloudSave();
  else if (cloudRefreshError) refreshFromCloud(true);
}

// よくあるエラーに、原因と直し方の目安を添える
function explainCloudError(error) {
  const text = `${error.message} ${error.code} ${error.details || ""}`;
  if (error.code === "SETUP") return "";
  if (error.code === "DUPLICATE") return "「データを書き出す」でファイルに控えてから、ページを開き直してください。";
  if (error.code === "TIMEOUT") return "インターネットにつながっているか確かめてください。";
  if (/Failed to fetch|NetworkError|Load failed/i.test(text)) {
    return "インターネットにつながっているか確かめてください。";
  }
  if (error.code === "PGRST301" || /JWT expired/i.test(text)) {
    return "ログインの期限が切れました。ページを開き直して、もう一度ログインしてください。";
  }
  if (error.code === "42501" || /permission denied|row-level security/i.test(text)) {
    return "Supabase の行ごとのアクセス制限（RLS）で止められています。ログインしている人が、使う人のリスト（app_members）に入っているか、管理する人に確かめてもらってください。";
  }
  if (/Invalid API key|No API key|JWT|apikey/i.test(text)) {
    return "supabase-config.js の Publishable key が正しいか確かめてください。";
  }
  if (error.code === "PGRST204" || error.code === "PGRST205" || error.code === "42703" || error.code === "42P01" || /does not exist|Could not find/i.test(text)) {
    return "Supabase に必要なテーブルや列がありません。SUPABASE_LOGIN.md の手順で、supabase-auth.sql を実行したか確かめてください（supabase-schema.sql は、データが消えるので実行しないでください）。";
  }
  return "";
}

function cloudErrorText(error) {
  const advice = explainCloudError(error);
  return `${error.message}${error.code && error.code !== "SETUP" && error.code !== "DUPLICATE" ? `（コード：${error.code}）` : ""}${advice ? `\n${advice}` : ""}`;
}

// 画面の上の「保存の状態」と、送れなかったときの赤いお知らせを、今の状態に合わせる
function showCloudStatus() {
  const status = document.getElementById("cloudStatus");
  const box = document.getElementById("cloudError");
  if (!status || !box) return;
  const button = document.getElementById("cloudRetryButton");
  box.hidden = !cloudSaveError && !cloudRefreshError;
  if (cloudSaveError) {
    document.getElementById("cloudErrorText").textContent = `Supabase に保存できていない変更があります。\n${cloudErrorText(cloudSaveError)}\nこのままページを閉じたり開き直したりすると、その変更は消えます。\n（保存できるまでは、ほかのパソコンやタブの変更も取り込みません）`;
    button.textContent = "もう一度保存する";
  } else if (cloudRefreshError) {
    document.getElementById("cloudErrorText").textContent = `Supabase から最新のデータを読み込めていないため、データを変える操作を止めています（古いデータで、ほかのパソコンの変更を上書きしないため）。\n${cloudErrorText(cloudRefreshError)}\n直ったら「もう一度読み込む」を押してください。`;
    button.textContent = "もう一度読み込む";
  }
  button.disabled = cloudSaving || cloudRefreshing;
  if (!cloudReady) {
    status.textContent = "";
  } else if (cloudSaving) {
    status.textContent = "Supabase に保存しています…";
  } else if (cloudSaveError) {
    status.textContent = "保存できていない変更があります";
  } else if (cloudRefreshing && cloudRefreshShown) {
    status.textContent = "Supabase から読み込んでいます…";
  } else if (cloudRefreshError) {
    status.textContent = "最新のデータを読み込めていません";
  } else {
    status.textContent = "Supabase に保存済み";
  }
  status.classList.toggle("cloud-status-error", !cloudSaving && !(cloudRefreshing && cloudRefreshShown) && !!(cloudSaveError || cloudRefreshError));
}

// 読み込みの間（と、読み込めなかったとき）は、画面全体をおおって操作できないようにする
function showCloudLoading(text, canRetry) {
  document.getElementById("loginScreen").hidden = true;
  document.getElementById("cloudLoadingText").textContent = text;
  document.getElementById("cloudReloadButton").hidden = !canRetry;
  document.getElementById("cloudLoading").hidden = false;
  document.querySelector(".container").inert = true;
}

function hideCloudLoading() {
  document.getElementById("cloudLoading").hidden = true;
  document.querySelector(".container").inert = false;
}

// Supabase からすべてのデータを読み、アプリの形にする。読めなかったら { error } を返す
async function fetchCloudData() {
  const tables = [...CLOUD_TABLES, { table: CLOUD_VARIETY_TABLE, order: ["variety"] }];
  const results = await Promise.all(tables.map(t => fetchAllSupabaseRows(t.table, t.order)));
  const failed = results.find(r => r.error);
  if (failed) return { error: failed.error };
  let skipped = 0;
  const versions = {};
  const lists = CLOUD_TABLES.map((t, i) => {
    const list = [];
    versions[t.table] = new Map();
    results[i].data.forEach(row => {
      const item = t.fromRow(row);
      if (item) {
        list.push(item);
        versions[t.table].set(row[t.keyColumn], row.updated_at);
      } else {
        skipped++;
      }
    });
    return list;
  });
  const settings = results[CLOUD_TABLES.length].data.filter(row => varieties.includes(row.variety));
  const stock = {};
  const price = {};
  settings.forEach(row => {
    stock[row.variety] = row.stock_kg;
    price[row.variety] = row.price;
  });
  versions[CLOUD_VARIETY_TABLE] = new Map(settings.map(row => [row.variety, row.updated_at]));
  return { lists, stock: normalizeInventory(stock), price: loadPricesFrom(price), savedVarieties: new Set(settings.map(row => row.variety)), versions, skipped };
}

// 読んだデータを cloudStore と控え（cloudBaseline）に入れる。今の画面のデータと違っていたら true を返す
function applyCloudData(d) {
  const texts = {};
  CLOUD_TABLES.forEach((t, i) => texts[t.key] = JSON.stringify(d.lists[i]));
  texts[INVENTORY_STORAGE_KEY] = JSON.stringify(d.stock);
  texts[PRICES_STORAGE_KEY] = JSON.stringify(d.price);
  const changed = STORAGE_KEYS.some(k => cloudStore[k] !== texts[k]);
  Object.assign(cloudStore, texts);
  CLOUD_TABLES.forEach((t, i) => {
    // 控えは、読み込んだデータをもう一度「行」にしたもので作る（読み込んだだけで送り直しにならないように）
    cloudBaseline[t.table] = new Map(t.toRows(d.lists[i]).map(row => [row[t.keyColumn], JSON.stringify(row)]));
  });
  // 在庫・単価の控えは、Supabase に行があった品種だけ（無い品種は、次に保存するときに行を作る）
  cloudBaseline[CLOUD_VARIETY_TABLE] = new Map(varietySettingRows().filter(row => d.savedVarieties.has(row.variety)).map(row => [row.variety, JSON.stringify(row)]));
  Object.assign(cloudVersions, d.versions);
  // Supabase の内容に入れかえたので、まとめて置きかえる印も下ろす
  cloudReplaceAll = false;
  cloudLoadedAt = Date.now();
  return changed;
}

function notifySkippedRows(skipped) {
  if (skipped) {
    notify(`Supabase のデータのうち${skipped}件は、番号（id）が正しくないため読み込みませんでした。`, "warn", 15000);
  }
}

// ページを開いたときに、Supabase からすべてのデータを読み込む
async function loadFromCloud() {
  showCloudLoading("Supabase からデータを読み込んでいます…", false);
  const d = await fetchCloudData();
  if (d.error) {
    showCloudLoading(`Supabase からデータを読み込めませんでした。\n${cloudErrorText(d.error)}\n直したら「もう一度読み込む」を押してください。`, true);
    return;
  }
  applyCloudData(d);
  cloudReady = true;
  reloadFromStorage();
  hideCloudLoading();
  showCloudStatus();
  notifySkippedRows(d.skipped);
}

// まだ送っていない変更があれば true（このときは読み直さない。読み直すと、その変更が消えるため）
function hasUnsentCloudChanges() {
  return cloudSaving || cloudSaveQueued || !!cloudSaveError;
}

// 編集中のフォームがあるか、入力欄で入力している途中なら true
function userIsEditing() {
  if (editingReservationId !== null || editingShipmentId !== null || editingCustomerId !== null) return true;
  const el = document.activeElement;
  return !!el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !!el.closest(".container");
}

// ほかのパソコンやタブで変わった内容を取り込むため、Supabase から読み直す
// （古い画面のまま保存すると、ほかで変えた内容を古い値で上書きしてしまうため）。
// 内容が変わっていたときだけ画面を作り直す（入力中の内容を、むやみに消さないため）。
// 30秒ごとの読み直し（force が false）は、編集や入力の途中なら後回しにする。
// 操作の前の読み直し（force が true）は、古いデータで保存しないよう、編集中でも読み直す
async function refreshFromCloud(force = false) {
  if (!cloudReady || hasUnsentCloudChanges()) return;
  if (cloudRefreshing) {
    // 30秒ごとの読み直しの途中に、操作の前の読み直しを頼まれたら、終わったときに「もう一度操作してください」を出す
    if (force) {
      cloudRefreshShown = true;
      cloudRefreshAsked = true;
      showCloudStatus();
    }
    return;
  }
  if (!force && userIsEditing()) return;
  cloudRefreshing = true;
  cloudRefreshShown = force || !!cloudRefreshError;
  cloudRefreshAsked = force;
  showCloudStatus();
  const changesBefore = cloudChangeCount;
  let d;
  let timer;
  try {
    // 返事が来ないまま待ち続けないよう、時間の上限を決めて待つ
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve({ error: { message: `Supabase から${CLOUD_REFRESH_TIMEOUT_MS / 1000}秒たっても返事がありませんでした。`, code: "TIMEOUT" } }), CLOUD_REFRESH_TIMEOUT_MS);
    });
    d = await Promise.race([fetchCloudData(), timeout]);
  } catch (err) {
    d = { error: { message: String((err && err.message) || err), code: "" } };
  } finally {
    clearTimeout(timer);
    cloudRefreshing = false;
  }
  if (d.error) {
    // 読み直せないときは、画面の上の赤い枠で理由を知らせる（読み直せるまで、データを変える操作は止める）
    cloudRefreshError = d.error;
    showCloudStatus();
    return;
  }
  const recovered = !!cloudRefreshError;
  cloudRefreshError = null;
  showCloudStatus();
  // 読み直している間に、この画面で保存があったら、読んだ内容は古いので使わない
  if (cloudChangeCount !== changesBefore || hasUnsentCloudChanges()) return;
  if (!applyCloudData(d)) {
    // 操作の前の読み直しで、変わったところが無かったときは、もう一度押してもらう
    if (cloudRefreshAsked) notify("最新のデータを読み込みました。もう一度操作してください。", "success");
    else if (recovered) notify("Supabase から最新のデータを読み込めるようになりました。", "success");
    return;
  }
  const wasEditing = editingReservationId !== null || editingShipmentId !== null || editingCustomerId !== null;
  reloadFromStorage();
  notify(`ほかのパソコンやタブでデータが更新されていたため、最新の内容に更新しました。${wasEditing ? "編集中の内容は取り消しました。もう一度編集してください。" : ""}`, wasEditing ? "warn" : "info", 10000);
  notifySkippedRows(d.skipped);
}

// 画面を開いている間は、ときどき読み直す（見えていないタブでは読み直さず、戻ってきたときに読み直す）
setInterval(() => {
  if (!document.hidden) refreshFromCloud();
}, CLOUD_REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshFromCloud();
});
window.addEventListener("pageshow", e => {
  if (e.persisted) refreshFromCloud();
});

// Supabase に送れていない変更があるうちにページを閉じようとしたら、ブラウザの確認を出す
window.addEventListener("beforeunload", e => {
  if (cloudSigningOut) return;
  if (!cloudSaving && !cloudSaveQueued && !cloudSaveError) return;
  e.preventDefault();
  e.returnValue = "";
});

// ---------- ログイン ----------

// ログアウトのために開き直すときは true（閉じる前の確認を出さないため）
let cloudSigningOut = false;

function setLoginMessage(text, isError) {
  const el = document.getElementById("loginMessage");
  el.textContent = text;
  el.classList.toggle("login-message-error", !!isError);
}

// ログイン画面を出す（ほかの画面は操作できないようにする）
function showLoginScreen(message) {
  document.getElementById("cloudLoading").hidden = true;
  document.getElementById("loginScreen").hidden = false;
  document.querySelector(".container").inert = true;
  setLoginMessage(message || "", !!message);
  document.getElementById("loginEmail").focus();
}

function hideLoginScreen() {
  document.getElementById("loginScreen").hidden = true;
}

// ログインのエラーを、分かりやすい文にする
function loginErrorText(error) {
  const text = `${error.message} ${error.code}`;
  if (/Invalid login credentials/i.test(text)) return "メールアドレスかパスワードが違います。";
  if (/Email not confirmed/i.test(text)) return "このメールアドレスは、まだ確認が済んでいません。管理する人に、Supabase で登録し直してもらってください（登録するときに「Auto Confirm User」にチェックを入れます）。";
  if (/rate limit|too many/i.test(text)) return "ログインを何度も失敗したため、しばらくログインできません。少し時間をおいてから、もう一度ためしてください。";
  return `ログインできませんでした。\n${cloudErrorText(error)}`;
}

async function submitLogin(event) {
  event.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const passwordInput = document.getElementById("loginPassword");
  if (!email || !passwordInput.value) {
    setLoginMessage("メールアドレスとパスワードを入れてください。", true);
    return;
  }
  const button = document.getElementById("loginButton");
  button.disabled = true;
  setLoginMessage("ログインしています…", false);
  const { data, error } = await signInSupabase(email, passwordInput.value);
  button.disabled = false;
  if (error) {
    setLoginMessage(loginErrorText(error), true);
    return;
  }
  passwordInput.value = "";
  hideLoginScreen();
  afterSignIn(data.email);
}

// ログインできたら、使う人のリストに入っているかを確かめてから、データを読み込む
async function afterSignIn(email) {
  showCloudLoading("使う人のリストを確かめています…", false);
  const { data, error } = await isSupabaseMember();
  if (error) {
    showCloudLoading(`使う人のリストを確かめられませんでした。\n${cloudErrorText(error)}\n直したら「もう一度読み込む」を押してください。`, true);
    return;
  }
  if (!data) {
    // リストに入っていない人は、ログインを消してログイン画面に戻す
    await signOutSupabase();
    showLoginScreen(`「${email}」は、使う人のリストに入っていないため、使えません。管理する人に、Supabase の app_members に追加してもらってください。`);
    return;
  }
  document.getElementById("cloudUserEmail").textContent = email;
  document.getElementById("cloudUser").hidden = false;
  loadFromCloud();
}

// ページを開いたとき：ログインしていればデータを読み込み、していなければログイン画面を出す
async function startCloud() {
  showCloudLoading("ログインを確かめています…", false);
  if (supabaseSetupProblem) {
    showCloudLoading(`Supabase の準備ができていません。\n${supabaseSetupProblem}\n直したら「もう一度読み込む」を押してください。`, true);
    return;
  }
  const { data, error } = await getSupabaseUser();
  if (error) {
    showCloudLoading(`ログインを確かめられませんでした。\n${cloudErrorText(error)}\n直したら「もう一度読み込む」を押してください。`, true);
    return;
  }
  if (!data) {
    showLoginScreen("");
    return;
  }
  afterSignIn(data.email);
}

async function logout() {
  if (hasUnsentCloudChanges() && !confirm("Supabase に保存できていない変更があります。ログアウトすると、その変更は消えます。ログアウトしますか？")) return;
  cloudSigningOut = true;
  await signOutSupabase();
  // 画面のデータを残さないよう、ページを開き直す（ログイン画面が出る）
  location.reload();
}

// ほかのタブでログアウトしたときや、ログインの期限が切れて延長できなかったときは、開き直してログイン画面を出す
watchSupabaseSignOut(() => {
  if (cloudSigningOut) return;
  if (cloudReady) {
    if (hasUnsentCloudChanges()) {
      alert("ほかのタブでログアウトしたか、ログインの期限が切れたため、ログイン画面に戻ります。Supabase に保存できていなかった変更は、保存されません。");
    }
    cloudSigningOut = true;
    location.reload();
  }
});

// ---------- 納品書・請求書 ----------

function yen(v) {
  return `¥${Math.round(Number(v) || 0).toLocaleString("ja-JP")}`;
}

function buildDocRows(c) {
  return shipments.filter(s => customerFor(s)?.customerId === c.customerId).map(s => ({ s, unit: Number(prices[s.variety]) || 0, amount: Math.round((Number(s.kg) || 0) * (Number(prices[s.variety]) || 0)) })).sort((a, b) => String(a.s.date).localeCompare(String(b.s.date)));
}

function printCustomerDoc(customerId, kind) {
  // 別のタブで単価や出荷が変わっていたら、最新の内容にしてからやり直してもらう
  if (!ensureFresh()) return;
  const c = customers.find(x => x.customerId === customerId);
  if (!c) return;
  const rows = buildDocRows(c);
  if (!rows.length) {
    notify("この顧客の出荷の記録がありません", "warn");
    return;
  }
  const title = kind === "invoice" ? "請求書" : "納品書";
  // 品種が無い出荷は単価が決まらず、金額0円のまま気づかずに印刷されてしまうため、印刷を止めて直す出荷を知らせる
  const noVariety = rows.filter(({ s }) => !varieties.includes(s.variety));
  if (noVariety.length) {
    const list = noVariety.slice(0, 5).map(({ s }) => `${s.date || "日付なし"}・${formatKg(s.kg)}`).join("、");
    const more = noVariety.length > 5 ? `ほか${noVariety.length - 5}件` : "";
    // 紐づけた予約にも品種が無いと、出荷の品種欄は予約に合わせて固定され選べないため、先に予約を直すよう案内する
    const reservationToo = noVariety.some(({ s }) => {
      const r = s.reservationId ? reservations.find(x => x.id === s.reservationId) : null;
      return r && !varieties.includes(r.variety);
    });
    const how = reservationToo
      ? "紐づけた予約にも品種が無いものがあります。先に「予約登録・一覧」でその予約の品種を選び、そのあと「出荷管理」で出荷を編集して品種を選んでください。"
      : "「出荷管理」でこれらの出荷を編集して品種を選んでください。";
    notify(`品種が未設定または不明な出荷が${noVariety.length}件あるため、${title}を印刷できません（${list}${more}）。${how}`, "warn", 15000);
    return;
  }
  // 単価が0円（未入力）の品種があると、その分の金額が0円になる。サービス品などもあり得るので、確認してから印刷する
  const zeroPrice = [...new Set(rows.filter(r => r.unit === 0).map(r => r.s.variety))];
  if (zeroPrice.length && !confirm(`単価が0円の品種があります（${zeroPrice.join("、")}）。この品種の金額は0円になります。\n\n単価を入れる場合は「キャンセル」を押し、「在庫管理」で単価を入力してください。\nこのまま${title}を印刷しますか？`)) return;
  const total = rows.reduce((a, r) => a + r.amount, 0);
  const body = rows.map(({ s, unit, amount }) => `<tr><td>${esc(s.date)}</td><td>${esc(s.variety)}</td><td>${formatKg(s.kg)}</td><td>${yen(unit)}</td><td>${yen(amount)}</td></tr>`).join("");
  const doc = document.getElementById("docPrint");
  doc.innerHTML = `
    <h1>${title}</h1>
    <p class="doc-meta">発行日：${todayString().replace(/-/g, "/")}</p>
    <p class="doc-to">${esc(c.name)} 様</p>
    <table class="doc-table">
      <thead><tr><th>出荷日</th><th>品種</th><th>kg</th><th>単価</th><th>金額</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="doc-total">${kind === "invoice" ? "ご請求金額" : "合計金額"}：${yen(total)}</p>
    ${kind === "invoice" ? '<p class="doc-note">お手数ですが、期日までのお支払いをお願いいたします。</p>' : ""}
  `;
  document.body.classList.add("printing-doc");
  setTimeout(() => window.print(), 50);
}

window.addEventListener("afterprint", () => {
  document.body.classList.remove("printing-doc");
});

// ---------- CSV出力・印刷 ----------

function csvCell(v) {
  let text = String(v ?? "");
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function roundKg(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function downloadCsv(filename, header, rows) {
  const lines = [header, ...rows].map(row => row.map(csvCell).join(","));
  const blob = new Blob(["\uFEFF" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateStamp() {
  return todayString().replace(/-/g, "");
}

function exportReservationsCsv() {
  const rows = getVisibleReservations().map(({ r }) => [r.variety, r.month, customerName(r), roundKg(r.kg), channelOf(r) || "未設定", STATUSES[statusOf(r)]]);
  if (!rows.length) {
    notify("書き出す予約がありません", "warn");
    return;
  }
  downloadCsv(`reservations-${dateStamp()}.csv`, ["品種", "月", "名前", "kg", "受付経路", "状態"], rows);
  notify(`予約${rows.length}件をCSVに書き出しました（表示中の絞り込み・並び順のとおり）`, "success");
}

function exportShipmentsCsv() {
  const rows = getVisibleShipments().map(({ s }) => [s.date, s.variety, customerName(s), roundKg(s.kg), s.memo || ""]);
  if (!rows.length) {
    notify("書き出す出荷がありません", "warn");
    return;
  }
  downloadCsv(`shipments-${dateStamp()}.csv`, ["出荷日", "品種", "顧客", "kg", "メモ"], rows);
  notify(`出荷${rows.length}件をCSVに書き出しました（表示中の並び順のとおり）`, "success");
}

function exportCustomersCsv() {
  const rows = getVisibleCustomers().map(({ c, s }) => [c.name, c.furigana || "", c.phone || "", c.address || "", c.memo || "", roundKg(s.reserved), roundKg(s.shipped), roundKg(s.unshipped)]);
  if (!rows.length) {
    notify("書き出す顧客がいません", "warn");
    return;
  }
  downloadCsv(`customers-${dateStamp()}.csv`, ["顧客名", "ふりがな", "電話番号", "住所", "メモ", "予約合計kg", "出荷済みkg", "未出荷kg"], rows);
  notify(`顧客${rows.length}件をCSVに書き出しました。個人情報が含まれるため、GitHubなど公開の場所には置かないでください。`, "info", 9000);
}

function printCurrentList() {
  window.print();
}

window.addEventListener("beforeprint", () => {
  const tab = document.querySelector(".view-tab.active");
  const el = document.getElementById("printTitle");
  if (el) el.textContent = `米予約管理｜${tab ? tab.textContent : ""}｜${todayString().replace(/-/g, "/")}`;
});

// ---------- バックアップ（書き出し・読み込み） ----------

function pad2(n) {
  return String(n).padStart(2, "0");
}

function timestampForFilename() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function showBackupStatus() {
  const el = document.getElementById("backupStatus");
  if (!el) return;
  const last = read(LAST_BACKUP_STORAGE_KEY, null);
  const lastDate = last ? new Date(last) : null;
  const lastText = lastDate && !Number.isNaN(lastDate.getTime()) ? `最終バックアップ：${lastDate.toLocaleString("ja-JP")}` : "まだバックアップしていません";
  el.textContent = `現在のデータ：予約${reservations.length}件 / 出荷${shipments.length}件 / 顧客${customers.length}件　${lastText}`;
}

// 今のデータからバックアップを作る（ファイルへの書き出しに使う）
function makeBackup() {
  return {
    app: BACKUP_APP_NAME,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: { reservations, shipments, customers, inventory, prices }
  };
}

function exportBackup() {
  const backup = makeBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rice-backup-${timestampForFilename()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  save(LAST_BACKUP_STORAGE_KEY, new Date().toISOString());
  showBackupStatus();
}

function isPlainObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function validateBackup(obj) {
  if (!isPlainObject(obj) || obj.app !== BACKUP_APP_NAME) {
    return { error: "米予約管理のバックアップファイルではありません" };
  }
  if (obj.version !== BACKUP_VERSION) {
    return { error: "対応していないバージョンのバックアップファイルです" };
  }
  const d = obj.data;
  if (!isPlainObject(d)) {
    return { error: "バックアップの中にデータが見つかりません" };
  }
  const labels = { reservations: "予約", shipments: "出荷", customers: "顧客" };
  for (const key of Object.keys(labels)) {
    if (!Array.isArray(d[key])) {
      return { error: `${labels[key]}のデータが正しくありません` };
    }
  }
  // 品種が無い古いデータは、書き出すと品種の項目そのものが無くなる。それも読み込めるようにする
  const varietyOk = v => v === undefined || v === null || typeof v === "string";
  // 画面への表示は esc() や textContent で守っているが、念のための二重の守りとして、
  // id には英数字・「_」「-」だけを受け付ける（細工した文字が入ったファイルを読み込まないように）。
  // 古いデータで id が無いものは、読み込んだあとに付け直す
  const idOk = v => v === undefined || v === null || v === "" || (typeof v === "string" && SAFE_ID_PATTERN.test(v));
  // 顧客の id は、使える文字の文字列のほか、古いデータに備えて「無し」と「0以上の整数」も受け付ける。
  // どちらも読み込んだあとに fixCustomerIds で文字列の id に直す
  const customerIdOk = v => idOk(v) || isLegacyNumericId(v);
  const badReservation = d.reservations.findIndex(r => !(isPlainObject(r) && varietyOk(r.variety) && idOk(r.id) && customerIdOk(r.customerId)));
  if (badReservation !== -1) {
    return { error: `予約のデータが正しくありません（${badReservation + 1}件目）` };
  }
  const badShipment = d.shipments.findIndex(s => !(isPlainObject(s) && varietyOk(s.variety) && idOk(s.id) && customerIdOk(s.customerId) && idOk(s.reservationId)));
  if (badShipment !== -1) {
    return { error: `出荷のデータが正しくありません（${badShipment + 1}件目）` };
  }
  const badCustomer = d.customers.findIndex(c => !(isPlainObject(c) && typeof c.name === "string" && customerIdOk(c.customerId)));
  if (badCustomer !== -1) {
    return { error: `顧客のデータが正しくありません（${badCustomer + 1}件目）` };
  }
  // 同じ id が2件以上あると、Supabase には1件しか保存できない（もう1件が消える）ため、読み込まない
  const duplicates = [
    ["予約", d.reservations, r => r.id],
    ["出荷", d.shipments, x => x.id],
    ["顧客", d.customers, c => c.customerId]
  ].find(([, list, idOf]) => hasDuplicateId(list, idOf));
  if (duplicates) {
    return { error: `${duplicates[0]}のデータに、同じ番号（id）のものが2件以上あります` };
  }
  if (!isPlainObject(d.inventory)) {
    return { error: "在庫のデータが正しくありません" };
  }
  if (d.prices !== undefined && !isPlainObject(d.prices)) {
    return { error: "単価のデータが正しくありません" };
  }
  return { data: { reservations: d.reservations, shipments: d.shipments, customers: d.customers, inventory: d.inventory, prices: d.prices || {} } };
}

// 同じ id のものが2件以上あれば true（id が無いものは、読み込んだあとに別々の id を付けるので数えない。
// 顧客の古い数値の id は文字に直すので、数値の 1 と文字の "1" は同じとみなす）
function hasDuplicateId(list, idOf) {
  const seen = new Set();
  return list.some(x => {
    const id = idOf(x);
    if (id === undefined || id === null || id === "" || id === false) return false;
    const key = String(id);
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
}

// バックアップの内容に入れ替えて保存する。保存できたら true、できなければ元のデータのまま false を返す
function applyBackup(d) {
  const previous = { reservations, shipments, customers, inventory, prices };
  reservations = d.reservations;
  shipments = d.shipments;
  customers = d.customers;
  inventory = normalizeInventory(d.inventory);
  prices = loadPricesFrom(d.prices);
  ensureAllIds(false);
  // バックアップの内容で、Supabase をまとめて置きかえる（1行ずつ更新日時を確かめない）
  cloudReplaceAll = true;
  const saved = saveAll([
    ["reservations", reservations],
    [SHIPMENTS_STORAGE_KEY, shipments],
    [CUSTOMERS_STORAGE_KEY, customers],
    [INVENTORY_STORAGE_KEY, inventory],
    [PRICES_STORAGE_KEY, prices]
  ]);
  if (!saved) {
    ({ reservations, shipments, customers, inventory, prices } = previous);
    refreshAll();
    return false;
  }
  // 読み込んだデータは id も含めてすべて保存できたので、保存待ちの id は無い
  idsNotSaved = false;
  cancelEdit();
  cancelShipmentEdit();
  cancelCustomerEdit();
  const detail = document.getElementById("customerDetail");
  detail.hidden = true;
  detail.innerHTML = "";
  refreshAll();
  return true;
}

function importBackup(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;
  const finish = (message, type = "error") => {
    input.value = "";
    if (message) notify(message, type);
  };
  if (file.size > MAX_BACKUP_BYTES) {
    finish("ファイルが大きすぎます。バックアップファイルを選んでください");
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => finish("ファイルを読み込めませんでした");
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      finish("ファイルを読み込めませんでした。書き出したバックアップファイル（.json）を選んでください");
      return;
    }
    const result = validateBackup(parsed);
    if (result.error) {
      finish(result.error);
      return;
    }
    const d = result.data;
    const message = `このバックアップを読み込みますか？\n\n【読み込む内容】予約${d.reservations.length}件 / 出荷${d.shipments.length}件 / 顧客${d.customers.length}件\n【現在のデータ】予約${reservations.length}件 / 出荷${shipments.length}件 / 顧客${customers.length}件\n\nSupabase に保存している現在のデータは、この内容に置きかわります（ほかのパソコンやスマホで見ているデータも置きかわります。ただし、この画面が最後に読み込んだあとで、ほかの人が足したデータは残ります）。必要なら先に「データを書き出す」で保存してください。`;
    confirmThen(message, () => {
      // Supabase へ送っている途中は、送り終わるまで待ってもらう（送っている変更と、バックアップが混ざらないように）
      if (cloudSaving || hasUnsentCloudChanges()) {
        finish("Supabase へ保存している途中のため、バックアップを読み込めませんでした。「Supabase に保存済み」になってから、もう一度読み込んでください。");
        return;
      }
      if (applyBackup(d)) {
        finish("バックアップを読み込みました", "success");
      } else {
        finish("バックアップを保存できなかったため、読み込みを取りやめました（保存できる容量が足りない可能性があります）。今までのデータはそのままです");
      }
    }, () => finish());
  };
  reader.readAsText(file);
}

fillOptions();
document.getElementById("reservationSort").value = loadChoice(RESERVATION_SORT_KEY, RESERVATION_SORTS, "recent");
document.getElementById("shipmentSort").value = loadChoice(SHIPMENT_SORT_KEY, SHIPMENT_SORTS, "recent");
document.getElementById("shipmentDate").value = todayString();
document.getElementById("reservationSort").addEventListener("change", e => {
  save(RESERVATION_SORT_KEY, e.target.value);
  refreshAll();
});
document.getElementById("shipmentSort").addEventListener("change", e => {
  save(SHIPMENT_SORT_KEY, e.target.value);
  refreshAll();
});
["searchName", "filterVariety", "filterMonth", "filterChannel", "filterStatus", "customerSearch", "customerSort"].forEach(id => document.getElementById(id).addEventListener("input", refreshAll));
document.getElementById("filterVariety").onchange = refreshAll;
document.getElementById("filterMonth").onchange = refreshAll;
document.getElementById("customerSort").onchange = displayCustomers;
document.getElementById("customerSelect").onchange = e => {
  document.getElementById("name").value = customers.find(c => c.customerId === e.target.value)?.name || "";
};
document.getElementById("shipmentCustomerSelect").onchange = e => {
  document.getElementById("shipmentName").value = customers.find(c => c.customerId === e.target.value)?.name || "";
  // 前に選んでいた予約が、選び直した顧客の予約なら、選んだままにする。
  // 出荷の編集中は、元の出荷が紐づいていた予約も候補にする（顧客を A→B→A と戻したときに、元の予約が選ばれるように）
  const current = document.getElementById("shipmentReservation").value;
  const original = editingShipmentId === null ? null : shipments.find(x => x.id === editingShipmentId);
  const owns = id => !!id && customerFor(reservations.find(x => x.id === id) || {})?.customerId === e.target.value;
  refreshShipmentReservationOptions(owns(current) ? current : owns(original?.reservationId) ? original.reservationId : "");
};
document.getElementById("name").oninput = () => detachCustomerIfRenamed("customerSelect", "name");
document.getElementById("shipmentName").oninput = () => {
  if (detachCustomerIfRenamed("shipmentCustomerSelect", "shipmentName")) refreshShipmentReservationOptions();
};
// 名前欄の入力を終えたとき（欄を離れたとき）に、登録済みの顧客と同じ名前ならその顧客を選ぶ
// （出荷が紐づいた予約の編集中は顧客を変えられないので、自動で選ばない。選ぶと、変えていないのに「顧客は変更できません」で止まるため。
//   ただし顧客の登録が見つからない予約は選び直せるので、自動で選ぶ）
document.getElementById("name").onchange = () => {
  if (linkedShipmentCount(editingReservationId) && !reservationCustomerMissing(editingReservationId)) return;
  selectCustomerByTypedName("customerSelect", "name");
};
document.getElementById("shipmentName").onchange = () => {
  if (selectCustomerByTypedName("shipmentCustomerSelect", "shipmentName")) refreshShipmentReservationOptions();
};
document.getElementById("shipmentReservation").onchange = syncShipmentVarietyWithReservation;
document.querySelectorAll(".view-tab").forEach(e => e.onclick = () => switchView(e.dataset.view));
OLD_SHEET_KEYS.forEach(k => {
  try {
    localStorage.removeItem(k);
  } catch {
    // 消せなくても、アプリは使える
  }
});
refreshAll();
document.getElementById("loginForm").addEventListener("submit", submitLogin);
startCloud();
