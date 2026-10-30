// Splits a message body at the stored quote offsets. The text is never searched again:
// a span that doesn't fit the body (or no longer matches its quote) is skipped and the text stays as written.

export interface MarkSpan {
  id: string;
  start: number;
  end: number;
  quote: string;
}

export type BodySegment = { kind: "text"; text: string } | { kind: "mark"; text: string; id: string };

export function segmentBody(body: string, spans: readonly MarkSpan[]): BodySegment[] {
  const segments: BodySegment[] = [];
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const fits =
      Number.isInteger(span.start) &&
      Number.isInteger(span.end) &&
      span.start >= cursor && // also drops a span overlapping the previous mark
      span.end > span.start &&
      span.end <= body.length &&
      body.slice(span.start, span.end) === span.quote;
    if (!fits) continue;
    if (span.start > cursor) segments.push({ kind: "text", text: body.slice(cursor, span.start) });
    segments.push({ kind: "mark", text: span.quote, id: span.id });
    cursor = span.end;
  }
  if (cursor < body.length) segments.push({ kind: "text", text: body.slice(cursor) });
  return segments;
}
