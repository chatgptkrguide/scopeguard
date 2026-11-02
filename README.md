# Tollgate

Catch scope creep in client messages and bill it with PayPal before you do the extra work.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (2026). Work in progress.

## The problem

Freelancers who work with overseas clients agree on a scope, then the requests keep coming in chat and email: "could you also add…". Each one feels too small to price, so the extra work goes unpaid, and asking for money later feels awkward. Getting paid in USD from abroad is its own chore.

## How it works

The goal:

1. Paste a new client message into the project.
2. Claude compares it with the agreed scope and marks the phrases that add work. It estimates the hours; the price comes from your own hourly rate.
3. You review the mark and send a change order. Tollgate creates and sends a PayPal invoice for it.
4. When the client pays, a PayPal webhook marks the change order as paid and the project total updates.

The agent proposes; nothing is billed until you approve it. The design and the plan the code follows are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What works today

Steps 3 and 4 are built; steps 1 and 2 (pasting a message and Claude's review) are not yet.

- **Demo copy.** Each browser gets its own copy of one sample project (a fictional coffee shop client), with its scope, messages and change orders stored in SQLite. "Reset demo" asks for a confirmation, then starts the copy over; it refuses while a change order has a PayPal invoice the client can still pay, so a payment is never left with nothing to record it. Copies unused for seven days are deleted, except one with such an invoice.
- **Scope marks: sample data, not Claude yet.** The two marked phrases and their hour estimates are written into the demo by hand. The message box and its "Check scope" button are shown switched off, and no code calls the Anthropic API; `ANTHROPIC_API_KEY` is read but unused. Claude scope review is planned for phase 4. Prices are computed from the project's hourly rate.
- **PayPal invoices (sandbox).** "Send change order" creates and sends a PayPal invoice from the order's database row; a sent invoice can be cancelled, a cancelled order quoted again, and a draft included at no charge. Without sandbox keys the send button stays off and says why. The whole server sends at most 10 invoices a minute and 200 a day.
- **Payment webhook.** `POST /api/webhooks/paypal` handles `INVOICING.INVOICE.PAID`: it checks the signature with PayPal (`verify-webhook-signature`, using `PAYPAL_WEBHOOK_ID`), reads the invoice back from PayPal, and marks the order paid only if the reference, amount and currency match; the totals then show it as paid. Without `PAYPAL_WEBHOOK_ID` every event is refused with 503, so PayPal retries later. The handler is covered by unit tests with a stand-in PayPal; a delivery from PayPal to the deployed app has not been checked yet. "Check payment" on a sent order reads the same invoice from PayPal and settles it the same way, so a payment can be confirmed without the webhook.
- **Health and deploy.** `/api/health/live` checks the database, `/api/health` also gets a PayPal token. `render.yaml` defines the Render service; the first deploy is in progress.

## Built with

- Next.js 16, TypeScript, Tailwind CSS 4, Node.js 22
- PayPal REST APIs in the sandbox: Invoicing and Webhooks
- Claude (Anthropic API) for scope review (planned, phase 4)
- SQLite through libSQL and Drizzle

## Run locally

Needs Node.js 22 (`.nvmrc`) and pnpm 10.

```bash
pnpm install
cp .env.example .env.local   # optional: PayPal sandbox keys; without them sending stays off
pnpm db:migrate              # create data/tollgate.db; each browser gets its own demo copy on first visit
pnpm dev
```

The webhook needs a public URL, so locally use "Check payment" (or a tunnel) to see a payment arrive. `pnpm check` runs lint, typecheck and the unit tests; `pnpm e2e` builds the app and runs the browser tests.

## Trying it in the PayPal sandbox

Judge test steps and a sandbox buyer account will be listed in the Devpost submission.

## License

[MIT](LICENSE)
