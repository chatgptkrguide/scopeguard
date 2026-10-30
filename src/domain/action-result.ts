// What a server action tells the browser. Never a database row: only whether it worked and why not.
export const ACTION_ERRORS = ["invalid_input", "not_found", "invalid_state"] as const;
export type ActionError = (typeof ACTION_ERRORS)[number];
export type ActionResult = { ok: true } | { ok: false; error: ActionError };
