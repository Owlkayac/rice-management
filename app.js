let reservations =
  JSON.parse(localStorage.getItem("reservations")) || [];

let editingIndex = null;

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
    row.children[3].textContent = `${reservation.kg}kg`;

    const editButton = document.createElement("button");
    editButton.className = "edit-button";
    editButton.textContent = "編集";
    editButton.addEventListener("click", () => editReservation(index));

    const deleteButton = document.createElement("button");
    deleteButton.className = "delete-button";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => deleteReservation(index));

    row.children[4].append(editButton, deleteButton);
    list.appendChild(row);
  });

  displaySummary();
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
    div.textContent = `${total.variety}　${total.month}　${total.kg}kg`;
    summary.appendChild(div);
  });
}

document.getElementById("searchName").addEventListener("input", displayReservations);
document.getElementById("filterVariety").addEventListener("change", displayReservations);
document.getElementById("filterMonth").addEventListener("change", displayReservations);

displayReservations();
