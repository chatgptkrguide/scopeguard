import "server-only";
import { countCopiesCreatedSince, type MayCreateCopy } from "./db/demo";

// Limits on making new demo copies. A request without a cookie gets a new visitor (proxy.ts), and its first page
// view writes a copy of about 13 rows, so a bot repeating GET / would otherwise grow the database without end.
// A refused visitor still sees the demo: the page renders the seed from memory (previewWorkspace) and writes nothing.

// New copies from one IP address per hour. A person needs one; a few more cover a team behind one NAT, or someone
// trying several browsers.
export const NEW_COPIES_PER_IP_PER_HOUR = 10;
export const IP_WINDOW_MS = 60 * 60 * 1000;
// New copies on the whole server in any 24 hours. Copies live seven days, so at most about 7 × this many exist
// (about 3,500 copies, ~45,000 rows: a few MB of the 1 GB disk) whatever the IP addresses look like.
export const NEW_COPIES_PER_DAY = 500;
export const DAY_MS = 24 * 60 * 60 * 1000;
// Addresses remembered at once. Past this, finished windows are dropped first, then everything; the daily cap
// still holds then.
const MAX_TRACKED_ADDRESSES = 10_000;

interface Window {
  startedAt: number;
  count: number;
}

// A fixed one-hour window per address, kept in this process's memory. The app runs as one instance (Render, one
// disk), so this sees every request; a restart forgets the counts, and the database-backed daily cap still holds.
export class AddressLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number = NEW_COPIES_PER_IP_PER_HOUR,
    private readonly windowMs: number = IP_WINDOW_MS,
    private readonly maxAddresses: number = MAX_TRACKED_ADDRESSES,
  ) {}

  // Counts one new copy for the address and says whether it is allowed.
  take(address: string, now: Date): boolean {
    const at = now.getTime();
    const current = this.windows.get(address);
    if (current && at - current.startedAt < this.windowMs) {
      if (current.count >= this.limit) return false;
      current.count += 1;
      return true;
    }
    if (!current && this.windows.size >= this.maxAddresses) this.prune(at);
    this.windows.set(address, { startedAt: at, count: 1 });
    return true;
  }

  get size(): number {
    return this.windows.size;
  }

  private prune(at: number): void {
    for (const [address, window] of this.windows) {
      if (at - window.startedAt >= this.windowMs) this.windows.delete(address);
    }
    if (this.windows.size >= this.maxAddresses) this.windows.clear();
  }
}

// `next start` fills X-Forwarded-For with the loopback address when no proxy did, so every local visitor (a judge
// running it locally, the browser tests) would share one allowance. Behind Render's proxy a client is never loopback.
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/i;

// The client's address as Render's proxy forwards it: the first X-Forwarded-For entry, else X-Real-IP. Null when
// neither is set or it is loopback (local runs, which then meet only the daily cap). A client can put its own
// value in X-Forwarded-For, so this limit slows ordinary bots; the daily cap is the bound that always holds.
export function clientAddress(headers: Pick<Headers, "get">): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || headers.get("x-real-ip")?.trim();
  if (!address || LOOPBACK.test(address)) return null;
  return address.slice(0, 64);
}

const sharedLimiter = new AddressLimiter();

// The check ensureDemoCopy runs before it writes a new copy. The daily cap is checked first, so a refusal there
// doesn't use up the address's allowance.
export function demoCopyGate(
  address: string | null,
  { limiter = sharedLimiter, dailyCap = NEW_COPIES_PER_DAY }: { limiter?: AddressLimiter; dailyCap?: number } = {},
): MayCreateCopy {
  return async (db, now) => {
    const createdToday = await countCopiesCreatedSince(db, new Date(now.getTime() - DAY_MS));
    if (createdToday >= dailyCap) return false;
    return address === null || limiter.take(address, now);
  };
}
