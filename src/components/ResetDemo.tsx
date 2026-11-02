"use client";

import { useActionState, useEffect, useId, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { resetDemo } from "@/app/actions";
import type { ResetActionResult, ResetError } from "@/domain/action-result";

export interface ResetDemoProps {
  projectId: string;
}

const errorText: Record<ResetError, string> = {
  invalid_input: "This isn't your demo copy. Reload the page.",
  not_found: "This isn't your demo copy. Reload the page.",
  invalid_state: "The demo changed while resetting. Reload the page.", // reset never returns this today
  server_error: "The demo couldn't be reset just now. Nothing changed; try again.",
  invoice_open:
    "A change order has a PayPal invoice the client can still pay, so the demo wasn't reset. Cancel that invoice first (a draft marked Send again: send it, then cancel it), then reset.",
};

// Puts the visitor's copy back to the starting demo, after a confirmation: it deletes every change made to it.
// The server checks the id against the visitor cookie, and refuses while an invoice is still payable.
// Quiet text buttons: a demo utility, not part of the contract under review.
export function ResetDemo({ projectId }: ResetDemoProps) {
  const [confirming, setConfirming] = useState(false);
  // An answer closes the confirmation, whatever it says.
  const [state, resetAction, pending] = useActionState(async (prev: ResetActionResult | null, formData: FormData) => {
    const result = await resetDemo(prev, formData);
    setConfirming(false);
    return result;
  }, null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const confirmId = useId();
  const progress = pending ? "Resetting…" : state?.ok ? "Demo reset." : "";

  // "Reset demo" takes the confirm button's place once the answer is in, so focus goes back to it.
  useEffect(() => {
    if (state) resetRef.current?.focus();
  }, [state]);

  // Opening or closing the confirmation replaces the pressed button, so focus moves to the one in its place. The
  // "keep" button takes the first spot, so a double click lands on it rather than on the confirmation.
  const swap = (open: boolean, target: RefObject<HTMLButtonElement | null>) => {
    flushSync(() => setConfirming(open));
    target.current?.focus();
  };
  const QUIET =
    "min-h-11 rounded-md px-2 text-sm text-ink-soft underline decoration-rule underline-offset-4 not-aria-disabled:hover:text-ink not-aria-disabled:hover:decoration-ink-soft not-aria-disabled:active:bg-paper";

  return (
    <form action={resetAction} data-action="reset-demo" className="flex flex-col items-end gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      {confirming ? (
        <div className="-mr-2 flex flex-wrap justify-end gap-1">
          <button
            key="keep"
            ref={keepRef}
            type="button"
            onClick={pending ? undefined : () => swap(false, resetRef)}
            aria-disabled={pending || undefined}
            aria-describedby={confirmId}
            className={QUIET}
          >
            Keep my changes
          </button>
          {/* aria-disabled while resetting, not disabled: a disabled button drops the focus it holds. */}
          <button
            key="confirm"
            type="submit"
            aria-disabled={pending || undefined}
            aria-describedby={confirmId}
            onClick={(event) => {
              if (pending) event.preventDefault(); // no second reset while the first is running
            }}
            className={`${QUIET} font-semibold text-ink aria-disabled:cursor-wait`}
          >
            {pending ? "Resetting…" : "Confirm: reset demo"}
          </button>
        </div>
      ) : (
        <button key="reset" ref={resetRef} type="button" onClick={() => swap(true, keepRef)} className={`-mr-2 ${QUIET}`}>
          Reset demo
        </button>
      )}
      {confirming && (
        <p id={confirmId} className="max-w-xs text-right text-sm leading-relaxed">
          This deletes every change you made to this demo and starts it over.
        </p>
      )}
      {/* Always present, so screen readers announce each change of its text. */}
      <p role="status" className="sr-only">
        {progress}
      </p>
      {state && !state.ok && (
        <p role="alert" className="max-w-xs border-l-2 border-mark pl-3 text-sm font-semibold text-ink">
          {errorText[state.error]}
        </p>
      )}
    </form>
  );
}
