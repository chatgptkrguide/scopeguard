# Tollgate architecture

This document is the plan the code follows. When the code and this file disagree, fix one of them in the same commit.

**Build status.** The sections below describe the whole design. This table says what exists today; anything not listed as built arrives in the phase shown.

| Area | Status |
|:--|:--|
| Visitor demo copies, workspace from the database, waive and reset (phase 1) | Built |
| PayPal invoices: create, send, cancel, quote again, activity events, server-wide send cap (phase 2) | Built |
| Payment webhook, "Check payment", startup migrations, `/api/health`, daily check, Render deploy (phase 3) | Planned |
| Claude scope review, Claude call caps, activity panel on screen (phase 4) | Planned |
| Per-copy limits and public demo polish (phase 5) | Planned |
| Payment-locked timeline with Bryntum (phase 6, only if phase 5 passes its go/no-go check) | Planned |

## 1. Product in one paragraph

Freelancers agree on a scope with a client, then the client keeps adding requests in chat and email. Tollgate compares each new client message with the agreed scope, marks the phrases that add work, and proposes a change order priced from the freelancer's own hourly rate. The freelancer approves it, Tollgate sends a PayPal invoice, and a PayPal webhook marks it paid. Extra work stays locked on a timeline until its change order is paid; the payment webhook unlocks it and moves the delivery date.

**Who:** solo freelancers and small studios billing clients abroad in USD. **Core loop:** paste message, review marks, send change order, get paid.

## 2. Scope of the hackathon build

| Must (MVP) | Should, once the core loop runs on the deployed app | Not doing |
|:--|:--|:--|
| One project with agreed scope items and an hourly rate | Timeline where an unpaid change order locks its phase until PayPal confirms payment (Bryntum; trial starts Nov 9 so it covers judging) | Accounts, sign-up, teams |
| Paste a client message, Claude marks scope additions | | Multi-currency (USD only) |
| Change order lifecycle: draft, sent, paid, waived, cancelled | | Email or chat inbox integration |
| PayPal invoice per change order (create, send, read the payer link, cancel) | | Mobile app |
| Webhook confirms payment, with a "Check payment" fallback; totals update | | Live PayPal (sandbox only) |
| Activity panel: each step Claude and the app took, including what went to PayPal | | Payouts and Orders APIs |
| Public demo: every visitor gets their own sandbox copy of the demo project | | Agent Toolkit chat assistant |
| | | Claude drafting the first scope (the agreed scope is typed in or seeded) |
| | | An invoice for the agreed scope itself |

## 3. Principles

1. **The agent proposes, the person approves.** No invoice is created, sent, or cancelled without a click from the freelancer. Claude never sees PayPal credentials and never moves money.
2. **Prices come from the freelancer's rate, not from the model.** Claude estimates hours; the app computes `hours × hourly rate`. The reasoning shown to the user is the model's, the arithmetic is ours.
3. **Every money state change is idempotent.** A double click, a retried request, or a duplicate webhook must not create a second invoice or flip a status twice.
4. **Domain logic is plain TypeScript.** Status rules and money math live in `src/domain` with no framework or I/O, so they are unit tested.
5. **Public repo hygiene.** Secrets live only in `.env.local` / the host's env. Sample data is fictional.
6. **The browser sends ids, not amounts.** Server actions load prices and statuses from the database, so a forged request can't change what gets billed.
7. **The public demo can't hurt anyone else.** There are no accounts, so each visitor works on their own copy, only in the PayPal sandbox, with Claude calls capped.

## 4. System overview

```
 Browser (React, Next.js App Router)
    │  server actions                         ┌──────────────────────────┐
    ▼                                         │ Anthropic API (Claude)   │
 Next.js server ── src/server/ai ────────────▶│ structured scope review  │
    │                                         └──────────────────────────┘
    ├── src/domain      (pure rules, money)
    ├── src/server/db   (Drizzle + libSQL/SQLite file)
    │                                         ┌──────────────────────────┐
    ├── src/server/paypal ───────────────────▶│ PayPal REST (sandbox)    │
    │     OAuth token cache, Invoicing v2     │ invoices, webhook verify │
    │                                         └────────────┬─────────────┘
    └── POST /api/webhooks/paypal  ◀──────────────────────┘ INVOICING.INVOICE.PAID
```

## 5. Domain model

All money is stored as integer cents. Dates are ISO strings in UTC. Every project is a visitor's demo copy: `projects.created_at` is when the copy was created or last reset, and `last_seen_at` is when it was last opened.

| Entity | Key fields | Notes |
|:--|:--|:--|
| `Project` | id, client name, client email, title, hourly rate, hours per day, agreed on, due date | One per engagement |
| `ScopeItem` | id, project id, title, amount, position | The agreed scope, version 1 |
| `Message` | id, project id, from (`client` \| `me`), author, sent at, body | Pasted text, stored as written |
| `Finding` | id, message id, quote, quote start/end, title, estimated hours, reason | A phrase Claude marked; `quote` must be an exact substring of the body, and its offsets are stored so the screen never searches again |
| `ChangeOrder` | id, project id, finding id, title, hours, amount, extra days, status, PayPal invoice id, payer view URL, sent at, paid at, send claimed at | Created from a finding when the user reviews it. One live order per finding; after a cancel the finding can be quoted again. `send_claimed_at` marks a send in progress so a second request doesn't call PayPal; it expires after two minutes. |
| `ActivityEvent` | id (insertion order), project id, change order id, kind, actor, summary, detail (JSON), at | One line in the activity panel. Written in the same `db.batch()` as the state change it describes |
| `WebhookEvent` | PayPal event id (unique), type, received at, processed at | Makes webhook handling idempotent |

The database repeats the core rules as CHECK constraints (known status, no negative amounts, `sent` needs an invoice id, billed orders need an amount above zero, `paid` needs its dates in order), so a write that skips the domain code still can't store a broken order.

### Change order status

```
            send (creates + sends PayPal invoice)        paid webhook + invoice status PAID
  draft ───────────────────────────────────────▶ sent ──────────────────────────────────▶ paid
    │                                              │
    │ include at no charge                         │ cancel (cancels the PayPal invoice)
    ▼                                              ▼
  waived                                       cancelled
                                                   ▲
  draft ───────────────────────────────────────────┘
        the invoice under this number was already cancelled in PayPal
```

`draft → cancelled` happens only when PayPal reports that the invoice for this order's number is already cancelled (or can never be paid), so the finding can be quoted again instead of getting stuck.

Allowed transitions are defined once in `src/domain/change-order.ts`; everything else is rejected.

## 6. Key flows

**Review a message** (phase 4). The user pastes a client message. A server action stores it, sends the agreed scope plus the message to Claude, and asks for findings in a fixed JSON schema (quote, title, estimated hours, reason). The response is validated with zod; findings whose quote is not found in the message are dropped. Curly and straight quote marks match each other, a repeated phrase maps to its next free occurrence, and when two quotes overlap the longer one wins. Each finding becomes a `draft` change order priced at `hours × rate`, rounded up to the next $10.

**Send a change order.** The server action receives only the change order id and loads the amount, status, and client from the database. It checks that `draft → sent` is allowed and the amount is above zero, then marks the order as being sent with a single conditional update, so a second request for the same order stops there. If the order has no invoice id yet, it creates a draft PayPal invoice whose invoice number is derived from the change order id (`TG-` plus 22 base-36 characters). PayPal's Invoicing API ignores `PayPal-Request-Id` (checked in the sandbox on Oct 31, 2026: the same id created a new invoice each time), but it refuses a second invoice with the same number, even when both requests arrive at once. When it answers `DUPLICATE_INVOICE_NUMBER`, the app looks the invoice up by number, checks its reference and amount, and reuses it. The invoice id is saved before sending, so a retry reuses it. Sending again answers `INVOICE_ALREADY_SENT`, which counts as sent. After sending, it reads the invoice back and stores `detail.metadata.recipient_view_url` as the payer view URL, only if it is a `https://www.sandbox.paypal.com/invoice/p/` link, so the demo can open the client's view. PayPal's error names come from sandbox responses, not from the published schema, so any 422 the app doesn't recognize is treated as a rejection that changes nothing. If PayPal may already have sent the invoice but the app couldn't confirm it (the read-back failed, PayPal still showed a draft, or saving `sent` failed), the order stays a draft that holds the invoice id, the screen offers "Send again" instead of "Include at no charge", and sending again settles it. A draft that holds an invoice id, or is being sent, can't be waived. The whole server sends at most 10 invoices a minute and 200 a day (counted from activity events and in memory), so a public demo can't exhaust the shared sandbox account; per-copy limits come with the public demo work.

**Cancel a change order.** Only a `sent` order can be cancelled, after a confirmation step. The app asks PayPal to cancel the invoice; `INVOICE_CANCELED_ALREADY` counts as cancelled, and `CANNOT_CANCEL_PAID_INVOICE` leaves the order `sent` for the payment webhook or "Check payment" to settle. A cancelled order's finding can be quoted again: a new draft with a new id (so a new invoice number), priced again from the rate.

**Get paid** (phase 3). PayPal posts `INVOICING.INVOICE.PAID` to `/api/webhooks/paypal`. The handler reads the raw body as text (refusing bodies over 64 KB) and verifies it with `POST /v1/notifications/verify-webhook-signature`; the event is passed back exactly as received, because re-serializing it can fail verification. PayPal also sends this event for partial and pending payments, so the handler reads the invoice back and moves the order to `paid` only when the invoice status is `PAID`. Recording the event id and changing the order happen in one `db.batch()` (a single SQLite transaction); a conflict on the event id means a duplicate.

- No `PAYPAL_WEBHOOK_ID` configured: every webhook is rejected.
- PayPal's verification call fails: answer 5xx so PayPal retries.
- The order is still `draft` but holds that invoice id (the app stopped between sending and saving `sent`): record it as sent, then paid.
- Unknown invoices and repeated events: answer 200 and change nothing.

**Check payment** (phase 3). If the webhook is late, the freelancer can press "Check payment". It reads the invoice back and applies the same rule (only `PAID` marks the order paid), so a webhook and a click arriving together still change the order once.

**Waive.** `draft → waived` keeps the finding visible with no charge, so the record shows what was given for free. Waiving can't be undone, so the button asks for a second confirmation first.

**Reading the workspace.** `getWorkspace(db, projectId)` in `src/server/db/queries.ts` returns the project, its scope items, its messages with their findings (each with the stored quote offsets and the live change order), every change order, and the totals: agreed, with changes (agreed plus draft, sent and paid orders), and paid. Waived and cancelled orders are listed but never counted. The page goes through `openVisitorWorkspace`, which ensures the copy and reads it, trying once more if a cleanup removed the copy in between. The screen marks quotes only at the stored offsets and never searches the text again.

**Activity panel** (sending and cancelling since phase 2; review steps and the panel itself in phase 4). Reviewing and sending write short steps to a log shown beside the workspace: message read, findings proposed with their quotes, price computed from the rate, invoice created and sent, payment confirmed. It explains what the agent did; it never triggers a PayPal call by itself. Steps are stored in `activity_events`, written in the same batch as the state change, ordered by insertion. Failed PayPal calls are recorded with their step, HTTP status, issue, and debug id, never with credentials.

**Public demo.** `src/proxy.ts` gives a visitor without a valid `tg_visitor` cookie a random 256-bit id (HttpOnly, SameSite=Lax, Secure in production, seven days, renewed on each visit) and forwards it to the same request, so the first page render already sees it. The visitor's project id is a hash of that id (`v_` + 22 characters of SHA-256), so the cookie can't be recovered from the database and the same visitor always maps to the same copy. The page creates the copy the first time it renders for that id; two requests racing to create it end with one copy, because the project id is the primary key. Creating the copy and refreshing its `last_seen_at` (at most once an hour) are the only writes allowed during rendering. Every copy and every reset gets fresh random ids for its child rows, so a change order id (later the PayPal request id) is never reused. Reset replaces all rows of the copy in one batch. Copies not opened for seven days (`last_seen_at`) are deleted whenever a new copy is created, so a judge who returns days later still finds their copy. Server actions receive only ids, derive the project from the cookie, and answer `not_found` for anything outside the visitor's copy. Claude calls will be capped per copy and per day overall when scope review arrives (phase 4).

## 7. Directory layout

```
src/
  proxy.ts                  visitor cookie
  app/                      routes, layouts, server actions
    api/webhooks/paypal/    PayPal webhook route handler (phase 3)
  components/               UI (client components only where state is needed)
  domain/                   types, status rules, money math (no I/O)
  server/
    env.ts                  zod-validated environment
    visitor.ts, session.ts  visitor cookie helpers, current visitor and project
    db/                     Drizzle schema, client, demo copies, queries, change order commands
    billing.ts              sends, cancels and re-quotes change orders (database + PayPal)
    paypal/                 REST client: token, invoices (webhook verification in phase 3)
    ai/                     scope review prompt + Claude client (phase 4)
drizzle/                    SQL migrations generated by drizzle-kit
scripts/                    db.mts: migrate and seed from the command line
test/                       test-only helpers (fake PayPal); app code may not import them
docs/                       this file
```

## 8. Configuration

| Variable | Used by | Notes |
|:--|:--|:--|
| `PAYPAL_ENV` | paypal | `sandbox` for the hackathon; `live` refuses to start without both keys and the webhook id |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | paypal | REST app credentials |
| `PAYPAL_WEBHOOK_ID` | webhook route (phase 3) | From the app's webhook settings; required to verify signatures |
| `ANTHROPIC_API_KEY` | ai | Without it, message review is disabled and the UI says so |
| `DATABASE_URL` | db | Defaults to `file:data/tollgate.db`; on Render, point it at the disk, e.g. `file:/var/data/tollgate.db` |

## 9. Testing

- **Database writes:** statements that must land together use `db.batch()`. Interactive `db.transaction()` callbacks that await between statements are not used in request handling: libSQL's local client runs on the Node thread, so any other write during an open write transaction fails at once with `SQLITE_BUSY`, and a busy timeout only blocks the thread.
- **Unit (Vitest):** status transitions, pricing and rounding, finding validation, database constraints, demo copies (independence, concurrent creation, reset, seven-day cleanup by last use), the visitor cookie in `proxy.ts`, workspace queries and totals, the waive and reset actions refusing another copy's ids, PayPal token caching and the one 401 retry, invoice request bodies and error handling against recorded sandbox responses, the send and cancel commands with a fake PayPal (two sends at once create one invoice, a send interrupted after creating the invoice reuses it), activity order, PayPal client request shapes with `fetch` mocked, and, from phase 3, the webhook handler (verified, unverified, no webhook id configured, verification call failing, duplicate, unknown invoice, partial payment, draft recovery), check payment racing the webhook.
- **Sandbox, by hand (phase 3):** send a change order, pay it as the sandbox buyer, watch the webhook arrive. Locally the webhook needs a tunnel. Events from PayPal's webhook simulator can't pass signature verification, so the simulator only shows the route is reachable.
- **Sandbox (`pnpm accept:sandbox`):** runs against the real PayPal sandbox with the keys in `.env.local`, outside `pnpm check`; it sends twice at once and counts the invoices for that change order with the search API, then cancels what it sent.
- **Browser (Playwright, `pnpm e2e`):** one production build, the installed Chrome, and fresh throwaway databases; phase 1 tests run on a server without PayPal keys, PayPal tests on one with them; two browser contexts get separate copies, state survives reload, reset restores the seed, and a forged id from another copy is refused.
- Every commit passes `pnpm check` (lint, typecheck, test) and `pnpm build`.

## 10. Deployment

Render web service on the Starter plan with a 1 GB persistent disk for the SQLite file, paid from the hackathon's Render credit (free web services can't attach a disk). The disk is mounted only at runtime, so migrations will run when the app starts (added with the first deploy), not at build or pre-deploy. With a disk attached, Render stops the old instance before starting the new one, so every deploy has a few seconds of downtime. Render deploys the `deploy` branch with auto-deploy off; every deploy is started by hand. From the first deploy on, each phase that changes product code deploys its candidate commit, checks the live app, and either moves `deploy` to the new passing tag or rolls back to the last deployed passing tag (the very first deploy has nothing to roll back to, so its fix is redeployed); during judging (Dec 1–15, 2026) only outage fixes are deployed. From phase 3, `/api/health` will check the database and a PayPal token, and a daily check will alert the maintainer when it fails. The demo, sandbox credentials, Anthropic balance, and Bryntum trial must all last through judging. Fallback: Vercel with a hosted libSQL database.

## 11. Decisions

| Decision | Why | Revisit if |
|:--|:--|:--|
| Invoice number derived from the change order id is the idempotency key for PayPal, plus a send claim in the database | Invoicing ignores `PayPal-Request-Id` in the sandbox; PayPal enforces unique invoice numbers atomically | PayPal starts honoring the request id for invoices |
| Direct REST client for invoices, not the Agent Toolkit | Sending money-related documents must be deterministic and testable; the toolkit fits an assistant better than a button | We add a chat assistant (not planned for the hackathon) |
| Per-visitor demo copies instead of accounts | Judges can send and pay a real sandbox invoice without signing up, and can't touch each other's data | Abuse or Claude cost gets out of hand |
| Render Starter + disk, not Vercel | The SQLite file has to survive deploys; Vercel's filesystem doesn't keep it | We move to hosted libSQL |
| Claude for review, JSON schema output | Needs reasoning over two texts and an exact quote back | Cost or latency is a problem |
| SQLite through libSQL + Drizzle | Zero setup for judges running locally, one file to back up | We need concurrent writers |
| Hours from the model, price from the rate | Keeps prices explainable and stops the model inventing numbers | — |
| English UI | Judges and the target clients are international | — |
