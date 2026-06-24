/* =============================================================================
 * Credit Tracker — standalone, no backend.
 * State is persisted to localStorage. Works by opening index.html directly.
 * ============================================================================= */
(function () {
  "use strict";

  var STORAGE_KEY = "credit-tracker.v1";
  var CURRENCY = "\u20B1"; // Peso sign. Change to "$", "\u20AC", etc.

  /** @type {{users: Array, cards: Array, activeUser: string}} */
  var state = { users: [], cards: [], activeUser: "all" };

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        state.users = Array.isArray(parsed.users) ? parsed.users : [];
        state.cards = Array.isArray(parsed.cards) ? parsed.cards : [];
        return;
      }
    } catch (e) {
      console.warn("Could not read saved data:", e);
    }
    seed();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ users: state.users, cards: state.cards }));
    } catch (e) {
      console.warn("Could not save data:", e);
    }
  }

  function seed() {
    var s = sampleData();
    state.users = s.users;
    state.cards = s.cards;
    save();
  }

  // Reusable sample dataset (used on first run and by "Load sample data").
  function sampleData() {
    var u1 = { id: uid(), name: "Patrick" };
    var u2 = { id: uid(), name: "Dioce" };
    return {
      users: [u1, u2],
      cards: [
        { id: uid(), userId: u1.id, name: "Platinum Rewards", bank: "BPI", last4: "4821",
          limit: 150000, balance: 42300, statementDay: 5, dueDay: 23, color: "#6366f1", paidCycle: "" },
        { id: uid(), userId: u1.id, name: "Cashback", bank: "UnionBank", last4: "1190",
          limit: 80000, balance: 12750, statementDay: 12, dueDay: 2, color: "#34d399", paidCycle: "" },
        { id: uid(), userId: u2.id, name: "Gold", bank: "Metrobank", last4: "7755",
          limit: 120000, balance: 98400, statementDay: 20, dueDay: 10, color: "#fbbf24", paidCycle: "" }
      ]
    };
  }

  function loadSamples() {
    if (state.cards.length && !confirm("Replace current data with the sample set?")) return;
    var s = sampleData();
    state.users = s.users;
    state.cards = s.cards;
    state.activeUser = "all";
    save();
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function money(n) {
    var v = Number(n) || 0;
    return CURRENCY + v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function startOfToday() {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function cycleKey(date) {
    return date.getFullYear() + "-" + (date.getMonth() + 1);
  }

  // Next occurrence of a day-of-month from today (clamped to month length).
  function dueDateFor(dueDay, fromDate) {
    var base = fromDate || startOfToday();
    var y = base.getFullYear();
    var m = base.getMonth();
    var day = Math.min(dueDay, daysInMonth(y, m));
    var candidate = new Date(y, m, day);
    if (candidate < base) {
      m += 1;
      day = Math.min(dueDay, daysInMonth(y, m));
      candidate = new Date(y, m, day);
    }
    return candidate;
  }

  // Effective due date, skipping a cycle already marked paid.
  function effectiveDue(card) {
    var due = dueDateFor(card.dueDay);
    if (card.paidCycle && card.paidCycle === cycleKey(due)) {
      var next = new Date(due.getFullYear(), due.getMonth() + 1, 1);
      due = dueDateFor(card.dueDay, next);
    }
    return due;
  }

  function daysUntil(date) {
    return Math.round((date - startOfToday()) / 86400000);
  }

  function isPaidThisCycle(card) {
    return !!card.paidCycle && card.paidCycle === cycleKey(dueDateFor(card.dueDay));
  }

  function statusFor(days) {
    if (days <= 3) return "urgent";
    if (days <= 7) return "soon";
    return "ok";
  }

  function userName(userId) {
    var u = state.users.find(function (x) { return x.id === userId; });
    return u ? u.name : "Unknown";
  }

  function fmtDate(d) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------------------------------------------------------------------------
  // Element refs
  // ---------------------------------------------------------------------------
  var el = {
    stats: document.getElementById("stats"),
    filters: document.getElementById("userFilters"),
    sort: document.getElementById("sortSelect"),
    grid: document.getElementById("cardGrid"),
    empty: document.getElementById("emptyState"),
    // card modal
    cardModal: document.getElementById("cardModal"),
    cardForm: document.getElementById("cardForm"),
    cardModalTitle: document.getElementById("cardModalTitle"),
    cardId: document.getElementById("cardId"),
    cardHolder: document.getElementById("cardHolder"),
    cardName: document.getElementById("cardName"),
    cardBank: document.getElementById("cardBank"),
    cardLast4: document.getElementById("cardLast4"),
    cardColor: document.getElementById("cardColor"),
    cardLimit: document.getElementById("cardLimit"),
    cardBalance: document.getElementById("cardBalance"),
    cardStatementDay: document.getElementById("cardStatementDay"),
    cardDueDay: document.getElementById("cardDueDay"),
    deleteCardBtn: document.getElementById("deleteCardBtn"),
    // user modal
    userModal: document.getElementById("userModal"),
    userForm: document.getElementById("userForm"),
    userName: document.getElementById("userName"),
    userList: document.getElementById("userList"),
    importFile: document.getElementById("importFile")
  };

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function visibleCards() {
    var cards = state.cards.slice();
    if (state.activeUser !== "all") {
      cards = cards.filter(function (c) { return c.userId === state.activeUser; });
    }
    var sort = el.sort.value;
    cards.sort(function (a, b) {
      if (sort === "balance") return (b.balance || 0) - (a.balance || 0);
      if (sort === "name") return String(a.name).localeCompare(String(b.name));
      if (sort === "utilization") return utilization(b) - utilization(a);
      return effectiveDue(a) - effectiveDue(b); // due
    });
    return cards;
  }

  function utilization(card) {
    if (!card.limit) return 0;
    return Math.min(100, Math.round(((card.balance || 0) / card.limit) * 100));
  }

  function renderStats() {
    var cards = state.activeUser === "all"
      ? state.cards
      : state.cards.filter(function (c) { return c.userId === state.activeUser; });

    var totalBalance = cards.reduce(function (s, c) { return s + (Number(c.balance) || 0); }, 0);
    var dueSoon = 0, overdue = 0, nextDue = null;
    cards.forEach(function (c) {
      if (isPaidThisCycle(c)) return;
      var days = daysUntil(effectiveDue(c));
      if (days <= 7) dueSoon++;
      if (days <= 3) overdue++;
      var d = effectiveDue(c);
      if (!nextDue || d < nextDue) nextDue = d;
    });

    var items = [
      { label: "Cards", value: String(cards.length), sub: state.users.length + " cardholder(s)" },
      { label: "Total balance", value: money(totalBalance), sub: "across all cards" },
      { label: "Due in 7 days", value: String(dueSoon), sub: "needs attention", cls: dueSoon ? "accent-amber" : "" },
      { label: "Due in 3 days", value: String(overdue), sub: "pay now", cls: overdue ? "accent-red" : "" }
    ];
    el.stats.innerHTML = items.map(function (it) {
      return '<div class="stat"><div class="label">' + it.label + '</div>' +
        '<div class="value ' + (it.cls || "") + '">' + it.value + '</div>' +
        '<div class="sub">' + it.sub + '</div></div>';
    }).join("");
  }

  function renderFilters() {
    var chips = ['<button class="chip ' + (state.activeUser === "all" ? "active" : "") +
      '" data-user="all" role="tab">All</button>'];
    state.users.forEach(function (u) {
      var count = state.cards.filter(function (c) { return c.userId === u.id; }).length;
      chips.push('<button class="chip ' + (state.activeUser === u.id ? "active" : "") +
        '" data-user="' + u.id + '" role="tab">' + escapeHtml(u.name) + ' (' + count + ')</button>');
    });
    el.filters.innerHTML = chips.join("");
  }

  function renderCards() {
    var cards = visibleCards();
    el.empty.hidden = cards.length !== 0;
    el.grid.innerHTML = cards.map(cardHtml).join("");
  }

  function cardHtml(c) {
    var paid = isPaidThisCycle(c);
    var due = effectiveDue(c);
    var days = daysUntil(due);
    var st = paid ? "paid" : statusFor(days);
    var badgeText = paid ? "Paid" :
      (days === 0 ? "Due today" : days < 0 ? Math.abs(days) + "d overdue" : "in " + days + "d");
    var util = utilization(c);
    var barCls = util >= 75 ? "high" : util >= 40 ? "mid" : "";

    return '' +
      '<article class="cc" style="--cc-accent:' + escapeHtml(c.color || "#6366f1") + '" data-id="' + c.id + '">' +
        '<div class="cc-top">' +
          '<div>' +
            '<div class="cc-bank">' + escapeHtml(c.bank) + '</div>' +
            '<h3 class="cc-name">' + escapeHtml(c.name) + '</h3>' +
            '<div class="cc-holder">' + escapeHtml(userName(c.userId)) + '</div>' +
          '</div>' +
          '<span class="badge ' + st + '">' + badgeText + '</span>' +
        '</div>' +
        (c.last4 ? '<div class="cc-number">&bull;&bull;&bull;&bull; ' + escapeHtml(c.last4) + '</div>' : '') +
        '<div class="cc-balance">' +
          '<div class="row"><span class="muted">Balance</span><strong>' + money(c.balance) + '</strong></div>' +
          (c.limit ? '<div class="row"><span class="muted">Limit</span><span>' + money(c.limit) + '</span></div>' +
            '<div class="bar"><span class="' + barCls + '" style="width:' + util + '%"></span></div>' : '') +
        '</div>' +
        '<div class="cc-due">' +
          '<div><div class="due-label">Next due</div><div class="due-date">' + fmtDate(due) + '</div></div>' +
          '<div class="due-days">day ' + c.dueDay + ' monthly</div>' +
        '</div>' +
        '<div class="cc-actions">' +
          '<button class="btn btn-ghost" data-action="toggle-paid" data-id="' + c.id + '">' +
            (paid ? "Mark unpaid" : "Mark paid") + '</button>' +
          '<button class="btn btn-ghost" data-action="edit" data-id="' + c.id + '">Edit</button>' +
        '</div>' +
      '</article>';
  }

  function renderUserList() {
    if (state.users.length === 0) {
      el.userList.innerHTML = '<li><span class="u-name">No cardholders yet</span></li>';
      return;
    }
    el.userList.innerHTML = state.users.map(function (u) {
      var count = state.cards.filter(function (c) { return c.userId === u.id; }).length;
      return '<li><span><span class="u-name">' + escapeHtml(u.name) +
        '</span><span class="u-count">' + count + ' card(s)</span></span>' +
        '<button class="btn btn-danger-ghost" data-del-user="' + u.id + '">Remove</button></li>';
    }).join("");
  }

  function renderUserOptions() {
    el.cardHolder.innerHTML = state.users.map(function (u) {
      return '<option value="' + u.id + '">' + escapeHtml(u.name) + '</option>';
    }).join("");
  }

  function renderAll() {
    renderStats();
    renderFilters();
    renderCards();
  }

  // ---------------------------------------------------------------------------
  // Card modal
  // ---------------------------------------------------------------------------
  function openCardModal(card) {
    if (state.users.length === 0) {
      openUserModal();
      return;
    }
    renderUserOptions();
    el.cardForm.reset();
    if (card) {
      el.cardModalTitle.textContent = "Edit card";
      el.cardId.value = card.id;
      el.cardHolder.value = card.userId;
      el.cardName.value = card.name;
      el.cardBank.value = card.bank;
      el.cardLast4.value = card.last4 || "";
      el.cardColor.value = card.color || "#6366f1";
      el.cardLimit.value = card.limit || "";
      el.cardBalance.value = card.balance || "";
      el.cardStatementDay.value = card.statementDay || "";
      el.cardDueDay.value = card.dueDay || "";
      el.deleteCardBtn.hidden = false;
    } else {
      el.cardModalTitle.textContent = "Add card";
      el.cardId.value = "";
      el.cardColor.value = "#6366f1";
      el.deleteCardBtn.hidden = true;
    }
    el.cardModal.hidden = false;
  }

  function closeCardModal() { el.cardModal.hidden = true; }

  function submitCard(e) {
    e.preventDefault();
    var dueDay = clampDay(el.cardDueDay.value);
    if (!dueDay) { el.cardDueDay.focus(); return; }
    var id = el.cardId.value;
    var data = {
      userId: el.cardHolder.value,
      name: el.cardName.value.trim(),
      bank: el.cardBank.value.trim(),
      last4: (el.cardLast4.value || "").replace(/\D/g, "").slice(0, 4),
      color: el.cardColor.value,
      limit: Number(el.cardLimit.value) || 0,
      balance: Number(el.cardBalance.value) || 0,
      statementDay: clampDay(el.cardStatementDay.value) || null,
      dueDay: dueDay
    };
    if (id) {
      var card = state.cards.find(function (c) { return c.id === id; });
      if (card) Object.assign(card, data);
    } else {
      data.id = uid();
      data.paidCycle = "";
      state.cards.push(data);
    }
    save();
    closeCardModal();
    renderAll();
  }

  function clampDay(v) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return null;
    return Math.max(1, Math.min(31, n));
  }

  // ---------------------------------------------------------------------------
  // User modal
  // ---------------------------------------------------------------------------
  function openUserModal() {
    renderUserList();
    el.userModal.hidden = false;
  }
  function closeUserModal() { el.userModal.hidden = true; }

  function addUser(e) {
    e.preventDefault();
    var name = el.userName.value.trim();
    if (!name) return;
    state.users.push({ id: uid(), name: name });
    el.userName.value = "";
    save();
    renderUserList();
    renderFilters();
    renderUserOptions();
  }

  function removeUser(userId) {
    var count = state.cards.filter(function (c) { return c.userId === userId; }).length;
    var msg = count
      ? "Remove this cardholder and their " + count + " card(s)?"
      : "Remove this cardholder?";
    if (!confirm(msg)) return;
    state.users = state.users.filter(function (u) { return u.id !== userId; });
    state.cards = state.cards.filter(function (c) { return c.userId !== userId; });
    if (state.activeUser === userId) state.activeUser = "all";
    save();
    renderUserList();
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // Import / export
  // ---------------------------------------------------------------------------
  function exportData() {
    var blob = new Blob([JSON.stringify({ users: state.users, cards: state.cards }, null, 2)],
      { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "credit-tracker-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed.users) || !Array.isArray(parsed.cards)) {
          throw new Error("Invalid file format");
        }
        state.users = parsed.users;
        state.cards = parsed.cards;
        state.activeUser = "all";
        save();
        renderAll();
        alert("Data imported.");
      } catch (e) {
        alert("Could not import file: " + e.message);
      }
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function bind() {
    document.getElementById("addCardBtn").addEventListener("click", function () { openCardModal(null); });
    document.getElementById("emptyAddBtn").addEventListener("click", function () { openCardModal(null); });
    document.getElementById("loadSampleBtn").addEventListener("click", loadSamples);
    document.getElementById("manageUsersBtn").addEventListener("click", openUserModal);

    document.getElementById("cardModalClose").addEventListener("click", closeCardModal);
    document.getElementById("cardCancelBtn").addEventListener("click", closeCardModal);
    el.cardForm.addEventListener("submit", submitCard);
    el.deleteCardBtn.addEventListener("click", function () {
      var id = el.cardId.value;
      if (id && confirm("Delete this card?")) {
        state.cards = state.cards.filter(function (c) { return c.id !== id; });
        save();
        closeCardModal();
        renderAll();
      }
    });

    document.getElementById("userModalClose").addEventListener("click", closeUserModal);
    el.userForm.addEventListener("submit", addUser);
    el.userList.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-del-user]");
      if (btn) removeUser(btn.getAttribute("data-del-user"));
    });

    el.filters.addEventListener("click", function (e) {
      var chip = e.target.closest(".chip");
      if (!chip) return;
      state.activeUser = chip.getAttribute("data-user");
      renderAll();
    });

    el.sort.addEventListener("change", renderCards);

    el.grid.addEventListener("click", function (e) {
      var actionBtn = e.target.closest("[data-action]");
      if (actionBtn) {
        e.stopPropagation();
        var id = actionBtn.getAttribute("data-id");
        var card = state.cards.find(function (c) { return c.id === id; });
        if (!card) return;
        var action = actionBtn.getAttribute("data-action");
        if (action === "edit") {
          openCardModal(card);
        } else if (action === "toggle-paid") {
          var key = cycleKey(dueDateFor(card.dueDay));
          card.paidCycle = isPaidThisCycle(card) ? "" : key;
          save();
          renderAll();
        }
        return;
      }
      var cardEl = e.target.closest(".cc");
      if (cardEl) {
        var c = state.cards.find(function (x) { return x.id === cardEl.getAttribute("data-id"); });
        if (c) openCardModal(c);
      }
    });

    document.getElementById("exportBtn").addEventListener("click", exportData);
    document.getElementById("importBtn").addEventListener("click", function () { el.importFile.click(); });
    el.importFile.addEventListener("change", function () {
      if (el.importFile.files[0]) importData(el.importFile.files[0]);
      el.importFile.value = "";
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeCardModal(); closeUserModal(); }
    });
    [el.cardModal, el.userModal].forEach(function (overlay) {
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) overlay.hidden = true;
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  load();
  bind();
  renderAll();
})();
