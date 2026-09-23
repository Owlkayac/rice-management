let reservations =
  JSON.parse(localStorage.getItem("reservations")) || [];

let editingIndex = null;
const varieties = ["A", "B", "C", "D", "E", "F"];
const months = Array.from({ length: 12 }, (_, index) => `${index + 1}月`);

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
  if (!reservation.name) {
    alert("名前を入力してください");
    return false;
  }

  if (!reservation.kg || reservation.kg <= 0) {
    alert("kgを入力してください");
    return false;
  }

  return true;
}

function addReservation() {
  const reservation = getFormValues();

  if (!validateReservation(reservation)) {
    return;
  }

  if (editingIndex === null) {
    reservations.push(reservation);
  } else {
    reservations[editingIndex] = reservation;
    cancelEdit();
  }

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
  if (!confirm("この予約を削除しますか？")) {
    return;
  }

  reservations.splice(index, 1);
  if (editingIndex === index) {
    cancelEdit();
  } else if (editingIndex !== null && editingIndex > index) {
    editingIndex -= 1;
  }

  saveData();
  displayReservations();
}

function saveData() {
  localStorage.setItem("reservations", JSON.stringify(reservations));
}

function displayReservations() {
  const list = document.getElementById("reservationList");
  const searchName = document.getElementById("searchName").value.trim();
  const filterVariety = document.getElementById("filterVariety").value;
  const filterMonth = document.getElementById("filterMonth").value;

  list.innerHTML = "";

  reservations.forEach((reservation, index) => {
    const matchesName = !searchName || reservation.name.includes(searchName);
    const matchesVariety = !filterVariety || reservation.variety === filterVariety;
    const matchesMonth = !filterMonth || reservation.month === filterMonth;

    if (!matchesName || !matchesVariety || !matchesMonth) {
      return;
    }

    const row = document.createElement("tr");
    row.innerHTML = `
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td class="action-cell"></td>
    `;
    row.children[0].textContent = reservation.variety;
    row.children[1].textContent = reservation.month;
    row.children[2].textContent = reservation.name;
    row.children[3].textContent = formatKg(reservation.kg);

    const editButton = document.createElement("button");
    editButton.className = "edit-button";
    editButton.textContent = "編集";
    editButton.addEventListener("click", () => editReservation(index));

    const deleteButton = document.createElement("button");
    deleteButton.className = "delete-button";
    deleteButton.textContent = "��除";
    deleteButton.addEventListener("click", () => deleteReservation(index));

    row.children[4].append(editButton, deleteButton);
    list.appendChild(row);
  });

  displaySummary();
  displayDashboard();
}

function displaySummary() {
  const summary = document.getElementById("summary");
  summary.innerHTML = "";
  const totals = {};

  reservations.forEach(reservation => {
    const key = `${reservation.variety}_${reservation.month}`;

    if (!totals[key]) {
      totals[key] = {
        variety: reservation.variety,
        month: reservation.month,
        kg: 0
      };
    }

    totals[key].kg += Number(reservation.kg);
  });

  Object.values(totals).forEach(total => {
    const div = document.createElement("div");
    div.className = "summary-item";
    div.textContent = `${total.variety}　${total.month}　${formatKg(total.kg)}`;
    summary.appendChild(div);
  });
}

function displayDashboard() {
  const totals = {};
  varieties.forEach(variety => {
    totals[variety] = {};
    months.forEach(month => {
      totals[variety][month] = 0;
    });
  });

  reservations.forEach(reservation => {
    if (totals[reservation.variety] && months.includes(reservation.month)) {
      totals[reservation.variety][reservation.month] += Number(reservation.kg);
    }
  });

  const columnTotals = {};
  months.forEach(month => {
    columnTotals[month] = 0;
  });

  const body = document.getElementById("dashboardBody");
  body.innerHTML = "";
  let grandTotal = 0;

  varieties.forEach(variety => {
    const row = document.createElement("tr");
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = variety;
    row.appendChild(label);

    let varietyTotal = 0;
    months.forEach(month => {
      const value = totals[variety][month];
      varietyTotal += value;
      columnTotals[month] += value;
      const cell = document.createElement("td");
      cell.textContent = formatKg(value);
      row.appendChild(cell);
    });

    grandTotal += varietyTotal;
    const annualCell = document.createElement("td");
    annualCell.className = "annual-total";
    annualCell.textContent = formatKg(varietyTotal);
    row.appendChild(annualCell);
    body.appendChild(row);
  });

  const totalRow = document.createElement("tr");
  totalRow.className = "grand-total-row";
  const totalLabel = document.createElement("th");
  totalLabel.scope = "row";
  totalLabel.textContent = "全体合計";
  totalRow.appendChild(totalLabel);

  months.forEach(month => {
    const cell = document.createElement("td");
    cell.textContent = formatKg(columnTotals[month]);
    totalRow.appendChild(cell);
  });

  const grandCell = document.createElement("td");
  grandCell.textContent = formatKg(grandTotal);
  totalRow.appendChild(grandCell);
  body.appendChild(totalRow);

  document.getElementById("dashboardTotal").textContent = formatKg(grandTotal);
}

function switchView(viewId) {
  document.querySelectorAll(".view-panel").forEach(panel => {
    panel.hidden = panel.id !== viewId;
  });
  document.querySelectorAll(".view-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.view === viewId);
  });
}

document.getElementById("searchName").addEventListener("input", displayReservations);
document.getElementById("filterVariety").addEventListener("change", displayReservations);
document.getElementById("filterMonth").addEventListener("change", displayReservations);
document.querySelectorAll(".view-tab").forEach(tab => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

displayReservations();
