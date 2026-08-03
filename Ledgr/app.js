// ═══════════════════════════════════════════════════════════════
//  Ledgr — envelope budgeting on Firebase
//
//  Balance model (important): scheduled contributions are never
//  written to the database. A balance is derived on every render as
//
//      opening + (amount × occurrences to date) + deposits − expenses
//
//  That makes the app idempotent. Open it on three devices, or not
//  for six months, and the numbers are identical — there is no cron
//  job to run and no way to double-post. The trade-off is that
//  editing a schedule's amount restates history, so change amounts
//  by ending one schedule and starting another when the past matters.
// ═══════════════════════════════════════════════════════════════

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, GoogleAuthProvider,
  signInWithPopup, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, getDocs, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Namespace import on purpose: the Firebase console hands you
// `const firebaseConfig = {…}`, so accept that spelling as well as ours
// (and a default export) rather than making a rename mandatory.
import * as configModule from "./config.js";

const FIREBASE_CONFIG =
  configModule.FIREBASE_CONFIG ||
  configModule.firebaseConfig ||
  configModule.default ||
  null;

// ─── DOM shorthand ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const money = (n) => (n < 0 ? "−" : "") + new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD"
}).format(Math.abs(n || 0));

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

// ═══ Date helpers ══════════════════════════════════════════════
// Dates are stored as plain 'YYYY-MM-DD' strings and parsed in local
// time. No timezone drift, no Timestamp conversions on read.

const todayISO = () => new Date().toLocaleDateString("en-CA");

function parseISO(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function toISO(dt) {
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
function addDays(dt, n) {
  const d = new Date(dt); d.setDate(d.getDate() + n); return d;
}
function addMonths(base, n) {
  const y = base.getFullYear(), m = base.getMonth() + n, day = base.getDate();
  const lastOfMonth = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, lastOfMonth));
}
function prettyDate(iso) {
  return parseISO(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function shortDate(iso) {
  return parseISO(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function ledgerDate(iso) {
  const thisYear = iso.slice(0, 4) === todayISO().slice(0, 4);
  return shortDate(iso) + (thisYear ? "" : ` '${iso.slice(2, 4)}`);
}

const INTERVALS = {
  week:   { label: "every week",      short: "wk"  },
  biweek: { label: "every two weeks", short: "2wk" },
  month:  { label: "every month",     short: "mo"  }
};

/** Every scheduled contribution date from start through `asOf`. */
function occurrences(sch, asOfISO) {
  if (!sch?.enabled || !(sch.amount > 0) || !sch.startDate) return [];
  const asOf = parseISO(asOfISO);
  const start = parseISO(sch.startDate);
  const end = sch.endDate ? parseISO(sch.endDate) : null;
  const ceiling = end && end < asOf ? end : asOf;
  if (start > ceiling) return [];

  const out = [];
  const step = sch.interval === "week" ? 7 : 14;
  for (let i = 0; i < 4000; i++) {
    const d = sch.interval === "month" ? addMonths(start, i) : addDays(start, i * step);
    if (d > ceiling) break;
    out.push(d);
  }
  return out;
}

/** The next contribution strictly after today, or null if the schedule is done. */
function nextOccurrence(sch) {
  if (!sch?.enabled || !(sch.amount > 0) || !sch.startDate) return null;
  const today = parseISO(todayISO());
  const start = parseISO(sch.startDate);
  const end = sch.endDate ? parseISO(sch.endDate) : null;
  const step = sch.interval === "week" ? 7 : 14;
  for (let i = 0; i < 4000; i++) {
    const d = sch.interval === "month" ? addMonths(start, i) : addDays(start, i * step);
    if (d > today) return (end && d > end) ? null : d;
  }
  return null;
}

/** Normalised monthly funding rate, for the summary strip. */
function monthlyRate(sch) {
  if (!sch?.enabled || !(sch.amount > 0)) return 0;
  if (sch.endDate && parseISO(sch.endDate) < parseISO(todayISO())) return 0;
  if (sch.interval === "week") return sch.amount * 52 / 12;
  if (sch.interval === "biweek") return sch.amount * 26 / 12;
  return sch.amount;
}

// ═══ App state ═════════════════════════════════════════════════
const state = {
  uid: null,
  tab: "allowance",
  envelopes: [],
  txns: [],
  settings: { savingsActual: null },
  unsub: []
};

let db, auth;

/** Derive everything the UI needs about one envelope.
 *
 *  Two funding modes:
 *    add    — each occurrence contributes `amount`; the balance is cumulative
 *             and surplus rolls over forever.
 *    refill — each occurrence resets the envelope to `amount`; the balance is
 *             `amount` plus whatever you've moved since the latest refill, so
 *             unspent money is dropped rather than carried.
 *
 *  Both stay purely derived — a refill is a computed reset, not a stored
 *  transaction, so nothing needs to run on a schedule for it to happen.
 */
function derive(env) {
  const asOf = todayISO();
  const sch = env.schedule || {};
  const mode = sch.mode === "refill" ? "refill" : "add";
  const dates = occurrences(sch, asOf);

  // In refill mode everything from the latest refill onward is what counts.
  // A transaction dated on the refill day is spent from the fresh balance.
  const lastRefill = (mode === "refill" && dates.length)
    ? toISO(dates[dates.length - 1]) : null;

  let deposits = 0, expenses = 0;          // all time, for history
  let periodDeposits = 0, periodExpenses = 0; // since the latest refill
  for (const t of state.txns) {
    if (t.envelopeId !== env.id || t.date > asOf) continue;
    const inPeriod = !lastRefill || t.date >= lastRefill;
    if (t.kind === "deposit") {
      deposits += t.amount;
      if (inPeriod) periodDeposits += t.amount;
    } else {
      expenses += t.amount;
      if (inPeriod) periodExpenses += t.amount;
    }
  }

  let balance, accrued = 0;
  if (mode === "refill") {
    balance = lastRefill
      ? (sch.amount || 0) + periodDeposits - periodExpenses
      : (env.opening || 0) + deposits - expenses;  // before the first refill
  } else {
    accrued = dates.length * (sch.amount || 0);
    balance = (env.opening || 0) + accrued + deposits - expenses;
  }

  const target = (mode === "refill" && sch.enabled)
    ? (sch.amount || 0)
    : (env.target > 0 ? env.target : (sch.enabled ? (sch.amount || 0) : 0));
  const pct = target > 0 ? Math.max(0, Math.min(1, balance / target)) : (balance > 0 ? 1 : 0);

  return {
    mode, lastRefill, balance, target, pct, accrued,
    deposits, expenses, periodDeposits, periodExpenses,
    count: dates.length, dates
  };
}

/** Start date of the fixed expense's current billing period (its most recent
 *  scheduled occurrence on or before today), or null if its first occurrence
 *  hasn't landed yet. */
function currentPeriodStart(sch) {
  const dates = occurrences(sch, todayISO());
  return dates.length ? toISO(dates[dates.length - 1]) : null;
}

/** Whether a fixed-expense envelope has an expense logged in its current period. */
function isPaidThisPeriod(env) {
  const periodStart = currentPeriodStart(env.schedule);
  if (!periodStart) return false;
  const asOf = todayISO();
  return state.txns.some((t) =>
    t.envelopeId === env.id && t.kind === "expense" && t.date >= periodStart && t.date <= asOf);
}

// ═══ Rendering ═════════════════════════════════════════════════

const SECTION_TITLES = { allowance: "Allowances", sinking: "Sinking Funds", fixed: "Fixed Expenses" };

function render() {
  const kind = state.tab;
  const list = state.envelopes
    .filter((e) => e.kind === kind)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  $("section-title").textContent = SECTION_TITLES[kind] || "";
  renderOverview();
  renderStrip(kind, list);
  renderGrid(list, kind);
}

/** Spent vs. planned this month, across every envelope on every tab. */
function renderOverview() {
  const asOf = todayISO();
  const monthStart = asOf.slice(0, 8) + "01";

  const planned = state.envelopes.reduce((s, e) => s + monthlyRate(e.schedule), 0);
  const spent = state.txns
    .filter((t) => t.kind === "expense" && t.date >= monthStart && t.date <= asOf)
    .reduce((s, t) => s + t.amount, 0);
  const pct = planned > 0 ? Math.max(0, Math.min(1, spent / planned)) : 0;

  $("overview").innerHTML = `
    <div class="overview__label">Spent this month</div>
    <div class="overview__figure">
      <span class="overview__spent mono">${esc(money(spent))}</span>
      <span class="overview__of">of</span>
      <span class="overview__planned mono">${esc(money(planned))}</span>
      <span class="overview__of">planned</span>
    </div>
    <div class="overview__bar"><div class="overview__bar-fill" style="width:${(pct * 100).toFixed(1)}%"></div></div>`;
}

function renderStrip(kind, list) {
  // A snapshot can land mid-keystroke; don't yank the field out from under them.
  const active = document.activeElement;
  const keepActual = active?.id === "actual-input"
    ? { value: active.value, caret: active.selectionStart } : null;

  const totals = list.map(derive);
  const allocated = totals.reduce((s, d) => s + d.balance, 0);
  const rate = list.reduce((s, e) => s + monthlyRate(e.schedule), 0);

  if (kind === "sinking") {
    const actual = state.settings.savingsActual;
    const unassigned = actual == null ? null : actual - allocated;
    const cls = unassigned == null ? "" : (Math.abs(unassigned) < 0.005 ? "is-even" : (unassigned < 0 ? "is-off" : ""));

    $("strip").innerHTML = `
      <div class="strip__lede">
        <div class="strip__eyebrow">🏦 Allocated across sinking funds</div>
        <div class="strip__total">${esc(money(allocated))}</div>
      </div>
      <div class="strip__stat">
        <div class="strip__stat-label">Savings account says</div>
        <input id="actual-input" class="strip__actual" inputmode="decimal"
               placeholder="—" value="${actual == null ? "" : actual.toFixed(2)}">
      </div>
      <div class="strip__stat">
        <div class="strip__stat-label">Unassigned</div>
        <div class="strip__stat-value ${cls}">${unassigned == null ? "—" : esc(money(unassigned))}</div>
      </div>
      <div class="strip__stat">
        <div class="strip__stat-label">Funding / month</div>
        <div class="strip__stat-value">${esc(money(rate))}</div>
      </div>
      <p class="strip__note">
        ${actual == null
          ? "Type your real savings balance above to reconcile it against the envelopes. 🔍"
          : (Math.abs(unassigned) < 0.005
              ? "Reconciled — every dollar in the account has a job. ✅"
              : (unassigned < 0
                  ? "The envelopes claim more than the account holds. Trim a fund or top up the account. ⚠️"
                  : "Money in the account that no envelope has claimed yet. 💤"))}
      </p>`;

    const inp = $("actual-input");
    if (keepActual) {
      inp.value = keepActual.value;
      inp.focus();
      try { inp.setSelectionRange(keepActual.caret, keepActual.caret); } catch { /* noop */ }
    }
    inp.addEventListener("change", async () => {
      const raw = inp.value.trim();
      const val = raw === "" ? null : Math.round(parseFloat(raw.replace(/[$,]/g, "")) * 100) / 100;
      if (raw !== "" && !Number.isFinite(val)) { toast("That isn't a number 🤔"); return; }
      await setDoc(doc(db, "users", state.uid, "meta", "settings"),
        { savingsActual: val, updatedAt: serverTimestamp() }, { merge: true });
      toast("Savings balance saved 💾");
    });
  } else if (kind === "allowance") {
    const asOf = todayISO();
    const monthStart = asOf.slice(0, 8) + "01";
    const ids = new Set(list.map((e) => e.id));
    const spent = state.txns
      .filter((t) => ids.has(t.envelopeId) && t.kind === "expense" && t.date >= monthStart && t.date <= asOf)
      .reduce((s, t) => s + t.amount, 0);

    $("strip").innerHTML = `
      <div class="strip__lede">
        <div class="strip__eyebrow">💸 Available across allowances</div>
        <div class="strip__total">${esc(money(allocated))}</div>
      </div>
      <div class="strip__stat">
        <div class="strip__stat-label">Funding / month</div>
        <div class="strip__stat-value">${esc(money(rate))}</div>
      </div>
      <div class="strip__stat">
        <div class="strip__stat-label">Spent this month</div>
        <div class="strip__stat-value">${esc(money(spent))}</div>
      </div>
      <div class="strip__stat">
        <div class="strip__stat-label">Envelopes</div>
        <div class="strip__stat-value">${list.length}</div>
      </div>`;
  } else {
    const asOf = todayISO();
    const monthStart = asOf.slice(0, 8) + "01";
    const ids = new Set(list.map((e) => e.id));
    const paid = state.txns
      .filter((t) => ids.has(t.envelopeId) && t.kind === "expense" && t.date >= monthStart && t.date <= asOf)
      .reduce((s, t) => s + t.amount, 0);
    const paidCount = list.filter(isPaidThisPeriod).length;

    $("strip").innerHTML = `
      <div class="strip__lede">
        <div class="strip__eyebrow">📌 Committed / month</div>
        <div class="strip__total">${esc(money(rate))}</div>
      </div>
      <div class="strip__stat">
        <div class="strip__stat-label">Paid this month</div>
        <div class="strip__stat-value">${esc(money(paid))}</div>
      </div>
      <div class="strip__stat">
        <div class="strip__stat-label">Bills paid</div>
        <div class="strip__stat-value">${paidCount} / ${list.length}</div>
      </div>`;
  }
}

const EMPTY_STATES = {
  allowance: `<span class="empty__emoji">💸</span>
    <div class="empty__title">No allowances yet</div>
    <div>Allowances refill on a schedule — groceries, coffee, hobby money.
    Make one and it starts filling on its own.</div>`,
  sinking: `<span class="empty__emoji">🏦</span>
    <div class="empty__title">No sinking funds yet</div>
    <div>Sinking funds save toward something specific — a new car, a trip,
    the next vet bill. Together they account for your savings balance.</div>`,
  fixed: `<span class="empty__emoji">📌</span>
    <div class="empty__title">No fixed expenses yet</div>
    <div>Rent, insurance, subscriptions — bills that cost the same every
    week, two weeks, or month. Add one, then mark it paid with a click.</div>`
};

function renderGrid(list, kind) {
  const grid = $("grid"), empty = $("empty");

  if (!list.length) {
    grid.innerHTML = "";
    empty.hidden = false;
    empty.innerHTML = EMPTY_STATES[kind] || "";
    return;
  }

  empty.hidden = true;

  if (kind === "fixed") {
    grid.innerHTML = list.map((env) => {
      const sch = env.schedule || {};
      const next = nextOccurrence(sch);
      const started = !!currentPeriodStart(sch);
      const paid = started && isPaidThisPeriod(env);

      const cls = ["env", "env--fixed"];
      if (paid) cls.push("env--paid");

      const scheduleLine = started
        ? `${esc(INTERVALS[sch.interval]?.label || "")}${next ? ` · next ${esc(shortDate(toISO(next)))}` : " · finished 🏁"}`
        : `${esc(INTERVALS[sch.interval]?.label || "")} · starts ${esc(shortDate(sch.startDate))}`;

      const statusLabel = !started ? "⏳ Not started yet" : (paid ? "✅ Paid this period" : "⏳ Not paid yet");

      const actionBtn = !started
        ? `<button class="btn" disabled title="This bill's schedule hasn't started yet">Mark paid</button>`
        : paid
          ? `<button class="btn" data-act="history" data-id="${env.id}">✅ Paid</button>`
          : `<button class="btn btn--primary" data-act="pay" data-id="${env.id}">Mark paid</button>`;

      return `
        <article class="${cls.join(" ")}">
          <div class="env__head">
            <span class="env__emoji">${esc(env.emoji || "📌")}</span>
            <h3 class="env__name" title="${esc(env.name)}">${esc(env.name)}</h3>
          </div>
          <div class="env__balance">${esc(money(sch.amount || 0))}</div>
          <div class="env__target">${scheduleLine}</div>
          <div class="env__sched ${paid ? "" : "env__sched--off"}">${statusLabel}</div>
          <div class="env__acts">
            ${actionBtn}
            <button class="btn" data-act="history" data-id="${env.id}" title="History">📜</button>
            <button class="btn" data-act="edit" data-id="${env.id}" title="Edit">✏️</button>
          </div>
        </article>`;
    }).join("");
    return;
  }

  grid.innerHTML = list.map((env) => {
    const d = derive(env);
    const next = nextOccurrence(env.schedule);
    const sch = env.schedule;

    const schChip = sch?.enabled && sch.amount > 0
      ? (d.mode === "refill"
          ? `<div class="env__sched">🔄 Back to ${esc(money(sch.amount))} ${esc(INTERVALS[sch.interval]?.label || "")}${
              next ? ` · next ${esc(shortDate(toISO(next)))}` : " · finished 🏁"}</div>`
          : `<div class="env__sched">＋${esc(money(sch.amount))} ${esc(INTERVALS[sch.interval]?.label || "")}${
              next ? ` · next ${esc(shortDate(toISO(next)))}` : " · finished 🏁"}</div>`)
      : `<div class="env__sched env__sched--off">Manual only ✋</div>`;

    const ratio = d.target > 0 ? Math.round((d.balance / d.target) * 100) : 0;
    const unit = d.mode === "refill" ? " refill" : (kind === "sinking" ? " goal" : " per period");
    const targetLine = d.target > 0
      ? `<div class="env__target">${ratio}% of ${esc(money(d.target))}${unit}${
          d.balance < 0 ? " · overdrawn 🚩" : (d.balance > d.target ? " · over 🎉" : "")}</div>`
      : `<div class="env__target">${d.balance < 0 ? "Overdrawn 🚩" : "No target set"}</div>`;

    const cls = ["env"];
    if (d.balance < 0) cls.push("env--neg");
    else if (d.target > 0 && d.balance > d.target) cls.push("env--over");

    // Overdrawn envelopes get a fixed shallow band rather than pct, which
    // clamps to zero and would leave the card looking merely empty.
    const fill = d.balance < 0 ? 9 : d.pct * 100;

    return `
      <article class="${cls.join(" ")}" style="--fill:${fill.toFixed(1)}%">
        <div class="env__fill"></div>
        <svg class="env__flap" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 0 L50 11 L100 0" fill="none" stroke="var(--silver)" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="env__head">
          <span class="env__emoji">${esc(env.emoji || "✉️")}</span>
          <h3 class="env__name" title="${esc(env.name)}">${esc(env.name)}</h3>
        </div>
        <div class="env__balance">${esc(money(d.balance))}</div>
        ${targetLine}
        ${schChip}
        <div class="env__acts">
          <button class="btn" data-act="deposit" data-id="${env.id}">➕ Add</button>
          <button class="btn" data-act="expense" data-id="${env.id}">➖ Spend</button>
          <button class="btn" data-act="history" data-id="${env.id}" title="History">📜</button>
          <button class="btn" data-act="edit" data-id="${env.id}" title="Edit">✏️</button>
        </div>
      </article>`;
  }).join("");
}

$("grid").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const env = state.envelopes.find((x) => x.id === btn.dataset.id);
  if (!env) return;
  const act = btn.dataset.act;
  if (act === "edit") openEnvelopeModal(env);
  else if (act === "history") openHistoryModal(env);
  else if (act === "pay") markPaid(env);
  else openTxnModal(env, act);
});

/** Fixed-expense "Mark paid" button: logs the scheduled amount as an
 *  expense today, no modal needed since there's nothing to choose. */
async function markPaid(env) {
  const amount = env.schedule?.amount || 0;
  if (!(amount > 0)) { toast("Set a fixed amount for this expense first ✏️"); return; }
  await addDoc(collection(db, "users", state.uid, "txns"), {
    envelopeId: env.id,
    kind: "expense",
    amount,
    date: todayISO(),
    note: "Marked paid",
    createdAt: serverTimestamp()
  });
  toast(`Marked ${money(amount)} paid ✅`);
}

// ═══ Modals ════════════════════════════════════════════════════

let closeModal = () => {};

function openModal({ title, emoji, body, submitLabel, onSubmit, extra, hideCancel }) {
  const root = $("modal-root");
  root.innerHTML = `
    <div class="scrim">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal__head">
          <span style="font-size:20px">${esc(emoji)}</span>
          <h2 class="modal__title">${esc(title)}</h2>
          <button class="modal__x" data-x aria-label="Close">✕</button>
        </div>
        ${body}
        <p class="error" data-err hidden></p>
        <div class="modal__foot">
          ${extra || ""}
          ${hideCancel ? "" : '<button class="btn" data-x>Cancel</button>'}
          <button class="btn btn--primary" data-go>${esc(submitLabel)}</button>
        </div>
      </div>
    </div>`;

  const scrim = root.firstElementChild;
  const err = root.querySelector("[data-err]");

  closeModal = () => { root.innerHTML = ""; document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") closeModal(); };
  document.addEventListener("keydown", onKey);

  scrim.addEventListener("click", (e) => {
    if (e.target === scrim || e.target.closest("[data-x]")) closeModal();
  });

  const go = root.querySelector("[data-go]");
  go.addEventListener("click", async () => {
    err.hidden = true;
    go.disabled = true;
    try {
      await onSubmit(root, (msg) => { err.textContent = msg; err.hidden = false; });
    } catch (ex) {
      err.textContent = ex.message || String(ex);
      err.hidden = false;
    } finally {
      go.disabled = false;
    }
  });

  root.querySelector("input, select, textarea")?.focus();
  return root;
}

function num(root, sel) {
  const raw = (root.querySelector(sel)?.value || "").trim().replace(/[$,]/g, "");
  if (raw === "") return 0;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
}

// ── New / edit envelope ────────────────────────────────────────
function openEnvelopeModal(env) {
  const editing = !!env;
  const e = env || {
    name: "", emoji: "", kind: state.tab, opening: 0, target: 0,
    schedule: { enabled: true, amount: 0, interval: "month", startDate: todayISO(), endDate: "" }
  };
  const s = e.schedule || {};

  const body = `
    <div class="field-row">
      <label class="field">
        <span class="field__label">Emoji</span>
        <input class="input" data-emoji maxlength="4" placeholder="✉️" value="${esc(e.emoji || "")}">
      </label>
      <label class="field">
        <span class="field__label">Section</span>
        <select class="input" data-kind>
          <option value="allowance" ${e.kind === "allowance" ? "selected" : ""}>💸 Allowance</option>
          <option value="sinking" ${e.kind === "sinking" ? "selected" : ""}>🏦 Sinking fund</option>
          <option value="fixed" ${e.kind === "fixed" ? "selected" : ""}>📌 Fixed expense</option>
        </select>
      </label>
    </div>
    <label class="field">
      <span class="field__label">Name</span>
      <input class="input" data-name placeholder="Groceries" value="${esc(e.name || "")}">
    </label>
    <div class="field-row">
      <label class="field">
        <span class="field__label">Starting balance</span>
        <input class="input mono" data-opening inputmode="decimal" placeholder="0.00" value="${e.opening ? e.opening.toFixed(2) : ""}">
      </label>
      <label class="field" data-target-field>
        <span class="field__label">Target / goal</span>
        <input class="input mono" data-target inputmode="decimal" placeholder="optional" value="${e.target ? e.target.toFixed(2) : ""}">
      </label>
    </div>

    <label class="check" data-sched-on-field ${e.kind === "fixed" ? "hidden" : ""}>
      <input type="checkbox" data-sched-on ${s.enabled || e.kind === "fixed" ? "checked" : ""}>
      <span>Fund this envelope on a schedule 🔁</span>
    </label>

    <div data-sched-fields ${s.enabled || e.kind === "fixed" ? "" : "hidden"}>
      <label class="field" data-mode-field ${e.kind === "sinking" || e.kind === "fixed" ? "hidden" : ""}>
        <span class="field__label">How it funds</span>
        <select class="input" data-mode>
          <option value="add"    ${s.mode !== "refill" ? "selected" : ""}>➕ Add this much each period — surplus rolls over</option>
          <option value="refill" ${s.mode === "refill" ? "selected" : ""}>🔄 Refill to this much each period — surplus is dropped</option>
        </select>
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field__label" data-amount-label>${s.mode === "refill" ? "Refill to" : "Amount"}</span>
          <input class="input mono" data-amount inputmode="decimal" placeholder="0.00" value="${s.amount ? s.amount.toFixed(2) : ""}">
        </label>
        <label class="field">
          <span class="field__label">Every</span>
          <select class="input" data-interval>
            <option value="week"   ${s.interval === "week" ? "selected" : ""}>Week</option>
            <option value="biweek" ${s.interval === "biweek" ? "selected" : ""}>Two weeks</option>
            <option value="month"  ${s.interval === "month" ? "selected" : ""}>Month</option>
          </select>
        </label>
      </div>
      <div class="field-row">
        <label class="field">
          <span class="field__label">Starts</span>
          <input class="input mono" data-start type="date" value="${esc(s.startDate || todayISO())}">
        </label>
        <label class="field">
          <span class="field__label">Ends (optional)</span>
          <input class="input mono" data-end type="date" value="${esc(s.endDate || "")}">
        </label>
      </div>
      <p class="muted" style="margin:-4px 0 12px" data-sched-note></p>
    </div>`;

  const extra = editing ? `<button class="btn btn--danger" data-del>🗑️</button>` : "";

  const root = openModal({
    title: editing ? "Edit envelope" : "New envelope",
    emoji: editing ? "✏️" : "✉️",
    body, extra,
    submitLabel: editing ? "Save changes 💾" : "Create envelope ✨",
    onSubmit: async (r, fail) => {
      const name = r.querySelector("[data-name]").value.trim();
      if (!name) return fail("Give the envelope a name so you can find it later.");

      const opening = num(r, "[data-opening]");
      const target = num(r, "[data-target]");
      if (Number.isNaN(opening) || Number.isNaN(target)) return fail("Balances need to be numbers.");

      const kind = r.querySelector("[data-kind]").value;
      const on = kind === "fixed" || r.querySelector("[data-sched-on]").checked;
      const amount = num(r, "[data-amount]");
      const startDate = r.querySelector("[data-start]").value;
      const endDate = r.querySelector("[data-end]").value;

      if (on) {
        if (Number.isNaN(amount) || amount <= 0) return fail(kind === "fixed"
          ? "The fixed amount has to be more than zero." : "A scheduled amount has to be more than zero.");
        if (!startDate) return fail("Pick a start date for the schedule.");
        if (endDate && endDate < startDate) return fail("The end date lands before the start date.");
      }

      const mode = kind === "sinking" || kind === "fixed" ? "add" : r.querySelector("[data-mode]").value;

      const payload = {
        name,
        emoji: r.querySelector("[data-emoji]").value.trim() || "✉️",
        kind,
        opening,
        target: mode === "refill" ? 0 : target,
        schedule: {
          enabled: on,
          mode,
          amount: on ? amount : 0,
          interval: r.querySelector("[data-interval]").value,
          startDate: on ? startDate : "",
          endDate: on ? (endDate || "") : ""
        }
      };

      if (editing) {
        await updateDoc(doc(db, "users", state.uid, "envelopes", env.id), payload);
        toast("Envelope updated ✅");
      } else {
        payload.createdAt = serverTimestamp();
        await addDoc(collection(db, "users", state.uid, "envelopes"), payload);
        toast("Envelope created 🎉");
      }
      state.tab = payload.kind;
      syncTabs();
      closeModal();
    }
  });

  const kindEl = root.querySelector("[data-kind]");
  const modeEl = root.querySelector("[data-mode]");

  function syncModeUI() {
    const fixed = kindEl.value === "fixed";
    const forceAdd = kindEl.value === "sinking" || fixed;
    const refill = !forceAdd && modeEl.value === "refill";

    root.querySelector("[data-sched-on-field]").hidden = fixed;
    if (fixed) {
      root.querySelector("[data-sched-on]").checked = true;
      root.querySelector("[data-sched-fields]").hidden = false;
    }
    root.querySelector("[data-mode-field]").hidden = forceAdd;
    root.querySelector("[data-target-field]").hidden = refill || fixed;
    root.querySelector("[data-amount-label]").textContent = refill ? "Refill to" : (fixed ? "Amount due" : "Amount");
    root.querySelector("[data-sched-note]").textContent = fixed
      ? "Ledgr expects the same amount every period. When it's due, click Mark paid on the card to log it — no need to open this form."
      : refill
        ? "On each refill date the balance resets to this amount. Anything left unspent is dropped rather than carried forward, and the refill amount doubles as the target."
        : "Contributions accrue from the start date forward, including that first day. Unspent money carries over indefinitely.";
  }

  kindEl.addEventListener("change", syncModeUI);
  modeEl.addEventListener("change", syncModeUI);
  syncModeUI();

  root.querySelector("[data-sched-on]").addEventListener("change", (ev) => {
    root.querySelector("[data-sched-fields]").hidden = !ev.target.checked;
  });

  root.querySelector("[data-del]")?.addEventListener("click", () => confirmDelete(env));
}

function confirmDelete(env) {
  openModal({
    title: `Delete ${env.name}?`,
    emoji: "🗑️",
    body: `<p class="muted">This removes the envelope and every transaction filed under it.
           There's no undo, and the balance won't move anywhere else.</p>`,
    submitLabel: "Delete it",
    onSubmit: async () => {
      const txSnap = await getDocs(query(
        collection(db, "users", state.uid, "txns"),
        where("envelopeId", "==", env.id)
      ));
      const batch = writeBatch(db);
      txSnap.forEach((d) => batch.delete(d.ref));
      batch.delete(doc(db, "users", state.uid, "envelopes", env.id));
      await batch.commit();
      toast("Envelope deleted 🗑️");
      closeModal();
    }
  });
}

// ── Deposit / expense ──────────────────────────────────────────
function openTxnModal(env, kind) {
  const isDeposit = kind === "deposit";
  const d = derive(env);

  openModal({
    title: `${isDeposit ? "Add to" : "Spend from"} ${env.name}`,
    emoji: env.emoji || (isDeposit ? "➕" : "➖"),
    body: `
      <p class="muted" style="margin-top:-6px">Currently holding <strong class="mono">${esc(money(d.balance))}</strong>.</p>
      <label class="field">
        <span class="field__label">Amount</span>
        <input class="input mono" data-amt inputmode="decimal" placeholder="0.00" autofocus>
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field__label">Date</span>
          <input class="input mono" data-date type="date" value="${todayISO()}">
        </label>
        <label class="field">
          <span class="field__label">Note</span>
          <input class="input" data-note placeholder="${isDeposit ? "Rebate check" : "Corner store"}" maxlength="80">
        </label>
      </div>`,
    submitLabel: isDeposit ? "Add it 💰" : "Log it 🧾",
    onSubmit: async (r, fail) => {
      const amount = num(r, "[data-amt]");
      if (Number.isNaN(amount) || amount <= 0) return fail("Enter an amount greater than zero.");
      const date = r.querySelector("[data-date]").value || todayISO();

      await addDoc(collection(db, "users", state.uid, "txns"), {
        envelopeId: env.id,
        kind,
        amount,
        date,
        note: r.querySelector("[data-note]").value.trim(),
        createdAt: serverTimestamp()
      });
      toast(isDeposit ? `Added ${money(amount)} 💰` : `Logged ${money(amount)} 🧾`);
      closeModal();
    }
  });
}

// ── History ────────────────────────────────────────────────────
function openHistoryModal(env) {
  const d = derive(env);
  const sch = env.schedule || {};
  const intervalLabel = INTERVALS[sch.interval]?.label || "";

  const isFixed = env.kind === "fixed";

  const auto = d.dates.map((dt) => {
    const iso = toISO(dt);
    return d.mode === "refill"
      ? {
          date: iso, kind: "refill", amount: sch.amount,
          note: `Refilled to ${money(sch.amount)} · ${intervalLabel}`
            + (iso === d.lastRefill ? " · current period" : ""),
          auto: true
        }
      : { date: iso, kind: "deposit", amount: sch.amount, note: `${isFixed ? "Due" : "Scheduled"} · ${intervalLabel}`, auto: true };
  });
  const manual = state.txns.filter((t) => t.envelopeId === env.id);

  const rows = [...auto, ...manual]
    .sort((a, b) => (b.date === a.date ? (a.auto ? 1 : -1) : b.date.localeCompare(a.date)))
    .slice(0, 80);

  const summary = isFixed
    ? (d.balance > 0.005
        ? `Owed <strong class="mono">${esc(money(d.balance))}</strong> · ${d.count} due · ${esc(money(d.expenses))} paid`
        : `<strong class="mono">Paid up ✅</strong> · ${d.count} due · ${esc(money(d.expenses))} paid`)
    : d.mode === "refill"
      ? `Balance <strong class="mono">${esc(money(d.balance))}</strong> ·
         ${d.count} refill${d.count === 1 ? "" : "s"} ·
         ${d.lastRefill
            ? `${esc(money(d.periodExpenses))} spent since ${esc(prettyDate(d.lastRefill))}`
            : "no refill has landed yet"}`
      : `Balance <strong class="mono">${esc(money(d.balance))}</strong> ·
         ${d.count} scheduled · ${esc(money(d.deposits))} added · ${esc(money(d.expenses))} spent`;

  const body = `
    <p class="muted" style="margin-top:-6px">${summary}</p>
    <div class="ledger">
      ${rows.length ? rows.map((t) => `
        <div class="ledger__row">
          <span class="ledger__date">${esc(ledgerDate(t.date))}</span>
          <span class="ledger__what">${esc(t.note || (t.kind === "deposit" ? "Deposit" : "Expense"))}
            ${t.auto ? '<span class="ledger__auto">🔁</span>' : ""}</span>
          <span class="ledger__amt ${t.kind === "expense" ? "is-out" : "is-in"}">
            ${t.kind === "refill" ? "＝" : (t.kind === "deposit" ? "＋" : "−")}${esc(money(t.amount))}
            ${t.auto ? "" : `<button class="ledger__del" data-del="${t.id}" title="Delete entry">✕</button>`}
          </span>
        </div>`).join("")
      : `<p class="muted" style="padding:18px 0">Nothing filed here yet. 🍃</p>`}
      ${env.opening && d.mode !== "refill" ? `
        <div class="ledger__row">
          <span class="ledger__date">—</span>
          <span class="ledger__what">Starting balance</span>
          <span class="ledger__amt is-in">＋${esc(money(env.opening))}</span>
        </div>` : ""}
    </div>
    ${d.mode === "refill" && d.lastRefill
      ? `<p class="muted" style="margin-top:10px">Only entries from ${esc(prettyDate(d.lastRefill))} onward affect the current balance. Earlier ones are kept for the record.</p>`
      : ""}
    ${rows.length >= 80 ? '<p class="muted" style="margin-top:10px">Showing the 80 most recent entries.</p>' : ""}`;

  const root = openModal({
    title: `${env.name} history`,
    emoji: "📜",
    body,
    submitLabel: "Done",
    hideCancel: true,
    onSubmit: async () => closeModal()
  });

  root.addEventListener("click", async (ev) => {
    const del = ev.target.closest("[data-del]");
    if (!del) return;
    await deleteDoc(doc(db, "users", state.uid, "txns", del.dataset.del));
    toast("Entry removed 🧽");
    closeModal();
    openHistoryModal(state.envelopes.find((x) => x.id === env.id) || env);
  });
}

// ═══ Tabs ══════════════════════════════════════════════════════
function syncTabs() {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.kind === state.tab;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", String(on));
  });
  render();
}
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => { state.tab = t.dataset.kind; syncTabs(); });
});
$("add-env").addEventListener("click", () => openEnvelopeModal(null));

// ═══ Firestore subscriptions ═══════════════════════════════════
function subscribe(uid) {
  state.uid = uid;

  state.unsub.push(onSnapshot(collection(db, "users", uid, "envelopes"), (snap) => {
    state.envelopes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => toast(`Couldn't load envelopes: ${err.code} ⚠️`)));

  state.unsub.push(onSnapshot(collection(db, "users", uid, "txns"), (snap) => {
    state.txns = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => toast(`Couldn't load transactions: ${err.code} ⚠️`)));

  state.unsub.push(onSnapshot(doc(db, "users", uid, "meta", "settings"), (snap) => {
    state.settings = snap.exists() ? snap.data() : { savingsActual: null };
    render();
  }));
}

function unsubscribe() {
  state.unsub.forEach((fn) => fn());
  state.unsub = [];
  state.envelopes = [];
  state.txns = [];
  state.settings = { savingsActual: null };
  state.uid = null;
}

// ═══ Auth screen ═══════════════════════════════════════════════
const AUTH_MESSAGES = {
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/missing-password": "Enter your password.",
  "auth/weak-password": "Passwords need at least 6 characters.",
  "auth/email-already-in-use": "That email already has an account. Sign in instead.",
  "auth/invalid-credential": "Email or password didn't match.",
  "auth/wrong-password": "Email or password didn't match.",
  "auth/user-not-found": "No account with that email yet. Create one below.",
  "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
  "auth/operation-not-allowed": "Turn this sign-in method on in Firebase console → Authentication → Sign-in method.",
  "auth/popup-blocked": "Your browser blocked the popup. Allow popups for localhost.",
  "auth/unauthorized-domain": "Add this domain under Firebase console → Authentication → Settings → Authorized domains."
};
const authErr = (e) => AUTH_MESSAGES[e.code] || e.message || "Something went wrong.";

function showAuthError(msg) {
  const el = $("auth-error");
  el.textContent = msg;
  el.hidden = false;
}

function wireAuthScreen() {
  const email = () => $("auth-email").value.trim();
  const pass = () => $("auth-pass").value;

  $("auth-signin").addEventListener("click", async () => {
    try { await signInWithEmailAndPassword(auth, email(), pass()); }
    catch (e) { showAuthError(authErr(e)); }
  });

  $("auth-signup").addEventListener("click", async () => {
    try { await createUserWithEmailAndPassword(auth, email(), pass()); }
    catch (e) { showAuthError(authErr(e)); }
  });

  $("auth-google").addEventListener("click", async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { showAuthError(authErr(e)); }
  });

  $("auth-reset").addEventListener("click", async () => {
    if (!email()) return showAuthError("Enter your email first, then request the reset.");
    try {
      await sendPasswordResetEmail(auth, email());
      toast("Reset email sent 📬");
    } catch (e) { showAuthError(authErr(e)); }
  });

  $("auth-pass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("auth-signin").click();
  });

  $("signout").addEventListener("click", () => signOut(auth));
}

// ═══ Boot ══════════════════════════════════════════════════════
const LS_KEY = "ledgr.firebaseConfig";

function resolveConfig() {
  if (FIREBASE_CONFIG?.apiKey && !FIREBASE_CONFIG.apiKey.startsWith("PASTE_")) return FIREBASE_CONFIG;
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (saved?.apiKey) return saved;
  } catch { /* fall through to setup */ }
  return null;
}

function showSetup() {
  $("boot").hidden = true;
  $("setup").hidden = false;

  // config.js exported something, but not a shape we recognise. Say so here
  // rather than leaving them staring at a setup screen they thought they'd
  // already filled in.
  const exported = Object.keys(configModule).filter((k) => k !== "__esModule");
  if (!FIREBASE_CONFIG && exported.length) {
    const err = $("setup-error");
    err.textContent = `config.js exports ${exported.map((k) => `"${k}"`).join(", ")}, `
      + "but Ledgr looks for FIREBASE_CONFIG, firebaseConfig, or a default export. "
      + "Add `export` in front of the config object and name it one of those.";
    err.hidden = false;
  }

  $("setup-save").addEventListener("click", () => {
    const err = $("setup-error");
    err.hidden = true;
    let raw = $("setup-json").value.trim()
      .replace(/^\s*(const|let|var)\s+\w+\s*=\s*/, "")
      .replace(/;?\s*$/, "");
    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch {
      try {
        // Tolerate the unquoted-key form copied straight out of the console.
        cfg = Function(`"use strict";return (${raw})`)();
      } catch {
        err.textContent = "That didn't parse as a config object. Paste everything from { to }.";
        err.hidden = false;
        return;
      }
    }
    if (!cfg?.apiKey || !cfg?.projectId) {
      err.textContent = "The config needs at least apiKey and projectId.";
      err.hidden = false;
      return;
    }
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
    location.reload();
  });
}

function start(cfg) {
  const app = initializeApp(cfg);
  auth = getAuth(app);
  db = getFirestore(app);
  wireAuthScreen();

  onAuthStateChanged(auth, (user) => {
    $("boot").hidden = true;
    if (user) {
      $("auth").hidden = true;
      $("app").hidden = false;
      $("who").textContent = user.email || user.displayName || "signed in";
      $("auth-error").hidden = true;
      subscribe(user.uid);
      syncTabs();
    } else {
      unsubscribe();
      $("app").hidden = true;
      $("auth").hidden = false;
    }
  });
}

const cfg = resolveConfig();
if (cfg) start(cfg); else showSetup();