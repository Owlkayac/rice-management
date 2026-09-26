const LOW_STOCK_THRESHOLD = 100;
const INVENTORY_STORAGE_KEY = "inventory";
const SHIPMENTS_STORAGE_KEY = "shipments";
const CUSTOMERS_STORAGE_KEY = "customers";
const LAST_BACKUP_STORAGE_KEY = "lastBackupAt";
const BACKUP_APP_NAME = "rice-reservation-backup";
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
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
    return JSON.parse(localStorage.getItem(k)) ?? f;
  } catch {
    return f;
  }
}

function rawGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
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
    localStorage.setItem(k, text);
    lastSeen[k] = text;
    return true;
  } catch {
    warnSaveFailed();
    return false;
  }
}

// 複数のデータをまとめて保存する。どれか1つでも保存に失敗したら、先に保存したものも元の中身に戻して false を返す
// （容量不足などで途中まで保存され、「予約は新しいのに顧客は古い」ような食い違いが残らないようにするため）。
// 失敗の通知は呼び出す側で出す
function saveAll(entries) {
  const written = [];
  try {
    entries.forEach(([k, v]) => {
      const before = rawGet(k);
      const text = JSON.stringify(v);
      localStorage.setItem(k, text);
      lastSeen[k] = text;
      written.push({ k, before, text });
    });
    return true;
  } catch {
    // 元に戻すのは、書き込めたキーだけ（書き込めなかったキーは元の中身のまま残っている）。
    // 先に書き込んだキーを消して容量を空けてから、元の中身を書き戻す
    written.forEach(({ k }) => {
      try {
        localStorage.removeItem(k);
      } catch {
        // 消せなくても、書き戻しは続ける
      }
    });
    let restored = true;
    written.forEach(({ k, before, text }) => {
      try {
        if (before !== null) localStorage.setItem(k, before);
      } catch {
        restored = false;
        // 元に戻せないときも、そのキーを空のままにしない（さっき書き込めた新しい中身を書き直す）
        try {
          localStorage.setItem(k, text);
        } catch {
          // ここまで失敗したら、どうにもできない
        }
      }
      lastSeen[k] = rawGet(k);
    });
    if (!restored) {
      notify("保存に失敗し、元のデータにも戻せませんでした。データが食い違っている可能性があります。すぐに「データを書き出す」でバックアップを取り、内容を確かめてください。", "error", 20000);
    }
    return false;
  }
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
function unshippedByVariety(reservationList, shipmentList) {
  const groups = [...varieties.map(v => x => x.variety === v), x => !varieties.includes(x.variety)];
  let remaining = 0;
  let over = 0;
  groups.forEach(match => {
    const rest = unshippedKg(sumKg(reservationList.filter(match)), sumKg(shipmentList.filter(match)));
    if (rest > 0) remaining += rest;
    else over -= rest;
  });
  return { remaining: roundKg(remaining), over: roundKg(over) };
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

// 顧客の選択肢を作り直す。選んでいた顧客の名前が変わっていたら名前欄も今の名前にそろえ、
// 選んでいた顧客が消えていたら名前欄も空にする（名前欄と選択の食い違いを残さないため）
function refreshCustomerSelects() {
  const placeholder = customers.length ? "顧客を選択してください" : "顧客管理から登録してください";
  const opts = `<option value="">${placeholder}</option>` + customers.map(c => `<option value="${esc(c.customerId)}">${esc(c.name)}</option>`).join("");
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
  if (linked && before && customerChangedSinceEditStart()) {
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
  if (linked && before && !sameVariety(before.variety, r.variety)) {
    confirmThen(`この予約には出荷が${linked}件紐づいています。\n\n品種：${varietyLabel(before.variety)} → ${varietyLabel(r.variety)}\n\n紐づいた出荷の品種は変わらないため、予約と出荷の品種が食い違います。このまま保存しますか？`, checkStock);
  } else {
    checkStock();
  }
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
  if (editingReservationId === null) {
    r.id = uid("reservation");
    r.status = "received";
    reservations.push(r);
  } else {
    const i = reservations.findIndex(x => x.id === editingReservationId);
    if (i === -1) {
      notify("編集中の予約が見つかりません（削除された可能性があります）。編集を取り消しました。", "warn");
      cancelEdit();
      refreshAll();
      return;
    }
    r.id = editingReservationId;
    r.status = statusOf(reservations[i]);
    reservations[i] = r;
    cancelEdit();
  }
  save("reservations", reservations);
  clearReservation();
  refreshAll();
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

// 出荷が紐づいている予約を編集している間は、顧客欄の下に「顧客は変更できません」と出しておく
function updateCustomerLockNote() {
  const note = document.getElementById("customerLockNote");
  // 古い index.html が残っていて要素が無いときは何もしない（ここで止まると予約の保存まで止まるため）
  if (!note) return;
  const count = linkedShipmentCount(editingReservationId);
  note.hidden = !count;
  note.textContent = "";
  if (!count) return;
  // 画面が狭いときは「、」のところで折り返すように、2つに分けて入れる
  [`出荷が${count}件紐づいているため、`, "顧客は変更できません"].forEach(text => {
    const span = document.createElement("span");
    span.textContent = text;
    note.appendChild(span);
  });
}

function clearReservation() {
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
      if (!ensureFresh()) return;
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
    tr.querySelector("input").onchange = e => {
      if (!ensureFresh()) return;
      inventory[v] = Math.max(0, Number(e.target.value) || 0);
      save(INVENTORY_STORAGE_KEY, inventory);
      refreshAll();
    };
    tr.querySelector(".price-input").onchange = e => {
      if (!ensureFresh()) return;
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
  if (original && !sameVariety(original.variety, s.variety)) {
    const hint = s.reservationId ? "\n\n品種は、紐づけた予約に合わせています。元の品種のままにするなら「キャンセル」を押し、対象の予約を「特定の予約に紐づけない」にしてから品種を選び直してください。" : "";
    confirmThen(`この出荷の品種を「${varietyLabel(original.variety)}」から「${varietyLabel(s.variety)}」に変えて保存しますか？${hint}`, () => commitShipment(s));
    return;
  }
  commitShipment(s);
}

function commitShipment(s) {
  if (editingShipmentId === null) {
    s.id = uid("shipment");
    shipments.push(s);
  } else {
    const i = shipments.findIndex(x => x.id === editingShipmentId);
    if (i === -1) {
      notify("編集中の出荷が見つかりません（削除された可能性があります）。編集を取り消しました。", "warn");
      cancelShipmentEdit();
      refreshAll();
      return;
    }
    s.id = editingShipmentId;
    shipments[i] = s;
    cancelShipmentEdit();
  }
  save(SHIPMENTS_STORAGE_KEY, shipments);
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
// 未出荷は品種ごとの残りの合計。「出荷完了」は、すべての品種で残りが0のときだけ出す。
// 予約も出荷も無い顧客は「—」（取引が無いのに「完了」と見えないように）。
// スマホの表ではマスの中身が横に並ぶので、1つの span にまとめて、補足がバッジや数字の下に来るようにする
function unshippedCell(stats) {
  if (!stats.rs.length && !stats.ss.length) return "—";
  const main = stats.unshipped > 0 ? formatKg(stats.unshipped) : '<span class="badge badge-done">出荷完了</span>';
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
  const { remaining, over } = unshippedByVariety(rs, ss);
  return {
    rs, ss, byV, shipV, month, reserved, shipped, unshipped: remaining, overShipped: over
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
  document.getElementById("customerList").innerHTML = arr.map(({ c, s }) => `<tr><td data-label="顧客名">${esc(c.name)}</td><td data-label="電話番号">${esc(c.phone)}</td><td data-label="住所">${esc(c.address)}</td><td data-label="メモ">${esc(c.memo)}</td><td data-label="予約合計">${formatKg(s.reserved)}</td><td data-label="出荷済み">${formatKg(s.shipped)}</td><td data-label="未出荷">${unshippedCell(s)}</td><td class="action-td"><button class="detail-button">詳細</button></td><td class="action-td"><button class="edit-button">編集</button></td><td class="action-td"><button class="delete-button">削除</button></td></tr>`).join("") || `<tr><td colspan="10" class="empty-message">${customers.length ? "条件に合う顧客がいません" : "まだ顧客が登録されていません"}</td></tr>`;
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

function saveCustomer() {
  if (!ensureFresh()) return;
  const name = document.getElementById("customerName").value.trim();
  const furigana = document.getElementById("customerFurigana").value.trim();
  if (!name) {
    notify("顧客名を入力してください", "warn");
    return;
  }
  if (!furigana) {
    notify("ふりがなを入力してください", "warn");
    return;
  }
  const squash = t => String(t || "").replace(/\s+/g, "");
  const original = editingCustomerId ? customers.find(x => x.customerId === editingCustomerId) : null;
  const nameChanged = !original || squash(original.name) !== squash(name);
  if (nameChanged && customers.some(x => x.customerId !== editingCustomerId && squash(x.name) === squash(name))) {
    confirmThen(`「${name}」という名前の顧客がすでに登録されています。\n同じ人なら、新しく登録せず既存の顧客を使ってください。\n別の人として、このまま保存しますか？`, () => commitCustomer(name, furigana));
  } else {
    commitCustomer(name, furigana);
  }
}

function commitCustomer(name, furigana) {
  const c = {
    customerId: editingCustomerId || uid(), name, furigana, phone: document.getElementById("customerPhone").value.trim(), address: document.getElementById("customerAddress").value.trim(), memo: document.getElementById("customerMemo").value.trim()
  };
  if (editingCustomerId) {
    customers = customers.map(x => x.customerId === editingCustomerId ? c : x);
  } else {
    customers.push(c);
  }
  save(CUSTOMERS_STORAGE_KEY, customers);
  cancelCustomerEdit();
  refreshAll();
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
  d.innerHTML = `<h2>${esc(c.name)} の詳細</h2><div class="detail-grid"><div class="detail-card"><p><b>電話番号：</b>${esc(c.phone) || "未登録"}</p><p><b>住所：</b>${esc(c.address) || "未登録"}</p><p><b>メモ：</b>${esc(c.memo) || "なし"}</p></div><div class="detail-card"><h3>取引状況</h3><p>予約合計：${formatKg(s.reserved)}</p><p>出荷済み：${formatKg(s.shipped)}</p><p>未出荷：${unshippedCell(s)}</p></div><div class="detail-card"><h3>予約（品種別）</h3><ul>${list(s.byV, varietyLabel)}</ul></div><div class="detail-card"><h3>予約（月別）</h3><ul>${list(s.month, monthLabel)}</ul></div><div class="detail-card"><h3>出荷（品種別）</h3><ul>${list(s.shipV, varietyLabel)}</ul></div></div><div class="doc-buttons"><button type="button" class="tool-button" data-doc="delivery">納品書を印刷</button><button type="button" class="tool-button" data-doc="invoice">請求書を印刷</button></div><button type="button" class="detail-close-button">詳細を閉じる</button>`;
  // 顧客の id は onclick 属性に書き込まず、ここで結びつける（id に細工があってもスクリプトとして動かないように）
  d.querySelectorAll("[data-doc]").forEach(btn => btn.onclick = () => printCustomerDoc(c.customerId, btn.dataset.doc));
  d.querySelector(".detail-close-button").onclick = () => d.hidden = true;
  d.scrollIntoView({ behavior: "smooth" });
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

function syncFromOtherTab() {
  if (!isStale()) return;
  reloadFromStorage();
  notify("別のタブでデータが更新されたため、最新の内容に更新しました。", "info", 8000);
}

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

function exportBackup() {
  const backup = {
    app: BACKUP_APP_NAME,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: { reservations, shipments, customers, inventory, prices }
  };
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
  if (!isPlainObject(d.inventory)) {
    return { error: "在庫のデータが正しくありません" };
  }
  if (d.prices !== undefined && !isPlainObject(d.prices)) {
    return { error: "単価のデータが正しくありません" };
  }
  return { data: { reservations: d.reservations, shipments: d.shipments, customers: d.customers, inventory: d.inventory, prices: d.prices || {} } };
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
    const message = `このバックアップを読み込みますか？\n\n【読み込む内容】予約${d.reservations.length}件 / 出荷${d.shipments.length}件 / 顧客${d.customers.length}件\n【現在のデータ】予約${reservations.length}件 / 出荷${shipments.length}件 / 顧客${customers.length}件\n\n現在のデータはすべて上書きされます。必要なら先に「データを書き出す」で保存してください。`;
    confirmThen(message, () => {
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
  refreshShipmentReservationOptions();
};
document.getElementById("name").oninput = () => detachCustomerIfRenamed("customerSelect", "name");
document.getElementById("shipmentName").oninput = () => {
  if (detachCustomerIfRenamed("shipmentCustomerSelect", "shipmentName")) refreshShipmentReservationOptions();
};
document.getElementById("shipmentReservation").onchange = syncShipmentVarietyWithReservation;
document.querySelectorAll(".view-tab").forEach(e => e.onclick = () => switchView(e.dataset.view));
refreshAll();
