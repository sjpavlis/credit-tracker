# Credit Tracker

> A standalone, zero-dependency app for tracking credit cards, bills,
> shared payers, and installments.

One HTML file plus dedicated CSS and JS. No build step, no backend, no framework. Data lives
in the browser's `localStorage` by default, but the architecture exposes a clean data-source
abstraction so any host app can swap in its own API without touching the UI.

---

## Features

- **Dashboard** — total outstanding, monthly due, upcoming due dates with overdue
  highlighting, settlements ("who owes whom" directional flows), spending breakdowns
  by category and by person, active installment summary.
- **Cards** — create/edit/delete with owner, network, last 4 digits, credit limit,
  statement day, due day, accent color.
- **Transactions** — description, category, amount, date, card assignment, multi-user
  split (equal / custom amounts), optional installment plan.
- **Splits** — tag multiple users per transaction; supports equal split or custom
  amounts. Math uses integer cents with largest-remainder distribution so splits
  always reconcile exactly. Duplicate people are rejected.
- **Billing cycles** — transactions are grouped into statement periods based on each
  card's due day. The card detail view shows one cycle at a time with prev/next
  navigation, and stats/settlements/breakdowns are scoped to the selected cycle.
- **Installments** — N-month plans with a visual schedule, forecasted per-month due
  dates, and **per-person payment tracking** (each payer advances independently).
- **Categories** — optional label per transaction with autocomplete suggestions,
  surfaced in spending breakdowns.
- **Theming** — light / dark mode toggle (persisted), plus CSS custom properties for
  full rebranding.
- **States** — loading spinner, error display with retry, empty states for cards and
  transactions.
- **Import / Export** — full JSON backup and restore.
- **Responsive** — mobile + desktop, accessible (semantic HTML, focus trapping, aria
  attributes, keyboard navigation).

---

## Run standalone

```bash
git clone https://github.com/sjpavlis/credit-tracker.git
cd credit-tracker
# serve it over a local web server:
python -m http.server 8000   # visit http://localhost:8000
```

No install, no dependencies.

> **Important:** serve the app over `http://` (e.g. the command above) rather than
> opening `index.html` directly via `file://`. Browsers treat the `file://` origin as
> opaque, so `localStorage` may not persist and your data won't be saved between
> reloads. Any real web server works — including how a host app like a Spring Boot
> backend serves it over `http(s)://`.

---

## Project structure

```
credit-tracker/
├── index.html        # HTML shell (references css + js)
├── css/styles.css    # all styles (themed via --ct-* custom properties)
├── js/app.js         # all logic (config, data source, rendering, events)
├── LICENSE
└── README.md
```

---

## Data model (JSON shape)

The app persists (and exports/imports) this structure:

```jsonc
{
  "users": [
    { "id": "abc123", "name": "Patrick", "color": "#6366f1" }
  ],
  "cards": [
    {
      "id": "def456",
      "ownerId": "abc123",       // references a user
      "name": "Platinum Rewards",
      "network": "Visa",         // optional
      "last4": "4821",           // optional
      "limitCents": 15000000,    // integer cents (150,000.00)
      "statementDay": 5,         // 1–31, nullable
      "dueDay": 23,              // 1–31, required
      "color": "#6366f1",
      "note": ""                 // optional
    }
  ],
  "transactions": [
    {
      "id": "ghi789",
      "cardId": "def456",
      "description": "iPhone 15",
      "category": "Shopping",    // optional label, "" if unset
      "amountCents": 6000000,    // integer cents (60,000.00)
      "date": "2026-03-01",     // ISO date string
      "splits": [
        { "userId": "abc123", "amountCents": 3000000, "paid": false },
        { "userId": "xyz999", "amountCents": 3000000, "paid": false }
      ],
      "installment": {           // or null for a one-time charge
        "months": 12,
        "monthsPaid": 3,         // derived: min across splitPayments
        "startDate": "2026-03-01", // first payment date; drives due-date forecast
        "splitPayments": {       // per-person months paid (independent)
          "abc123": 4,
          "xyz999": 3
        }
      },
      "createdAt": "2026-03-01"
    }
  ]
}
```

**Key invariants:**
- All money values are **integer cents** (multiply display amounts by 100).
- `splits[].amountCents` always sums to `transaction.amountCents`.
- `category` is an optional string (`""` when unset).
- For installments:
  - `months` is the total number of monthly payments.
  - `splitPayments[userId]` tracks how many months each payer has settled, so people
    can be at different points in the plan.
  - `monthsPaid` is the **minimum** of all `splitPayments` values — i.e. the number of
    months fully paid by everyone. Each month's amount uses largest-remainder
    distribution for exact reconciliation, and a per-month due date is derived from
    `startDate` plus the card's `dueDay`.

---

## Host adoption / rebranding

### 1. Configuration object

Set `window.CreditTrackerConfig` **before** the script executes (or patch the defaults
inside the file):

```html
<script>
window.CreditTrackerConfig = {
  brandName: "Patrices Finance",
  brandTagline: "Our shared credit dashboard",
  brandLogo: "/img/logo.png",      // or null for default emoji icon
  currency: "PHP",                 // ISO 4217
  locale: "en-PH",                // BCP47
  currencySymbol: "₱",            // fallback
  storageKey: "patrices-credit.v1",
  dataSource: null                 // see below
};
</script>
```

### 2. CSS theming

All colors, fonts, radius, and spacing are CSS custom properties prefixed `--ct-*`.
Override them in a `<style>` block or external stylesheet:

```css
:root {
  --ct-primary: #e11d48;
  --ct-primary-hi: #fb7185;
  --ct-bg: #ffffff;
  --ct-text: #1f2937;
  --ct-font: "Inter", sans-serif;
}
```

### 3. Custom data source (backend API)

Replace localStorage by providing an object with two async methods:

```js
window.CreditTrackerConfig = {
  dataSource: {
    load: async function() {
      const res = await fetch("/api/credit-tracker/data");
      if (!res.ok) throw new Error("Load failed");
      return res.json(); // must return the JSON shape above, or null for fresh start
    },
    save: async function(data) {
      await fetch("/api/credit-tracker/data", {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(data)
      });
    }
  }
};
```

The UI calls `load()` on boot and `save(data)` after every mutation.

### 4. Serving from a host app (e.g. Spring Boot)

Drop `index.html` into static resources:

```bash
git clone --depth 1 https://github.com/sjpavlis/credit-tracker.git \
  src/main/resources/static/credit-tracker
```

Add a controller route:

```java
@GetMapping("/credit-tracker")
public String creditTracker() {
    return "forward:/credit-tracker/index.html";
}
```

Since everything is in one file with no external asset references, it works under any
sub-path without changes.

---

## License

MIT
