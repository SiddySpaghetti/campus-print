"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { printShops, type PrintShop } from "@/lib/data/print-shops";
import {
  canAccessStep,
  type FlowProgress,
  type FlowStepId,
} from "@/lib/flow-access";
import type { PageCountSource } from "@/lib/page-count";
import {
  calculatePrice,
  defaultPrintOptions,
  DEMO_PAGE_COUNT,
  MAX_COPIES,
  MIN_COPIES,
  type PriceBreakdown,
  type PrintOptions,
} from "@/lib/pricing";

export type FlowFile = {
  name: string;
  type: string;
  sizeBytes: number;
  /** Printable pages in this document: 1 for an image, counted for a PDF. */
  pageCount: number;
  /** How that number was arrived at, so the UI can flag an estimate. */
  pageCountSource: PageCountSource;
};

export type PaymentMethod = "upi" | "card" | "cash";
export type PaymentStatus = "idle" | "processing" | "paid";
/** Mirrors the tracking timeline on the order screen. */
export type OrderStatus = "received" | "accepted" | "printing" | "ready";

// Re-exported so flow components have one import for the step vocabulary.
export type { FlowStepId };

export const flowSteps: { id: FlowStepId; label: string; href: string }[] = [
  { id: "shop", label: "Shop", href: "/start-printing" },
  { id: "upload", label: "Upload", href: "/start-printing/upload" },
  { id: "options", label: "Options", href: "/start-printing/options" },
  { id: "review", label: "Review", href: "/start-printing/review" },
  { id: "payment", label: "Payment", href: "/start-printing/payment" },
  { id: "track", label: "Track", href: "/start-printing/track" },
];

/** Demo order number, matching the ticket shown on the landing page. */
export const ORDER_TOKEN = "A-042";

const STORAGE_KEY = "campusprint.flow.v1";

type FlowSnapshot = {
  shopId: string | null;
  file: FlowFile | null;
  options: PrintOptions;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  orderStatus: OrderStatus;
  /** False until sessionStorage has been read, so guards don't fire too early. */
  ready: boolean;
};

const emptyFlow: FlowSnapshot = {
  shopId: null,
  file: null,
  options: defaultPrintOptions,
  paymentMethod: "upi",
  paymentStatus: "idle",
  orderStatus: "received",
  ready: false,
};

/*
 * The flow lives in a module-level store rather than component state. It keeps
 * one copy of the order for the whole journey, survives navigation between
 * steps, and is mirrored into sessionStorage so a refresh mid-flow doesn't
 * lose the order. Nothing here talks to a server — this is a prototype.
 */
let snapshot: FlowSnapshot = emptyFlow;
let hydrationStarted = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

/** The server never has storage, so it always renders the un-hydrated state. */
function getServerSnapshot() {
  return emptyFlow;
}

function persist() {
  try {
    // `ready` describes this page load, so it isn't worth storing.
    const persistable = { ...snapshot, ready: undefined };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
  } catch {
    // Private mode or blocked storage: the flow still works in memory.
  }
}

function write(patch: Partial<FlowSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  persist();
  emit();
}

/** Reads storage once per page load, then wakes every subscriber. */
function hydrate() {
  if (hydrationStarted) return;
  hydrationStarted = true;

  let stored: Partial<FlowSnapshot> = {};
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as Partial<FlowSnapshot>;
  } catch {
    // Ignore unreadable storage.
  }

  snapshot = {
    ...snapshot,
    ...stored,
    options: { ...snapshot.options, ...stored.options },
    ready: true,
  };
  emit();
}

export function resetFlow() {
  snapshot = { ...emptyFlow, ready: true };
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
  emit();
}

export function selectShop(shopId: string) {
  write({ shopId });
}

export function setFile(file: FlowFile | null) {
  write({ file });
}

export function setOptions(patch: Partial<PrintOptions>) {
  write({ options: { ...snapshot.options, ...patch } });
}

export function setCopies(copies: number) {
  const clamped = Math.min(MAX_COPIES, Math.max(MIN_COPIES, copies));
  write({ options: { ...snapshot.options, copies: clamped } });
}

export function setPaymentMethod(paymentMethod: PaymentMethod) {
  write({ paymentMethod });
}

export function setPaymentStatus(paymentStatus: PaymentStatus) {
  write({ paymentStatus });
}

export function setOrderStatus(orderStatus: OrderStatus) {
  if (snapshot.orderStatus === orderStatus) return;
  write({ orderStatus });
}

/** Shapes the snapshot for the pure policy in lib/flow-access.ts. */
export function toProgress(flow: FlowSnapshot): FlowProgress {
  return {
    hasShop: Boolean(flow.shopId),
    hasFile: Boolean(flow.file),
    paid: flow.paymentStatus === "paid",
  };
}

export type FlowValue = FlowSnapshot & {
  shop: PrintShop | null;
  pageCount: number;
  price: PriceBreakdown | null;
  selectShop: typeof selectShop;
  setFile: typeof setFile;
  setOptions: typeof setOptions;
  setCopies: typeof setCopies;
  setPaymentMethod: typeof setPaymentMethod;
  setPaymentStatus: typeof setPaymentStatus;
  setOrderStatus: typeof setOrderStatus;
  resetFlow: typeof resetFlow;
  canAccess: (step: FlowStepId) => boolean;
  completedSteps: Record<FlowStepId, boolean>;
};

/** Reads the shared flow and the values derived from it. */
export function useFlow(): FlowValue {
  const flow = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Hydration touches an external store, not React state.
  useEffect(() => {
    hydrate();
  }, []);

  const shop = useMemo(
    () => printShops.find((item) => item.id === flow.shopId) ?? null,
    [flow.shopId],
  );

  // The chosen document decides the page count; the fixed estimate is only a
  // fallback for PDFs we couldn't read, and for before a file is picked.
  const pageCount = flow.file?.pageCount ?? DEMO_PAGE_COUNT;

  const price = useMemo(
    () =>
      shop
        ? calculatePrice({ shop, options: flow.options, pageCount })
        : null,
    [shop, flow.options, pageCount],
  );

  const canAccess = useCallback(
    (step: FlowStepId) => canAccessStep(step, toProgress(flow)),
    [flow],
  );

  const completedSteps = useMemo<Record<FlowStepId, boolean>>(
    () => ({
      shop: Boolean(flow.shopId),
      upload: Boolean(flow.file),
      options: Boolean(flow.shopId && flow.file),
      review: Boolean(flow.shopId && flow.file),
      payment: flow.paymentStatus === "paid",
      track: flow.orderStatus === "ready",
    }),
    [flow.shopId, flow.file, flow.paymentStatus, flow.orderStatus],
  );

  return {
    ...flow,
    shop,
    pageCount,
    price,
    selectShop,
    setFile,
    setOptions,
    setCopies,
    setPaymentMethod,
    setPaymentStatus,
    setOrderStatus,
    resetFlow,
    canAccess,
    completedSteps,
  };
}
