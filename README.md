# Tollgate

Catch scope creep in client messages and bill it with PayPal before you do the extra work.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (2026). Work in progress.

## The problem

Freelancers who work with overseas clients agree on a scope, then the requests keep coming in chat and email: "could you also add…". Each one feels too small to price, so the extra work goes unpaid, and asking for money later feels awkward. Getting paid in USD from abroad is its own chore.

## How it works

1. Paste a new client message into the project.
2. Claude compares it with the agreed scope and marks the phrases that add work. It estimates the hours; the price comes from your own hourly rate.
3. You review the mark and send a change order. Tollgate creates and sends a PayPal invoice for it.
4. When the client pays, a PayPal webhook marks the change order as paid and the project total updates.

The agent proposes; nothing is billed until you approve it. The design and the plan the code follows are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Built with

- Next.js 16, TypeScript, Tailwind CSS 4
- PayPal REST APIs in the sandbox: Invoicing and Webhooks
- Claude (Anthropic API) for scope review
- SQLite through libSQL and Drizzle

## Run locally

```bash
pnpm install
cp .env.example .env.local   # add PayPal sandbox and Anthropic keys
pnpm db:seed                 # create data/tollgate.db with the demo project
pnpm dev
```

## Trying it in the PayPal sandbox

Judge test steps and a sandbox buyer account will be listed in the Devpost submission.

## License

[MIT](LICENSE)
