// ===========================================================================
// Credit Tracker - Self-contained single-file app
// ===========================================================================
(function(){
"use strict";

// ===========================================================================
// HOST CONFIGURATION - override these before the script runs or via
// window.CreditTrackerConfig to rebrand / change currency / plug a backend.
// ===========================================================================
var DEFAULT_CONFIG = {
  brandName: "Credit Tracker",
  brandTagline: "Cards, bills & shared payers - all in one place",
  brandLogo: null,            // URL or null for default icon
  currency: "PHP",            // ISO 4217 code
  locale: "en-PH",           // BCP47 locale for formatting
  currencySymbol: "\u20B1",  // fallback display symbol
  storageKey: "credit-tracker.v2",
  // dataSource: null - set to an object implementing DataSource interface to
  // replace localStorage. See README for the interface spec.
  dataSource: null
};
var CONFIG = Object.assign({}, DEFAULT_CONFIG, window.CreditTrackerConfig || {});

// ===========================================================================
// DATA SOURCE ABSTRACTION
// Any host can provide {load():Promise<Data>, save(data):Promise<void>}
// ===========================================================================
var LocalStorageSource = {
  load: function() {
    return new Promise(function(resolve, reject) {
      try {
        var raw = localStorage.getItem(CONFIG.storageKey);
        resolve(raw ? JSON.parse(raw) : null);
      } catch(e) { reject(e); }
    });
  },
  save: function(data) {
    return new Promise(function(resolve, reject) {
      try {
        localStorage.setItem(CONFIG.storageKey, JSON.stringify(data));
        resolve();
      } catch(e) { reject(e); }
    });
  }
};
var dataSource = CONFIG.dataSource || LocalStorageSource;

// ===========================================================================
// THEME (light/dark toggle)
// ===========================================================================
function initTheme() {
  var saved = localStorage.getItem("ct-theme");
  if(saved === "light") document.documentElement.setAttribute("data-theme","light");
}
function toggleTheme() {
  var current = document.documentElement.getAttribute("data-theme");
  var next = current === "light" ? "dark" : "light";
  if(next === "dark") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme","light");
  }
  localStorage.setItem("ct-theme", next);
}
initTheme();

// ===========================================================================
// MONEY MATH - integer cents to avoid floating-point drift
// ===========================================================================
function toCents(n) { return Math.round(Number(n) * 100) || 0; }
function fromCents(c) { return c / 100; }
function fmtMoney(cents) {
  var val = fromCents(cents);
  try {
    return val.toLocaleString(CONFIG.locale, {style:"currency",currency:CONFIG.currency,minimumFractionDigits:2,maximumFractionDigits:2});
  } catch(e) {
    return CONFIG.currencySymbol + val.toFixed(2);
  }
}

// Distribute `totalCents` across `n` parts so they sum exactly (largest-remainder)
function distributeCents(totalCents, n) {
  if (n <= 0) return [];
  var base = Math.floor(totalCents / n);
  var remainder = totalCents - base * n;
  var parts = [];
  for (var i = 0; i < n; i++) parts.push(base + (i < remainder ? 1 : 0));
  return parts;
}

// Distribute by percentages (array of numbers summing ~100)
function distributeByPct(totalCents, pcts) {
  var raw = pcts.map(function(p){ return totalCents * p / 100; });
  var floored = raw.map(function(r){ return Math.floor(r); });
  var diff = totalCents - floored.reduce(function(a,b){return a+b;},0);
  var remainders = raw.map(function(r,i){return {i:i,r:r-floored[i]};});
  remainders.sort(function(a,b){return b.r - a.r;});
  for(var i=0;i<diff;i++) floored[remainders[i].i]++;
  return floored;
}

// Distribute by custom amounts - adjusts last entry to ensure sum = total
function distributeCustom(totalCents, amountsCents) {
  var result = amountsCents.slice();
  var sum = result.reduce(function(a,b){return a+b;},0);
  if(sum !== totalCents && result.length > 0) {
    result[result.length-1] += (totalCents - sum);
  }
  return result;
}

// ===========================================================================
// DATA MODEL
// ===========================================================================
// users: [{id, name, color?}]
// cards: [{id, ownerId, name, network?, last4?, limitCents, statementDay, dueDay, color, note?}]
// transactions: [{id, cardId, description, amountCents, date, splits:[{userId,amountCents,paid}],
//                 installment:{months,monthsPaid}|null, createdAt}]
//
// A split always sums to amountCents. If installment, per-month = amountCents/months with
// remainder distribution.
// ===========================================================================

var state = {users:[], cards:[], transactions:[], view:"dashboard", activeFilter:"all",
             sort:"due", cardView:"grid", currentCardId:null, currentPersonId:null,
             personScope:"cycle", detailPersonFilter:null, detailFromPerson:false, loading:true, error:null};

function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8);}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function loadData() {
  state.loading = true; state.error = null; render();
  dataSource.load().then(function(data){
    state.loading = false;
    if(data) {
      state.users = data.users || [];
      state.cards = data.cards || [];
      state.transactions = data.transactions || [];
      migrate(state);
    } else { seed(); }
    render();
  }).catch(function(e){
    state.loading = false;
    state.error = "Could not load data: " + e.message;
    render();
  });
}

function saveData() {
  var payload = {users:state.users, cards:state.cards, transactions:state.transactions};
  dataSource.save(payload).catch(function(e){
    console.warn("Save failed:", e);
  });
}

function migrate(s) {
  // Ensure all transactions have proper shape
  s.transactions.forEach(function(t){
    if(!t.id) t.id = uid();
    t.amountCents = t.amountCents || toCents(t.amount) || 0;
    delete t.amount;
    if(!Array.isArray(t.splits)) t.splits = [];
    if(t.splits.length === 0 && t.personId) {
      t.splits = [{userId:t.personId, amountCents:t.amountCents, paid:false}];
      delete t.personId;
    }
    t.splits.forEach(function(sp){
      sp.amountCents = sp.amountCents || toCents(sp.amount) || 0;
      delete sp.amount;
      if(sp.paid === undefined) sp.paid = false;
    });
    if(t.installment) {
      t.installment.months = t.installment.months || 1;
      t.installment.monthsPaid = t.installment.monthsPaid || 0;
      if(!t.installment.startDate) t.installment.startDate = t.date || "";
      // Per-person payment tracking: {userId: monthsPaidCount}
      if(!t.installment.splitPayments) {
        t.installment.splitPayments = {};
        t.splits.forEach(function(sp){
          t.installment.splitPayments[sp.userId] = t.installment.monthsPaid;
        });
      }
    }
    if(!t.date) t.date = "";
    if(!t.category) t.category = "";
    if(!t.createdAt) t.createdAt = t.date || new Date().toISOString().slice(0,10);
  });
  s.cards.forEach(function(c){
    c.limitCents = c.limitCents || toCents(c.limit) || 0;
    delete c.limit;
    if(!c.statementDay) c.statementDay = null;
    if(!c.dueDay) c.dueDay = 1;
  });
}

function seed() {
  var u1 = {id:uid(),name:"Patrick",color:"#6366f1"};
  var u2 = {id:uid(),name:"Dioce",color:"#34d399"};
  state.users = [u1,u2];
  var c1 = {id:uid(),ownerId:u1.id,name:"Platinum Rewards",network:"Visa",last4:"4821",
    limitCents:15000000,statementDay:5,dueDay:23,color:"#6366f1",note:""};
  var c2 = {id:uid(),ownerId:u1.id,name:"Cashback",network:"Mastercard",last4:"1190",
    limitCents:8000000,statementDay:12,dueDay:2,color:"#34d399",note:""};
  var c3 = {id:uid(),ownerId:u2.id,name:"Gold",network:"Visa",last4:"7755",
    limitCents:12000000,statementDay:20,dueDay:10,color:"#fbbf24",note:""};
  state.cards = [c1,c2,c3];
  state.transactions = [
    {id:uid(),cardId:c1.id,description:"Groceries",amountCents:800000,date:"2026-06-10",
     splits:[{userId:u1.id,amountCents:400000,paid:false},{userId:u2.id,amountCents:400000,paid:false}],
     installment:null,createdAt:"2026-06-10"},
    {id:uid(),cardId:c1.id,description:"iPhone 15",amountCents:6000000,date:"2026-03-01",
     splits:[{userId:u1.id,amountCents:6000000,paid:false}],
     installment:{months:12,monthsPaid:3,startDate:"2026-03-01"},createdAt:"2026-03-01"},
    {id:uid(),cardId:c1.id,description:"Plane tickets",amountCents:2230000,date:"2026-06-05",
     splits:[{userId:u2.id,amountCents:2230000,paid:false}],
     installment:null,createdAt:"2026-06-05"},
    {id:uid(),cardId:c2.id,description:"Electric bill",amountCents:1275000,date:"2026-06-01",
     splits:[{userId:u1.id,amountCents:637500,paid:false},{userId:u2.id,amountCents:637500,paid:false}],
     installment:null,createdAt:"2026-06-01"},
    {id:uid(),cardId:c3.id,description:"Laptop",amountCents:4800000,date:"2026-04-01",
     splits:[{userId:u2.id,amountCents:4800000,paid:false}],
     installment:{months:6,monthsPaid:2,startDate:"2026-04-01"},createdAt:"2026-04-01"},
    {id:uid(),cardId:c3.id,description:"Dinner",amountCents:440000,date:"2026-05-15",
     splits:[{userId:u1.id,amountCents:220000,paid:true},{userId:u2.id,amountCents:220000,paid:false}],
     installment:null,createdAt:"2026-05-15"}
  ];
  saveData();
}

// ===========================================================================
// DERIVED CALCULATIONS
// ===========================================================================
function txRemaining(t) {
  if(!t.installment) return t.amountCents;
  var m = t.installment.months, paid = t.installment.monthsPaid;
  var perMonth = distributeCents(t.amountCents, m);
  var rem = 0;
  for(var i=paid;i<m;i++) rem += perMonth[i];
  return rem;
}

function txMonthly(t) {
  if(!t.installment) return t.amountCents;
  return distributeCents(t.amountCents, t.installment.months)[0];
}

function txSettled(t) {
  if(t.installment) return t.installment.monthsPaid >= t.installment.months;
  return t.splits.every(function(s){return s.paid;});
}

function cardBalance(card) {
  return cardTransactions(card.id).reduce(function(s,t){return s + (txSettled(t)?0:txRemaining(t));},0);
}

function cardTransactions(cardId) {
  return state.transactions.filter(function(t){return t.cardId===cardId;});
}

function cardMonthly(card) {
  return cardTransactions(card.id).reduce(function(s,t){return s + (txSettled(t)?0:txMonthly(t));},0);
}

function userOwes(userId) {
  // Total a user owes across all cards where they are NOT the owner
  var total = 0;
  state.transactions.forEach(function(t){
    if(txSettled(t)) return;
    var card = state.cards.find(function(c){return c.id===t.cardId;});
    if(!card) return;
    t.splits.forEach(function(sp){
      if(sp.userId === userId && sp.userId !== card.ownerId && !sp.paid) {
        if(t.installment) {
          var pct = sp.amountCents / t.amountCents;
          total += Math.round(txRemaining(t) * pct);
        } else {
          total += sp.amountCents;
        }
      }
    });
  });
  return total;
}

function userIsOwed(userId) {
  // Total owed TO this user (they own the card, others haven't paid)
  var total = 0;
  state.transactions.forEach(function(t){
    if(txSettled(t)) return;
    var card = state.cards.find(function(c){return c.id===t.cardId;});
    if(!card || card.ownerId !== userId) return;
    t.splits.forEach(function(sp){
      if(sp.userId !== userId && !sp.paid) {
        if(t.installment) {
          var pct = sp.amountCents / t.amountCents;
          total += Math.round(txRemaining(t) * pct);
        } else {
          total += sp.amountCents;
        }
      }
    });
  });
  return total;
}

function activeInstallments() {
  return state.transactions.filter(function(t){
    return t.installment && t.installment.monthsPaid < t.installment.months;
  });
}

function completedInstallments() {
  return state.transactions.filter(function(t){
    return t.installment && t.installment.monthsPaid >= t.installment.months;
  });
}

// ===========================================================================
// DATE HELPERS
// ===========================================================================
function startOfToday(){var d=new Date();return new Date(d.getFullYear(),d.getMonth(),d.getDate());}
function daysInMonth(y,m){return new Date(y,m+1,0).getDate();}

function nextDueDate(dueDay){
  var base=startOfToday(),y=base.getFullYear(),m=base.getMonth();
  var day=Math.min(dueDay,daysInMonth(y,m));
  var cand=new Date(y,m,day);
  if(cand<base){m++;day=Math.min(dueDay,daysInMonth(y,m));cand=new Date(y,m,day);}
  return cand;
}

function daysUntil(date){return Math.round((date-startOfToday())/86400000);}

function fmtDate(d){return d.toLocaleDateString(CONFIG.locale,{month:"short",day:"numeric"});}
function fmtDateFull(d){return d.toLocaleDateString(CONFIG.locale,{month:"short",day:"numeric",year:"numeric"});}
function fmtISO(iso){if(!iso)return"";var d=new Date(iso);return isNaN(d)?"":fmtDateFull(d);}

function statusClass(days){
  if(days<0) return "overdue";
  if(days<=3) return "urgent";
  if(days<=7) return "soon";
  return "ok";
}

function statusLabel(days){
  if(days<0) return Math.abs(days)+"d overdue";
  if(days===0) return "Due today";
  return "in "+days+"d";
}

// ===========================================================================
// UTILITY
// ===========================================================================
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c];});}
function userName(id){var u=state.users.find(function(x){return x.id===id;});return u?u.name:"Unknown";}
function userColor(id){var u=state.users.find(function(x){return x.id===id;});return u&&u.color?u.color:"#6366f1";}

// Returns a readable text color (dark or white) for a given background hex,
// using WCAG relative luminance — so light avatars (e.g. yellow) get dark text.
function contrastOn(hex){
  if(!hex) return "#ffffff";
  var c = String(hex).replace("#","");
  if(c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
  if(c.length < 6) return "#ffffff";
  var r = parseInt(c.substr(0,2),16), g = parseInt(c.substr(2,2),16), b = parseInt(c.substr(4,2),16);
  function lin(v){ v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }
  var L = 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
  // Crossover (L > 0.179) where black yields better contrast than white.
  // Picking the higher-contrast option guarantees the initial stays >= ~4.5:1.
  return L > 0.179 ? "#111827" : "#ffffff";
}

function involves(card,userId){
  if(card.ownerId===userId) return true;
  return state.transactions.some(function(t){
    return t.cardId===card.id && t.splits.some(function(s){return s.userId===userId;});
  });
}

function utilization(card){
  if(!card.limitCents) return 0;
  return Math.min(100,Math.round(cardBalance(card)/card.limitCents*100));
}

// ===========================================================================
// RENDERING ENGINE
// ===========================================================================
var root = document.getElementById("ct-root");

function render() {
  if(state.loading) { root.innerHTML = renderLoading(); return; }
  if(state.error) { root.innerHTML = renderError(); return; }
  if(state.view === "detail" && state.currentCardId) {
    root.innerHTML = renderDetail();
  } else if(state.view === "installments") {
    root.innerHTML = renderInstallmentsView();
  } else if(state.view === "person" && state.currentPersonId) {
    root.innerHTML = renderPersonView();
  } else {
    root.innerHTML = renderDashboard();
  }
  bindEvents();
}

function renderLoading() {
  return '<div class="ct-app"><div class="ct-loading" role="status" aria-live="polite">' +
    '<div class="ct-spinner" aria-hidden="true"></div><p>Loading data&hellip;</p></div></div>';
}

function renderError() {
  return '<div class="ct-app"><div class="ct-error" role="alert">' +
    '<h2>Something went wrong</h2><p>'+esc(state.error)+'</p>' +
    '<button class="btn btn-primary" data-action="retry">Retry</button></div></div>';
}

// ===========================================================================
// DASHBOARD
// ===========================================================================
function renderDashboard() {
  var html = '<div class="ct-app">';
  html += renderTopbar();
  html += renderToolbar();
  var cards = visibleCards();
  if(cards.length === 0 && state.cards.length === 0) {
    html += renderEmpty();
  } else if(cards.length === 0) {
    html += '<div class="ct-empty"><p>No cards match this filter.</p></div>';
  } else if(state.cardView === "table") {
    html += renderCardTable(cards);
  } else {
    html += '<main class="ct-card-grid" role="list">';
    cards.forEach(function(c){ html += renderCard(c); });
    html += '</main>';
  }
  html += renderFooter();
  html += '</div>';
  return html;
}

function renderTopbar() {
  var logo = CONFIG.brandLogo
    ? '<img src="'+esc(CONFIG.brandLogo)+'" alt="" class="ct-brand-logo"/>'
    : '<span class="ct-brand-mark" aria-hidden="true">&#128179;</span>';
  var v = state.view;
  var peopleActive = (v === "person");
  var instActive = (v === "installments");
  function navBtn(action, label, isActive) {
    return '<button class="btn btn-ghost ct-nav-btn'+(isActive?" active":"")+'" data-action="'+action+'" type="button"'+
      (isActive?' aria-current="page"':'')+'>'+label+'</button>';
  }
  return '<header class="ct-topbar">'+
    '<button class="ct-brand" data-action="go-home" type="button" aria-label="Go to dashboard">'+logo+'<div><h1>'+esc(CONFIG.brandName)+'</h1>'+
    '<p class="ct-tagline">'+esc(CONFIG.brandTagline)+'</p></div></button>'+
    '<div class="ct-topbar-actions">'+
    '<button class="btn btn-primary" data-action="add-card" type="button">+ Add card</button>'+
    navBtn("view-people", "People", peopleActive)+
    navBtn("view-installments", "Installments", instActive)+
    '<span class="ct-topbar-divider" aria-hidden="true"></span>'+
    '<div class="ct-topbar-utils">'+
    '<button class="btn btn-ghost ct-theme-toggle" data-action="toggle-theme" type="button" aria-label="Toggle light or dark mode" title="Toggle light/dark mode">&#9788;</button>'+
    '<button class="btn btn-ghost" data-action="show-help" type="button" aria-label="Help and guide" title="Help">?</button>'+
    '</div>'+
    '</div></header>';
}

function statBox(label,value,sub,cls) {
  return '<div class="ct-stat"><div class="ct-stat-label">'+label+'</div>'+
    '<div class="ct-stat-value '+(cls||"")+'">'+value+'</div>'+
    '<div class="ct-stat-sub">'+sub+'</div></div>';
}

// Per-card split summary: [{userId, totalOwed}] for non-owners who still owe
function cardSplitSummary(cardId) {
  var card = state.cards.find(function(c){return c.id===cardId;});
  if(!card) return [];
  var byUser = {};
  state.transactions.forEach(function(t){
    if(t.cardId !== cardId || txSettled(t)) return;
    t.splits.forEach(function(sp){
      if(!byUser[sp.userId]) byUser[sp.userId] = {userId:sp.userId, total:0, paid:0};
      var amt = 0;
      if(t.installment) {
        var pct = sp.amountCents / t.amountCents;
        amt = Math.round(txRemaining(t) * pct);
      } else {
        amt = sp.amountCents;
      }
      if(!sp.paid) byUser[sp.userId].total += amt;
      else byUser[sp.userId].paid += amt;
    });
  });
  var result = [];
  Object.keys(byUser).forEach(function(uid){
    result.push(byUser[uid]);
  });
  return result;
}

function renderToolbar() {
  var grid = state.cardView === "grid";
  return '<section class="ct-toolbar">'+
    '<div class="ct-view-toggle" role="tablist" aria-label="Card view">'+
      '<button class="ct-vt-btn'+(grid?" active":"")+'" data-action="set-card-view" data-view="grid" role="tab" aria-selected="'+grid+'" title="Grid view">&#9638; Grid</button>'+
      '<button class="ct-vt-btn'+(!grid?" active":"")+'" data-action="set-card-view" data-view="table" role="tab" aria-selected="'+(!grid)+'" title="Table view">&#9776; Table</button>'+
    '</div>'+
    '<label class="ct-sort"><span>Sort</span><select data-action="sort">'+
    '<option value="due"'+(state.sort==="due"?" selected":"")+'>Due date</option>'+
    '<option value="balance"'+(state.sort==="balance"?" selected":"")+'>Balance</option>'+
    '<option value="name"'+(state.sort==="name"?" selected":"")+'>Card name</option>'+
    '</select></label></section>';
}

function visibleCards() {
  var cards = state.cards.slice();
  var s = state.sort;
  cards.sort(function(a,b){
    if(s==="balance") return cardBalance(b)-cardBalance(a);
    if(s==="name") return String(a.name).localeCompare(String(b.name));
    return nextDueDate(a.dueDay)-nextDueDate(b.dueDay);
  });
  return cards;
}

function renderCard(c) {
  var balance = cardBalance(c);
  var due = nextDueDate(c.dueDay);
  var days = daysUntil(due);
  var st = statusClass(days);
  var util = utilization(c);
  var barCls = util>=75?"high":util>=40?"mid":"";
  var txCount = cardTransactions(c.id).length;
  var instCount = cardTransactions(c.id).filter(function(t){return t.installment && !txSettled(t);}).length;

  // Build split summary for the card
  var splits = cardSplitSummary(c.id);
  var splitHtml = '';
  // Only show splits section if there are multiple people involved
  var activeSplits = splits.filter(function(sp){ return sp.total > 0; });
  if(activeSplits.length > 0) {
    var maxVisible = 3;
    var visible = activeSplits.slice(0, maxVisible);
    var overflow = activeSplits.length - maxVisible;

    splitHtml = '<div class="ct-cc-splits"><div class="ct-cc-splits-title">Split breakdown</div>';
    visible.forEach(function(sp){
      var isOwner = sp.userId === c.ownerId;
      var pct = balance > 0 ? Math.round(sp.total / balance * 100) : 0;
      splitHtml += '<div class="ct-cc-split-row">' +
        '<span class="ct-cc-split-avatar" style="background:'+esc(userColor(sp.userId))+';color:'+contrastOn(userColor(sp.userId))+'">'+esc(userName(sp.userId).charAt(0))+'</span>'+
        '<span class="ct-cc-split-name">'+esc(userName(sp.userId))+(isOwner?' <span class="ct-owner-tag">owner</span>':'')+'</span>'+
        '<span class="ct-cc-split-bar"><span style="width:'+pct+'%"></span></span>'+
        '<span class="ct-cc-split-amt'+(sp.total>0&&!isOwner?' ct-cc-split-owes':'')+'">'+fmtMoney(sp.total)+'</span>'+
      '</div>';
    });
    if(overflow > 0) {
      var overflowTotal = activeSplits.slice(maxVisible).reduce(function(s,sp){return s+sp.total;},0);
      splitHtml += '<div class="ct-cc-split-overflow">+'+overflow+' more &middot; '+fmtMoney(overflowTotal)+'</div>';
    }
    splitHtml += '</div>';
  }

  // Per-card settlement summary (pinned to the bottom for consistent placement)
  var owedHtml = '';
  var owedToOwner = activeSplits.filter(function(sp){return sp.userId !== c.ownerId && sp.total > 0;});
  if(owedToOwner.length > 0) {
    var owedTotal = owedToOwner.reduce(function(s,sp){return s+sp.total;},0);
    owedHtml = '<div class="ct-cc-owed">Owed to <strong>'+esc(userName(c.ownerId))+'</strong>: <span class="ct-cc-owed-amt">'+fmtMoney(owedTotal)+'</span></div>';
  }

  var dueValCls = days < 0 ? "red" : (days <= 3 ? "red" : (days <= 7 ? "amber" : ""));
  var dueText = days < 0 ? (Math.abs(days)+"d overdue") : (days === 0 ? "Today" : (days+(days===1?" day":" days")));

  return '<article class="ct-cc" style="--cc-accent:'+esc(c.color||"#6366f1")+'" data-card-id="'+c.id+'" role="listitem">'+
    '<div class="ct-cc-top"><div>'+
    '<div class="ct-cc-bank">'+esc(c.network||c.name)+'</div>'+
    '<h3 class="ct-cc-name">'+esc(c.name)+'</h3>'+
    '<div class="ct-cc-holder"><span class="ct-owner-tag">owner</span> '+esc(userName(c.ownerId))+'</div>'+
    '</div><span class="ct-badge '+st+'">'+statusLabel(days)+'</span></div>'+
    (c.last4?'<div class="ct-cc-number">&bull;&bull;&bull;&bull; '+esc(c.last4)+'</div>':'')+
    (c.limitCents?'<div class="ct-bar"><span class="'+barCls+'" style="width:'+util+'%"></span></div>':'')+
    '<div class="ct-cc-stats">'+
      '<div class="ct-cc-stat"><span class="ct-cc-stat-lbl">Outstanding</span>'+
        '<span class="ct-cc-stat-val">'+fmtMoney(balance)+'</span>'+
        '<span class="ct-cc-stat-sub">'+(c.limitCents?util+"% of limit":"no limit")+'</span></div>'+
      '<div class="ct-cc-stat"><span class="ct-cc-stat-lbl">Monthly</span>'+
        '<span class="ct-cc-stat-val">'+fmtMoney(cardMonthly(c))+'</span>'+
        '<span class="ct-cc-stat-sub">min. due</span></div>'+
      '<div class="ct-cc-stat"><span class="ct-cc-stat-lbl">Due in</span>'+
        '<span class="ct-cc-stat-val '+dueValCls+'">'+dueText+'</span>'+
        '<span class="ct-cc-stat-sub">'+fmtDate(due)+'</span></div>'+
    '</div>'+
    splitHtml+
    '<div class="ct-cc-bottom">'+
      owedHtml+
      '<div class="ct-cc-foot">'+
        '<span class="ct-cc-meta">'+txCount+' charge'+(txCount!==1?'s':'')+
        (instCount?' &middot; '+instCount+' installment'+(instCount!==1?'s':''):'')+'</span>'+
        '<button class="btn btn-ghost btn-sm" data-action="open-detail" data-id="'+c.id+'" aria-label="View details for '+esc(c.name)+'">View details</button>'+
      '</div>'+
    '</div>'+
    '</article>';
}

function renderCardTable(cards) {
  var totBal = 0, totMonthly = 0, totInst = 0;
  var rows = cards.map(function(c){
    var balance = cardBalance(c);
    var monthly = cardMonthly(c);
    var due = nextDueDate(c.dueDay);
    var days = daysUntil(due);
    var st = statusClass(days);
    var util = utilization(c);
    var barCls = util>=75?"high":util>=40?"mid":"";
    var instCount = cardTransactions(c.id).filter(function(t){return t.installment && !txSettled(t);}).length;
    totBal += balance; totMonthly += monthly; totInst += instCount;

    return '<tr data-action="open-detail" data-id="'+c.id+'" tabindex="0" role="button" aria-label="Open '+esc(c.name)+'">'+
      '<td class="ct-tbl-card"><span class="ct-tbl-dot" style="background:'+esc(c.color||"#6366f1")+'"></span>'+
        '<span><span class="ct-tbl-name">'+esc(c.name)+'</span>'+
        (c.last4?'<span class="ct-tbl-last4">&bull;&bull;&bull;&bull; '+esc(c.last4)+'</span>':'')+'</span></td>'+
      '<td>'+esc(userName(c.ownerId))+'</td>'+
      '<td class="num"><strong>'+fmtMoney(balance)+'</strong></td>'+
      '<td>'+(c.limitCents?
        '<span class="ct-tbl-util"><span class="ct-minibar"><span class="'+barCls+'" style="width:'+util+'%"></span></span>'+util+'%</span>'
        :'<span class="muted">&mdash;</span>')+'</td>'+
      '<td class="num">'+fmtMoney(monthly)+'</td>'+
      '<td><span class="ct-tbl-pill '+st+'">'+statusLabel(days)+'</span><span class="ct-tbl-duedate">'+fmtDate(due)+'</span></td>'+
      '<td class="num">'+(instCount||'&mdash;')+'</td>'+
    '</tr>';
  }).join("");

  return '<div class="ct-tablewrap ct-card-tablewrap"><table class="ct-card-table" aria-label="Cards">'+
    '<thead><tr>'+
      '<th>Card</th><th>Owner</th><th class="num">Outstanding</th><th>Utilization</th>'+
      '<th class="num">Monthly</th><th>Due</th><th class="num">Installments</th>'+
    '</tr></thead><tbody>'+rows+'</tbody>'+
    '<tfoot><tr class="ct-tbl-total">'+
      '<td>Total</td><td></td>'+
      '<td class="num">'+fmtMoney(totBal)+'</td><td></td>'+
      '<td class="num">'+fmtMoney(totMonthly)+'</td><td></td>'+
      '<td class="num">'+(totInst||'&mdash;')+'</td>'+
    '</tr></tfoot></table></div>';
}

function renderEmpty() {
  return '<div class="ct-empty"><div class="ct-empty-art" aria-hidden="true">&#128179;</div>'+
    '<h2>No cards yet</h2><p>Add your first credit card to start tracking.</p>'+
    '<div class="ct-empty-actions">'+
    '<button class="btn btn-primary" data-action="add-card">+ Add card</button>'+
    '<button class="btn btn-ghost" data-action="load-samples">Load sample data</button>'+
    '</div></div>';
}

function renderFooter() {
  return '<footer class="ct-footer"><span>Data stored locally. Nothing sent to a server.</span>'+
    '<button class="btn btn-link" data-action="export">Export</button>'+
    '<button class="btn btn-link" data-action="import">Import</button>'+
    '<input type="file" id="ct-import-file" accept="application/json" hidden/>'+
    '</footer>';
}

// ===========================================================================
// DETAIL VIEW
// ===========================================================================
function renderDetail() {
  var card = state.cards.find(function(c){return c.id===state.currentCardId;});
  if(!card) { state.view="dashboard"; return renderDashboard(); }
  var personFilter = (state.detailPersonFilter && state.users.find(function(u){return u.id===state.detailPersonFilter;}))
    ? state.detailPersonFilter : null;
  var txs = cardTransactions(card.id);
  if(personFilter) {
    txs = txs.filter(function(t){ return t.splits.some(function(s){return s.userId===personFilter;}); });
  }
  var balance = cardBalance(card);
  var total = txs.reduce(function(s,t){return s+t.amountCents;},0);
  var monthly = cardMonthly(card);

  var backBtn = (personFilter && state.detailFromPerson)
    ? '<button class="btn btn-ghost" data-action="back-to-person" type="button">&larr; Back to '+esc(userName(personFilter))+'</button>'
    : '<button class="btn btn-ghost" data-action="back" type="button">&larr; All cards</button>';

  var html = '<div class="ct-app">'+renderTopbar()+'<div class="ct-detail-bar">'+
    backBtn+
    '<div class="ct-detail-bar-actions">'+
    '<button class="btn btn-ghost" data-action="edit-card" data-id="'+card.id+'">Edit</button>'+
    '<button class="btn btn-primary" data-action="add-tx" data-card="'+card.id+'">+ Add transaction</button>'+
    '</div></div>';

  html += '<header class="ct-detail-head" style="--cc-accent:'+esc(card.color||"#6366f1")+'">'+
    '<div class="ct-cc-bank">'+esc(card.network||"")+(card.last4?' &bull;&bull;&bull;&bull; '+esc(card.last4):'')+'</div>'+
    '<h1>'+esc(card.name)+'</h1>'+
    '<div class="ct-detail-sub"><span class="ct-owner-tag">owner</span> '+esc(userName(card.ownerId))+
    ' &middot; due day '+card.dueDay+
    (card.note?' &mdash; <span class="muted">'+esc(card.note)+'</span>':'')+'</div></header>';

  if(personFilter) {
    html += '<div class="ct-filter-banner">Showing only <strong>'+esc(userName(personFilter))+'</strong>\u2019s transactions on this card '+
      '<button class="ct-rbtn" data-action="clear-person-filter">Show all</button></div>';
  }

  if(txs.length === 0) {
    html += '<div class="ct-detail-empty"><p>'+(personFilter?'No transactions for '+esc(userName(personFilter))+' on this card.':'No transactions yet.')+'</p>'+
      (personFilter?'':'<button class="btn btn-primary" data-action="add-tx" data-card="'+card.id+'">+ Add transaction</button>')+'</div>';
  } else {
    // Group transactions by billing cycle
    var cycles = groupByCycle(txs, card);

    // Determine active (current/next due) cycle
    var today = startOfToday();
    var activeCycleIdx = 0;
    for(var ci = 0; ci < cycles.length; ci++) {
      if(cycles[ci].due >= today) { activeCycleIdx = ci; break; }
      activeCycleIdx = ci;
    }

    // Selected cycle index (default to active)
    var selectedIdx = state._cycleIdx != null ? state._cycleIdx : activeCycleIdx;
    selectedIdx = Math.max(0, Math.min(selectedIdx, cycles.length - 1));
    var cycle = cycles[selectedIdx];

    // Cycle navigator: prev | dropdown | next
    html += '<div class="ct-cycle-nav">';
    html += '<button class="btn btn-ghost btn-sm" data-action="cycle-prev" data-idx="'+selectedIdx+'"'+(selectedIdx<=0?' disabled':'')+'>&larr; Prev</button>';
    html += '<div class="ct-cycle-nav-center">';
    html += '<select data-action="cycle-select" class="ct-cycle-select" aria-label="Select billing cycle">';
    cycles.forEach(function(c,i){
      var label = c.dueLabel;
      html += '<option value="'+i+'"'+(i===selectedIdx?' selected':'')+'>'+esc(label)+'</option>';
    });
    html += '</select>';
    if(selectedIdx !== activeCycleIdx) {
      html += '<button class="btn btn-link btn-sm" data-action="cycle-today">Today</button>';
    }
    html += '</div>';
    html += '<button class="btn btn-ghost btn-sm" data-action="cycle-next" data-idx="'+selectedIdx+'"'+(selectedIdx>=cycles.length-1?' disabled':'')+'>Next &rarr;</button>';
    html += '</div>';

    // Cycle-scoped stats, settlements, breakdowns
    if(cycle) {
      var cycleTotal, cycleUnpaid, cyclePaid, cardTotalStat, cardTotalSub;
      if(personFilter) {
        // Scope every figure to the filtered person's share.
        cycleTotal = cycle.txs.reduce(function(s,t){ return s + personShareOnEntry(t, personFilter); }, 0);
        cycleUnpaid = cycle.txs.reduce(function(s,t){ return s + personUnpaidShareOnEntry(t, personFilter); }, 0);
        cyclePaid = cycleTotal - cycleUnpaid;
        cardTotalStat = cardUserAmounts(card, "all")[personFilter] || 0;
        cardTotalSub = "all cycles";
      } else {
        cycleTotal = cycle.txs.reduce(function(s,t){ return s + (t._monthAmt || t.amountCents); }, 0);
        cycleUnpaid = cycle.total;
        cyclePaid = cycleTotal - cycleUnpaid;
        cardTotalStat = balance;
        cardTotalSub = "all cycles";
      }

      html += '<section class="ct-detail-stats">'+
        statBox("This cycle",fmtMoney(cycleUnpaid),"unpaid"," ")+
        statBox("Cycle total",fmtMoney(cycleTotal),cycle.txs.length+" item"+(cycle.txs.length!==1?"s":"")," ")+
        statBox("Paid",fmtMoney(cyclePaid),""," ")+
        statBox(personFilter?"Their card total":"Card total",fmtMoney(cardTotalStat),cardTotalSub," ")+
        '</section>';

      html += renderCycleBreakdowns(card, cycle, personFilter);
    }

    // Show the single selected cycle
    if(cycle) {
      var itemCount = cycle.txs.length;
      var headerTotal = personFilter
        ? cycle.txs.reduce(function(s,t){ return s + personUnpaidShareOnEntry(t, personFilter); }, 0)
        : cycle.total;
      html += '<div class="ct-cycle-group ct-cycle-active">';
      html += '<div class="ct-cycle-header ct-cycle-header-active">' +
        '<div class="ct-cycle-label">' +
          '<div>'+
            '<span class="ct-cycle-due-lbl">Due date</span>'+
            '<span class="ct-cycle-due">'+esc(cycle.dueLabel)+'</span>'+
            '<span class="ct-cycle-range">'+esc(cycle.rangeLabel)+' &middot; '+itemCount+' item'+(itemCount!==1?'s':'')+'</span>'+
          '</div>'+
        '</div>'+
        '<span class="ct-cycle-total">'+fmtMoney(headerTotal)+'</span>'+
      '</div>';
      html += '<div class="ct-cycle-body">';
      if(itemCount === 0) {
        html += '<div class="ct-detail-empty"><p>No transactions in this cycle.</p></div>';
      } else {
        html += '<div class="ct-detail-tablewrap"><table class="ct-charges" aria-label="Transactions due '+esc(cycle.dueLabel)+'">'+
          '<thead><tr><th>Description</th><th>Category</th><th>Split</th><th class="num">Amount</th>'+
          '<th>Plan</th><th class="num">Monthly</th><th class="num">Remaining</th><th aria-label="Actions"></th></tr></thead><tbody>';
        cycle.txs.forEach(function(t){ html += renderTxRow(card,t,personFilter); });
        html += '</tbody></table></div>';
      }
      html += '</div></div>';
    }
  }

  html += '<div class="ct-detail-foot">'+
    '<button class="btn btn-danger-ghost" data-action="delete-card" data-id="'+card.id+'">Delete card</button></div>';
  html += '</div>';
  return html;
}

// Group transactions into billing cycles based on the card's statement + due day
function groupByCycle(txs, card) {
  var dueDay = card.dueDay || 1;
  var stmtDay = card.statementDay || null;

  // Which statement's DUE DATE does a transaction on `dateStr` belong to?
  // Real-card model: a purchase belongs to the statement that is still open when
  // it's made (i.e. closes on the next statement day on/after it). That statement's
  // due date is dueDay — in the same month as the close if dueDay > statementDay,
  // otherwise the following month.
  function cycleDueDate(dateStr) {
    if(!dateStr) return nextDueDate(dueDay);
    var d = new Date(dateStr);
    if(isNaN(d)) return nextDueDate(dueDay);
    var y = d.getFullYear(), m = d.getMonth(), day = d.getDate();

    if(stmtDay) {
      // Find the statement close month: if the txn is after this month's close,
      // it rolls into next month's statement.
      var cy = y, cm = m;
      var closeThis = Math.min(stmtDay, daysInMonth(cy, cm));
      if(day > closeThis) { cm++; if(cm > 11){ cm = 0; cy++; } }
      // Due date relative to that close month.
      var dy = cy, dm = cm;
      if(dueDay <= stmtDay) { dm++; if(dm > 11){ dm = 0; dy++; } }
      var dd = Math.min(dueDay, daysInMonth(dy, dm));
      return new Date(dy, dm, dd);
    }
    // Fallback (no statement day set): due-day boundary.
    var thisDue = Math.min(dueDay, daysInMonth(y, m));
    if(day > thisDue) { m++; if(m > 11){ m = 0; y++; } }
    var dd2 = Math.min(dueDay, daysInMonth(y, m));
    return new Date(y, m, dd2);
  }

  // Statement window (start–end) for a given due date, for the cycle label.
  function periodForDue(due) {
    var dy = due.getFullYear(), dm = due.getMonth();
    if(stmtDay) {
      // Close month is the same as due month if dueDay > stmtDay, else previous month.
      var cy = dy, cm = dm;
      if(dueDay <= stmtDay) { cm--; if(cm < 0){ cm = 11; cy--; } }
      var endDay = Math.min(stmtDay, daysInMonth(cy, cm));
      var end = new Date(cy, cm, endDay);
      var py = cy, pm = cm - 1; if(pm < 0){ pm = 11; py--; }
      var prevEndDay = Math.min(stmtDay, daysInMonth(py, pm));
      var start = new Date(py, pm, prevEndDay + 1);
      return {start:start, end:end};
    }
    var py2 = dy, pm2 = dm - 1; if(pm2 < 0){ pm2 = 11; py2--; }
    var prevDue = Math.min(dueDay, daysInMonth(py2, pm2));
    var start2 = new Date(py2, pm2, prevDue + 1);
    return {start:start2, end:due};
  }

  var groups = {}; // key: "YYYY-MM-DD" of due date

  txs.forEach(function(t){
    if(t.installment) {
      // Installment: each unpaid month goes into its own cycle
      var startDate = t.installment.startDate || t.date || t.createdAt || "";
      for(var i = 0; i < t.installment.months; i++) {
        var due = installmentDueDateObj(startDate, dueDay, i);
        var key = due.toISOString().slice(0,10);
        if(!groups[key]) groups[key] = {due:due, txs:[], total:0};
        var isPaid = i < t.installment.monthsPaid;
        var monthAmt = distributeCents(t.amountCents, t.installment.months)[i];
        var virtual = Object.assign({}, t, {
          _installmentMonth: i,
          _monthAmt: monthAmt,
          _isPaidMonth: isPaid
        });
        groups[key].txs.push(virtual);
        if(!isPaid) groups[key].total += monthAmt;
      }
    } else {
      // One-time: assign to the statement cycle its date falls in
      var due = cycleDueDate(t.date);
      var key = due.toISOString().slice(0,10);
      if(!groups[key]) groups[key] = {due:due, txs:[], total:0};
      groups[key].txs.push(t);
      if(!txSettled(t)) groups[key].total += txRemaining(t);
    }
  });

  // Sort cycles by due date
  var keys = Object.keys(groups).sort();
  return keys.map(function(key){
    var g = groups[key];
    var due = g.due;
    var dueLabel = fmtDateFull(due);
    var period = periodForDue(due);
    var rangeLabel = fmtDate(period.start) + " – " + fmtDate(period.end);
    return {dueLabel:dueLabel, rangeLabel:rangeLabel, total:g.total, txs:g.txs, due:due};
  });
}

function renderCardSettlements(card) {
  // Show who owes what on this card (including the owner's own unpaid share)
  var debts = []; // non-owners who owe the card owner
  var ownerUnpaid = 0; // owner's own unpaid share

  state.transactions.forEach(function(t){
    if(t.cardId !== card.id || txSettled(t)) return;
    t.splits.forEach(function(sp){
      if(sp.paid) return;
      var amt = 0;
      if(t.installment) {
        var pct = sp.amountCents / t.amountCents;
        amt = Math.round(txRemaining(t) * pct);
      } else {
        amt = sp.amountCents;
      }
      if(amt <= 0) return;

      if(sp.userId === card.ownerId) {
        ownerUnpaid += amt;
      } else {
        var existing = debts.find(function(d){return d.from===sp.userId;});
        if(existing) existing.amount += amt;
        else debts.push({from:sp.userId, amount:amt});
      }
    });
  });

  // Check if multiple people are involved on this card at all
  var involvedUsers = {};
  state.transactions.forEach(function(t){
    if(t.cardId !== card.id) return;
    t.splits.forEach(function(sp){ involvedUsers[sp.userId] = true; });
  });
  var userCount = Object.keys(involvedUsers).length;

  // Only show settlements panel if more than one person uses this card
  if(userCount <= 1) return '';

  var allSettled = debts.length === 0 && ownerUnpaid === 0;
  var html = '<div class="ct-card-settlements">';

  if(allSettled) {
    html += '<div class="ct-card-settlements-header"><span class="ct-section-title" style="margin:0">Card settlements</span></div>';
    html += '<div class="ct-settled-msg">&#10003; All settled on this card</div>';
  } else {
    var totalOwed = debts.reduce(function(s,d){return s+d.amount;},0);
    html += '<div class="ct-card-settlements-header"><span class="ct-section-title" style="margin:0">Card settlements</span></div>';

    // Owner's own share
    if(ownerUnpaid > 0) {
      html += '<div class="ct-settlement-row ct-settlement-owner">' +
        '<span class="ct-debt-avatar" style="background:'+esc(userColor(card.ownerId))+'">'+esc(userName(card.ownerId).charAt(0))+'</span>'+
        '<span class="ct-settlement-label">'+esc(userName(card.ownerId))+' <span class="ct-owner-tag">owner</span></span>'+
        '<span class="ct-settlement-amt">'+fmtMoney(ownerUnpaid)+' own share unpaid</span>'+
      '</div>';
    }

    // Others who owe the owner
    debts.forEach(function(d){
      html += '<div class="ct-debt-flow ct-debt-flow-sm">' +
        '<div class="ct-debt-from" style="--user-color:'+esc(userColor(d.from))+'">'+
          '<span class="ct-debt-avatar">'+esc(userName(d.from).charAt(0))+'</span>'+
          '<span class="ct-debt-name">'+esc(userName(d.from))+'</span>'+
        '</div>'+
        '<div class="ct-debt-arrow">' +
          '<span class="ct-debt-line"></span>'+
          '<span class="ct-debt-amount">'+fmtMoney(d.amount)+'</span>'+
          '<span class="ct-debt-line"></span>'+
          '<span class="ct-debt-chevron">&rarr;</span>'+
        '</div>'+
        '<div class="ct-debt-to" style="--user-color:'+esc(userColor(card.ownerId))+'">'+
          '<span class="ct-debt-avatar">'+esc(userName(card.ownerId).charAt(0))+'</span>'+
          '<span class="ct-debt-name">'+esc(userName(card.ownerId))+'</span>'+
        '</div>'+
      '</div>';
    });

    if(totalOwed > 0) {
      html += '<div class="ct-settlement-total">Total owed to '+esc(userName(card.ownerId))+': <strong>'+fmtMoney(totalOwed)+'</strong></div>';
    }
  }
  html += '</div>';
  return html;
}

function renderCycleBreakdowns(card, cycle, personFilter) {
  var txs = cycle.txs.filter(function(t){return !t._isPaidMonth;});
  if(txs.length === 0) return '';

  // A person's share of a (possibly installment-month) transaction.
  function personShare(t){
    var isV = t._installmentMonth !== undefined;
    var sum = 0;
    t.splits.forEach(function(sp){
      if(personFilter && sp.userId !== personFilter) return;
      if(sp.paid && !isV) return;
      sum += isV ? Math.round(t._monthAmt * sp.amountCents / t.amountCents) : sp.amountCents;
    });
    return sum;
  }

  // By category for this cycle (scoped to the person when filtered)
  var byCategory = {};
  txs.forEach(function(t){
    var cat = t.category || "Uncategorized";
    var amt = personFilter ? personShare(t) : (t._monthAmt || t.amountCents);
    if(amt > 0) byCategory[cat] = (byCategory[cat] || 0) + amt;
  });
  var catEntries = Object.keys(byCategory).map(function(k){return {name:k, amount:byCategory[k]};});
  catEntries.sort(function(a,b){return b.amount - a.amount;});
  var catMax = catEntries.length > 0 ? catEntries[0].amount : 1;

  // By user for this cycle (only the filtered person when filtered)
  var byUser = {};
  txs.forEach(function(t){
    var isVirtual = t._installmentMonth !== undefined;
    t.splits.forEach(function(sp){
      if(personFilter && sp.userId !== personFilter) return;
      if(sp.paid && !isVirtual) return;
      var amt = isVirtual ? Math.round(t._monthAmt * sp.amountCents / t.amountCents) : sp.amountCents;
      byUser[sp.userId] = (byUser[sp.userId] || 0) + amt;
    });
  });
  var userEntries = Object.keys(byUser).map(function(id){return {userId:id, amount:byUser[id]};});
  userEntries.sort(function(a,b){return b.amount - a.amount;});
  var userMax = userEntries.length > 0 ? userEntries[0].amount : 1;

  // Hide only when unfiltered and there's nothing meaningful to compare.
  if(!personFilter && catEntries.length <= 1 && userEntries.length <= 1) return '';
  if(catEntries.length === 0 && userEntries.length === 0) return '';

  var html = '<div class="ct-breakdowns ct-breakdowns-card">';
  html += '<div class="ct-breakdown-panel"><h3 class="ct-section-title">By Category</h3>';
  catEntries.slice(0,5).forEach(function(e){
    var pct = Math.round(e.amount / catMax * 100);
    html += '<div class="ct-bk-row"><span class="ct-bk-label">'+esc(e.name)+'</span>'+
      '<span class="ct-bk-bar"><span style="width:'+pct+'%"></span></span>'+
      '<span class="ct-bk-amt">'+fmtMoney(e.amount)+'</span></div>';
  });
  html += '</div>';
  html += '<div class="ct-breakdown-panel"><h3 class="ct-section-title">By Person</h3>';
  userEntries.forEach(function(e){
    var pct = Math.round(e.amount / userMax * 100);
    var rowAttrs = personFilter ? '' : ' data-action="filter-person" data-person="'+e.userId+'" role="button" tabindex="0" title="Filter to '+esc(userName(e.userId))+'"';
    html += '<div class="ct-bk-row'+(personFilter?'':' ct-bk-row-click')+'"'+rowAttrs+'><span class="ct-bk-avatar" style="background:'+esc(userColor(e.userId))+';color:'+contrastOn(userColor(e.userId))+'">'+esc(userName(e.userId).charAt(0))+'</span>'+
      '<span class="ct-bk-label">'+esc(userName(e.userId))+'</span>'+
      '<span class="ct-bk-bar"><span style="width:'+pct+'%"></span></span>'+
      '<span class="ct-bk-amt">'+fmtMoney(e.amount)+'</span></div>';
  });
  html += '</div></div>';
  return html;
}

function renderTxRow(card,t,personFilter) {
  var settled = txSettled(t);
  var inst = !!t.installment;
  var isVirtual = t._installmentMonth !== undefined;

  // Build compact split chips. When filtered to a person, show only their chip.
  var shownSplits = personFilter
    ? t.splits.filter(function(s){ return s.userId === personFilter; })
    : t.splits;
  var splitCell = '<div class="ct-split-chips">';
  shownSplits.forEach(function(s){
    var name = userName(s.userId);
    var initial = name.charAt(0);
    var color = userColor(s.userId);
    var isOwner = s.userId === card.ownerId;
    // For virtual installment rows, show per-month share not total
    var chipAmt = s.amountCents;
    if(isVirtual && t.installment && t.installment.months > 1) {
      chipAmt = Math.round(s.amountCents / t.installment.months);
    }
    var amt = fmtMoney(chipAmt);
    var paidCls = s.paid ? ' ct-chip-paid' : '';
    var clickable = !personFilter;
    var chipAttrs = clickable ? ' data-action="filter-person" data-person="'+s.userId+'" role="button" tabindex="0"' : '';
    var chipTitle = esc(name)+': '+amt+(s.paid?' (paid)':'')+(clickable?' \u2014 click to filter':'');
    splitCell += '<span class="ct-split-chip'+paidCls+(clickable?' ct-chip-click':'')+'"'+chipAttrs+' title="'+chipTitle+'">' +
      '<span class="ct-split-chip-dot" style="background:'+esc(color)+';color:'+contrastOn(color)+'">'+esc(initial)+'</span>' +
      '<span class="ct-split-chip-amt">'+amt+'</span>' +
      (isOwner?'<span class="ct-mini-tag">owner</span>':'')+
      (s.paid?'<span class="ct-mini-tag ct-paid-tag">paid</span>':'')+
    '</span>';
  });
  splitCell += '</div>';

  // Handle virtual installment month entries from groupByCycle
  var plan, mo, rem;
  if(isVirtual) {
    plan = "Mo "+(t._installmentMonth+1)+"/"+t.installment.months;
    mo = fmtMoney(t._monthAmt);
    rem = t._isPaidMonth ? '<span class="ct-mini-tag ct-paid-tag">paid</span>' : fmtMoney(t._monthAmt);
    settled = t._isPaidMonth;
  } else {
    plan = inst ? (t.installment.monthsPaid+"/"+t.installment.months+" mo") : "One-time";
    mo = inst ? fmtMoney(txMonthly(t)) : "&mdash;";
    rem = fmtMoney(txRemaining(t));
  }

  return '<tr class="'+(settled?"settled":"")+'">'+
    '<td class="ct-c-desc">'+esc(t.description||"(no description)")+
    (t.date?'<span class="ct-c-date">'+esc(fmtISO(t.date))+'</span>':'')+'</td>'+
    '<td class="ct-c-category">'+(t.category?'<span class="ct-c-cat">'+esc(t.category)+'</span>':'&mdash;')+'</td>'+
    '<td class="ct-c-split">'+splitCell+'</td>'+
    '<td class="num">'+fmtMoney(t.amountCents)+'</td>'+
    '<td>'+plan+'</td>'+
    '<td class="num">'+mo+'</td>'+
    '<td class="num">'+rem+'</td>'+
    '<td class="ct-row-actions">'+
    (isVirtual
      ? '<span class="ct-inst-label">Installment</span>'
      : (inst&&!settled?'<button class="ct-rbtn" data-action="pay-month" data-id="'+t.id+'">+1 mo</button>':'')+
        (!inst?'<button class="ct-rbtn'+(settled?" paid":"")+'" data-action="toggle-settled" data-id="'+t.id+'">'+(settled?"Settled":"Mark paid")+'</button>':'')+
        '<button class="ct-rbtn" data-action="edit-tx" data-id="'+t.id+'">Edit</button>'+
        '<button class="ct-icon-btn" data-action="del-tx" data-id="'+t.id+'" aria-label="Delete">&times;</button>'
    )+
    '</td></tr>';
}

// ===========================================================================
// PERSON VIEW (per-person summary)
// ===========================================================================

// Active (current/next due) billing cycle for a card.
function activeCycleFor(card) {
  var cycles = groupByCycle(cardTransactions(card.id), card);
  if(!cycles.length) return null;
  var today = startOfToday(), idx = 0;
  for(var i = 0; i < cycles.length; i++) { if(cycles[i].due >= today) { idx = i; break; } idx = i; }
  return cycles[idx];
}

// Map of userId -> unpaid amount owed on a card, under a scope ("cycle" | "all").
function cardUserAmounts(card, scope) {
  var by = {};
  function add(uid, amt) { if(amt > 0) by[uid] = (by[uid] || 0) + amt; }
  if(scope === "all") {
    cardTransactions(card.id).forEach(function(t){
      if(txSettled(t)) return;
      t.splits.forEach(function(sp){
        if(sp.paid) return;
        add(sp.userId, t.installment ? Math.round(txRemaining(t) * sp.amountCents / t.amountCents) : sp.amountCents);
      });
    });
  } else {
    var cyc = activeCycleFor(card);
    if(cyc) cyc.txs.forEach(function(t){
      if(t._isPaidMonth) return;
      var isV = t._installmentMonth !== undefined;
      t.splits.forEach(function(sp){
        if(sp.paid && !isV) return;
        add(sp.userId, isV ? Math.round(t._monthAmt * sp.amountCents / t.amountCents) : sp.amountCents);
      });
    });
  }
  return by;
}

// A person's share of one (possibly installment-month) entry, regardless of paid status.
function personShareOnEntry(t, personId) {
  var isV = t._installmentMonth !== undefined;
  var base = isV ? (t._monthAmt || 0) : t.amountCents;
  var sum = 0;
  t.splits.forEach(function(sp){ if(sp.userId === personId) sum += Math.round(base * sp.amountCents / t.amountCents); });
  return sum;
}

// A person's UNPAID share of one entry.
function personUnpaidShareOnEntry(t, personId) {
  var isV = t._installmentMonth !== undefined;
  if(isV) return t._isPaidMonth ? 0 : personShareOnEntry(t, personId);
  var sum = 0;
  t.splits.forEach(function(sp){ if(sp.userId === personId && !sp.paid) sum += sp.amountCents; });
  return sum;
}

function renderPersonView() {
  var p = state.users.find(function(u){return u.id === state.currentPersonId;});
  if(!p) { state.view = "dashboard"; return renderDashboard(); }
  var scope = state.personScope || "cycle";
  var color = p.color || "#6366f1";

  var owesOthers = 0, ownShare = 0, isOwed = 0;
  var rows = [];
  state.cards.forEach(function(card){
    var amounts = cardUserAmounts(card, scope);
    var mine = amounts[state.currentPersonId] || 0;
    var isOwner = card.ownerId === state.currentPersonId;
    var cardTotal = 0;
    Object.keys(amounts).forEach(function(uid){ cardTotal += amounts[uid]; });
    if(mine > 0) {
      rows.push({card:card, amount:mine, isOwner:isOwner, pct: cardTotal ? Math.round(mine/cardTotal*100) : 0});
      if(isOwner) ownShare += mine; else owesOthers += mine;
    }
    if(isOwner) {
      Object.keys(amounts).forEach(function(uid){ if(uid !== state.currentPersonId) isOwed += amounts[uid]; });
    }
  });
  rows.sort(function(a,b){ return b.amount - a.amount; });

  var scopeLabel = scope === "cycle" ? "this billing cycle" : "all outstanding";
  var html = '<div class="ct-app">';
  html += renderTopbar();

  // Top bar: back + manage
  html += '<div class="ct-detail-bar">'+
    '<button class="btn btn-ghost" data-action="back" type="button">&larr; All cards</button>'+
    '<button class="btn btn-ghost" data-action="manage-users" type="button">Manage people</button>'+
  '</div>';

  // People selector: search + chips
  var chips = state.users.map(function(u){
    var active = u.id === state.currentPersonId;
    var uc = u.color || "#6366f1";
    return '<button class="ct-pchip'+(active?" active":"")+'" data-action="select-person" data-id="'+u.id+'" '+
      'data-name="'+esc(u.name.toLowerCase())+'" aria-pressed="'+active+'">'+
      '<span class="ct-pchip-av" style="background:'+esc(uc)+';color:'+contrastOn(uc)+'">'+esc(u.name.charAt(0))+'</span>'+
      esc(u.name)+'</button>';
  }).join("");
  html += '<div class="ct-people-bar">'+
    '<div class="ct-people-search"><span aria-hidden="true">&#128269;</span>'+
      '<input type="text" data-people-search placeholder="Search people\u2026" aria-label="Search people"/></div>'+
    '<div class="ct-pchips">'+chips+'</div></div>';

  // Summary header
  html += '<header class="ct-pv-head">'+
    '<span class="ct-pv-av" style="background:'+esc(color)+';color:'+contrastOn(color)+'">'+esc(p.name.charAt(0))+'</span>'+
    '<div class="ct-pv-id"><div class="ct-pv-name">'+esc(p.name)+'</div>'+
    '<div class="ct-pv-meta">Showing '+esc(scopeLabel)+'</div></div>'+
    '<div class="ct-pv-scope" role="tablist" aria-label="Amount scope">'+
      '<button class="ct-vt-btn'+(scope==="cycle"?" active":"")+'" data-action="person-scope" data-scope="cycle" role="tab" aria-selected="'+(scope==="cycle")+'">This cycle</button>'+
      '<button class="ct-vt-btn'+(scope==="all"?" active":"")+'" data-action="person-scope" data-scope="all" role="tab" aria-selected="'+(scope==="all")+'">All</button>'+
    '</div>'+
    '<div class="ct-pv-totals">'+
      '<div class="ct-pv-tot"><div class="lbl">Owes others</div><div class="val red">'+fmtMoney(owesOthers)+'</div></div>'+
      (isOwed > 0 ? '<div class="ct-pv-tot"><div class="lbl">Is owed</div><div class="val green">'+fmtMoney(isOwed)+'</div></div>' : '')+
    '</div></header>';

  if(rows.length === 0) {
    html += '<div class="ct-detail-empty"><p>Nothing outstanding for '+esc(p.name)+' '+esc(scopeLabel)+'.</p></div>';
  } else {
    html += '<div class="ct-pv-cards">';
    rows.forEach(function(r){
      var c = r.card;
      html += '<div class="ct-pv-card" data-action="open-card-for-person" data-id="'+c.id+'" data-person="'+state.currentPersonId+'" tabindex="0" role="button" aria-label="Open '+esc(c.name)+' filtered to '+esc(p.name)+'">'+
        '<span class="ct-pv-acc" style="background:'+esc(c.color||"#6366f1")+'"></span>'+
        '<div class="ct-pv-cbody">'+
          '<div class="ct-pv-ctop"><span class="ct-pv-cname">'+esc(c.name)+'</span>'+
            (r.isOwner ? ' <span class="ct-owner-tag">owner</span>' : '')+'</div>'+
          '<div class="ct-pv-csub">'+(r.isOwner ? 'own unpaid share' : 'owed to '+esc(userName(c.ownerId)))+'</div>'+
        '</div>'+
        '<span class="ct-pv-bar"><span style="width:'+r.pct+'%"></span></span>'+
        '<div class="ct-pv-amt"><div class="a">'+fmtMoney(r.amount)+'</div><div class="p">'+r.pct+'% of card</div></div>'+
      '</div>';
    });
    html += '</div>';
    html += '<div class="ct-pv-foot"><span class="t">Total '+esc(p.name)+' owes (all cards)</span>'+
      '<span class="v">'+fmtMoney(owesOthers + ownShare)+'</span></div>';
  }

  html += '</div>';
  return html;
}

// ===========================================================================
// INSTALLMENTS VIEW
// ===========================================================================
function renderInstallmentsView() {
  var inst = activeInstallments();
  var html = '<div class="ct-app">'+renderTopbar()+'<div class="ct-detail-bar">'+
    '<button class="btn btn-ghost" data-action="back">&larr; Dashboard</button>'+
    '<h2 style="margin:0">Installment Schedules</h2></div>';
  if(inst.length===0) {
    html += '<div class="ct-detail-empty"><p>No active installment plans.</p></div>';
  } else {
    html += '<h3 class="ct-inst-section-title">Active plans <span class="ct-inst-count">'+inst.length+'</span></h3>';
    inst.forEach(function(t){
      // Defensive: ensure per-person payment map exists (older data / edge cases)
      if(!t.installment.splitPayments) {
        t.installment.splitPayments = {};
        t.splits.forEach(function(sp){ t.installment.splitPayments[sp.userId] = t.installment.monthsPaid || 0; });
      }
      var card = state.cards.find(function(c){return c.id===t.cardId;});
      var cardName = card ? card.name : "?";
      var dueDay = card ? card.dueDay : 1;
      var perMonth = distributeCents(t.amountCents, t.installment.months);
      var pctDone = Math.round(t.installment.monthsPaid / t.installment.months * 100);
      var startDate = t.installment.startDate || t.date || t.createdAt || "";

      html += '<div class="ct-inst-card">';
      html += '<div class="ct-inst-header">' +
        '<div class="ct-inst-title">' +
          '<strong>'+esc(t.description||"(no description)")+'</strong>'+
          '<span class="ct-inst-meta">'+esc(cardName)+' &middot; '+fmtMoney(t.amountCents)+' total &middot; '+fmtMoney(perMonth[0])+'/mo</span>'+
        '</div>'+
        '<div class="ct-inst-progress-wrap">'+
          '<div class="ct-progress" style="width:120px"><div class="ct-progress-bar" style="width:'+pctDone+'%"></div></div>'+
          '<span>'+t.installment.monthsPaid+'/'+t.installment.months+'</span>'+
        '</div>'+
      '</div>';

      // Schedule grid
      html += '<div class="ct-inst-schedule">';
      for(var i = 0; i < t.installment.months; i++) {
        var isPaid = i < t.installment.monthsPaid;
        var isNext = i === t.installment.monthsPaid;
        var dueDate = computeInstallmentDueDate(startDate, dueDay, i);
        var statusCls = isPaid ? "ct-inst-paid" : (isNext ? "ct-inst-next" : "ct-inst-future");
        var label = isPaid ? "All paid" : (isNext ? "Due now" : "Upcoming");

        // Per-person status for this month
        var personStatus = '';
        if(!isPaid) {
          t.splits.forEach(function(sp){
            var spPaid = (t.installment.splitPayments[sp.userId] || 0) > i;
            personStatus += '<div class="ct-inst-person'+(spPaid?' ct-inst-person-paid':'')+'">' +
              '<span class="ct-inst-person-dot" style="background:'+esc(userColor(sp.userId))+';color:'+contrastOn(userColor(sp.userId))+'">'+esc(userName(sp.userId).charAt(0))+'</span>'+
              '<span>'+(spPaid?'Paid':'Unpaid')+'</span>'+
            '</div>';
          });
        }

        html += '<div class="ct-inst-month '+statusCls+'">' +
          '<div class="ct-inst-month-num">Mo '+(i+1)+'</div>'+
          '<div class="ct-inst-month-amt">'+fmtMoney(perMonth[i])+'</div>'+
          '<div class="ct-inst-month-date">'+(dueDate||"")+'</div>'+
          '<div class="ct-inst-month-status">'+label+'</div>'+
          personStatus+
        '</div>';
      }
      html += '</div>';

      // Per-person payment actions
      html += '<div class="ct-inst-actions">';
      html += '<div class="ct-inst-pay-people">';
      t.splits.forEach(function(sp){
        var spMonths = t.installment.splitPayments[sp.userId] || 0;
        var allDone = spMonths >= t.installment.months;
        html += '<div class="ct-inst-person-ctrl">' +
          '<span class="ct-inst-person-dot" style="background:'+esc(userColor(sp.userId))+';color:'+contrastOn(userColor(sp.userId))+'">'+esc(userName(sp.userId).charAt(0))+'</span>'+
          '<span class="ct-inst-person-name">'+esc(userName(sp.userId))+'</span>'+
          '<div class="ct-inst-person-counter">'+
            '<button class="ct-inst-counter-btn" data-action="unpay-person-month" data-id="'+t.id+'" data-user="'+sp.userId+'"'+(spMonths<=0?' disabled':'')+'>&minus;</button>'+
            '<span class="ct-inst-counter-val" data-action="set-person-month" data-id="'+t.id+'" data-user="'+sp.userId+'" data-max="'+t.installment.months+'" title="Click to set">'+spMonths+'/'+t.installment.months+'</span>'+
            '<button class="ct-inst-counter-btn" data-action="pay-person-month" data-id="'+t.id+'" data-user="'+sp.userId+'"'+(allDone?' disabled':'')+'>&plus;</button>'+
          '</div>'+
          (allDone?'<span class="ct-inst-done-badge">Done</span>':'')+
        '</div>';
      });
      html += '</div>';
      html += '<div class="ct-inst-actions-right">'+
        '<button class="ct-rbtn" data-action="edit-tx" data-id="'+t.id+'">Edit</button>'+
        '<button class="ct-rbtn ct-rbtn-danger" data-action="del-tx" data-id="'+t.id+'">Delete</button>'+
        '<span class="ct-inst-remaining">'+fmtMoney(txRemaining(t))+' remaining</span>'+
      '</div></div>';
      html += '</div>';
    });
  }

  // Completed plans (fully paid)
  var done = completedInstallments();
  if(done.length > 0) {
    html += '<h3 class="ct-inst-section-title ct-inst-section-done">Completed <span class="ct-inst-count">'+done.length+'</span></h3>';
    html += '<div class="ct-inst-done-list">';
    done.forEach(function(t){
      var card = state.cards.find(function(c){return c.id===t.cardId;});
      var cardName = card ? card.name : "?";
      var perMonth = distributeCents(t.amountCents, t.installment.months);
      var startDate = t.installment.startDate || t.date || t.createdAt || "";
      var dueDay = card ? card.dueDay : 1;
      var finishedDate = computeInstallmentDueDate(startDate, dueDay, t.installment.months - 1);
      html += '<div class="ct-inst-done-card">'+
        '<span class="ct-inst-done-check" aria-hidden="true">&#10003;</span>'+
        '<div class="ct-inst-done-body">'+
          '<div class="ct-inst-done-main">'+
            '<strong>'+esc(t.description||"(no description)")+'</strong>'+
            (t.category?'<span class="ct-c-cat">'+esc(t.category)+'</span>':'')+
          '</div>'+
          '<div class="ct-inst-done-meta">'+
            esc(cardName)+' &middot; '+t.installment.months+' mo &middot; '+fmtMoney(perMonth[0])+'/mo'+
            (finishedDate?' &middot; finished '+finishedDate:'')+
          '</div>'+
        '</div>'+
        '<span class="ct-inst-done-total">'+fmtMoney(t.amountCents)+'</span>'+
        '<div class="ct-inst-done-actions">'+
          '<button class="ct-rbtn" data-action="edit-tx" data-id="'+t.id+'">Edit</button>'+
          '<button class="ct-rbtn ct-rbtn-danger" data-action="del-tx" data-id="'+t.id+'">Delete</button>'+
        '</div>'+
      '</div>';
    });
    html += '</div>';
  }

  html += '</div>';
  return html;
}
function computeInstallmentDueDate(startDateStr, dueDay, monthIndex) {
  var base;
  if(startDateStr) {
    base = new Date(startDateStr);
    if(isNaN(base)) base = new Date();
  } else {
    base = new Date();
  }
  var y = base.getFullYear();
  var m = base.getMonth() + monthIndex;
  var targetYear = y + Math.floor(m / 12);
  var targetMonth = m % 12;
  var day = Math.min(dueDay, daysInMonth(targetYear, targetMonth));
  var d = new Date(targetYear, targetMonth, day);
  return fmtDateFull(d);
}

// ===========================================================================
// Helper: get a Date object for an installment month's due date
// ===========================================================================
function installmentDueDateObj(startDateStr, dueDay, monthIndex) {
  var base;
  if(startDateStr) {
    base = new Date(startDateStr);
    if(isNaN(base)) base = new Date();
  } else {
    base = new Date();
  }
  var y = base.getFullYear();
  var m = base.getMonth() + monthIndex;
  var targetYear = y + Math.floor(m / 12);
  var targetMonth = m % 12;
  var day = Math.min(dueDay, daysInMonth(targetYear, targetMonth));
  return new Date(targetYear, targetMonth, day);
}

// ===========================================================================
// MODALS
// ===========================================================================
function showModal(html) {
  var overlay = document.createElement("div");
  overlay.className = "ct-modal-overlay";
  overlay.setAttribute("role","dialog");
  overlay.setAttribute("aria-modal","true");
  overlay.innerHTML = '<div class="ct-modal">'+html+'</div>';
  document.body.appendChild(overlay);
  // Focus trap
  var modal = overlay.querySelector(".ct-modal");
  var focusable = modal.querySelectorAll('input,select,textarea,button,[tabindex]:not([tabindex="-1"])');
  if(focusable.length) focusable[0].focus();
  overlay.addEventListener("click",function(e){if(e.target===overlay) closeModal();});
  document.addEventListener("keydown",modalKeyHandler);
}

function closeModal() {
  var overlay = document.querySelector(".ct-modal-overlay");
  if(overlay) overlay.remove();
  document.removeEventListener("keydown",modalKeyHandler);
}

function modalKeyHandler(e) {
  if(e.key==="Escape") { closeModal(); return; }
  if(e.key==="Tab") {
    var modal = document.querySelector(".ct-modal");
    if(!modal) return;
    var focusable = Array.from(modal.querySelectorAll('input,select,textarea,button,[tabindex]:not([tabindex="-1"])'));
    if(focusable.length===0) return;
    var first=focusable[0], last=focusable[focusable.length-1];
    if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}
  }
}

// ---------------------------------------------------------------------------
// CARD MODAL
// ---------------------------------------------------------------------------
function openCardModal(card) {
  if(state.users.length===0){openUserModal();return;}
  var title = card ? "Edit card" : "Add card";
  var ownerOpts = state.users.map(function(u){
    return '<option value="'+u.id+'"'+(card&&card.ownerId===u.id?" selected":"")+'>'+esc(u.name)+'</option>';
  }).join("");

  var html = '<div class="ct-modal-head"><h2>'+title+'</h2>'+
    '<button class="ct-icon-btn" data-action="close-modal" aria-label="Close">&times;</button></div>'+
    '<form class="ct-form" id="ct-card-form">'+
    '<input type="hidden" name="cardId" value="'+(card?card.id:"")+'"/>'+
    field("Card owner",'<select name="ownerId" required>'+ownerOpts+'</select>')+
    '<div class="ct-grid2">'+
    field("Card name",'<input name="name" type="text" value="'+esc(card?card.name:"")+'" required/>')+
    field("Network",'<input name="network" type="text" value="'+esc(card?card.network||"":"")+'" placeholder="Visa, Mastercard..."/>')+
    '</div><div class="ct-grid2">'+
    field("Last 4 digits",'<input name="last4" type="text" inputmode="numeric" maxlength="4" pattern="\\d{0,4}" value="'+esc(card?card.last4||"":"")+'"/>')+
    field("Accent color",'<input name="color" type="color" value="'+(card?card.color:"#6366f1")+'"/>')+
    '</div><div class="ct-grid2">'+
    field("Credit limit",'<input name="limitCents" type="number" min="0" step="0.01" value="'+(card?fromCents(card.limitCents)||"":"")+'"/>')+
    field("Due day *",'<input name="dueDay" type="number" min="1" max="31" value="'+(card?card.dueDay:"")+'" required/>')+
    '</div>'+
    field("Statement day",'<input name="statementDay" type="number" min="1" max="31" value="'+(card&&card.statementDay?card.statementDay:"")+'"/>')+
    field("Note",'<input name="note" type="text" value="'+esc(card?card.note||"":"")+'"/>')+
    '<div class="ct-modal-foot"><span class="spacer"></span>'+
    '<button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>'+
    '<button type="submit" class="btn btn-primary">Save card</button></div></form>';
  showModal(html);
}

function field(label,input) {
  return '<div class="ct-field"><label>'+label+'</label>'+input+'</div>';
}

function categoryDatalist() {
  // Collect unique categories from existing transactions
  var cats = {};
  state.transactions.forEach(function(t){ if(t.category) cats[t.category] = true; });
  // Add common defaults
  ["Food","Grocery","Bills","Transport","Shopping","Entertainment","Travel","Health","Subscriptions","Others"].forEach(function(c){ cats[c]=true; });
  return Object.keys(cats).sort().map(function(c){ return '<option value="'+esc(c)+'"/>'; }).join("");
}

function categoryOptions(selected) {
  var defaults = ["Food","Grocery","Bills","Transport","Shopping","Entertainment","Travel","Health","Subscriptions","Others"];
  var cats = {};
  defaults.forEach(function(c){ cats[c] = true; });
  // Include any custom categories already used so they're preserved
  state.transactions.forEach(function(t){ if(t.category) cats[t.category] = true; });
  var list = Object.keys(cats).sort();
  var opts = '<option value=""'+(!selected?' selected':'')+'>— None —</option>';
  opts += list.map(function(c){
    return '<option value="'+esc(c)+'"'+(c===selected?' selected':'')+'>'+esc(c)+'</option>';
  }).join("");
  return opts;
}

// ---------------------------------------------------------------------------
// TRANSACTION MODAL
// ---------------------------------------------------------------------------
function openTxModal(tx, cardId) {
  if(state.users.length===0){openUserModal();return;}
  var isEdit = !!tx;
  var title = isEdit ? "Edit transaction" : "Add transaction";
  var card = state.cards.find(function(c){return c.id===(tx?tx.cardId:cardId);});

  var cardOpts = state.cards.map(function(c){
    var sel = (tx?tx.cardId:cardId)===c.id?" selected":"";
    return '<option value="'+c.id+'"'+sel+'>'+esc(c.name)+'</option>';
  }).join("");

  // Split mode: equal, custom, percentage
  var splitMode = "equal";
  var splitUsers = [];
  if(tx && tx.splits.length > 0) {
    splitUsers = tx.splits.map(function(s){return {userId:s.userId,amountCents:s.amountCents,paid:s.paid};});
    // Detect mode
    var allEqual = splitUsers.every(function(s){return Math.abs(s.amountCents - splitUsers[0].amountCents)<=1;});
    splitMode = allEqual ? "equal" : "custom";
  } else {
    // Default: card owner
    if(card) splitUsers = [{userId:card.ownerId, amountCents:0, paid:false}];
  }

  var html = '<div class="ct-modal-head"><h2>'+title+'</h2>'+
    '<button class="ct-icon-btn" data-action="close-modal" aria-label="Close">&times;</button></div>'+
    '<form class="ct-form" id="ct-tx-form">'+
    '<input type="hidden" name="txId" value="'+(tx?tx.id:"")+'"/>'+
    field("Description *",'<input name="description" type="text" value="'+esc(tx?tx.description:"")+'" required/>')+
    '<div class="ct-grid2">'+
    field("Category",'<select name="category">'+categoryOptions(tx?tx.category||"":"")+'</select>')+
    field("Amount *",'<input name="amount" type="number" min="0.01" step="0.01" value="'+(tx?fromCents(tx.amountCents):"")+'" required/>')+
    '</div>'+
    '<div class="ct-grid2">'+
    field("Card",'<select name="cardId" required>'+cardOpts+'</select>')+
    field("Date",'<input name="date" type="date" value="'+(tx?tx.date||"":"")+'"/>')+
    '</div>'+
    '<fieldset class="ct-fieldset"><legend>Split among</legend>'+
    '<div class="ct-split-mode"><label><input type="radio" name="splitMode" value="equal"'+(splitMode==="equal"?" checked":"")+'/> Equal split</label>'+
    '<label><input type="radio" name="splitMode" value="custom"'+(splitMode==="custom"?" checked":"")+'/> Custom amounts</label></div>'+
    '<div id="ct-split-rows">';

  splitUsers.forEach(function(s,i){
    html += splitRow(s,i);
  });

  html += '</div><button type="button" class="btn btn-ghost btn-sm" data-action="add-split-row">+ Add person</button></fieldset>';

  // Installment
  var hasInst = tx && tx.installment;
  var instStart = hasInst && tx.installment.startDate ? tx.installment.startDate : "";
  html += '<label class="ct-check-row"><input type="checkbox" name="isInstallment"'+(hasInst?" checked":"")+'/>Installment plan</label>'+
    '<div class="ct-inst-fields"'+(hasInst?'':' hidden')+'>'+
    '<div class="ct-grid2">'+
    field("Total months",'<input name="instMonths" type="number" min="2" max="60" value="'+(hasInst?tx.installment.months:"")+'"/>')+
    field("Months paid",'<input name="instPaid" type="number" min="0" value="'+(hasInst?tx.installment.monthsPaid:"0")+'"/>')+
    '</div>'+
    field("First payment date",'<input name="instStart" type="date" value="'+esc(instStart)+'"/>')+
    '<small class="ct-hint">Used to calculate due dates for each month. If blank, uses the transaction date.</small>'+
    '</div>';

  html += '<div class="ct-modal-foot">';
  if(isEdit) html += '<button type="button" class="btn btn-danger-ghost" data-action="delete-tx" data-id="'+tx.id+'">Delete</button>';
  html += '<span class="spacer"></span>'+
    '<button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>'+
    '<button type="submit" class="btn btn-primary">Save</button></div></form>';
  showModal(html);
}

function splitRow(s,idx) {
  var opts = state.users.map(function(u){
    return '<option value="'+u.id+'"'+(s.userId===u.id?" selected":"")+'>'+esc(u.name)+'</option>';
  }).join("");
  return '<div class="ct-split-row" data-idx="'+idx+'">'+
    '<select name="split_user_'+idx+'">'+opts+'</select>'+
    '<input name="split_amt_'+idx+'" type="number" step="0.01" min="0" placeholder="Amount" value="'+(s.amountCents?fromCents(s.amountCents):"")+'"/>'+
    '<label class="ct-split-paid"><input type="checkbox" name="split_paid_'+idx+'"'+(s.paid?" checked":"")+'/>Paid</label>'+
    '<button type="button" class="ct-icon-btn ct-split-remove" data-action="remove-split" data-idx="'+idx+'" aria-label="Remove">&times;</button>'+
    '</div>';
}

// ---------------------------------------------------------------------------
// USER MODAL
// ---------------------------------------------------------------------------
function openPeopleView() {
  if(state.users.length === 0) { openUserModal(); return; }
  state.view = "person";
  if(!state.currentPersonId || !state.users.find(function(u){return u.id===state.currentPersonId;})) {
    state.currentPersonId = state.users[0].id;
  }
  render();
}

function openUserModal() {
  var rows = state.users.map(function(u, i){
    var isFirst = i === 0;
    var isLast = i === state.users.length - 1;
    return '<li class="ct-user-li">'+
      '<span class="ct-user-avatar" style="background:'+esc(u.color||"#6366f1")+';color:'+contrastOn(u.color||"#6366f1")+'">'+esc(u.name.charAt(0))+'</span>'+
      '<span class="ct-u-name">'+esc(u.name)+'</span>'+
      '<input type="color" class="ct-user-color" value="'+esc(u.color||"#6366f1")+'" data-action="set-user-color" data-id="'+u.id+'" title="Change color"/>'+
      '<div class="ct-user-reorder">'+
        '<button class="ct-icon-btn" data-action="move-user-up" data-id="'+u.id+'" aria-label="Move up"'+(isFirst?' disabled':'')+'>&#9650;</button>'+
        '<button class="ct-icon-btn" data-action="move-user-down" data-id="'+u.id+'" aria-label="Move down"'+(isLast?' disabled':'')+'>&#9660;</button>'+
      '</div>'+
      '<button class="btn btn-danger-ghost btn-sm" data-action="del-user" data-id="'+u.id+'">Remove</button>'+
    '</li>';
  }).join("") || '<li class="ct-user-li">No people yet</li>';

  var html = '<div class="ct-modal-head"><h2>People</h2>'+
    '<button class="ct-icon-btn" data-action="close-modal" aria-label="Close">&times;</button></div>'+
    '<div class="ct-form"><form id="ct-user-form" class="ct-add-user-row">'+
    '<input name="userName" type="text" placeholder="Name" required/>'+
    '<input name="userColor" type="color" value="#6366f1" title="Pick a color"/>'+
    '<button type="submit" class="btn btn-primary">Add</button></form>'+
    '<ul class="ct-user-list">'+rows+'</ul></div>';
  showModal(html);
}

function setUserColor(userId, color) {
  var u = state.users.find(function(x){return x.id===userId;});
  if(u){ u.color = color; saveData(); render(); openUserModal(); }
}

function moveUser(userId, dir) {
  var i = state.users.findIndex(function(x){return x.id===userId;});
  if(i < 0) return;
  var j = dir === "up" ? i - 1 : i + 1;
  if(j < 0 || j >= state.users.length) return;
  var tmp = state.users[i];
  state.users[i] = state.users[j];
  state.users[j] = tmp;
  saveData();
  render();
  openUserModal();
}

// ---------------------------------------------------------------------------
// HELP MODAL
// ---------------------------------------------------------------------------
function openHelpModal() {
  var html = '<div class="ct-modal-head"><h2>Help &amp; Guide</h2>'+
    '<button class="ct-icon-btn" data-action="close-modal" aria-label="Close">&times;</button></div>'+
    '<div class="ct-form ct-help-content">'+

    '<h3>Getting Started</h3>'+
    '<ol>'+
    '<li><strong>Add People</strong> &mdash; Click "People" in the top bar to add everyone who uses or shares credit cards.</li>'+
    '<li><strong>Add a Card</strong> &mdash; Click "+ Add card" to register a credit card with its owner, due day, and limit.</li>'+
    '<li><strong>Add Transactions</strong> &mdash; Open a card and add charges. Split them among people and optionally set up installment plans.</li>'+
    '</ol>'+

    '<h3>Top Bar (on every view)</h3>'+
    '<ul>'+
    '<li><strong>Brand / logo</strong> &mdash; Click it any time to return to the dashboard.</li>'+
    '<li><strong>+ Add card</strong> &mdash; Register a new card.</li>'+
    '<li><strong>People</strong> &mdash; Open the per-person summary view (see below).</li>'+
    '<li><strong>Installments</strong> &mdash; Open the installment schedules view.</li>'+
    '<li><strong>&#9788; Theme</strong> &mdash; Toggle light / dark mode.</li>'+
    '<li><strong>?</strong> &mdash; This help guide.</li>'+
    '</ul>'+

    '<h3>Key Concepts</h3>'+
    '<dl>'+
    '<dt>Owner</dt><dd>The person whose name is on the credit card. They are responsible for paying the bank.</dd>'+
    '<dt>Split</dt><dd>Each transaction can be divided among multiple people. Use "Equal split" to divide evenly, or "Custom amounts" to set each person\'s share.</dd>'+
    '<dt>Settlement</dt><dd>When someone other than the owner uses the card, they owe the owner. The owed/owns totals show who owes whom.</dd>'+
    '<dt>Billing Cycle</dt><dd>Each card has a due day (e.g. 23rd). Transactions are grouped by which billing period they fall into.</dd>'+
    '<dt>Installment</dt><dd>A purchase paid over multiple months. Set the total months and start date, and the app tracks each person\'s monthly payments with forecasted due dates.</dd>'+
    '<dt>Category</dt><dd>Optional label for transactions (Food, Bills, Travel, etc.) to see spending breakdowns.</dd>'+
    '</dl>'+

    '<h3>Dashboard</h3>'+
    '<ul>'+
    '<li><strong>Grid / Table toggle</strong> &mdash; Switch between card tiles and a sortable table with a totals row.</li>'+
    '<li><strong>Sort</strong> &mdash; Order cards by due date, balance, or name.</li>'+
    '<li><strong>Card tiles</strong> &mdash; Each card shows its balance, a stat strip (outstanding, monthly due, days until due), the split breakdown, and what is owed to the owner.</li>'+
    '<li><strong>Open a card</strong> &mdash; Click a tile (or table row) to see its full detail.</li>'+
    '</ul>'+

    '<h3>People View</h3>'+
    '<ul>'+
    '<li>Search or pick a person to see everything they owe, broken down per card.</li>'+
    '<li><strong>Scope toggle</strong> &mdash; Switch between the current billing cycle and all cycles.</li>'+
    '<li>Shows totals for what the person owes and what is owed to them.</li>'+
    '<li>Click any card row to jump into that card, already filtered to that person.</li>'+
    '<li><strong>Manage people</strong> &mdash; Add, rename, recolor, or remove people.</li>'+
    '</ul>'+

    '<h3>Card Detail</h3>'+
    '<ul>'+
    '<li><strong>Cycle navigator</strong> &mdash; Use Prev/Next or the dropdown to view transactions for any billing cycle. Defaults to the active cycle.</li>'+
    '<li><strong>Filter by person</strong> &mdash; Click a person\'s name or split chip to scope the whole card (stats, breakdowns, cycle totals) to just their share. Use "Show all" to clear the filter.</li>'+
    '<li><strong>Breakdowns</strong> &mdash; Per-card spending by category and by person.</li>'+
    '</ul>'+

    '<h3>Installments View</h3>'+
    '<ul>'+
    '<li><strong>Active plans</strong> &mdash; Visual schedule of each plan with paid / due / upcoming months and per-person payment tracking.</li>'+
    '<li><strong>Completed</strong> &mdash; Plans where every month has been paid are collected in a separate section.</li>'+
    '</ul>'+

    '<h3>Data</h3>'+
    '<ul>'+
    '<li>All data is stored locally in your browser (localStorage). Nothing is sent to a server.</li>'+
    '<li>Use <strong>Export</strong> (footer) to download a JSON backup.</li>'+
    '<li>Use <strong>Import</strong> (footer) to restore from a backup file.</li>'+
    '<li>Clearing browser data will erase everything &mdash; export regularly!</li>'+
    '</ul>'+

    '<h3>Keyboard Shortcuts</h3>'+
    '<ul>'+
    '<li><kbd>Esc</kbd> &mdash; Close any open modal or dialog.</li>'+
    '<li><kbd>Enter</kbd> / <kbd>Space</kbd> &mdash; Open a focused card or activate a focused row.</li>'+
    '<li><kbd>Tab</kbd> &mdash; Navigate between interactive elements.</li>'+
    '</ul>'+

    '</div>';
  showModal(html);
}

// ===========================================================================
// EVENT BINDING (delegated)
// ===========================================================================
function bindEvents() {
  root.removeEventListener("click",handleClick);
  root.addEventListener("click",handleClick);
  root.removeEventListener("change",handleChange);
  root.addEventListener("change",handleChange);
  root.removeEventListener("keydown",handleKeydown);
  root.addEventListener("keydown",handleKeydown);
  root.removeEventListener("input",handleInput);
  root.addEventListener("input",handleInput);
}

// Live-filter the people chips as you type (no re-render, keeps input focus).
function handleInput(e) {
  if(e.target && e.target.hasAttribute && e.target.hasAttribute("data-people-search")) {
    var q = e.target.value.toLowerCase().trim();
    var chips = root.querySelectorAll(".ct-pchip");
    for(var i = 0; i < chips.length; i++) {
      var name = chips[i].getAttribute("data-name") || "";
      chips[i].style.display = (!q || name.indexOf(q) !== -1) ? "" : "none";
    }
  }
}

function handleKeydown(e) {
  if(e.key !== "Enter" && e.key !== " ") return;
  var t = e.target;
  if(!t || !t.matches) return;
  // Activate custom keyboard-focusable controls (cards, table rows, cycle headers)
  if(t.matches(".ct-cc") || t.matches("tr[data-action]") || t.matches("[data-action][tabindex]")) {
    e.preventDefault();
    t.click(); // reuse the delegated click handling
  }
}

function handleChange(e) {
  var el = e.target;
  if(el.getAttribute("data-action")==="sort"){
    state.sort = el.value; render();
  }
  if(el.getAttribute("data-action")==="cycle-select"){
    state._cycleIdx = parseInt(el.value, 10) || 0;
    render();
  }
  // Toggle installment fields
  if(el.name==="isInstallment") {
    var fields = document.querySelector(".ct-inst-fields");
    if(fields) fields.hidden = !el.checked;
  }
}

function handleClick(e) {
  var btn = e.target.closest("[data-action]");
  if(!btn) {
    // Clicking on a card article
    var cc = e.target.closest(".ct-cc");
    if(cc) {
      state.view="detail";state.currentCardId=cc.getAttribute("data-card-id");render();
      return;
    }
    // Filter chips
    var chip = e.target.closest("[data-filter]");
    if(chip){state.activeFilter=chip.getAttribute("data-filter");render();return;}
    return;
  }
  var action = btn.getAttribute("data-action");
  var id = btn.getAttribute("data-id");

  switch(action) {
    case "retry": loadData(); break;
    case "add-card": openCardModal(null); break;
    case "edit-card":
      var card=state.cards.find(function(c){return c.id===id;});
      if(card) openCardModal(card);
      break;
    case "delete-card":
      if(confirm("Delete this card and all its transactions?")){
        state.cards=state.cards.filter(function(c){return c.id!==id;});
        state.transactions=state.transactions.filter(function(t){return t.cardId!==id;});
        saveData(); state.view="dashboard"; render();
      } break;
       case "open-detail": case "view-detail":
      state.view="detail";state.currentCardId=btn.getAttribute("data-id")||btn.closest("[data-card-id]").getAttribute("data-card-id");state._cycleIdx=null;state.detailPersonFilter=null;state.detailFromPerson=false;render();break;
    case "open-card-for-person":
      state.view="detail";state.currentCardId=btn.getAttribute("data-id");state.detailPersonFilter=btn.getAttribute("data-person");state.detailFromPerson=true;state._cycleIdx=null;render();break;
    case "filter-person":
      state.detailPersonFilter=btn.getAttribute("data-person");state.detailFromPerson=false;render();break;
    case "clear-person-filter":
      state.detailPersonFilter=null;state.detailFromPerson=false;render();break;
    case "view-people": openPeopleView();break;
    case "select-person": state.currentPersonId=btn.getAttribute("data-id");render();break;
    case "toggle-cycle":
      var body = btn.closest(".ct-cycle-group").querySelector(".ct-cycle-body");
      if(body) {
        var isHidden = body.hidden;
        body.hidden = !isHidden;
        btn.setAttribute("aria-expanded", isHidden);
        var chevron = btn.querySelector(".ct-cycle-chevron");
        if(chevron) chevron.innerHTML = isHidden ? "&#9660;" : "&#9654;";
      }
      break;
    case "cycle-prev":
      state._cycleIdx = Math.max(0, (parseInt(btn.getAttribute("data-idx"),10)||0) - 1);
      render(); break;
    case "cycle-next":
      state._cycleIdx = (parseInt(btn.getAttribute("data-idx"),10)||0) + 1;
      render(); break;
    case "cycle-today":
      state._cycleIdx = null;
      render(); break;
    case "back": state.view="dashboard";state.currentCardId=null;render();break;
    case "go-home":
      state.view="dashboard";
      state.currentCardId=null;
      state.currentPersonId=null;
      state.detailPersonFilter=null;
      state.detailFromPerson=false;
      render();break;
    case "back-to-person":
      state.view="person";state.currentPersonId=state.detailPersonFilter;state.detailPersonFilter=null;render();break;
    case "view-installments": state.view="installments";render();break;
    case "manage-users": openUserModal();break;
    case "show-help": openHelpModal();break;
    case "toggle-theme": toggleTheme();break;
    case "set-card-view": state.cardView = btn.getAttribute("data-view")||"grid"; render(); break;
    case "person-scope": state.personScope = btn.getAttribute("data-scope")||"cycle"; render(); break;
    case "add-tx": openTxModal(null,btn.getAttribute("data-card")||state.currentCardId);break;
    case "edit-tx":
      var tx=state.transactions.find(function(t){return t.id===id;});
      if(tx) openTxModal(tx,tx.cardId);
      break;
    case "del-tx":
      if(confirm("Delete this transaction?")){
        state.transactions=state.transactions.filter(function(t){return t.id!==id;});
        saveData();render();
      } break;
    case "pay-month":
      var tx2=state.transactions.find(function(t){return t.id===id;});
      if(tx2&&tx2.installment){
        // Advance all people by 1 month
        tx2.splits.forEach(function(sp){
          if(!tx2.installment.splitPayments) tx2.installment.splitPayments={};
          tx2.installment.splitPayments[sp.userId] = Math.min(tx2.installment.months, (tx2.installment.splitPayments[sp.userId]||0)+1);
        });
        // monthsPaid = minimum across all people
        var minPaid = tx2.installment.months;
        tx2.splits.forEach(function(sp){
          var p = tx2.installment.splitPayments[sp.userId]||0;
          if(p < minPaid) minPaid = p;
        });
        tx2.installment.monthsPaid = minPaid;
        saveData();render();
      } break;
    case "pay-person-month":
      var tx4=state.transactions.find(function(t){return t.id===id;});
      var payUserId = btn.getAttribute("data-user");
      if(tx4&&tx4.installment&&payUserId){
        if(!tx4.installment.splitPayments) tx4.installment.splitPayments={};
        tx4.installment.splitPayments[payUserId] = Math.min(tx4.installment.months, (tx4.installment.splitPayments[payUserId]||0)+1);
        // Update overall monthsPaid to minimum
        var minP = tx4.installment.months;
        tx4.splits.forEach(function(sp){
          var p = tx4.installment.splitPayments[sp.userId]||0;
          if(p < minP) minP = p;
        });
        tx4.installment.monthsPaid = minP;
        saveData();render();
      } break;
    case "unpay-person-month":
      var tx5=state.transactions.find(function(t){return t.id===id;});
      var unpayUserId = btn.getAttribute("data-user");
      if(tx5&&tx5.installment&&unpayUserId){
        if(!tx5.installment.splitPayments) tx5.installment.splitPayments={};
        tx5.installment.splitPayments[unpayUserId] = Math.max(0, (tx5.installment.splitPayments[unpayUserId]||0)-1);
        var minP2 = tx5.installment.months;
        tx5.splits.forEach(function(sp){
          var p = tx5.installment.splitPayments[sp.userId]||0;
          if(p < minP2) minP2 = p;
        });
        tx5.installment.monthsPaid = minP2;
        saveData();render();
      } break;
    case "set-person-month":
      var tx6=state.transactions.find(function(t){return t.id===id;});
      var setUserId = btn.getAttribute("data-user");
      var maxMonths = parseInt(btn.getAttribute("data-max"),10)||1;
      if(tx6&&tx6.installment&&setUserId){
        var currentVal = tx6.installment.splitPayments[setUserId]||0;
        var newVal = prompt("Set months paid for "+userName(setUserId)+" (0–"+maxMonths+"):", currentVal);
        if(newVal !== null) {
          newVal = Math.max(0, Math.min(maxMonths, parseInt(newVal,10)||0));
          if(!tx6.installment.splitPayments) tx6.installment.splitPayments={};
          tx6.installment.splitPayments[setUserId] = newVal;
          var minP3 = tx6.installment.months;
          tx6.splits.forEach(function(sp){
            var p = tx6.installment.splitPayments[sp.userId]||0;
            if(p < minP3) minP3 = p;
          });
          tx6.installment.monthsPaid = minP3;
          saveData();render();
        }
      } break;
    case "toggle-settled":
      var tx3=state.transactions.find(function(t){return t.id===id;});
      if(tx3){
        var allPaid=tx3.splits.every(function(s){return s.paid;});
        tx3.splits.forEach(function(s){s.paid=!allPaid;});
        saveData();render();
      } break;
    case "close-modal": closeModal();break;
    case "load-samples": seed();render();break;
    case "export": exportData();break;
    case "import":
      var fi=document.getElementById("ct-import-file");
      if(fi) fi.click();
      break;
    case "del-user": removeUser(id);break;
    case "add-split-row": addSplitRowToForm();break;
    case "remove-split": removeSplitRowFromForm(btn.getAttribute("data-idx"));break;
    case "delete-tx":
      if(confirm("Delete this transaction?")){
        state.transactions=state.transactions.filter(function(t){return t.id!==id;});
        saveData();closeModal();render();
      } break;
  }
}

// ===========================================================================
// FORM HANDLERS (bound on modal show via event delegation on document)
// ===========================================================================
document.addEventListener("submit",function(e){
  var form = e.target;
  if(form.id==="ct-card-form"){e.preventDefault();submitCardForm(form);}
  else if(form.id==="ct-tx-form"){e.preventDefault();submitTxForm(form);}
  else if(form.id==="ct-user-form"){e.preventDefault();submitUserForm(form);}
});

document.addEventListener("change",function(e){
  if(e.target.name==="isInstallment"){
    var fields=document.querySelector(".ct-inst-fields");
    if(fields) fields.hidden=!e.target.checked;
  }
  if(e.target.getAttribute && e.target.getAttribute("data-action")==="set-user-color"){
    setUserColor(e.target.getAttribute("data-id"), e.target.value);
  }
});

document.addEventListener("click",function(e){
  var btn=e.target.closest("[data-action]");
  if(!btn) return;
  var action=btn.getAttribute("data-action");
  if(action==="close-modal") closeModal();
  else if(action==="add-split-row") addSplitRowToForm();
  else if(action==="remove-split") removeSplitRowFromForm(btn.getAttribute("data-idx"));
  else if(action==="del-user") { removeUser(btn.getAttribute("data-id")); }
  else if(action==="move-user-up") { moveUser(btn.getAttribute("data-id"), "up"); }
  else if(action==="move-user-down") { moveUser(btn.getAttribute("data-id"), "down"); }
  else if(action==="delete-tx") {
    if(confirm("Delete this transaction?")){
      state.transactions=state.transactions.filter(function(t){return t.id!==btn.getAttribute("data-id");});
      saveData();closeModal();render();
    }
  }
});

// Import file change
document.addEventListener("change",function(e){
  if(e.target.id==="ct-import-file" && e.target.files[0]){
    importData(e.target.files[0]);
    e.target.value="";
  }
});

function addSplitRowToForm() {
  var container = document.getElementById("ct-split-rows");
  if(!container) return;
  var idx = container.children.length;
  var div = document.createElement("div");
  div.className="ct-split-row";
  div.setAttribute("data-idx",idx);
  div.innerHTML = splitRow({userId:state.users[0]?state.users[0].id:"",amountCents:0,paid:false},idx).replace(/^<div[^>]*>/,"").replace(/<\/div>$/,"");
  // Fix: splitRow returns wrapper div, just get innerHTML
  var temp = document.createElement("div");
  temp.innerHTML = splitRow({userId:state.users[0]?state.users[0].id:"",amountCents:0,paid:false},idx);
  container.appendChild(temp.firstChild);
}

function removeSplitRowFromForm(idx) {
  var container = document.getElementById("ct-split-rows");
  if(!container) return;
  // Don't remove if it's the last row
  if(container.children.length <= 1) return;
  var row = container.querySelector('[data-idx="'+idx+'"]');
  if(row) row.remove();
}

function submitCardForm(form) {
  var fd = new FormData(form);
  var dueDay = Math.max(1,Math.min(31,parseInt(fd.get("dueDay"),10)||1));
  var data = {
    ownerId: fd.get("ownerId"),
    name: (fd.get("name")||"").trim(),
    network: (fd.get("network")||"").trim(),
    last4: (fd.get("last4")||"").replace(/\D/g,"").slice(0,4),
    color: fd.get("color")||"#6366f1",
    limitCents: toCents(fd.get("limitCents")||0),
    statementDay: parseInt(fd.get("statementDay"),10)||null,
    dueDay: dueDay,
    note: (fd.get("note")||"").trim()
  };
  if(!data.name){form.querySelector('[name="name"]').focus();return;}

  var id = fd.get("cardId");
  if(id) {
    var card=state.cards.find(function(c){return c.id===id;});
    if(card) Object.assign(card,data);
  } else {
    data.id = uid();
    state.cards.push(data);
    state.currentCardId = data.id;
    state.view = "detail";
  }
  saveData(); closeModal(); render();
}

function submitTxForm(form) {
  var fd = new FormData(form);
  var amount = Number(fd.get("amount"))||0;
  if(amount<=0){form.querySelector('[name="amount"]').focus();return;}
  var amountCents = toCents(amount);
  var cardId = fd.get("cardId");
  var description = (fd.get("description")||"").trim();
  var category = (fd.get("category")||"").trim();
  var date = fd.get("date")||"";

  // Gather splits
  var splitRows = document.querySelectorAll("#ct-split-rows .ct-split-row");
  var splitMode = (form.querySelector('[name="splitMode"]:checked')||{}).value||"equal";
  var splits = [];
  splitRows.forEach(function(row){
    var idx = row.getAttribute("data-idx");
    var userId = form.querySelector('[name="split_user_'+idx+'"]');
    var amt = form.querySelector('[name="split_amt_'+idx+'"]');
    var paid = form.querySelector('[name="split_paid_'+idx+'"]');
    if(userId) splits.push({userId:userId.value, rawAmt:Number(amt?amt.value:0)||0, paid:!!(paid&&paid.checked)});
  });

  if(splits.length===0){alert("Add at least one person to the split.");return;}

  // Check for duplicate users
  var seenUsers = {};
  var hasDupes = false;
  splits.forEach(function(s){
    if(seenUsers[s.userId]) hasDupes = true;
    seenUsers[s.userId] = true;
  });
  if(hasDupes){alert("Each person can only appear once in the split. Remove duplicates.");return;}

  // Compute split amounts
  var finalSplits;
  if(splitMode==="equal") {
    var dist = distributeCents(amountCents, splits.length);
    finalSplits = splits.map(function(s,i){return {userId:s.userId,amountCents:dist[i],paid:s.paid};});
  } else {
    // Custom amounts — must add up to the transaction total (allow a few cents
    // of rounding slack, which distributeCustom then reconciles exactly).
    var customs = splits.map(function(s){return toCents(s.rawAmt);});
    var customSum = customs.reduce(function(a,b){return a+b;},0);
    var diff = customSum - amountCents;
    if(Math.abs(diff) > splits.length) {
      alert(
        "Custom amounts must add up to the total of " + fmtMoney(amountCents) + ".\n" +
        "Right now they sum to " + fmtMoney(customSum) +
        " (" + (diff > 0 ? "over" : "short") + " by " + fmtMoney(Math.abs(diff)) + ")."
      );
      return;
    }
    var distC = distributeCustom(amountCents, customs);
    finalSplits = splits.map(function(s,i){return {userId:s.userId,amountCents:distC[i],paid:s.paid};});
  }

  // Installment
  var txId = fd.get("txId");
  var existingTx = txId ? state.transactions.find(function(t){return t.id===txId;}) : null;
  var installment = null;
  var isInst = form.querySelector('[name="isInstallment"]');
  if(isInst && isInst.checked) {
    var months = Math.max(2,Math.min(60,parseInt(fd.get("instMonths"),10)||2));
    var paid = Math.max(0,Math.min(months,parseInt(fd.get("instPaid"),10)||0));
    var instStart = fd.get("instStart") || date || "";
    var prevInst = existingTx && existingTx.installment ? existingTx.installment : null;

    // Build per-person payment tracking. If editing and the overall "months paid"
    // field was left unchanged, preserve each person's individual progress;
    // otherwise apply the entered value uniformly.
    var keepPerPerson = prevInst && prevInst.splitPayments && paid === (prevInst.monthsPaid || 0);
    var splitPayments = {};
    finalSplits.forEach(function(s){
      var v = keepPerPerson && prevInst.splitPayments[s.userId] != null
        ? prevInst.splitPayments[s.userId]
        : paid;
      splitPayments[s.userId] = Math.max(0, Math.min(months, v));
    });
    // monthsPaid = the number of months everyone has paid (minimum)
    var minPaid = months;
    finalSplits.forEach(function(s){ if(splitPayments[s.userId] < minPaid) minPaid = splitPayments[s.userId]; });
    installment = {
      months: months,
      monthsPaid: finalSplits.length ? minPaid : paid,
      startDate: instStart,
      splitPayments: splitPayments
    };
  }

  if(txId) {
    if(existingTx) {
      existingTx.cardId=cardId; existingTx.description=description; existingTx.category=category; existingTx.amountCents=amountCents;
      existingTx.date=date; existingTx.splits=finalSplits; existingTx.installment=installment;
    }
  } else {
    state.transactions.push({
      id:uid(), cardId:cardId, description:description, category:category, amountCents:amountCents,
      date:date, splits:finalSplits, installment:installment, createdAt:date||new Date().toISOString().slice(0,10)
    });
  }
  saveData(); closeModal(); render();
}

function submitUserForm(form) {
  var fd = new FormData(form);
  var name = (fd.get("userName")||"").trim();
  if(!name) return;
  state.users.push({id:uid(), name:name, color:fd.get("userColor")||"#6366f1"});
  saveData(); closeModal(); openUserModal();
}

function removeUser(userId) {
  var owned = state.cards.filter(function(c){return c.ownerId===userId;}).length;
  var msg = owned
    ? "Remove this person and their "+owned+" card(s)? Related transactions are also removed."
    : "Remove this person? Their split entries will be removed from transactions.";
  if(!confirm(msg)) return;
  state.users = state.users.filter(function(u){return u.id!==userId;});
  state.cards = state.cards.filter(function(c){return c.ownerId!==userId;});
  state.transactions = state.transactions.filter(function(t){
    var card=state.cards.find(function(c){return c.id===t.cardId;});
    return !!card;
  });
  state.transactions.forEach(function(t){
    t.splits = t.splits.filter(function(s){return s.userId!==userId;});
  });
  // Remove transactions with no splits
  state.transactions = state.transactions.filter(function(t){return t.splits.length>0;});
  if(state.activeFilter===userId) state.activeFilter="all";
  saveData(); closeModal(); render();
}

// ===========================================================================
// IMPORT / EXPORT
// ===========================================================================
function exportData() {
  var payload = {users:state.users,cards:state.cards,transactions:state.transactions};
  var blob = new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "credit-tracker-"+new Date().toISOString().slice(0,10)+".json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(file) {
  var reader = new FileReader();
  reader.onload = function(){
    try {
      var parsed = JSON.parse(reader.result);
      if(!parsed.users&&!parsed.cards) throw new Error("Invalid format");
      state.users = parsed.users||[];
      state.cards = parsed.cards||[];
      state.transactions = parsed.transactions||[];
      migrate(state);
      saveData(); render();
      alert("Data imported successfully.");
    } catch(e) { alert("Import failed: "+e.message); }
  };
  reader.readAsText(file);
}

// ===========================================================================
// BOOT
// ===========================================================================
loadData();

})();