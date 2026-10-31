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
// A quiet text button: a demo utility, not part of the contract under review.
export function ResetDemo({ projectId }: ResetDemoProps) {
  const [state, resetAction, pending] = useActionState(resetDemo, null);
  const progress = pending ? "Resetting…" : state?.ok ? "Demo reset." : "";

  return (
    <form action={resetAction} data-action="reset-demo" className="flex flex-col items-end gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      {/* aria-disabled while resetting, not disabled: a disabled button drops the focus it holds. */}
      <button
        type="submit"
        aria-disabled={pending || undefined}
        onClick={(event) => {
          if (pending) event.preventDefault(); // no second reset while the first is running
        }}
        className="-mr-2 min-h-11 rounded-md px-2 text-sm text-ink-soft underline decoration-rule underline-offset-4 not-aria-disabled:hover:text-ink not-aria-disabled:hover:decoration-ink-soft not-aria-disabled:active:bg-paper aria-disabled:cursor-wait"
      >
        Reset demo
      </button>
      {/* Always present, so screen readers announce each change of its text. */}
      <p role="status" className="sr-only">
        {progress}
      </p>
      {state && !state.ok && (
        <p role="alert" className="border-l-2 border-mark pl-3 text-sm font-semibold text-ink">
          {errorText[state.error]}
        </p>
      )}
    </form>
  );
}
