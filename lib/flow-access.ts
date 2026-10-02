/**
 * Step access policy for the print flow, kept pure and free of React so it can
 * be reasoned about and tested on its own.
 *
 * Two rules matter here:
 *  - you can't skip ahead to a step whose inputs don't exist yet, and
 *  - once an order is paid you can't drop back into the middle of it, which is
 *    what kept sending people from payment to review.
 */
export type FlowStepId =
  | "shop"
  | "upload"
  | "options"
  | "review"
  | "payment"
  | "track";

export type FlowProgress = {
  hasShop: boolean;
  hasFile: boolean;
  paid: boolean;
};

/** Steps that make up the middle of an order, between picking and paying. */
const midOrderSteps: FlowStepId[] = ["upload", "options", "review"];

/** Whether a step's prerequisites exist, ignoring payment state. */
export function canAccessStep(step: FlowStepId, progress: FlowProgress): boolean {
  switch (step) {
    case "shop":
      return true;
    case "upload":
      return progress.hasShop;
    case "options":
    case "review":
    case "payment":
      return progress.hasShop && progress.hasFile;
    case "track":
      return progress.paid;
    default:
      return false;
  }
}

export type StepDisposition =
  /** Render the step. */
  | "open"
  /** Paid order: go forward to the confirmation. */
  | "forward-to-confirmation"
  /** Paid order, back at step one: clear it and start a new order. */
  | "start-new-order"
  /** Prerequisites missing: go back to the start. */
  | "send-to-start";

/** What a screen should do when someone lands on it. */
export function stepDisposition(
  step: FlowStepId,
  progress: FlowProgress,
): StepDisposition {
  if (progress.paid) {
    if (step === "shop") return "start-new-order";
    if (midOrderSteps.includes(step)) return "forward-to-confirmation";
  }

  return canAccessStep(step, progress) ? "open" : "send-to-start";
}
