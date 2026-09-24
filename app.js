const LOW_STOCK_THRESHOLD = 100;
const INVENTORY_STORAGE_KEY = "inventory";
const SHIPMENTS_STORAGE_KEY = "shipments";
const CUSTOMERS_STORAGE_KEY = "customers";
const LAST_BACKUP_STORAGE_KEY = "lastBackupAt";
const BACKUP_APP_NAME = "rice-reservation-backup";
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const varieties = ["A", "B", "C", "D", "E", "F"];
const months = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
let reservations = read("reservations", []);
let shipments = read(SHIPMENTS_STORAGE_KEY, []);
let customers = read(CUSTOMERS_STORAGE_KEY, []);
let inventory = loadInventory();
let editingIndex = null;
let editingShipmentIndex = null;
let editingCustomerId = null;

function read(k, f) {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? f;
  } catch {
    return f;
  }
}

function save(k, v) {
  localStorage.setItem(k, JSON.stringify(v));
}

function formatKg(v) {
  return `${Math.round((Number(v) || 0) * 10) / 10}kg`;
}

function uid() {
  return `customer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeInventory(x) {
  x = x || {};
  const r = {};
  varieties.forEach(v => r[v] = Number.isFinite(Number(x[v])) && Number(x[v]) >= 0 ? Number(x[v]) : 0);
  return r;
}

function loadInventory() {
  return normalizeInventory(read(INVENTORY_STORAGE_KEY, {}));
}

function fillOptions() {
  ["variety", "shipmentVariety"].forEach(id => {
    const e = document.getElementById(id);
    e.innerHTML = varieties.map(v => `<option>${v}</option>`).join("");
  });
  document.getElementById("filterVariety").innerHTML = '<option value="">すべて</option>' + varieties.map(v => `<option>${v}</option>`).join("");
  document.getElementById("month").innerHTML = months.map(m => `<option>${m}</option>`).join("");
  document.getElementById("filterMonth").innerHTML = '<option value="">すべて</option>' + months.map(m => `<option>${m}</option>`).join("");
  refreshCustomerSelects();
}

function customerFor(item) {
  return item.customerId ? customers.find(c => c.customerId === item.customerId) : customers.find(c => c.name === item.name);
}

function customerName(item) {
  return customerFor(item)?.name || item.name || "未登録";
}

function refreshCustomerSelects() {
  const opts = '<option value="">顧客管理から登録してください</option>' + customers.map(c => `<option value="${c.customerId}">${esc(c.name)}</option>`).join("");
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
    variety: variety.value, month: month.value, name: legacy || customers.find(c => c.customerId === s.value)?.name || "", customerId: s.value || undefined, kg: Number(document.getElementById("kg").value)
  };
}

function addReservation() {
  const r = getFormValues();
  if (!r.name) {
    alert("顧客を選択するか、既存データ用の名前を入力してください");
    return;
  }
  if (!r.kg || r.kg <= 0) {
    alert("kgを入力してください");
    return;
  }
  if (editingIndex === null) {
    reservations.push(r);
  } else {
    reservations[editingIndex] = r;
    cancelEdit();
  }
  save("reservations", reservations);
  clearReservation();
  refreshAll();
}

function editReservation(i) {
  const r = reservations[i];
  editingIndex = i;
  document.getElementById("variety").value = r.variety;
  document.getElementById("month").value = r.month;
  document.getElementById("name").value = r.name || "";
  document.getElementById("kg").value = r.kg;
  document.getElementById("customerSelect").value = r.customerId || customerFor(r)?.customerId || "";
  document.getElementById("submitButton").textContent = "変更を保存";
  document.getElementById("cancelEditButton").hidden = false;
}

function cancelEdit() {
  editingIndex = null;
  clearReservation();
  document.getElementById("submitButton").textContent = "予約を追加";
  document.getElementById("cancelEditButton").hidden = true;
}

function clearReservation() {
  document.getElementById("name").value = "";
  document.getElementById("kg").value = "";
  document.getElementById("customerSelect").value = "";
}

function deleteReservation(i) {
  if (confirm("この予約を削除しますか？")) {
    reservations.splice(i, 1);
    save("reservations", reservations);
    refreshAll();
  }
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

function displayReservations() {
  const q = document.getElementById("searchName").value.trim();
  const fv = document.getElementById("filterVariety").value;
  const fm = document.getElementById("filterMonth").value;
  const body = document.getElementById("reservationList");
  body.innerHTML = "";
  reservations.forEach((r, i) => {
    if (q && !customerName(r).includes(q) && !(r.name || "").includes(q) || fv && r.variety !== fv || fm && r.month !== fm) {
      return;
    }
    const tr = document.createElement("tr");
    [r.variety, r.month, customerName(r), formatKg(r.kg)].forEach(v => {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    });
    const td = document.createElement("td");
    td.className = "action-cell";
    td.innerHTML = '<button class="edit-button">編集</button><button class="delete-button">削除</button>';
    td.children[0].onclick = () => editReservation(i);
    td.children[1].onclick = () => deleteReservation(i);
    tr.appendChild(td);
    body.appendChild(tr);
  });
  const sums = {};
  reservations.forEach(r => {
    const k = `${r.variety}_${r.month}`;
    sums[k] = (sums[k] || 0) + (Number(r.kg) || 0);
  });
  document.getElementById("summary").innerHTML = Object.entries(sums).map(([k, v]) => `<div class="summary-item">${k.replace("_", "　")}　${formatKg(v)}</div>`).join("");
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
  document.getElementById("dashboardCustomerCount").textContent = customers.length;
  document.getElementById("dashboardReservationCustomerCount").textContent = rc.size;
  document.getElementById("dashboardShipmentCustomerCount").textContent = sc.size;
  document.getElementById("dashboardUnshippedTotal").textContent = formatKg(grand - getShippedTotalsAll());
}

function getShippedTotalsAll() {
  return shipments.reduce((a, s) => a + (Number(s.kg) || 0), 0);
}

function displayInventory() {
  const reserved = getReservedTotals();
  const shipped = getShippedTotals();
  const body = document.getElementById("inventoryList");
  body.innerHTML = "";
  varieties.forEach(v => {
    const remain = inventory[v] - (shipped[v] || 0);
    const tr = document.createElement("tr");
    tr.className = remain < 0 ? "stock-shortage" : remain < LOW_STOCK_THRESHOLD ? "stock-low" : "";
    tr.innerHTML = `<th>${v}</th><td><input type="number" min="0" value="${inventory[v]}"></td><td>${formatKg(reserved[v])}</td><td>${formatKg(remain)}</td><td>${remain < 0 ? "在庫不足" : remain < LOW_STOCK_THRESHOLD ? "在庫少" : ""}</td>`;
    tr.querySelector("input").onchange = e => {
      inventory[v] = Math.max(0, Number(e.target.value) || 0);
      save(INVENTORY_STORAGE_KEY, inventory);
      refreshAll();
    };
    body.appendChild(tr);
  });
}

function shipmentValues() {
  const s = document.getElementById("shipmentCustomerSelect");
  const legacy = document.getElementById("shipmentName").value.trim();
  return {
    variety: shipmentVariety.value, date: shipmentDate.value, name: legacy || customers.find(c => c.customerId === s.value)?.name || "", customerId: s.value || undefined, kg: Number(shipmentKg.value), memo: shipmentMemo.value.trim()
  };
}

function addShipment() {
  const s = shipmentValues();
  if (!s.date || !s.name || !s.kg || s.kg <= 0) {
    alert("出荷日・顧客・出荷kgを入力してください");
    return;
  }
  if (editingShipmentIndex === null) {
    shipments.push(s);
  } else {
    shipments[editingShipmentIndex] = s;
    cancelShipmentEdit();
  }
  save(SHIPMENTS_STORAGE_KEY, shipments);
  clearShipmentForm();
  refreshAll();
}

function editShipment(i) {
  const s = shipments[i];
  editingShipmentIndex = i;
  shipmentVariety.value = s.variety;
  shipmentDate.value = s.date;
  shipmentName.value = s.name || "";
  shipmentKg.value = s.kg;
  shipmentMemo.value = s.memo || "";
  shipmentCustomerSelect.value = s.customerId || customerFor(s)?.customerId || "";
  shipmentSubmitButton.textContent = "変更を保存";
  cancelShipmentEditButton.hidden = false;
}

function cancelShipmentEdit() {
  editingShipmentIndex = null;
  clearShipmentForm();
  shipmentSubmitButton.textContent = "出荷を登録";
  cancelShipmentEditButton.hidden = true;
}

function clearShipmentForm() {
  ["shipmentDate", "shipmentName", "shipmentKg", "shipmentMemo"].forEach(id => document.getElementById(id).value = "");
  shipmentCustomerSelect.value = "";
}

function deleteShipment(i) {
  if (confirm("この出荷データを削除しますか？")) {
    shipments.splice(i, 1);
    save(SHIPMENTS_STORAGE_KEY, shipments);
    refreshAll();
  }
}

function displayShipments() {
  const b = document.getElementById("shipmentList");
  b.innerHTML = "";
  shipments.forEach((s, i) => {
    const tr = document.createElement("tr");
    [s.date, s.variety, customerName(s), formatKg(s.kg), s.memo || ""].forEach(v => {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    });
    const td = document.createElement("td");
    td.innerHTML = '<button class="edit-button">編集</button><button class="delete-button">削除</button>';
    td.children[0].onclick = () => editShipment(i);
    td.children[1].onclick = () => deleteShipment(i);
    tr.appendChild(td);
    b.appendChild(tr);
  });
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
  const byM = totals(rs, r => true);
  const month = {};
  rs.forEach(r => month[r.month] = (month[r.month] || 0) + (Number(r.kg) || 0));
  const reserved = rs.reduce((a, r) => a + (Number(r.kg) || 0), 0);
  const shipped = ss.reduce((a, s) => a + (Number(s.kg) || 0), 0);
  return {
    rs, ss, byV, shipV, month, reserved, shipped, unshipped: reserved - shipped
  };
}

function displayCustomers() {
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
  document.getElementById("customerList").innerHTML = arr.map(({ c, s }) => `<tr><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${esc(c.address)}</td><td>${esc(c.memo)}</td><td>${formatKg(s.reserved)}</td><td>${formatKg(s.shipped)}</td><td>${s.unshipped <= 0 ? "出荷完了" : formatKg(s.unshipped)}</td><td><button class="detail-button" onclick="showCustomerDetail('${c.customerId}')">詳細</button></td><td><button class="edit-button" onclick="editCustomer('${c.customerId}')">編集</button></td><td><button class="delete-button" onclick="deleteCustomer('${c.customerId}')">削除</button></td></tr>`).join("");
}

function saveCustomer() {
  const name = document.getElementById("customerName").value.trim();
  const furigana = document.getElementById("customerFurigana").value.trim();
  if (!name) {
    alert("顧客名を入力してください");
    return;
  }
  if (!furigana) {
    alert("ふりがなを入力してください");
    return;
  }
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
  const c = customers.find(x => x.customerId === id);
  if (!c) {
    return;
  }
  const s = customerStats(c);
  if (s.rs.length || s.ss.length) {
    alert("この顧客には予約または出荷データが存在します。関連データを先に確認してください。");
    return;
  }
  if (confirm(`${c.name}を削除しますか？`)) {
    customers = customers.filter(x => x.customerId !== id);
    save(CUSTOMERS_STORAGE_KEY, customers);
    refreshAll();
  }
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
  d.innerHTML = `<h2>${esc(c.name)} の詳細</h2><div class="detail-grid"><div class="detail-card"><p><b>電話番号：</b>${esc(c.phone) || "未登録"}</p><p><b>住所：</b>${esc(c.address) || "未登録"}</p><p><b>メモ：</b>${esc(c.memo) || "なし"}</p></div><div class="detail-card"><h3>取引状況</h3><p>予約合計：${formatKg(s.reserved)}</p><p>出荷済み：${formatKg(s.shipped)}</p><p>未出荷：${s.unshipped <= 0 ? "出荷完了" : formatKg(s.unshipped)}</p></div><div class="detail-card"><h3>予約（品種別）</h3><ul>${list(s.byV)}</ul></div><div class="detail-card"><h3>予約（月別）</h3><ul>${list(s.month)}</ul></div><div class="detail-card"><h3>出荷（品種別）</h3><ul>${list(s.shipV)}</ul></div></div><button onclick="document.getElementById('customerDetail').hidden=true">詳細を閉じる</button>`;
  d.scrollIntoView({ behavior: "smooth" });
}

function switchView(id) {
  document.querySelectorAll(".view-panel").forEach(e => e.hidden = e.id !== id);
  document.querySelectorAll(".view-tab").forEach(e => e.classList.toggle("active", e.dataset.view === id));
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
  showBackupStatus();
}

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
    data: { reservations, shipments, customers, inventory }
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
  return { data: { reservations: d.reservations, shipments: d.shipments, customers: d.customers, inventory: d.inventory } };
}

function applyBackup(d) {
  reservations = d.reservations;
  shipments = d.shipments;
  customers = d.customers;
  inventory = normalizeInventory(d.inventory);
  save("reservations", reservations);
  save(SHIPMENTS_STORAGE_KEY, shipments);
  save(CUSTOMERS_STORAGE_KEY, customers);
  save(INVENTORY_STORAGE_KEY, inventory);
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
  const finish = message => {
    input.value = "";
    if (message) alert(message);
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
    if (!confirm(message)) {
      finish();
      return;
    }
    applyBackup(d);
    finish("バックアップを読み込みました");
  };
  reader.readAsText(file);
}

fillOptions();
["searchName", "filterVariety", "filterMonth", "customerSearch", "customerSort"].forEach(id => document.getElementById(id).addEventListener("input", refreshAll));
document.getElementById("filterVariety").onchange = refreshAll;
document.getElementById("filterMonth").onchange = refreshAll;
document.getElementById("customerSort").onchange = displayCustomers;
document.getElementById("customerSelect").onchange = e => {
  document.getElementById("name").value = customers.find(c => c.customerId === e.target.value)?.name || "";
};
document.getElementById("shipmentCustomerSelect").onchange = e => {
  document.getElementById("shipmentName").value = customers.find(c => c.customerId === e.target.value)?.name || "";
};
document.querySelectorAll(".view-tab").forEach(e => e.onclick = () => switchView(e.dataset.view));
refreshAll();
