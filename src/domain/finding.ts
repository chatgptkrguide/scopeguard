// Model output is untrusted: keep only findings that quote the message exactly and don't overlap.

export interface FindingDraft {
  quote: string;
  title: string;
  estimatedHours: number;
  reason: string;
}

export interface LocatedFinding extends FindingDraft {
  start: number;
  end: number;
}

const MAX_HOURS = 200;

export function locateFindings(body: string, drafts: readonly FindingDraft[]): LocatedFinding[] {
  const located: LocatedFinding[] = [];
  for (const draft of drafts) {
    const quote = draft.quote.trim();
    const title = draft.title.trim();
    if (!quote || !title) continue;
    if (!(draft.estimatedHours > 0) || draft.estimatedHours > MAX_HOURS) continue;
    const start = body.indexOf(quote);
    if (start < 0) continue;
    located.push({ ...draft, quote, title, start, end: start + quote.length });
  }
  located.sort((a, b) => a.start - b.start);
  const kept: LocatedFinding[] = [];
  for (const f of located) {
    const last = kept.at(-1);
    if (!last || f.start >= last.end) kept.push(f);
  }
  return kept;
}
