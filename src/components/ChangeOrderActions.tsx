"use client";

import { useActionState, useId } from "react";
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
  const reasonId = useId();
  if (order.status !== "draft") return null;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        {/* aria-disabled, not disabled: keyboard and screen reader users can still reach it and hear why. */}
        <button
          type="button"
          aria-disabled={sendBlockedReason ? true : undefined}
          aria-describedby={sendBlockedReason ? reasonId : undefined}
          className="min-h-11 rounded-md bg-ink px-4 text-sm font-semibold text-sheet aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
        >
          Send change order
        </button>
        <form action={waiveAction} data-action="waive">
          <input type="hidden" name="changeOrderId" value={order.id} />
          <button
            type="submit"
            disabled={pending}
            aria-busy={pending || undefined}
            className="min-h-11 rounded-md px-3 text-sm font-semibold text-ink-soft hover:text-ink disabled:cursor-wait disabled:opacity-60"
          >
            Include at no charge
          </button>
        </form>
      </div>
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
