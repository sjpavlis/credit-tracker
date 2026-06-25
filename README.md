# Credit Tracker

> A standalone, zero-dependency single-file app for tracking credit cards, bills,
> shared payers, and installments.

One HTML file plus dedicated CSS and JS. No build step, no backend, no framework. Data lives
in the browser's `localStorage` by default, but the architecture exposes a clean data-source
abstraction so any host app can swap in its own API without touching the UI.

---

## Features

- **Dashboard** — total outstanding, monthly due, upcoming due dates with overdue
  highlighting, "who owes what" per-person breakdown, active installment summary.
- **Cards** — create/edit/delete with owner, network, last 4 digits, credit limit,
  statement day, due day, accent color.
- **Transactions** — description, amount, date, card assignment, multi-user split
  (equal / custom amounts / percentage), optional installment plan.
- **Splits** — tag multiple users per transaction; supports equal split, custom
  amounts, or percentage mode. Math uses integer cents with largest-remainder
  distribution so splits always reconcile exactly.
- **Installments** — N-month plans with progress tracking, per-month amount, remaining
  balance, and a dedicated schedule view.
- **States** — loading spinner, error display with retry, empty states for cards and
  transactions.
- **Import / Export** — full JSON backup and restore.
- **Responsive** — mobile + desktop, dark theme, accessible (semantic HTML, focus
  trapping, aria attributes, keyboard navigation).

---

## Run standalone

```bash
git clone https://github.com/sjpavlis/credit-tracker.git
cd credit-tracker
# open index.html directly, or serve it:
python -m http.server 8000   # visit http://localhost:8000
```

No install, no dependencies.

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
      "description": "Groceries",
      "amountCents": 800000,     // integer cents (8,000.00)
      "date": "2026-06-10",     // ISO date string
      "splits": [
        { "userId": "abc123", "amountCents": 400000, "paid": false },
        { "userId": "xyz999", "amountCents": 400000, "paid": false }
      ],
      "installment": null,       // or { "months": 12, "monthsPaid": 3 }
      "createdAt": "2026-06-10"
    }
  ]
}
```

**Key invariants:**
- All money values are **integer cents** (multiply display amounts by 100).
- `splits[].amountCents` always sums to `transaction.amountCents`.
- Installment `monthsPaid` ≤ `months`. Remaining = per-month × (months − monthsPaid),
  where per-month amounts use largest-remainder distribution for exact reconciliation.

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
