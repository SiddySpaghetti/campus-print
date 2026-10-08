import type { OrderStatus } from "@/components/flow/order-tracker";

/** Order numbers (A-042) are assigned on payment; until then show a short id. */
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

export const paymentLabels: Record<string, string> = {
  PENDING: "Unpaid",
  PAID: "Paid",
  FAILED: "Payment failed",
  REFUND_PENDING: "Refund pending",
  REFUNDED: "Refunded",
};

export const FINAL_STATUSES: OrderStatus[] = ["COMPLETED", "CANCELLED", "REJECTED"];

/** Mirrors cancel_order: a student may cancel only a PENDING order. */
export function canStudentCancel(order: { status: OrderStatus }) {
  return order.status === "PENDING";
}

export function formatOrderDate(iso: string) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(iso));
}
