// The time zone is fixed: the server (UTC) and a browser elsewhere must print the same day,
// or hydration would disagree.
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// "2026-10-21" or "2026-10-21T08:12:00Z" → "Oct 21". Anything that isn't a date is shown as written.
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : shortDate.format(date);
}
