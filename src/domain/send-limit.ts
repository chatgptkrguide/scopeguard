// The server-wide cap on PayPal sends (P2-S1). Every demo copy shares one PayPal sandbox app, so a visitor looping
// "send, reset, send" could get that app rate limited (429) for everyone, in the middle of a demo too. A cap per
// copy comes in P5; this one holds however many copies or cookies are used.

export interface SendLimit {
  windowMs: number;
  max: number; // sends allowed within the window
}

export const SEND_LIMITS = [
  { windowMs: 60 * 1000, max: 10 },
  { windowMs: 24 * 60 * 60 * 1000, max: 200 },
] as const satisfies readonly SendLimit[];

const LONGEST_WINDOW_MS = Math.max(...SEND_LIMITS.map((limit) => limit.windowMs));

// The sends this server process let through (ms since the epoch), kept for the longest window. The database's
// count survives a restart; this one survives a demo reset, which deletes that copy's activity rows.
export interface SendLog {
  times: number[];
}

export function createSendLog(): SendLog {
  return { times: [] };
}

// Takes one send if every window still has room, or answers false and records nothing. A window's count is the
// larger of this process's log and the database's count for it (`stored[i]` goes with SEND_LIMITS[i]). It never
// awaits, so two requests in one process can't both take the last place.
export function takeSend(log: SendLog, at: Date, stored: readonly number[]): boolean {
  const now = at.getTime();
  log.times = log.times.filter((time) => time > now - LONGEST_WINDOW_MS);
  const full = SEND_LIMITS.some((limit, i) => {
    const logged = log.times.filter((time) => time > now - limit.windowMs).length;
    return Math.max(logged, stored[i] ?? 0) >= limit.max;
  });
  if (full) return false;
  log.times.push(now);
  return true;
}
