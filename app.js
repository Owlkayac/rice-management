let reservations =
  JSON.parse(localStorage.getItem("reservations")) || [];


function addReservation() {

  const variety =
    document.getElementById("variety").value;

  const month =
    document.getElementById("month").value;

  const name =
    document.getElementById("name").value.trim();

  const kg =
    Number(document.getElementById("kg").value);


  if (!name) {
    alert("名前を入力してください");
    return;
  }

  if (!kg || kg <= 0) {
    alert("kgを入力してください");
    return;
  }


  reservations.push({
    variety: variety,
    month: month,
    name: name,
    kg: kg
  });


  saveData();

  document.getElementById("name").value = "";
  document.getElementById("kg").value = "";

  displayReservations();
}


function deleteReservation(index) {

  if (!confirm("この予約を削除しますか？")) {
    return;
  }

  reservations.splice(index, 1);

  saveData();

  displayReservations();
}


function saveData() {

  localStorage.setItem(
    "reservations",
    JSON.stringify(reservations)
  );

}


function displayReservations() {

  const list =
    document.getElementById("reservationList");

  list.innerHTML = "";


  reservations.forEach((reservation, index) => {

    const row =
      document.createElement("tr");

    row.innerHTML = `

      <td>${reservation.variety}</td>

      <td>${reservation.month}</td>

      <td>${reservation.name}</td>

      <td>${reservation.kg}kg</td>

      <td>
        <button
          class="delete-button"
          onclick="deleteReservation(${index})">
          削除
        </button>
      </td>

    `;

    list.appendChild(row);

  });


  displaySummary();

}


function displaySummary() {

  const summary =
    document.getElementById("summary");

  summary.innerHTML = "";


  const totals = {};


  reservations.forEach(reservation => {

    const key =
      reservation.variety +
      "_" +
      reservation.month;


    if (!totals[key]) {

      totals[key] = {
        variety: reservation.variety,
        month: reservation.month,
        kg: 0
      };

    }


    totals[key].kg += reservation.kg;

  });


  Object.values(totals).forEach(total => {

    const div =
      document.createElement("div");

    div.className = "summary-item";

    div.textContent =
      `${total.variety}　${total.month}　${total.kg}kg`;

    summary.appendChild(div);

  });

}


displayReservations();
