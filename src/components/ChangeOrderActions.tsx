"use client";

import { useActionState, useEffect, useId, useRef, useState, type MouseEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { cancelChangeOrder, requoteChangeOrder, sendChangeOrder, waiveChangeOrder } from "@/app/actions";
import type { ActionError, ActionResult, BillingActionResult, PayPalActionError } from "@/domain/action-result";
import type { ChangeOrder } from "@/domain/types";

export interface ActionsOrder extends Pick<ChangeOrder, "id" | "status" | "payerViewUrl"> {
  hasInvoice: boolean; // PayPal already has an invoice for it (never the id itself: that stays on the server)
}

export interface ChangeOrderActionsProps {
  order: ActionsOrder;
  sendBlockedReason: string | null; // why PayPal actions are off (no keys on this server); null when they work
  statusLineId: string; // the note's status line (role="status", tabIndex -1), focused after an action succeeds
}

const errorText: Record<ActionError | PayPalActionError, string> = {
  invalid_input: "This change order isn't in your demo copy. Reload the page.",
  not_found: "This change order isn't in your demo copy. Reload the page.",
  invalid_state: "This change order was already updated. Reload to see it.",
  server_error: "This couldn't be saved just now. Nothing changed; try again.",
  in_progress: "This invoice is already being sent. Wait a moment, then reload.",
  paypal_unavailable: "PayPal didn't respond. Try again; the client won't get a second invoice.",
  paypal_rejected: "PayPal refused this request, so nothing changed here.",
  already_paid: "The client already paid this invoice, so it can't be cancelled.",
  not_configured: "PayPal isn't set up on this server, so nothing was sent.",
  invoice_exists: "PayPal already has an invoice for this, so it can't be included at no charge. Send it again; you can cancel it afterwards.",
};

const cancelErrorText: Partial<Record<ActionError | PayPalActionError, string>> = {
  paypal_unavailable: "PayPal didn't respond, so the invoice is still open. Try again.",
  not_configured: "PayPal isn't set up on this server, so the invoice wasn't cancelled.",
};

// Pressing shows a color change; a disabled (aria-disabled) button shows none and takes palette colors.
const PRIMARY =
  "min-h-11 rounded-md bg-ink px-4 text-sm font-semibold text-sheet not-aria-disabled:hover:bg-mark not-aria-disabled:active:bg-ink-soft aria-disabled:bg-rule aria-disabled:text-ink-soft";
const SECONDARY =
  "min-h-11 rounded-md border border-rule bg-sheet px-3 text-sm font-semibold text-ink-soft not-aria-disabled:hover:border-ink-soft not-aria-disabled:hover:text-ink not-aria-disabled:active:bg-paper aria-disabled:cursor-wait";

// The pressed button is about to disappear (the note changes state), so focus goes to the status line,
// and the screen reader reads the new status.
function useFocusOnSuccess(state: ActionResult | BillingActionResult | null, statusLineId: string) {
  useEffect(() => {
    if (state?.ok) document.getElementById(statusLineId)?.focus();
  }, [state, statusLineId]);
}

// The buttons under a change order: send or include at no charge (draft), send again (a draft PayPal already has an
// invoice for), the client's PayPal page and cancel (sent), quote again (cancelled). The browser sends only the
// order id; the server decides the rest.
export function ChangeOrderActions({ order, sendBlockedReason, statusLineId }: ChangeOrderActionsProps) {
  // Every hook stays here, whatever the status, so the component stays mounted through the refresh after an
  // action and can move focus once the new status arrives.
  const [waiveState, waiveAction, waiving] = useActionState(waiveChangeOrder, null);
  const [sendState, sendAction, sending] = useActionState(sendChangeOrder, null);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelChangeOrder, null);
  const [requoteState, requoteAction, requoting] = useActionState(requoteChangeOrder, null);
  // Which confirmation is open, for which order: quoting again gives this note a new order.
  const [confirming, setConfirming] = useState<{ step: "waive" | "cancel"; orderId: string } | null>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const includeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const keepInvoiceRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const confirmId = useId();
  const cancelConfirmId = useId();
  const resendId = useId();

  useFocusOnSuccess(waiveState, statusLineId);
  useFocusOnSuccess(sendState, statusLineId);
  useFocusOnSuccess(cancelState, statusLineId);
  useFocusOnSuccess(requoteState, statusLineId);
  // Waiving was refused because PayPal has the invoice: the waive buttons are gone, so focus goes to "Send again".
  useEffect(() => {
    if (waiveState?.ok === false && waiveState.error === "invoice_exists") sendRef.current?.focus();
  }, [waiveState]);

  const blocked = sendBlockedReason !== null;
  const isConfirming = (step: "waive" | "cancel") => confirming?.step === step && confirming.orderId === order.id;

  // Opening or closing a confirmation replaces the pressed button, so focus moves to the one in its place.
  // The "keep" button takes the first spot, so a double click lands on it rather than on the confirmation.
  const openConfirm = (step: "waive" | "cancel", target: RefObject<HTMLButtonElement | null>) => {
    flushSync(() => setConfirming({ step, orderId: order.id }));
    target.current?.focus();
  };
  const closeConfirm = (target: RefObject<HTMLButtonElement | null>) => {
    flushSync(() => setConfirming(null));
    target.current?.focus();
  };
  // No second submit while the first is running. Nothing else happens on the click: a re-render here would
  // rewrite the hidden id before the form is read.
  const submitOnce = (busy: boolean) => (event: MouseEvent<HTMLButtonElement>) => {
    if (busy) event.preventDefault();
  };

  const reason = blocked && (
    <p id={reasonId} className="mt-2 text-sm leading-relaxed text-ink-soft">
      {sendBlockedReason}
    </p>
  );
  // Each action keeps its last answer until it runs again; a success changes the status, which hides the panel.
  const errorFor = (state: ActionResult | BillingActionResult | null, texts: Partial<Record<ActionError | PayPalActionError, string>> = {}) =>
    state &&
    !state.ok && (
      <p role="alert" className="mt-2 border-l-2 border-mark pl-3 text-sm font-semibold text-ink">
        {texts[state.error] ?? errorText[state.error]}
      </p>
    );

  if (order.status === "draft") {
    // An earlier send got as far as creating the PayPal invoice, and the client may already have it (P2-D1).
    // Sending again finishes the job (PayPal never sends one invoice twice); waiving would leave it payable.
    const resend = order.hasInvoice;
    const confirmingWaive = !resend && isConfirming("waive");
    const sendDescribedBy = [resend && resendId, blocked && reasonId].filter(Boolean).join(" ") || undefined;
    return (
      <div className="mt-4">
        <div className="flex flex-wrap gap-2">
          <form action={sendAction} data-action="send">
            <input type="hidden" name="changeOrderId" value={order.id} />
            {/* aria-disabled, not disabled: keyboard and screen reader users can still reach it and hear why. */}
            <button
              ref={sendRef}
              type="submit"
              aria-disabled={blocked || sending || undefined}
              aria-describedby={sendDescribedBy}
              onClick={submitOnce(blocked || sending)}
              className={`${PRIMARY} ${blocked ? "aria-disabled:cursor-not-allowed" : "aria-disabled:cursor-wait"}`}
            >
              {sending ? "Sending…" : resend ? "Send again" : "Send change order"}
            </button>
          </form>
          {!resend && (
            <form action={waiveAction} data-action="waive" className="flex flex-wrap gap-2">
              <input type="hidden" name="changeOrderId" value={order.id} />
              {confirmingWaive ? (
                <>
                  <button
                    key="keep"
                    ref={keepRef}
                    type="button"
                    onClick={waiving ? undefined : () => closeConfirm(includeRef)}
                    aria-disabled={waiving || undefined}
                    aria-describedby={confirmId}
                    className={SECONDARY}
                  >
                    Keep the charge
                  </button>
                  {/* aria-disabled while saving, not disabled: a disabled button drops the focus it holds. */}
                  <button
                    key="confirm"
                    type="submit"
                    aria-disabled={waiving || undefined}
                    aria-describedby={confirmId}
                    onClick={submitOnce(waiving)}
                    className={`${PRIMARY} aria-disabled:cursor-wait`}
                  >
                    Confirm: include at no charge
                  </button>
                </>
              ) : (
                <button key="include" ref={includeRef} type="button" onClick={() => openConfirm("waive", keepRef)} className={SECONDARY}>
                  Include at no charge
                </button>
              )}
            </form>
          )}
        </div>
        {resend && (
          <p id={resendId} className="mt-2 text-sm leading-relaxed">
            PayPal already has this invoice from an earlier try, and the client may have it. Send it again to finish; you can cancel it afterwards.
          </p>
        )}
        {confirmingWaive && (
          <p id={confirmId} className="mt-2 text-sm leading-relaxed">
            The client won&apos;t be billed for this, and it can&apos;t be undone.
          </p>
        )}
        {reason}
        {errorFor(sendState)}
        {errorFor(waiveState)}
      </div>
    );
  }

  if (order.status === "sent") {
    const confirmingCancel = isConfirming("cancel");
    return (
      <div className="mt-4">
        {order.payerViewUrl && (
          <a
            href={order.payerViewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-mark underline-offset-4 hover:decoration-ink"
          >
            Open the client&apos;s PayPal page
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        <form action={cancelAction} data-action="cancel" className="mt-2 flex flex-wrap gap-2">
          <input type="hidden" name="changeOrderId" value={order.id} />
          {confirmingCancel ? (
            <>
              <button
                key="keep-invoice"
                ref={keepInvoiceRef}
                type="button"
                onClick={cancelling ? undefined : () => closeConfirm(cancelRef)}
                aria-disabled={cancelling || undefined}
                aria-describedby={cancelConfirmId}
                className={SECONDARY}
              >
                Keep the invoice
              </button>
              <button
                key="confirm-cancel"
                type="submit"
                aria-disabled={cancelling || undefined}
                aria-describedby={cancelConfirmId}
                onClick={submitOnce(cancelling)}
                className={`${PRIMARY} aria-disabled:cursor-wait`}
              >
                {cancelling ? "Cancelling…" : "Confirm: cancel the invoice"}
              </button>
            </>
          ) : (
            <button
              key="cancel"
              ref={cancelRef}
              type="button"
              aria-disabled={blocked || undefined}
              aria-describedby={blocked ? reasonId : undefined}
              onClick={blocked ? undefined : () => openConfirm("cancel", keepInvoiceRef)}
              className={`${SECONDARY} aria-disabled:cursor-not-allowed`}
            >
              Cancel invoice
            </button>
          )}
        </form>
        {confirmingCancel && (
          <p id={cancelConfirmId} className="mt-2 text-sm leading-relaxed">
            PayPal will cancel the invoice and the client can no longer pay it. You can quote this again afterwards.
          </p>
        )}
        {reason}
        {errorFor(cancelState, cancelErrorText)}
      </div>
    );
  }

  if (order.status === "cancelled") {
    return (
      <div className="mt-4">
        <form action={requoteAction} data-action="requote">
          <input type="hidden" name="changeOrderId" value={order.id} />
          <button type="submit" aria-disabled={requoting || undefined} onClick={submitOnce(requoting)} className={SECONDARY}>
            {requoting ? "Quoting…" : "Quote again"}
          </button>
        </form>
        {errorFor(requoteState)}
      </div>
    );
  }

  return null; // paid and waived are settled
}
