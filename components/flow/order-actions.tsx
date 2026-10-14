"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/api-client";

/** Re-renders the server page (and the header's unread badge) every 15s. */
export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    // ponytail: polling; switch to Supabase Realtime on orders if 15s feels slow.
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}

/** Cancels the student's own unpaid PENDING order (cancel_order decides). */
export function CancelOrderButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    if (!window.confirm("Cancel this order?")) return;
    setPending(true);
    setError(null);
    try {
      await postJson(`/api/orders/${orderId}/cancel`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Order could not be cancelled.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <Button type="button" variant="outline" disabled={pending} onClick={cancel}>
        {pending ? "Cancelling…" : "Cancel order"}
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type RazorpayCheckout = { open(): void; on(event: "payment.failed", cb: () => void): void };
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayCheckout;
  }
}

function loadCheckout() {
  return new Promise<boolean>((resolve) => {
    if (window.Razorpay) return resolve(true);
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

/**
 * Opens Razorpay Checkout for the student's own unpaid ONLINE order. The amount
 * comes from the server (orders.total_paise). Checkout's success callback marks
 * nothing paid: it only forwards Razorpay's ids and signature to the verify
 * route, which checks them server-side (the webhook is the backstop).
 */
export function PayNowButton({ orderId, label }: { orderId: string; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const pay = async () => {
    setPending(true);
    setError(null);
    try {
      const [loaded, session] = await Promise.all([
        loadCheckout(),
        postJson<{ keyId: string; razorpayOrderId: string; amountPaise: number; currency: string }>(
          `/api/orders/${orderId}/payment`,
        ),
      ]);
      if (!loaded || !window.Razorpay) throw new Error("Payment window could not load. Try again.");
      const checkout = new window.Razorpay({
        key: session.keyId,
        order_id: session.razorpayOrderId,
        amount: session.amountPaise,
        currency: session.currency,
        name: "CampusPrint",
        description: `Order #${label}`,
        handler: async (response: { razorpay_payment_id: string; razorpay_signature: string }) => {
          setConfirming(true);
          await postJson(`/api/orders/${orderId}/payment/verify`, {
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          }).catch(() => null); // the webhook still confirms it; AutoRefresh picks that up
          router.refresh();
        },
        modal: { ondismiss: () => setPending(false) },
      });
      checkout.on("payment.failed", () => setError("Payment failed. You can try again."));
      checkout.open();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment could not be started.");
      setPending(false);
    }
  };

  if (confirming) {
    return <p className="text-[13px] font-medium text-ink">Payment received. Confirming…</p>;
  }

  return (
    <div>
      <Button type="button" size="lg" disabled={pending} onClick={pay}>
        {pending ? "Opening payment…" : "Pay now"}
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type ShopTarget = "ACCEPTED" | "PRINTING" | "READY" | "COMPLETED" | "REJECTED" | "CANCELLED";

/** The shop's next moves for each active status (the server re-validates every one). */
const shopActions: Record<string, { target: ShopTarget; label: string; danger?: boolean }[]> = {
  PENDING: [
    { target: "ACCEPTED", label: "Accept" },
    { target: "REJECTED", label: "Reject", danger: true },
  ],
  ACCEPTED: [
    { target: "PRINTING", label: "Start printing" },
    { target: "CANCELLED", label: "Cancel", danger: true },
  ],
  PRINTING: [
    { target: "READY", label: "Mark ready" },
    { target: "CANCELLED", label: "Cancel", danger: true },
  ],
  READY: [{ target: "COMPLETED", label: "Collected & paid" }],
};

/** Status buttons for one order on the shop dashboard. */
export function ShopStatusActions({ orderId, status }: { orderId: string; status: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actions = shopActions[status] ?? [];
  if (actions.length === 0) return null;

  const move = async (target: ShopTarget, label: string) => {
    let reason: string | undefined;
    if (target === "REJECTED" || target === "CANCELLED") {
      const input = window.prompt(`${label} this order? Tell the student why (required):`);
      if (input === null) return;
      reason = input.trim().slice(0, 200);
      if (!reason) return;
    }
    setPending(true);
    setError(null);
    try {
      await postJson(`/api/shop/orders/${orderId}/status`, reason ? { status: target, reason } : { status: target });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Status could not be changed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button
            key={a.target}
            type="button"
            size="sm"
            variant={a.danger ? "outline" : "default"}
            disabled={pending}
            onClick={() => move(a.target, a.label)}
          >
            {a.label}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Marks every unread notification as read, then refreshes the badge. */
export function MarkAllReadButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const markRead = async () => {
    setPending(true);
    try {
      await postJson("/api/notifications/read");
      router.refresh();
    } catch {
      // Leave them unread; the button stays so the student can retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <Button type="button" variant="outline" size="sm" disabled={pending} onClick={markRead}>
      {pending ? "Marking…" : "Mark all as read"}
    </Button>
  );
}
