"use client";

import { useActionState } from "react";
import { resetDemo } from "@/app/actions";
import type { ActionError } from "@/domain/action-result";

export interface ResetDemoProps {
  projectId: string;
}

const errorText: Record<ActionError, string> = {
  invalid_input: "This isn't your demo copy. Reload the page.",
  not_found: "This isn't your demo copy. Reload the page.",
  invalid_state: "The demo changed while resetting. Reload the page.", // reset never returns this today
  server_error: "The demo couldn't be reset just now. Nothing changed; try again.",
};

// Puts the visitor's copy back to the starting demo. The server checks the id against the visitor cookie.
export function ResetDemo({ projectId }: ResetDemoProps) {
  const [state, resetAction, pending] = useActionState(resetDemo, null);

  return (
    <form action={resetAction} data-action="reset-demo" className="flex flex-col items-end gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending || undefined}
        className="min-h-11 rounded-md border border-rule bg-sheet px-3 text-sm font-semibold text-ink-soft hover:border-ink-soft hover:text-ink disabled:cursor-wait disabled:opacity-60"
      >
        Reset demo
      </button>
      {state && !state.ok && (
        <p role="alert" className="text-sm font-semibold text-mark">
          {errorText[state.error]}
        </p>
      )}
    </form>
  );
}
