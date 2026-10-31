import "server-only";
import type { ActivityDetail } from "@/domain/activity";
import type { PayPalActionError } from "@/domain/action-result";
import { activityInsert } from "./db/activity";
import type { Db } from "./db/client";
import type { PayPalError } from "./paypal/errors";

// A failed PayPal call as the owner sees it (an activity step) and as the action answers it. Shared by billing.ts
// and payments.ts; it lives apart from both so that neither has to import the other (P3-D2).

export type PayPalStep = "create" | "send" | "read" | "cancel";

const stepText: Record<PayPalStep, string> = {
  create: "creating the invoice",
  send: "sending the invoice",
  read: "reading the invoice back",
  cancel: "cancelling the invoice",
};

// What a refusal at each step leaves behind. Once the invoice was sent, nothing may claim that nothing happened.
const refusalMeans: Record<PayPalStep, string> = {
  create: "no invoice was made",
  send: "it wasn't sent",
  read: "it was sent but couldn't be confirmed",
  cancel: "the invoice is still open",
};

export function failureSummary(error: PayPalError, step: PayPalStep): string {
  switch (error.failure) {
    case "rejected":
      return `PayPal refused the request while ${stepText[step]}${error.issue ? ` (${error.issue})` : ""}; ${refusalMeans[step]}.`;
    case "auth":
      return `PayPal didn't accept the app's credentials while ${stepText[step]}.`;
    case "not_found":
      return `PayPal couldn't find the invoice while ${stepText[step]}.`;
    default:
      return `PayPal didn't respond while ${stepText[step]}; trying again won't bill the client twice.`;
  }
}

export function actionErrorFor(error: PayPalError): PayPalActionError {
  if (error.failure === "not_configured") return "not_configured";
  return error.failure === "rejected" ? "paypal_rejected" : "paypal_unavailable";
}

export function errorDetail(error: PayPalError): ActivityDetail {
  return { httpStatus: error.httpStatus, issue: error.issue, debugId: error.debugId };
}

// What recording a failure needs: billing.ts's BillingDeps fits it.
export interface FailureDeps {
  db: Db;
  now: () => Date;
}

export interface FailureRecord {
  ownerProjectId: string;
  changeOrderId: string;
  step: PayPalStep;
  summary: string;
  detail: ActivityDetail;
}

// Best effort: a failed PayPal call is logged and recorded, but failing to record it never changes the answer.
export async function recordFailure(deps: FailureDeps, record: FailureRecord): Promise<void> {
  try {
    await activityInsert(deps.db, {
      projectId: record.ownerProjectId,
      changeOrderId: record.changeOrderId,
      kind: "paypal_failed",
      actor: "paypal",
      summary: record.summary,
      detail: { step: record.step, ...record.detail },
      at: deps.now().toISOString(),
    });
  } catch (error) {
    console.error("recording a PayPal failure failed", error);
  }
}
