// The server-wide cap on PayPal sends (P2-S1). Every demo copy shares one PayPal sandbox app, so a visitor looping
// "send, reset, send" could get that app rate limited (429) for everyone, in the middle of a demo too. A cap per
// copy comes in P5; this one holds however many copies or cookies are used. The count lives in the paypal_sends
// table (server/db/paypal-sends.ts), which resets and cleanups never touch (P2-S1b).

export interface SendLimit {
  windowMs: number;
  max: number; // sends allowed within the window
}

export const SEND_LIMITS = [
  { windowMs: 60 * 1000, max: 10 },
  { windowMs: 24 * 60 * 60 * 1000, max: 200 },
] as const satisfies readonly SendLimit[];
