# ScopeGuard architecture

This document is the plan the code follows. When the code and this file disagree, fix one of them in the same commit.

## 1. Product in one paragraph

Freelancers agree on a scope with a client, then the client keeps adding requests in chat and email. ScopeGuard compares each new client message with the agreed scope, marks the phrases that add work, and proposes a change order priced from the freelancer's own hourly rate. The freelancer approves it, ScopeGuard sends a PayPal invoice, and a PayPal webhook marks it paid. A timeline shows how each change moves the delivery date and which phases wait on payment.

**Who:** solo freelancers and small studios billing clients abroad in USD. **Core loop:** paste message, review marks, send change order, get paid.

## 2. Scope of the hackathon build

| Must (MVP) | Later, if time allows | Not doing |
|:--|:--|:--|
| One project with agreed scope items and an hourly rate | Bryntum Gantt timeline (trial starts after Nov 1 so it covers judging) | Accounts, sign-up, teams |
| Paste a client message, Claude marks scope additions | Payouts to split a paid change order with a collaborator | Multi-currency (USD only) |
| Change order lifecycle: draft, sent, paid, waived, cancelled | Agent Toolkit assistant ("what is unpaid?", "send a reminder") | Email or chat inbox integration |
| PayPal invoice per change order (create + send) | Invoice for the agreed scope itself | Mobile app |
| Webhook marks paid, totals update | | Live PayPal (sandbox only) |
| Seeded demo project so judges can try it without setup | | |

## 3. Principles

1. **The agent proposes, the person approves.** No PayPal call happens without a click from the freelancer. Claude never sees PayPal credentials and never moves money.
2. **Prices come from the freelancer's rate, not from the model.** Claude estimates hours; the app computes `hours × hourly rate`. The reasoning shown to the user is the model's, the arithmetic is ours.
3. **Every money state change is idempotent.** A double click, a retried request, or a duplicate webhook must not create a second invoice or flip a status twice.
4. **Domain logic is plain TypeScript.** Status rules and money math live in `src/domain` with no framework or I/O, so they are unit tested.
5. **Public repo hygiene.** Secrets live only in `.env.local` / the host's env. Sample data is fictional.

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

The database repeats the core rules as CHECK constraints (known status, no negative amounts, `sent` needs an invoice id, `paid` needs its dates), so a write that skips the domain code still can't store a broken order.

### Change order status

```
            send (creates + sends PayPal invoice)        INVOICING.INVOICE.PAID
  draft ───────────────────────────────────────▶ sent ────────────────────────▶ paid
    │                                              │
    │ include at no charge                         │ cancel (cancels the PayPal invoice)
    ▼                                              ▼
  waived                                       cancelled
```

Allowed transitions are defined once in `src/domain/change-order.ts`; everything else is rejected.

## 6. Key flows

**Review a message.** The user pastes a client message. A server action stores it, sends the agreed scope plus the message to Claude, and asks for findings in a fixed JSON schema (quote, title, estimated hours, reason). The response is validated with zod; findings whose quote is not found in the message are dropped. Curly and straight quote marks match each other, a repeated phrase maps to its next free occurrence, and when two quotes overlap the longer one wins. Each finding becomes a `draft` change order priced at `hours × rate`, rounded up to the next $10.

**Send a change order.** On click: load the order, check the transition `draft → sent` is allowed, create a draft PayPal invoice if the order has no invoice id yet, then send it. The invoice id is saved before sending, so a retry reuses it instead of creating another. The payer view URL is stored so the demo can open the client's view of the invoice.

**Get paid.** PayPal posts `INVOICING.INVOICE.PAID` to `/api/webhooks/paypal`. The handler reads the raw body as text, verifies it with `POST /v1/notifications/verify-webhook-signature` (the event is passed back exactly as received; re-serializing it can fail verification), records the event id, and moves the matching change order to `paid`. Unknown or repeated events return 200 and change nothing.

**Waive.** `draft → waived` keeps the finding visible with no charge, so the record shows what was given for free.

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
docs/                       this file
```

## 8. Configuration

| Variable | Used by | Notes |
|:--|:--|:--|
| `PAYPAL_ENV` | paypal | `sandbox` for the hackathon |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | paypal | REST app credentials |
| `PAYPAL_WEBHOOK_ID` | webhook route | From the app's webhook settings; required to verify signatures |
| `ANTHROPIC_API_KEY` | ai | Without it, message review is disabled and the UI says so |
| `DATABASE_URL` | db | Defaults to `file:data/scopeguard.db` |

## 9. Testing

- **Unit (Vitest):** status transitions, pricing and rounding, finding validation, PayPal client request shapes with `fetch` mocked, webhook handler (verified, unverified, duplicate, unknown invoice).
- **Sandbox, by hand:** send a change order, pay it as the sandbox buyer, watch the webhook arrive. Locally the webhook needs a tunnel or PayPal's webhook simulator.
- Every commit passes `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## 10. Deployment

Render web service with a persistent disk for the SQLite file (Render is a hackathon sponsor and offers credits). Fallback: Vercel with a hosted libSQL database. The demo and sandbox credentials must stay up through the judging period (Dec 1–15, 2026).

## 11. Decisions

| Decision | Why | Revisit if |
|:--|:--|:--|
| Direct REST client for invoices, not the Agent Toolkit | Sending money-related documents must be deterministic and testable; the toolkit fits an assistant better than a button | We add the assistant (Later) |
| Claude for review, JSON schema output | Needs reasoning over two texts and an exact quote back | Cost or latency is a problem |
| SQLite through libSQL + Drizzle | Zero setup for judges running locally, one file to back up | We need concurrent writers |
| Hours from the model, price from the rate | Keeps prices explainable and stops the model inventing numbers | — |
| English UI | Judges and the target clients are international | — |
