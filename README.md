# ScopeGuard

Catch scope creep in client messages and bill it with PayPal before you do the extra work.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (2026). Work in progress.

## The problem

Freelancers who work with overseas clients agree on a scope, then the requests keep coming in chat and email: "could you also add…". Each one feels too small to price, so the extra work goes unpaid, and asking for money later feels awkward. Getting paid in USD from abroad is its own chore.

## How it works

1. Paste a new client message into the project.
2. Claude compares it with the agreed scope and marks the phrases that add work, with a suggested price and extra days.
3. You review the mark and send a change order. ScopeGuard creates and sends a PayPal invoice for it.
4. When the client pays, a PayPal webhook marks the change order as paid and the project total updates.

The agent proposes; nothing is billed until you approve it.

## Built with

- Next.js 16, TypeScript, Tailwind CSS 4
- PayPal REST APIs in the sandbox: Invoicing, Webhooks (Payouts planned for splitting with collaborators)
- PayPal Agent Toolkit
- Claude (Anthropic API) for scope comparison

## Run locally

```bash
pnpm install
cp .env.example .env.local   # add PayPal sandbox and Anthropic keys
pnpm dev
```

## Trying it in the PayPal sandbox

Judge test steps and a sandbox buyer account will be listed in the Devpost submission.

## License

[MIT](LICENSE)
