# 💳 Credit Tracker

> A standalone, zero-dependency page for tracking credit cards, cardholders, balances and due dates.

Plain HTML + CSS + JavaScript. No build step, no backend, no framework. Data lives in the
browser's `localStorage`, so it runs by simply opening `index.html` — or by being served as
static files from another app (see [Hosting from another app](#hosting-from-another-app)).

---

## Features

- **Cardholders** — group cards by owner, filter the dashboard per person
- **Cards** — bank, last 4 digits, credit limit, current balance, accent color
- **Due dates** — set a monthly due day; the app computes the next due date and days remaining
- **Status at a glance** — badges for due-in-7-days, due-in-3-days, and paid
- **Mark paid** — flag the current cycle as paid; the next due date rolls forward automatically
- **Utilization bar** — balance vs. limit, color-coded
- **Import / export** — back up or move your data as JSON
- **Responsive dark UI** — works on phone and desktop

> Data is stored only in the browser. Clearing site data removes it. Use **Export** to back up.

---

## Run standalone

Just open the file:

```bash
# clone, then open index.html in a browser
git clone https://github.com/sjpavlis/credit-tracker.git
cd credit-tracker
# double-click index.html, or serve it:
python -m http.server 8000   # then visit http://localhost:8000
```

No install, no dependencies.

---

## Project structure

```
credit-tracker/
├── index.html        # markup + modals
├── css/styles.css    # dark theme
├── js/app.js         # state, persistence, rendering (localStorage)
├── LICENSE
└── README.md
```

---

## Hosting from another app

This repo is designed to be **fetched at build/deploy time** and served as static content by a
host app (e.g. a Spring Boot site). Because everything is static and self-contained, dropping the
files under any static path works.

### Spring Boot

During CI, clone this repo into the host's static resources before packaging:

```bash
git clone --depth 1 https://github.com/sjpavlis/credit-tracker.git \
  src/main/resources/static/credit-tracker
```

Spring Boot then serves it at `/credit-tracker/`. Add a controller route for a clean URL:

```java
@GetMapping("/credit-tracker")
public String creditTracker() {
    return "forward:/credit-tracker/index.html";
}
```

All asset paths in `index.html` are relative (`css/styles.css`, `js/app.js`), so the app works
under any sub-path without changes.

### Serving it on its own subdomain

Because the app is self-contained under one folder, a subdomain must rewrite **every** path
(assets included) onto the prefix — unlike apps whose assets sit at the shared top level.
With [Shipyard](https://github.com/sjpavlis/shipyard)'s Caddy generator that's the `:full` mode:

```bash
bash setup-caddy.sh --domain example.com --subdomains "credit:/credit-tracker:full"
```

Which produces:

```caddy
credit.example.com {
    handle / {
        rewrite * /credit-tracker
        reverse_proxy localhost:8080
    }
    handle {
        rewrite * /credit-tracker{path}
        reverse_proxy localhost:8080
    }
}
```

---

## Configuration

A couple of constants at the top of `js/app.js`:

| Constant | Default | Purpose |
|----------|---------|---------|
| `CURRENCY` | `₱` | Currency symbol shown on amounts |
| `STORAGE_KEY` | `credit-tracker.v1` | localStorage key |

On first run the app seeds a few sample cards so the UI isn't empty. Remove them from the
**Cardholders** panel or just edit/delete the cards.

---

## License

MIT
