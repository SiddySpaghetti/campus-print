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
