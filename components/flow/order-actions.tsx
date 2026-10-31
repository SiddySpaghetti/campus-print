"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/api-client";

type VisibilityTarget = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/**
 * Calls `tick` every `ms` while the tab is visible. Hidden tabs don't tick;
 * coming back ticks once, then the interval starts over. Returns the cleanup.
 */
export function pollWhileVisible(tick: () => void, ms: number, doc: VisibilityTarget = document) {
  let hidden = doc.visibilityState === "hidden";
  let timer = hidden ? undefined : setInterval(tick, ms);
  const onChange = () => {
    if ((doc.visibilityState === "hidden") === hidden) return;
    hidden = !hidden;
    clearInterval(timer);
    timer = undefined;
    if (!hidden) {
      tick();
      timer = setInterval(tick, ms);
    }
  };
  doc.addEventListener("visibilitychange", onChange);
  return () => {
    clearInterval(timer);
    doc.removeEventListener("visibilitychange", onChange);
  };
}

/**
 * Re-renders the server page (and the header's unread badge) every 15s while
 * the tab is visible, and once on return to it. A tick is skipped while the
 * previous refresh is still in flight.
 */
export function AutoRefresh() {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const busy = useRef(false);
  useEffect(() => {
    busy.current = refreshing;
  }, [refreshing]);
  useEffect(
    // ponytail: polling; switch to Supabase Realtime on orders if 15s feels slow.
    () =>
      pollWhileVisible(() => {
        if (!busy.current) startTransition(() => router.refresh());
      }, 15_000),
    [router],
  );
  return null;
}

/**
 * Cancels the student's own PENDING order (cancel_order decides). A paid one
 * is not refunded automatically, so the student is told before confirming.
 */
export function CancelOrderButton({ orderId, paid = false }: { orderId: string; paid?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    const message = paid
      ? "Cancel this paid order? It is not refunded automatically. To request a refund, contact the shop."
      : "Cancel this order?";
    if (!window.confirm(message)) return;
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

/**
 * Downloads one order file. The server signs the link and only then (for an
 * ACCEPTED order) moves it to PRINTING; a failure changes nothing and shows
 * here instead of navigating away. Stays disabled until the refreshed status
 * arrives, so a double click can't fire twice.
 */
export function DownloadFileButton({
  fileId,
  children,
  variant = "default",
  className,
}: {
  fileId: string;
  children: ReactNode;
  variant?: "default" | "link";
  className?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setPending(true);
    setError(null);
    try {
      const { url } = await postJson<{ url: string }>(`/api/shop/files/${fileId}`);
      window.location.assign(url); // a signed attachment URL: the browser saves it and stays here
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "The document couldn't be downloaded.");
    } finally {
      setPending(false);
    }
  };

  return (
    <span className="flex min-w-0 flex-col gap-1">
      <Button type="button" variant={variant} disabled={pending || refreshing} onClick={download} className={className}>
        {pending ? "Preparing…" : children}
      </Button>
      {error ? (
        <span role="alert" className="text-[13px] font-medium text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}

type ShopTarget = "ACCEPTED" | "READY" | "COMPLETED" | "REJECTED" | "CANCELLED";
type ShopAction = { target: ShopTarget; label: string; danger?: boolean };

/**
 * The shop's next moves (the server re-validates every one). No button moves an
 * order to PRINTING: downloading the document does. Paid online orders skip
 * Accept. Rejecting or cancelling a paid one refunds nothing: the payment stays
 * recorded (REFUND_PENDING, "Paid · not completed") for the shop and student to
 * settle; only a refund Razorpay confirms marks it Refunded.
 */
export function shopActions(status: string, online: boolean): ShopAction[] {
  const cancel: ShopAction = { target: "CANCELLED", label: "Cancel", danger: true };
  switch (status) {
    case "PENDING":
      return online
        ? [{ target: "REJECTED", label: "Reject", danger: true }]
        : [{ target: "ACCEPTED", label: "Accept" }, { target: "REJECTED", label: "Reject", danger: true }];
    case "ACCEPTED":
      return [cancel];
    case "PRINTING":
      return [{ target: "READY", label: "Ready for pickup" }, cancel];
    case "READY":
      return [{ target: "COMPLETED", label: "Mark collected" }];
    default:
      return [];
  }
}

/** Status buttons for one order on the shop dashboard; `files` = its downloadable files. */
export function ShopStatusActions({
  orderId,
  status,
  paymentMethod,
  files,
}: {
  orderId: string;
  status: string;
  paymentMethod: string;
  files: { id: string; original_name: string }[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const online = paymentMethod === "ONLINE";
  const actions = shopActions(status, online);
  // Mirrors printFrom in the download route.
  const printable = status === "ACCEPTED" || (online && status === "PENDING");
  if (actions.length === 0) return null;

  const move = async (target: ShopTarget, label: string) => {
    let reason: string | undefined;
    if (target === "REJECTED" || target === "CANCELLED") {
      // Online orders the shop can see are paid (orders_select_shop).
      const paidNote = online ? " The payment is NOT refunded automatically; the student will be asked to contact you." : "";
      const input = window.prompt(`${label} this order?${paidNote} Tell the student why (required):`);
      if (input === null) return;
      reason = input.trim().slice(0, 200);
      if (!reason) return;
    }
    setPending(true);
    setError(null);
    try {
      await postJson(`/api/shop/orders/${orderId}/status`, reason ? { status: target, reason } : { status: target });
      // Stay disabled until the new status renders, so a double click can't fire twice.
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Status could not be changed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        {printable
          ? files.map((f) => (
              <DownloadFileButton key={f.id} fileId={f.id}>
                {files.length === 1 ? "Download document" : `Download ${f.original_name}`}
              </DownloadFileButton>
            ))
          : null}
        {actions.map((a) => (
          <Button
            key={a.target}
            type="button"
            variant={a.danger ? "outline" : "default"}
            disabled={pending || refreshing}
            onClick={() => move(a.target, a.label)}
          >
            {pending && !a.danger ? "Saving…" : a.label}
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

/** The shop's open/closed switch: closed stops new orders, placed ones carry on. */
export function ShopOpenToggle({ isOpen }: { isOpen: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (isOpen && !window.confirm("Close the shop? Students can't place new orders until you open it again.")) return;
    setPending(true);
    setError(null);
    try {
      await postJson("/api/shop/open", { open: !isOpen });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change the shop's status.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        <span className="text-[13px] text-muted-foreground">{isOpen ? "Open for orders" : "Closed to new orders"}</span>
        <Button type="button" variant={isOpen ? "outline" : "default"} size="sm" disabled={pending} onClick={toggle}>
          {pending ? "Saving…" : isOpen ? "Close shop" : "Open shop"}
        </Button>
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
