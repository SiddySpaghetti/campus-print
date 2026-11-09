import type { OrderStatus } from "@/components/flow/order-tracker";

/** What the workflow rules below read. accept_first is absent on older reads: treated as false. */
type FlowOrder = { status: OrderStatus; payment_status: string; payment_method?: string | null; accept_first?: boolean | null };

const isCounter = (o: FlowOrder) => o.payment_method === "PAY_AT_COUNTER";
const isUnpaid = (o: FlowOrder) => o.payment_status === "PENDING" || o.payment_status === "FAILED";
/** Online orders placed before accept-then-pay: paid first, and they skip Accept. */
const isPayFirst = (o: FlowOrder) => o.payment_method === "ONLINE" && !o.accept_first;

/** Mirrors attach_payment_order. */
export function canStudentPay(o: FlowOrder) {
  return o.payment_method === "ONLINE" && isUnpaid(o) && o.status === (o.accept_first ? "ACCEPTED" : "PENDING");
}

/** Shops may open a file once it is paid, or from the start for a counter order. Never before. */
export function canOpenFiles(o: FlowOrder) {
  return isCounter(o) || o.payment_status === "PAID";
}

/** Mirrors request_print. Includes PRINTING and READY: a jam needs a reprint. */
export function canPrint(o: FlowOrder) {
  return canOpenFiles(o) && (["ACCEPTED", "PRINTING", "READY"].includes(o.status) || (o.status === "PENDING" && isPayFirst(o)));
}

/** Whether a print still needs the shopkeeper's "Printing started" (mirrors confirm_printing). */
export function awaitsPrintConfirmation(o: FlowOrder) {
  return canPrint(o) && (o.status === "ACCEPTED" || o.status === "PENDING");
}

export type ShopStage = "decide" | "awaiting_payment" | "print" | "in_progress";

/** Which part of the shop's queue an active order belongs in. */
export function shopStage(o: FlowOrder): ShopStage {
  if (awaitsPrintConfirmation(o)) return "print";
  if (o.status === "PENDING") return "decide";
  if (o.status === "ACCEPTED") return "awaiting_payment";
  return "in_progress";
}

/** Order numbers (e.g. A-001) are assigned at placement for pay-at-counter orders and on
 * payment for online ones; until then show a short id. */
export function orderLabel(order: { id: string; order_number: string | null }) {
  return order.order_number ?? order.id.slice(0, 8).toUpperCase();
}

export const statusLabels: Record<OrderStatus, string> = {
  PENDING: "Placed",
  ACCEPTED: "Accepted",
  PRINTING: "Printing",
  READY: "Ready for pickup",
  COMPLETED: "Collected",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected",
};

/**
 * REFUND_PENDING is set by orders_lifecycle when a PAID order is cancelled or
 * rejected. For the pilot it promises nothing: no refund is issued
 * automatically, the student and shop settle it between them. It only means
 * "paid, not completed, no refund confirmed". REFUNDED appears only once
 * Razorpay's signed refund.processed webhook confirms a refund.
 */
export const paymentLabels: Record<string, string> = {
  PENDING: "Unpaid",
  PAID: "Paid",
  FAILED: "Payment failed",
  REFUND_PENDING: "Paid · not completed",
  REFUNDED: "Refunded",
};

/** Paid, but cancelled or rejected and not refunded by Razorpay: the student and shop resolve it. */
export function isPaidNotCompleted(order: { payment_status: string }) {
  return order.payment_status === "REFUND_PENDING";
}

/** Counter orders stay unpaid in the system until collected and paid in person. */
export function paymentLabel(order: { payment_status: string; payment_method?: string | null }) {
  if (order.payment_method === "PAY_AT_COUNTER" && order.payment_status === "PENDING") return "Pay at counter";
  return paymentLabels[order.payment_status] ?? order.payment_status;
}

export const FINAL_STATUSES: OrderStatus[] = ["COMPLETED", "CANCELLED", "REJECTED"];

/**
 * Mirrors cancel_order: online orders until printing starts (a paid one goes to
 * REFUND_PENDING, the existing manual refund workflow); counter orders only PENDING.
 */
export function canStudentCancel(order: { status: OrderStatus; payment_method?: string | null }) {
  return order.status === "PENDING" || (order.status === "ACCEPTED" && order.payment_method === "ONLINE");
}

export function formatOrderDate(iso: string) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(iso));
}
