// 残り在庫がこの値未満になったら「在庫少」と表示します。
const LOW_STOCK_THRESHOLD = 100;
const INVENTORY_STORAGE_KEY = "inventory";
const SHIPMENTS_STORAGE_KEY = "shipments";

let reservations = JSON.parse(localStorage.getItem("reservations")) || [];
let shipments = JSON.parse(localStorage.getItem(SHIPMENTS_STORAGE_KEY)) || [];

const varieties = ["A", "B", "C", "D", "E", "F"];
const months = Array.from({ length: 12 }, (_, index) => `${index + 1}月`);
let editingIndex = null;
let editingShipmentIndex = null;
let inventory = loadInventory();

function loadInventory() {
  const saved = JSON.parse(localStorage.getItem(INVENTORY_STORAGE_KEY)) || {};
  const values = {};
  varieties.forEach(variety => {
    const value = Number(saved[variety]);
    values[variety] = Number.isFinite(value) && value >= 0 ? value : 0;
  });
  return values;
}

function formatKg(value) {
  const rounded = Math.round(Number(value) * 10) / 10;
  return `${rounded}kg`;
}

function getFormValues() {
  return {
    variety: document.getElementById("variety").value,
    month: document.getElementById("month").value,
    name: document.getElementById("name").value.trim(),
    kg: Number(document.getElementById("kg").value)
  };
}

function validateReservation(reservation) {
  if (!reservation.name) { alert("名前を入力してください"); return false; }
  if (!reservation.kg || reservation.kg <= 0) { alert("kgを入力してください"); return false; }
  return true;
}

function addReservation() {
  const reservation = getFormValues();
  if (!validateReservation(reservation)) return;
  if (editingIndex === null) reservations.push(reservation);
  else { reservations[editingIndex] = reservation; cancelEdit(); }
  saveData();
  clearForm();
  displayReservations();
}

function editReservation(index) {
  const reservation = reservations[index];
  editingIndex = index;
  document.getElementById("variety").value = reservation.variety;
  document.getElementById("month").value = reservation.month;
  document.getElementById("name").value = reservation.name;
  document.getElementById("kg").value = reservation.kg;
  document.getElementById("submitButton").textContent = "変更を保存";
  document.getElementById("cancelEditButton").hidden = false;
  document.getElementById("name").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelEdit() {
  editingIndex = null;
  clearForm();
  document.getElementById("submitButton").textContent = "予約を追加";
  document.getElementById("cancelEditButton").hidden = true;
}

function clearForm() {
  document.getElementById("name").value = "";
  document.getElementById("kg").value = "";
}

function deleteReservation(index) {
  if (!confirm("この予約を削除しますか？")) return;
  reservations.splice(index, 1);
  if (editingIndex === index) cancelEdit();
  else if (editingIndex !== null && editingIndex > index) editingIndex -= 1;
  saveData();
  displayReservations();
}

function saveData() {
  localStorage.setItem("reservations", JSON.stringify(reservations));
}

function saveInventory(variety, value) {
  inventory[variety] = Math.max(0, Number(value) || 0);
  localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(inventory));
  refreshAll();
}

function getReservedTotals() {
  const totals = {};
  varieties.forEach(variety => { totals[variety] = 0; });
  reservations.forEach(reservation => {
    if (totals[reservation.variety] !== undefined) totals[reservation.variety] += Number(reservation.kg) || 0;
  });
  return totals;
}

function getShippedTotals() {
  const totals = {};
  varieties.forEach(variety => { totals[variety] = 0; });
  shipments.forEach(shipment => {
    if (totals[shipment.variety] !== undefined) totals[shipment.variety] += Number(shipment.kg) || 0;
  });
  return totals;
}

function getInventoryTotals() {
  const reserved = getReservedTotals();
  const shipped = getShippedTotals();
  let stockTotal = 0, reservedTotal = 0, shippedTotal = 0;
  varieties.forEach(variety => {
    stockTotal += inventory[variety];
    reservedTotal += reserved[variety];
    shippedTotal += shipped[variety];
  });
  return {
    stockTotal, reservedTotal, shippedTotal,
    unshippedTotal: reservedTotal - shippedTotal,
    physicalTotal: stockTotal - shippedTotal
  };
}

function getStockStatus(remaining) {
  if (remaining < 0) return "在庫不足";
  if (remaining < LOW_STOCK_THRESHOLD) return "在庫少";
  return "";
}

function displayReservations() {
  const list = document.getElementById("reservationList");
  const searchName = document.getElementById("searchName").value.trim();
  const filterVariety = document.getElementById("filterVariety").value;
  const filterMonth = document.getElementById("filterMonth").value;
  list.innerHTML = "";
  reservations.forEach((reservation, index) => {
    if (searchName && !reservation.name.includes(searchName)) return;
    if (filterVariety && reservation.variety !== filterVariety) return;
    if (filterMonth && reservation.month !== filterMonth) return;
    const row = document.createElement("tr");
    [reservation.variety, reservation.month, reservation.name, formatKg(reservation.kg)].forEach(value => {
      const cell = document.createElement("td"); cell.textContent = value; row.appendChild(cell);
    });
    const actions = document.createElement("td"); actions.className = "action-cell";
    const editButton = document.createElement("button"); editButton.className = "edit-button"; editButton.textContent = "編集";
    editButton.addEventListener("click", () => editReservation(index));
    const deleteButton = document.createElement("button"); deleteButton.className = "delete-button"; deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => deleteReservation(index));
    actions.append(editButton, deleteButton); row.appendChild(actions); list.appendChild(row);
  });
  displaySummary(); displayDashboard(); displayInventory();
}

function displaySummary() {
  const summary = document.getElementById("summary"); summary.innerHTML = "";
  const totals = {};
  reservations.forEach(reservation => {
    const key = `${reservation.variety}_${reservation.month}`;
    if (!totals[key]) totals[key] = { variety: reservation.variety, month: reservation.month, kg: 0 };
    totals[key].kg += Number(reservation.kg) || 0;
  });
  Object.values(totals).forEach(total => {
    const div = document.createElement("div"); div.className = "summary-item";
    div.textContent = `${total.variety}　${total.month}　${formatKg(total.kg)}`; summary.appendChild(div);
  });
}

function displayDashboard() {
  const totals = {}; varieties.forEach(v => { totals[v] = {}; months.forEach(m => { totals[v][m] = 0; }); });
  reservations.forEach(r => { if (totals[r.variety] && months.includes(r.month)) totals[r.variety][r.month] += Number(r.kg) || 0; });
  const columnTotals = {}; months.forEach(m => { columnTotals[m] = 0; });
  const body = document.getElementById("dashboardBody"); body.innerHTML = ""; let grandTotal = 0;
  varieties.forEach(variety => {
    const row = document.createElement("tr"); const label = document.createElement("th"); label.scope = "row"; label.textContent = variety; row.appendChild(label);
    let varietyTotal = 0;
    months.forEach(month => { const value = totals[variety][month]; varietyTotal += value; columnTotals[month] += value; const cell = document.createElement("td"); cell.textContent = formatKg(value); row.appendChild(cell); });
    grandTotal += varietyTotal; const annualCell = document.createElement("td"); annualCell.className = "annual-total"; annualCell.textContent = formatKg(varietyTotal); row.appendChild(annualCell); body.appendChild(row);
  });
  const totalRow = document.createElement("tr"); totalRow.className = "grand-total-row"; const totalLabel = document.createElement("th"); totalLabel.scope = "row"; totalLabel.textContent = "全体合計"; totalRow.appendChild(totalLabel);
  months.forEach(month => { const cell = document.createElement("td"); cell.textContent = formatKg(columnTotals[month]); totalRow.appendChild(cell); });
  const grandCell = document.createElement("td"); grandCell.textContent = formatKg(grandTotal); totalRow.appendChild(grandCell); body.appendChild(totalRow);
  document.getElementById("dashboardTotal").textContent = formatKg(grandTotal); displayDashboardTotals();
}

function displayDashboardTotals() {
  const totals = getInventoryTotals();
  document.getElementById("dashboardInventoryTotal").textContent = formatKg(totals.stockTotal);
  document.getElementById("dashboardReservedTotal").textContent = formatKg(totals.reservedTotal);
  document.getElementById("dashboardShippedTotal").textContent = formatKg(totals.shippedTotal);
  document.getElementById("dashboardUnshippedTotal").textContent = formatKg(totals.unshippedTotal);
  document.getElementById("dashboardPhysicalTotal").textContent = formatKg(totals.physicalTotal);
}

function displayInventory() {
  const body = document.getElementById("inventoryBody"); if (!body) return;
  const reserved = getReservedTotals(), shipped = getShippedTotals(); body.innerHTML = "";
  let stockTotal = 0, reservedTotal = 0, shippedTotal = 0;
  varieties.forEach(variety => {
    const physical = inventory[variety] - shipped[variety]; stockTotal += inventory[variety]; reservedTotal += reserved[variety]; shippedTotal += shipped[variety];
    const row = document.createElement("tr"); row.className = physical < 0 ? "stock-shortage" : physical < LOW_STOCK_THRESHOLD ? "stock-low" : "";
    const label = document.createElement("th"); label.scope = "row"; label.textContent = variety; row.appendChild(label);
    const inputCell = document.createElement("td"); const input = document.createElement("input"); input.type = "number"; input.min = "0"; input.step = "0.1"; input.value = inventory[variety]; input.setAttribute("aria-label", `${variety}の在庫量（kg）`); input.addEventListener("change", event => saveInventory(variety, event.target.value)); inputCell.appendChild(input); row.appendChild(inputCell);
    [formatKg(reserved[variety]), formatKg(physical)].forEach(value => { const cell = document.createElement("td"); cell.textContent = value; row.appendChild(cell); });
    const status = document.createElement("td"); status.className = "stock-status"; status.textContent = getStockStatus(physical); row.appendChild(status); body.appendChild(row);
  });
  const totalPhysical = stockTotal - shippedTotal; const totalRow = document.createElement("tr"); totalRow.className = "grand-total-row";
  ["全体", formatKg(stockTotal), formatKg(reservedTotal), formatKg(totalPhysical), getStockStatus(totalPhysical)].forEach((value, i) => { const cell = document.createElement(i === 0 ? "th" : "td"); if (i === 0) cell.scope = "row"; if (i === 4) cell.className = "stock-status"; cell.textContent = value; totalRow.appendChild(cell); }); body.appendChild(totalRow);
}

function getShipmentFormValues() {
  return { variety: document.getElementById("shipmentVariety").value, date: document.getElementById("shipmentDate").value, name: document.getElementById("shipmentName").value.trim(), kg: Number(document.getElementById("shipmentKg").value), memo: document.getElementById("shipmentMemo").value.trim() };
}

function addShipment() {
  const shipment = getShipmentFormValues();
  if (!shipment.date) { alert("出荷日を入力してください"); return; }
  if (!shipment.name) { alert("顧客名を入力してください"); return; }
  if (!shipment.kg || shipment.kg <= 0) { alert("出荷kgを入力してください"); return; }
  if (editingShipmentIndex === null) shipments.push(shipment); else { shipments[editingShipmentIndex] = shipment; cancelShipmentEdit(); }
  localStorage.setItem(SHIPMENTS_STORAGE_KEY, JSON.stringify(shipments)); clearShipmentForm(); refreshAll();
}

function editShipment(index) {
  const shipment = shipments[index]; editingShipmentIndex = index;
  document.getElementById("shipmentVariety").value = shipment.variety; document.getElementById("shipmentDate").value = shipment.date; document.getElementById("shipmentName").value = shipment.name; document.getElementById("shipmentKg").value = shipment.kg; document.getElementById("shipmentMemo").value = shipment.memo || "";
  document.getElementById("shipmentSubmitButton").textContent = "変更を保存"; document.getElementById("cancelShipmentEditButton").hidden = false; document.getElementById("shipmentName").focus();
}

function cancelShipmentEdit() { editingShipmentIndex = null; clearShipmentForm(); document.getElementById("shipmentSubmitButton").textContent = "出荷を登録"; document.getElementById("cancelShipmentEditButton").hidden = true; }
function clearShipmentForm() { ["shipmentDate", "shipmentName", "shipmentKg", "shipmentMemo"].forEach(id => { document.getElementById(id).value = ""; }); }
function deleteShipment(index) { if (!confirm("この出荷データを削除しますか？")) return; shipments.splice(index, 1); if (editingShipmentIndex === index) cancelShipmentEdit(); else if (editingShipmentIndex > index) editingShipmentIndex -= 1; localStorage.setItem(SHIPMENTS_STORAGE_KEY, JSON.stringify(shipments)); refreshAll(); }

function displayShipments() {
  const body = document.getElementById("shipmentList"); if (!body) return; body.innerHTML = "";
  shipments.forEach((shipment, index) => {
    const row = document.createElement("tr"); [shipment.date, shipment.variety, shipment.name, formatKg(shipment.kg), shipment.memo || ""].forEach(value => { const cell = document.createElement("td"); cell.textContent = value; row.appendChild(cell); });
    const actions = document.createElement("td"); actions.className = "action-cell"; const edit = document.createElement("button"); edit.className = "edit-button"; edit.textContent = "編集"; edit.addEventListener("click", () => editShipment(index)); const del = document.createElement("button"); del.className = "delete-button"; del.textContent = "削除"; del.addEventListener("click", () => deleteShipment(index)); actions.append(edit, del); row.appendChild(actions); body.appendChild(row);
  });
  displayShipmentTotals();
}

function displayShipmentTotals() {
  const body = document.getElementById("shipmentSummaryBody"); if (!body) return; const reserved = getReservedTotals(), shipped = getShippedTotals(); body.innerHTML = ""; let stock = 0, reservedTotal = 0, shippedTotal = 0;
  varieties.forEach(variety => { const unshipped = reserved[variety] - shipped[variety], physical = inventory[variety] - shipped[variety]; stock += inventory[variety]; reservedTotal += reserved[variety]; shippedTotal += shipped[variety]; const row = document.createElement("tr"); row.className = physical < 0 ? "stock-shortage" : physical < LOW_STOCK_THRESHOLD ? "stock-low" : ""; [variety, formatKg(inventory[variety]), formatKg(reserved[variety]), formatKg(shipped[variety]), formatKg(unshipped), formatKg(physical), getStockStatus(physical)].forEach((value, i) => { const cell = document.createElement(i === 0 ? "th" : "td"); if (i === 0) cell.scope = "row"; if (i === 6) cell.className = "stock-status"; cell.textContent = value; row.appendChild(cell); }); body.appendChild(row); });
  const totalPhysical = stock - shippedTotal; const totalRow = document.createElement("tr"); totalRow.className = "grand-total-row"; ["全体", formatKg(stock), formatKg(reservedTotal), formatKg(shippedTotal), formatKg(reservedTotal - shippedTotal), formatKg(totalPhysical), getStockStatus(totalPhysical)].forEach((value, i) => { const cell = document.createElement(i === 0 ? "th" : "td"); if (i === 0) cell.scope = "row"; if (i === 6) cell.className = "stock-status"; cell.textContent = value; totalRow.appendChild(cell); }); body.appendChild(totalRow);
}

function refreshAll() { displayReservations(); displayShipments(); }
function switchView(viewId) { document.querySelectorAll(".view-panel").forEach(panel => { panel.hidden = panel.id !== viewId; }); document.querySelectorAll(".view-tab").forEach(tab => { tab.classList.toggle("active", tab.dataset.view === viewId); }); }

document.getElementById("searchName").addEventListener("input", displayReservations);
document.getElementById("filterVariety").addEventListener("change", displayReservations);
document.getElementById("filterMonth").addEventListener("change", displayReservations);
document.querySelectorAll(".view-tab").forEach(tab => tab.addEventListener("click", () => switchView(tab.dataset.view)));
refreshAll();
