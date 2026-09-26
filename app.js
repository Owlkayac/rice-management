const LOW_STOCK_THRESHOLD = 100;
const INVENTORY_STORAGE_KEY = "inventory";
const SHIPMENTS_STORAGE_KEY = "shipments";
const CUSTOMERS_STORAGE_KEY = "customers";
const LAST_BACKUP_STORAGE_KEY = "lastBackupAt";
const BACKUP_APP_NAME = "rice-reservation-backup";
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
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

function warnSaveFailed() {
  const now = Date.now();
  if (now - lastSaveWarningAt < 3000) return;
  lastSaveWarningAt = now;
  notify("保存できませんでした。この変更は保存されていません。\nブラウザの保存容量がいっぱいか、プライベートブラウズ中の可能性があります。「データを書き出す」でバックアップを取ってください。", "error", 10000);
}

function save(k, v) {
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

function formatKg(v) {
  return `${Math.round((Number(v) || 0) * 100) / 100}kg`;
}

function uid(prefix = "customer") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// id が無い古いデータに id を付ける
function ensureIds(list, prefix, storageKey) {
  let changed = false;
  list.forEach(x => {
    if (!x.id) {
      x.id = uid(prefix);
      changed = true;
    }
  });
  if (changed) save(storageKey, list);
}

function ensureAllIds() {
  ensureIds(reservations, "reservation", "reservations");
  ensureIds(shipments, "shipment", SHIPMENTS_STORAGE_KEY);
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
      opts.push(`<option value="${r.id}">${esc(r.variety)}・${esc(r.month)}・${formatKg(r.kg)}（残り${formatKg(Math.max(remaining, 0))}）</option>`);
    }
  });
  sel.innerHTML = opts.join("");
  sel.value = list.some(({ r }) => r.id === selectedReservationId) ? selectedReservationId : "";
  sel.disabled = !customerId;
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

function refreshCustomerSelects() {
  const placeholder = customers.length ? "顧客を選択してください" : "顧客管理から登録してください";
  const opts = `<option value="">${placeholder}</option>` + customers.map(c => `<option value="${c.customerId}">${esc(c.name)}</option>`).join("");
  ["customerSelect", "shipmentCustomerSelect"].forEach(id => {
    const e = document.getElementById(id);
    const old = e.value;
    e.innerHTML = opts;
    if (customers.some(c => c.customerId === old)) {
      e.value = old;
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
  if (!r.kg || r.kg <= 0) {
    notify("kgを入力してください", "warn");
    return;
  }
  const warning = stockWarning(r, editingReservationId);
  if (warning) {
    confirmThen(warning, () => commitReservation(r));
  } else {
    commitReservation(r);
  }
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
  document.getElementById("name").value = r.name || "";
  document.getElementById("kg").value = r.kg;
  document.getElementById("channel").value = channelOf(r);
  document.getElementById("customerSelect").value = r.customerId || customerFor(r)?.customerId || "";
  document.getElementById("submitButton").textContent = "変更を保存";
  document.getElementById("cancelEditButton").hidden = false;
}

function cancelEdit() {
  editingReservationId = null;
  clearReservation();
  document.getElementById("channel").value = "";
  document.getElementById("submitButton").textContent = "予約を追加";
  document.getElementById("cancelEditButton").hidden = true;
}

function clearReservation() {
  document.getElementById("name").value = "";
  document.getElementById("kg").value = "";
  document.getElementById("customerSelect").value = "";
}

function deleteReservation(i) {
  if (!ensureFresh()) return;
  const targetId = reservations[i].id;
  confirmThen("この予約を削除しますか？", () => {
    const index = reservations.findIndex(x => x.id === targetId);
    if (index === -1) return;
    reservations.splice(index, 1);
    if (targetId === editingReservationId) cancelEdit();
    save("reservations", reservations);
    refreshAll();
  });
}

function totals(list, filter) {
  const r = {};
  list.filter(filter || (() => true)).forEach(x => r[x.variety] = (r[x.variety] || 0) + (Number(x.kg) || 0));
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
    [r.variety, r.month, customerName(r), formatKg(r.kg)].forEach((v, n) => {
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
    const k = `${r.variety}_${r.month}`;
    sums[k] = (sums[k] || 0) + (Number(r.kg) || 0);
  });
  document.getElementById("summary").innerHTML = Object.entries(sums).sort(([a], [b]) => {
    const [va, ma] = a.split("_");
    const [vb, mb] = b.split("_");
    return varieties.indexOf(va) - varieties.indexOf(vb) || monthNumber(ma) - monthNumber(mb);
  }).map(([k, v]) => `<div class="summary-item">${k.replace("_", "　")}　${formatKg(v)}</div>`).join("") || '<div class="empty-message">まだ予約がありません</div>';
}

function displayDashboard() {
  const data = {};
  varieties.forEach(v => data[v] = {});
  reservations.forEach(r => data[r.variety] && (data[r.variety][r.month] = (data[r.variety][r.month] || 0) + (Number(r.kg) || 0)));
  let grand = 0;
  let html = "";
  varieties.forEach(v => {
    let sum = 0;
    html += `<tr><th>${v}</th>` + months.map(m => {
      const n = data[v][m] || 0;
      sum += n;
      return `<td>${formatKg(n)}</td>`;
    }).join("") + `<td>${formatKg(sum)}</td></tr>`;
    grand += sum;
  });
  html += `<tr class="grand-total-row"><th>全体</th>${months.map(m => `<td>${formatKg(reservations.filter(r => r.month === m).reduce((a, r) => a + (Number(r.kg) || 0), 0))}</td>`).join("")}<td>${formatKg(grand)}</td></tr>`;
  document.getElementById("dashboardTableBody").innerHTML = html;
  document.getElementById("dashboardTotal").textContent = formatKg(grand);
  const rc = new Set(reservations.map(r => customerFor(r)?.customerId || `name:${r.name}`));
  const sc = new Set(shipments.map(r => customerFor(r)?.customerId || `name:${r.name}`));
  document.getElementById("dashboardCustomers").textContent = `${customers.length}人`;
  document.getElementById("dashboardReservationCustomerCount").textContent = `${rc.size}人`;
  document.getElementById("dashboardShipmentCustomerCount").textContent = `${sc.size}人`;
  document.getElementById("dashboardInventory").textContent = formatKg(varieties.reduce((a, v) => a + (Number(inventory[v]) || 0), 0));
  document.getElementById("dashboardShipments").textContent = formatKg(getShippedTotalsAll());
  document.getElementById("dashboardUnshippedTotal").textContent = formatKg(grand - getShippedTotalsAll());
  const sumKg = list => list.reduce((a, r) => a + (Number(r.kg) || 0), 0);
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
  if (s.reservationId) {
    const linked = reservations.find(x => x.id === s.reservationId);
    if (!linked || !s.customerId || customerFor(linked)?.customerId !== s.customerId) {
      notify("選んだ「対象の予約」がこの顧客の予約ではありません。顧客と対象の予約を選び直してください", "warn");
      refreshShipmentReservationOptions();
      return;
    }
  }
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
      confirmThen(`「${linked.variety}・${linked.month}・${formatKg(linked.kg)}」の予約は、紐づけられた出荷の合計で出荷し終えたようです。\n状態を「出荷済み」にしますか？`, () => {
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
  shipmentName.value = s.name || "";
  shipmentKg.value = s.kg;
  shipmentMemo.value = s.memo || "";
  shipmentCustomerSelect.value = s.customerId || customerFor(s)?.customerId || "";
  refreshShipmentReservationOptions(s.reservationId);
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
  shipmentCustomerSelect.value = keepCustomerId || "";
  shipmentName.value = customers.find(c => c.customerId === shipmentCustomerSelect.value)?.name || "";
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
  const b = document.getElementById("shipmentList");
  b.innerHTML = "";
  getVisibleShipments().forEach(({ s, i }) => {
    const tr = document.createElement("tr");
    [s.date, s.variety, customerName(s), formatKg(s.kg), s.memo || ""].forEach((v, n) => {
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
  body.innerHTML = varieties.map(v => `<tr><th>${v}</th><td>${formatKg(inventory[v])}</td><td>${formatKg(r[v])}</td><td>${formatKg(s[v])}</td><td>${formatKg((r[v] || 0) - (s[v] || 0))}</td></tr>`).join("");
}

function customerStats(c) {
  const rs = reservations.filter(r => customerFor(r)?.customerId === c.customerId);
  const ss = shipments.filter(s => customerFor(s)?.customerId === c.customerId);
  const byV = totals(rs);
  const shipV = totals(ss);
  const month = {};
  rs.forEach(r => month[r.month] = (month[r.month] || 0) + (Number(r.kg) || 0));
  const reserved = rs.reduce((a, r) => a + (Number(r.kg) || 0), 0);
  const shipped = ss.reduce((a, s) => a + (Number(s.kg) || 0), 0);
  return {
    rs, ss, byV, shipV, month, reserved, shipped, unshipped: reserved - shipped
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
  document.getElementById("customerList").innerHTML = arr.map(({ c, s }) => `<tr><td data-label="顧客名">${esc(c.name)}</td><td data-label="電話番号">${esc(c.phone)}</td><td data-label="住所">${esc(c.address)}</td><td data-label="メモ">${esc(c.memo)}</td><td data-label="予約合計">${formatKg(s.reserved)}</td><td data-label="出荷済み">${formatKg(s.shipped)}</td><td data-label="未出荷">${s.unshipped <= 0 ? '<span class="badge badge-done">出荷完了</span>' : formatKg(s.unshipped)}</td><td class="action-td"><button class="detail-button" onclick="showCustomerDetail('${c.customerId}')">詳細</button></td><td class="action-td"><button class="edit-button" onclick="editCustomer('${c.customerId}')">編集</button></td><td class="action-td"><button class="delete-button" onclick="deleteCustomer('${c.customerId}')">削除</button></td></tr>`).join("") || `<tr><td colspan="10" class="empty-message">${customers.length ? "条件に合う顧客がいません" : "まだ顧客が登録されていません"}</td></tr>`;
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
  const list = o => Object.entries(o).map(([k, v]) => `<li>${k}：${formatKg(v)}</li>`).join("") || "<li>なし</li>";
  const d = document.getElementById("customerDetail");
  d.hidden = false;
  d.innerHTML = `<h2>${esc(c.name)} の詳細</h2><div class="detail-grid"><div class="detail-card"><p><b>電話番号：</b>${esc(c.phone) || "未登録"}</p><p><b>住所：</b>${esc(c.address) || "未登録"}</p><p><b>メモ：</b>${esc(c.memo) || "なし"}</p></div><div class="detail-card"><h3>取引状況</h3><p>予約合計：${formatKg(s.reserved)}</p><p>出荷済み：${formatKg(s.shipped)}</p><p>未出荷：${s.unshipped <= 0 ? '<span class="badge badge-done">出荷完了</span>' : formatKg(s.unshipped)}</p></div><div class="detail-card"><h3>予約（品種別）</h3><ul>${list(s.byV)}</ul></div><div class="detail-card"><h3>予約（月別）</h3><ul>${list(s.month)}</ul></div><div class="detail-card"><h3>出荷（品種別）</h3><ul>${list(s.shipV)}</ul></div></div><div class="doc-buttons"><button type="button" class="tool-button" onclick="printCustomerDoc('${c.customerId}','delivery')">納品書を印刷</button><button type="button" class="tool-button" onclick="printCustomerDoc('${c.customerId}','invoice')">請求書を印刷</button></div><button onclick="document.getElementById('customerDetail').hidden=true">詳細を閉じる</button>`;
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
  const c = customers.find(x => x.customerId === customerId);
  if (!c) return;
  const rows = buildDocRows(c);
  if (!rows.length) {
    notify("この顧客の出荷の記録がありません", "warn");
    return;
  }
  const title = kind === "invoice" ? "請求書" : "納品書";
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
  if (!d.reservations.every(r => isPlainObject(r) && typeof r.variety === "string")) {
    return { error: "予約のデータが正しくありません" };
  }
  if (!d.shipments.every(s => isPlainObject(s) && typeof s.variety === "string")) {
    return { error: "出荷のデータが正しくありません" };
  }
  if (!d.customers.every(c => isPlainObject(c) && typeof c.name === "string" && /^[A-Za-z0-9_-]+$/.test(String(c.customerId)))) {
    return { error: "顧客のデータが正しくありません" };
  }
  if (!isPlainObject(d.inventory)) {
    return { error: "在庫のデータが正しくありません" };
  }
  if (d.prices !== undefined && !isPlainObject(d.prices)) {
    return { error: "単価のデータが正しくありません" };
  }
  return { data: { reservations: d.reservations, shipments: d.shipments, customers: d.customers, inventory: d.inventory, prices: d.prices || {} } };
}

function applyBackup(d) {
  reservations = d.reservations;
  shipments = d.shipments;
  customers = d.customers;
  inventory = normalizeInventory(d.inventory);
  prices = loadPricesFrom(d.prices);
  ensureAllIds();
  save("reservations", reservations);
  save(SHIPMENTS_STORAGE_KEY, shipments);
  save(CUSTOMERS_STORAGE_KEY, customers);
  save(INVENTORY_STORAGE_KEY, inventory);
  save(PRICES_STORAGE_KEY, prices);
  cancelEdit();
  cancelShipmentEdit();
  cancelCustomerEdit();
  const detail = document.getElementById("customerDetail");
  detail.hidden = true;
  detail.innerHTML = "";
  refreshAll();
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
      applyBackup(d);
      finish("バックアップを読み込みました", "success");
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
document.getElementById("shipmentReservation").onchange = e => {
  const r = reservations.find(x => x.id === e.target.value);
  if (r) shipmentVariety.value = r.variety;
};
document.querySelectorAll(".view-tab").forEach(e => e.onclick = () => switchView(e.dataset.view));
refreshAll();
