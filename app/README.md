# CourseCraft — subscription SaaS

A sellable web app that turns any book into a personalized learning journey.
Customers subscribe (payments via **Lemon Squeezy**, who handle EU VAT as merchant
of record), log in with their license key, and chat with CourseCraft — which
interviews them and builds their course module by module with all learning assets.

## Architecture

| Piece | What it does |
|---|---|
| `server.js` | Express server: landing page, license-key login, Lemon Squeezy webhook, metered streaming chat API |
| `db.js` | SQLite (better-sqlite3): users, sessions, monthly usage |
| `public/index.html` | Public landing/sales page with pricing + checkout link |
| `public/login.html` | License-key login |
| `public/app.html` + `app.js` | The chat app (requires active subscription) |
| `public/terms.html`, `privacy.html` | Legal page **templates — complete before launch** |
| `../render.yaml` | One-click Render deployment blueprint |
| `../prompts/book-to-course-prompt.md` | The CourseCraft system prompt (single source of truth) |

**How money is protected:** you pay Anthropic for customers' usage, so every
customer has a monthly fair-use budget (`MONTHLY_COST_CAP_USD`, default $5 of API
cost). The server computes real cost per request (including cache discounts) and
blocks generation once the budget is spent — it resets on the 1st.

## Local development

```bash
cd app
npm install
cp .env.example .env
# set ANTHROPIC_API_KEY and DEV_ACCESS_CODE=letmein in .env
npm start
```

Open http://localhost:3000 → Log in with `letmein` (the dev code bypasses
Lemon Squeezy locally — never set `DEV_ACCESS_CODE` in production).

## 🚀 Launch checklist

### 1. Lemon Squeezy (payments)
1. Create an account at [lemonsqueezy.com](https://lemonsqueezy.com) and complete
   store activation (identity verification takes a day or two).
2. Create a **Product** → "CourseCraft" → **Subscription** (suggested: €12/month).
3. In the product's settings, enable **License keys** (activations: unlimited or a
   sane number like 5). Every subscriber then automatically receives a license key
   by email — that's what they log in with.
4. Copy the product's **checkout link** → set as `LEMONSQUEEZY_CHECKOUT_URL`.
5. **Settings → Webhooks** → add endpoint `https://YOUR-DOMAIN/api/webhooks/lemonsqueezy`,
   select the `subscription_*` events, set a signing secret → set as
   `LEMONSQUEEZY_WEBHOOK_SECRET`. (This is how cancellations/expiries revoke access.)

### 2. Render (hosting)
1. Create an account at [render.com](https://render.com) and connect this GitHub repo.
2. Choose **Blueprints** → it picks up `render.yaml` automatically (web service +
   1 GB persistent disk for the SQLite database).
3. Set the secret env vars when prompted: `ANTHROPIC_API_KEY`,
   `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_CHECKOUT_URL`.
4. Add your custom domain in Render's settings (and buy one if you haven't —
   e.g. coursecraft.app-style names via any registrar).

### 3. Before taking real money
- [ ] Fill in the **Terms** and **Privacy** templates (`public/terms.html`,
      `public/privacy.html`) — name, address, support email — and have them
      reviewed for your jurisdiction.
- [ ] Confirm with an accountant how Lemon Squeezy payouts should be declared
      (as merchant of record they handle VAT on sales, but payouts are still
      your income).
- [ ] Do one **real test purchase** (Lemon Squeezy test mode first, then live),
      confirm the license key arrives by email and logs in.
- [ ] Cancel the test subscription and confirm access is revoked when it expires.
- [ ] Set a billing alert in the Anthropic console so runaway usage can't surprise you.

### 4. Pricing sanity check
At €12/month with a $5/month API budget per customer, heavy users cost you at most
~€5 — leaving margin for fees (~5% + 50¢ Lemon Squeezy) and hosting (~$7/month
Render starter). Adjust `MONTHLY_COST_CAP_USD` and the price on the landing page
(`public/index.html`) together.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic key — you pay for customer usage |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | ✅ (prod) | Webhook signing secret |
| `LEMONSQUEEZY_CHECKOUT_URL` | ✅ (prod) | Product checkout link shown on the landing page |
| `MONTHLY_COST_CAP_USD` | – | Per-customer monthly API budget (default 5) |
| `MODEL` | – | Claude model (default `claude-sonnet-5`) |
| `DB_PATH` | – | SQLite path (default `./data/coursecraft.db`) |
| `DEV_ACCESS_CODE` | – | Local-testing login bypass — **never set in production** |
| `PORT` | – | Default 3000 |

## How access control works

1. Customer subscribes via Lemon Squeezy → receives a license key by email.
2. They log in at `/login`; the server validates the key against Lemon Squeezy's
   License API and starts a 30-day session (httpOnly cookie).
3. Lemon Squeezy webhooks keep the local user status in sync: cancelled
   subscriptions keep access until the period ends; `subscription_expired`
   revokes it.
4. Every chat request checks the session, the subscription status, and the
   monthly fair-use budget before calling Claude.

Conversations are never stored server-side — they live in the customer's browser
(and can be exported as Markdown). The server only stores email, license key
status, and monthly token/cost counters.
