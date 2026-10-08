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
