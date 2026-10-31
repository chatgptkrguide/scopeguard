// What a server action tells the browser. Never a database row: only whether it worked and why not.
// server_error means the database failed (busy or unreachable) and nothing changed, so trying again may work.
export const ACTION_ERRORS = ["invalid_input", "not_found", "invalid_state", "server_error"] as const;
export type ActionError = (typeof ACTION_ERRORS)[number];
export type ActionResult = { ok: true } | { ok: false; error: ActionError };
