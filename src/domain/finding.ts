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

// Curly and straight quote marks count as the same character. Each swap keeps the string length,
// so offsets found in the folded text still point into the original body.
function foldQuoteMarks(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

export function locateFindings(body: string, drafts: readonly FindingDraft[]): LocatedFinding[] {
  const haystack = foldQuoteMarks(body);
  const seen = new Set<string>();
  const valid = drafts.filter((d) => {
    if (!(d.quote.trim() && d.title.trim() && d.estimatedHours > 0 && d.estimatedHours <= MAX_HOURS)) return false;
    // The model sometimes repeats a finding word for word; only a different title marks a second request.
    const key = [foldQuoteMarks(d.quote.trim()), d.title.trim(), d.reason.trim()].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Longer quotes claim their span first, so a broad request beats a fragment of it.
  const byLength = [...valid].sort((a, b) => b.quote.trim().length - a.quote.trim().length);

  const kept: LocatedFinding[] = [];
  for (const draft of byLength) {
    const needle = foldQuoteMarks(draft.quote.trim());
    const start = firstFreeOccurrence(haystack, needle, kept);
    if (start < 0) continue;
    const end = start + needle.length;
    kept.push({ ...draft, quote: body.slice(start, end), title: draft.title.trim(), start, end });
  }
  return kept.sort((a, b) => a.start - b.start);
}

// The first place the quote appears that no kept finding already covers, or -1.
function firstFreeOccurrence(haystack: string, needle: string, taken: readonly LocatedFinding[]): number {
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (taken.every((f) => end <= f.start || at >= f.end)) return at;
  }
  return -1;
}
