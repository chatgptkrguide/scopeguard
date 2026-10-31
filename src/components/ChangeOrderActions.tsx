"use client";

import { useActionState, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { waiveChangeOrder } from "@/app/actions";
import type { ActionError } from "@/domain/action-result";
import type { ChangeOrder } from "@/domain/types";

export interface ChangeOrderActionsProps {
  order: Pick<ChangeOrder, "id" | "status">;
  sendBlockedReason: string | null; // why sending is off; null once PayPal is connected (P2)
}

const errorText: Record<ActionError, string> = {
  invalid_input: "This change order isn't in your demo copy. Reload the page.",
  not_found: "This change order isn't in your demo copy. Reload the page.",
  invalid_state: "This change order was already updated. Reload to see it.",
  server_error: "This couldn't be saved just now. Nothing changed; try again.",
};

// The buttons under an open change order. The browser sends only the order id; the server decides the rest.
export function ChangeOrderActions({ order, sendBlockedReason }: ChangeOrderActionsProps) {
  const [state, waiveAction, pending] = useActionState(waiveChangeOrder, null);
  // Waived is final, so taking the charge off asks once more before anything reaches the server (D-015).
  const [confirming, setConfirming] = useState(false);
  const includeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const confirmId = useId();
  if (order.status !== "draft") return null;

  // The pressed button is replaced, so focus moves to the one in its place. "Keep the charge" takes the
  // first spot, so a double click on "Include at no charge" lands on it rather than on the confirmation.
  const askToConfirm = () => {
    flushSync(() => setConfirming(true));
    keepRef.current?.focus();
  };
  const keepCharge = () => {
    flushSync(() => setConfirming(false));
    includeRef.current?.focus();
  };

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        {/* aria-disabled, not disabled: keyboard and screen reader users can still reach it and hear why. */}
        <button
          type="button"
          aria-disabled={sendBlockedReason ? true : undefined}
          aria-describedby={sendBlockedReason ? reasonId : undefined}
          className="min-h-11 rounded-md bg-ink px-4 text-sm font-semibold text-sheet aria-disabled:cursor-not-allowed aria-disabled:bg-rule aria-disabled:text-ink-soft"
        >
          Send change order
        </button>
        <form action={waiveAction} data-action="waive" className="flex flex-wrap gap-2">
          <input type="hidden" name="changeOrderId" value={order.id} />
          {confirming ? (
            <>
              <button
                key="keep"
                ref={keepRef}
                type="button"
                onClick={keepCharge}
                aria-describedby={confirmId}
                className="min-h-11 rounded-md px-3 text-sm font-semibold text-ink-soft hover:text-ink"
              >
                Keep the charge
              </button>
              <button
                key="confirm"
                type="submit"
                disabled={pending}
                aria-busy={pending || undefined}
                className="min-h-11 rounded-md bg-ink px-4 text-sm font-semibold text-sheet disabled:cursor-wait disabled:opacity-60"
              >
                Confirm: include at no charge
              </button>
            </>
          ) : (
            <button
              key="include"
              ref={includeRef}
              type="button"
              onClick={askToConfirm}
              className="min-h-11 rounded-md px-3 text-sm font-semibold text-ink-soft hover:text-ink"
            >
              Include at no charge
            </button>
          )}
        </form>
      </div>
      {confirming && (
        <p id={confirmId} className="mt-2 text-sm leading-relaxed">
          The client won&apos;t be billed for this, and it can&apos;t be undone.
        </p>
      )}
      {sendBlockedReason && (
        <p id={reasonId} className="mt-2 text-sm leading-relaxed text-ink-soft">
          {sendBlockedReason}
        </p>
      )}
      {state && !state.ok && (
        <p role="alert" className="mt-2 text-sm font-semibold text-mark">
          {errorText[state.error]}
        </p>
      )}
    </div>
  );
}
