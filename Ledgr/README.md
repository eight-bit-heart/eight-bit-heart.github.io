# 🧾 Ledgr

Envelope budgeting with two sections — **💸 Allowances** (money that refills on a
rhythm) and **🏦 Sinking Funds** (money accumulating toward something, totalled
against your real savings account balance).

Static frontend, Firebase Auth + Firestore backend. No build step, no
dependencies to install, no server code. Runs entirely inside the free Spark plan.

---

## Setup

### 1. Create the Firebase project

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**. Analytics is optional; skip it.
2. **Build → Authentication → Get started**. Enable **Email/Password**. Enable **Google** too if you want the one-click button.
3. **Build → Firestore Database → Create database**. Pick a region near you, start in **production mode** (the rules below replace the defaults anyway).
4. **⚙️ Project settings → Your apps → Web (`</>`)**. Register the app, then copy the `firebaseConfig` object.

### 2. Point Ledgr at it

Either paste the config into `config.js`, or leave the placeholders alone and
paste it into the setup screen on first load (it saves to `localStorage`).

Those values are not secrets. A Firebase web API key is a public project
identifier — `firestore.rules` is what actually protects the data.

### 3. Publish the rules

**Firestore Database → Rules** → paste the contents of `firestore.rules` → **Publish**.

Skipping this step leaves your database open to the internet after the 30-day
test-mode window, or blocks all reads if you chose production mode. Don't skip it.

### 4. Serve it

Module scripts don't work over `file://`, so it needs a local server:

```bash
cd ledgr
python3 -m http.server 5173
#   or: npx serve -l 5173
```

Then open <http://localhost:5173>. `localhost` is already in Firebase's
authorized-domains list, so sign-in works with no extra configuration.

### If the console says the module provides no export named…

```
Uncaught SyntaxError: The requested module './config.js' does not
provide an export named 'FIREBASE_CONFIG'
```

`config.js` is an ES module, so the config object has to be exported by a name
Ledgr looks for. It accepts `FIREBASE_CONFIG`, `firebaseConfig` (the name the
Firebase console gives you), or a default export — so pasting the console's
snippet verbatim works as long as you put `export` in front of it:

```js
export const firebaseConfig = { apiKey: "…", projectId: "…", /* … */ };
```

Dropping the `export` keyword, or naming it something else entirely, is the one
case that fails. If that happens, Ledgr falls back to the setup screen and names
whatever your file actually exported.

---

## Publishing

Ledgr is static files with no build step, so GitHub Pages hosts it as-is.

1. Push the folder to a repo.
2. **Settings → Pages → Source: Deploy from a branch**, pick `main` and `/ (root)`.
3. Wait for the build, then visit `https://<user>.github.io/<repo>/`.
4. **Firebase console → Authentication → Settings → Authorized domains → Add domain** → `<user>.github.io`.

Step 4 is not optional. Without it every sign-in fails with
`auth/unauthorized-domain`, including the Google popup. Ledgr catches that error
and tells you exactly this, but it's easier to just do it up front.

Two details that already work in your favour: every path in the app is relative,
so serving from a `/<repo>/` subpath needs no changes, and Pages is HTTPS-only,
which Firebase Auth requires. No `.nojekyll` file is needed — nothing here starts
with an underscore.

**Firebase Hosting is the alternative** and it's also free on Spark, with 10 GB
of storage and 360 MB/day of transfer. It's `firebase init hosting` then
`firebase deploy`, and it auto-authorizes its own domain, so you skip step 4. Pick
Pages if the repo is the point; pick Hosting if you'd rather keep one vendor.

### What not to commit

The short version: **`config.js` is fine to commit, service account keys are not.**

Your Firebase *web* config — `apiKey`, `projectId`, `appId` — is a public
identifier, not a credential. It ships to every browser that loads the app and
can't be hidden. `firestore.rules` is what protects the data, which is why
publishing those rules matters far more than hiding the config.

What must never be committed is a **service account key** (`Project settings →
Service accounts → Generate new private key`). Those bypass security rules
entirely and grant full project access. You don't need one for Ledgr, but the
`.gitignore` blocks the usual filenames in case you add tooling later.

Two things worth doing once the repo is public:

- **Restrict the API key.** Google Cloud Console → APIs & Services → Credentials → your browser key → Application restrictions → HTTP referrers → add `https://<user>.github.io/*`. Scraped keys otherwise get pointed at your project's quota.
- **Decide whose Firebase project this is.** Committing your config means everyone who visits signs into *your* project and consumes *your* free quota — fine for freeware, and the rules keep each user's data separate. If you'd rather hand out the code and have people bring their own backend, uncomment `config.js` in `.gitignore` and let the setup screen collect it.

---

Scheduled contributions are **never written to the database**. Every balance is
derived at render time, in one of two modes you pick per envelope.

**➕ Add mode** (any envelope, and the only mode for sinking funds):

```
balance = starting balance
        + (amount × occurrences from start date through today)
        + manual deposits
        − manual expenses
```

Surplus rolls over forever. Fund groceries at $150/month, spend $120, and you
start the next month at $180.

**🔄 Refill mode** (allowances only):

```
balance = refill amount
        + manual deposits since the latest refill date
        − manual expenses since the latest refill date
```

Each refill date resets the envelope to the amount. Unspent money is dropped, not
carried. This is the mode that keeps an allowance meaningful as a constraint — a
dining-out envelope that rolls over forever quietly stops being a limit. Before
the first refill date lands, the envelope behaves like add mode against its
starting balance.

A transaction dated on the refill day counts against the fresh balance. In refill
mode the amount doubles as the target, so the target field is hidden.

This is the design decision worth knowing about, because it drives everything else:

**What you get.** The app is idempotent. Open it on your phone and your laptop at
the same time, or don't open it for four months, and the numbers are identical.
There's no cron job, no Cloud Function, nothing to keep alive, and no way to
double-post a contribution. It's also why Ledgr fits inside the Spark plan
without ever needing a billing account.

**What it costs you.** In add mode, editing a schedule's amount restates history —
bump groceries from $150 to $175 and every past month recomputes at $175. When the
past matters, end the current schedule (set an end date) and create a second
envelope, rather than editing the amount in place. Refill mode is largely immune to
this, since only the latest period feeds the balance; changing the amount there
just changes what the envelope refills to next time.

**Month-end handling.** A schedule starting the 31st fires on the 28th in
February and returns to the 31st in March — each occurrence is derived from the
original anchor date, not from the previous occurrence, so it never drifts.
Weekly and biweekly intervals are DST-safe.

## Data model

```
users/{uid}
  ├─ envelopes/{id}   name, emoji, kind, opening, target,
  │                   schedule { enabled, mode, amount, interval, startDate, endDate }
  ├─ txns/{id}        envelopeId, kind (deposit|expense), amount, date, note
  └─ meta/settings    savingsActual
```

Dates are `YYYY-MM-DD` strings parsed in local time rather than Firestore
`Timestamp`s — a budget entry belongs to a calendar day, not an instant, and
string dates sort and compare correctly without any conversion on read.

Two collection listeners plus one document listener per session. A hundred
envelopes with a few thousand transactions is a few hundred reads on load,
against a 50,000/day free quota.

## Free-tier notes

Everything here stays on Spark: Auth covers 50,000 monthly active users, and
Firestore covers 50,000 reads / 20,000 writes per day and 1 GiB stored. Cloud
Storage isn't used, which matters — since February 2026 it requires a linked
billing account even at zero usage.

If you later release this as freeware, the meaningful risk is Firestore reads,
not storage. Every user gets their own document subtree, so nothing is shared,
but a user who leaves a tab open all day holds two live listeners. Spark blocks
at the quota rather than billing you, so the failure mode is "the app stops
working today" rather than a surprise invoice.

## If you release it

Worth doing before handing it to anyone else:

- **Rate-limit account creation.** Firebase Auth has no built-in signup cap on Spark. Enable App Check if abuse becomes real.
- **Add an export.** Nobody should be able to lose their budget because you shut off a Firebase project. A JSON dump button is twenty lines.
- **Decide about multi-currency.** Amounts are formatted as USD in one place (`money()` in `app.js`) and stored as plain numbers, so this is a small change, but it's a schema decision you want to make before people have data.
- **Watch the restatement behavior.** It's defensible for you because you now know about it. It will surprise a stranger. Either surface it in the edit dialog or switch to versioned schedules (an array of `{amount, from, to}` segments) before releasing.

## Keyboard and accessibility

`Esc` closes any dialog, `Enter` submits the sign-in form, focus rings are
visible throughout, and `prefers-reduced-motion` disables the fill animation
and dialog transitions.
