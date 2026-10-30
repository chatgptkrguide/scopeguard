import { z } from "zod";

// Empty values from a copied .env.example count as "not set".
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optional = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const schema = z
  .object({
    DATABASE_URL: z.preprocess(emptyToUndefined, z.string().default("file:data/tollgate.db")),
    PAYPAL_ENV: z.preprocess(emptyToUndefined, z.enum(["sandbox", "live"]).default("sandbox")),
    PAYPAL_CLIENT_ID: optional,
    PAYPAL_CLIENT_SECRET: optional,
    PAYPAL_WEBHOOK_ID: optional,
    ANTHROPIC_API_KEY: optional,
  })
  .superRefine((env, ctx) => {
    // Live mode moves real money, so it never starts half-configured.
    if (env.PAYPAL_ENV === "live" && !(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && env.PAYPAL_WEBHOOK_ID)) {
      ctx.addIssue({ code: "custom", message: "PAYPAL_ENV=live needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID" });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  return schema.parse(source);
}
