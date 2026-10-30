// libSQL reports constraint failures by extended code. A batch throws the libSQL error itself;
// a single Drizzle query wraps it, with the libSQL error as its cause.
const UNIQUE_CODES: ReadonlySet<string> = new Set(["SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_UNIQUE"]);

function extendedCode(value: unknown): unknown {
  return typeof value === "object" && value !== null && "extendedCode" in value ? value.extendedCode : undefined;
}

function causeOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && "cause" in value ? value.cause : undefined;
}

// True when a write lost to an existing primary key or unique value (a duplicate, not a bug).
export function isUniqueViolation(error: unknown): boolean {
  const code = extendedCode(error) ?? extendedCode(causeOf(error));
  return typeof code === "string" && UNIQUE_CODES.has(code);
}
