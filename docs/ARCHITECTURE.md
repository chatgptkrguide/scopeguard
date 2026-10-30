# Tollgate architecture

This document is the plan the code follows. When the code and this file disagree, fix one of them in the same commit.

## 1. Product in one paragraph

Freelancers agree on a scope with a client, then the client keeps adding requests in chat and email. Tollgate compares each new client message with the agreed scope, marks the phrases that add work, and proposes a change order priced from the freelancer's own hourly rate. The freelancer approves it, Tollgate sends a PayPal invoice, and a PayPal webhook marks it paid. Extra work stays locked on a timeline until its change order is paid; the payment webhook unlocks it and moves the delivery date.

**Who:** solo freelancers and small studios billing clients abroad in USD. **Core loop:** paste message, review marks, send change order, get paid.

## 2. Scope of the hackathon build

| Must (MVP) | Should, once the core loop runs on the deployed app | Not doing |
|:--|:--|:--|
| One project with agreed scope items and an hourly rate | Timeline where an unpaid change order locks its phase until PayPal confirms payment (Bryntum; trial starts Nov 9 so it covers judging) | Accounts, sign-up, teams |
| Paste a client message, Claude marks scope additions | Invoice for the agreed scope itself | Multi-currency (USD only) |
| Change order lifecycle: draft, sent, paid, waived, cancelled | | Email or chat inbox integration |
| PayPal invoice per change order (create, send, read the payer link) | | Mobile app |
| Webhook confirms payment, totals update | | Live PayPal (sandbox only) |
| Activity panel: each step Claude and the app took, including what went to PayPal | | Payouts and Orders APIs |
| Public demo: every visitor gets their own sandbox copy of the demo project | | Agent Toolkit chat assistant |

## 3. Principles

1. **The agent proposes, the person approves.** No PayPal call happens without a click from the freelancer. Claude never sees PayPal credentials and never moves money.
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

All money is stored as integer cents. Dates are ISO strings in UTC.

| Entity | Key fields | Notes |
|:--|:--|:--|
| `Project` | id, client name, client email, title, hourly rate, hours per day, agreed on, due date | One per engagement |
| `ScopeItem` | id, project id, title, amount, position | The agreed scope, version 1 |
| `Message` | id, project id, from (`client` \| `me`), author, sent at, body | Pasted text, stored as written |
| `Finding` | id, message id, quote, quote start/end, title, estimated hours, reason | A phrase Claude marked; `quote` must be an exact substring of the body, and its offsets are stored so the screen never searches again |
| `ChangeOrder` | id, project id, finding id, title, hours, amount, extra days, status, PayPal invoice id, payer view URL, sent at, paid at | Created from a finding when the user reviews it. One live order per finding; after a cancel the finding can be quoted again |
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
```

Allowed transitions are defined once in `src/domain/change-order.ts`; everything else is rejected.

## 6. Key flows

**Review a message.** The user pastes a client message. A server action stores it, sends the agreed scope plus the message to Claude, and asks for findings in a fixed JSON schema (quote, title, estimated hours, reason). The response is validated with zod; findings whose quote is not found in the message are dropped. Curly and straight quote marks match each other, a repeated phrase maps to its next free occurrence, and when two quotes overlap the longer one wins. Each finding becomes a `draft` change order priced at `hours × rate`, rounded up to the next $10.

**Send a change order.** The server action receives only the change order id and loads the amount and status from the database. It checks that `draft → sent` is allowed, then creates a draft PayPal invoice if the order has no invoice id yet, with `PayPal-Request-Id` set to the change order id so a doubled or retried request gets the same invoice back. The invoice id is saved before sending, so a retry reuses it. After sending, it reads the invoice back and stores `detail.metadata.recipient_view_url` as the payer view URL, so the demo can open the client's view.

**Get paid.** PayPal posts `INVOICING.INVOICE.PAID` to `/api/webhooks/paypal`. The handler reads the raw body as text (refusing bodies over 64 KB) and verifies it with `POST /v1/notifications/verify-webhook-signature`; the event is passed back exactly as received, because re-serializing it can fail verification. PayPal also sends this event for partial and pending payments, so the handler reads the invoice back and moves the order to `paid` only when the invoice status is `PAID`. Recording the event id and changing the order happen in one transaction; a conflict on the event id means a duplicate.

- No `PAYPAL_WEBHOOK_ID` configured: every webhook is rejected.
- PayPal's verification call fails: answer 5xx so PayPal retries.
- The order is still `draft` but holds that invoice id (the app stopped between sending and saving `sent`): record it as sent, then paid.
- Unknown invoices and repeated events: answer 200 and change nothing.

**Waive.** `draft → waived` keeps the finding visible with no charge, so the record shows what was given for free.

**Activity panel.** Reviewing and sending write short steps to a log shown beside the workspace: message read, findings proposed with their quotes, price computed from the rate, invoice created and sent, payment confirmed. It explains what the agent did; it never triggers a PayPal call by itself.

**Public demo.** A visitor without a demo cookie gets a fresh copy of the demo project under a new id, tied to a random cookie, and can reset it. Claude calls are capped per copy and per day overall. Copies older than seven days are deleted.

## 7. Directory layout

```
src/
  app/                      routes, layouts, server actions
    api/webhooks/paypal/    PayPal webhook route handler
  components/               UI (client components only where state is needed)
  domain/                   types, status rules, money math (no I/O)
  server/
    env.ts                  zod-validated environment
    db/                     Drizzle schema, client, queries, seed
    paypal/                 REST client: token, invoices, webhook verification
    ai/                     scope review prompt + Claude client
  lib/                      sample data for the static screen (goes away once the screen reads the database)
drizzle/                    SQL migrations generated by drizzle-kit
scripts/                    db.mts: migrate and seed from the command line
docs/                       this file
```

## 8. Configuration

| Variable | Used by | Notes |
|:--|:--|:--|
| `PAYPAL_ENV` | paypal | `sandbox` for the hackathon; `live` refuses to start without both keys and the webhook id |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | paypal | REST app credentials |
| `PAYPAL_WEBHOOK_ID` | webhook route | From the app's webhook settings; required to verify signatures |
| `ANTHROPIC_API_KEY` | ai | Without it, message review is disabled and the UI says so |
| `DATABASE_URL` | db | Defaults to `file:data/tollgate.db`; on Render, point it at the disk, e.g. `file:/var/data/tollgate.db` |

## 9. Testing

- **Unit (Vitest):** status transitions, pricing and rounding, finding validation, database constraints and seed, PayPal client request shapes with `fetch` mocked, webhook handler (verified, unverified, duplicate, unknown invoice, partial payment).
- **Sandbox, by hand:** send a change order, pay it as the sandbox buyer, watch the webhook arrive. Locally the webhook needs a tunnel. Events from PayPal's webhook simulator can't pass signature verification, so the simulator only shows the route is reachable.
- Every commit passes `pnpm check` (lint, typecheck, test) and `pnpm build`.

## 10. Deployment

Render web service on the Starter plan with a 1 GB persistent disk for the SQLite file, paid from the hackathon's Render credit (free web services can't attach a disk). The disk is mounted only at runtime, so migrations run when the app starts, not at build or pre-deploy. With a disk attached, Render stops the old instance before starting the new one, so every deploy has a few seconds of downtime: no deploys during judging (Dec 1–15, 2026). The demo, sandbox credentials, Anthropic balance, and Bryntum trial must all last through judging. Fallback: Vercel with a hosted libSQL database.

## 11. Decisions

| Decision | Why | Revisit if |
|:--|:--|:--|
| Direct REST client for invoices, not the Agent Toolkit | Sending money-related documents must be deterministic and testable; the toolkit fits an assistant better than a button | We add a chat assistant (not planned for the hackathon) |
| Per-visitor demo copies instead of accounts | Judges can send and pay a real sandbox invoice without signing up, and can't touch each other's data | Abuse or Claude cost gets out of hand |
| Render Starter + disk, not Vercel | The SQLite file has to survive deploys; Vercel's filesystem doesn't keep it | We move to hosted libSQL |
| Claude for review, JSON schema output | Needs reasoning over two texts and an exact quote back | Cost or latency is a problem |
| SQLite through libSQL + Drizzle | Zero setup for judges running locally, one file to back up | We need concurrent writers |
| Hours from the model, price from the rate | Keeps prices explainable and stops the model inventing numbers | — |
| English UI | Judges and the target clients are international | — |
