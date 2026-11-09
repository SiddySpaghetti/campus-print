"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  canAccessStep,
  type FlowProgress,
  type FlowStepId,
} from "@/lib/flow-access";
import {
  calculatePrice,
  defaultPrintOptions,
  MAX_COPIES,
  MIN_COPIES,
  type PriceBreakdown,
  type PrintOptions,
} from "@/lib/pricing";
import type { FlowShop } from "@/lib/shops";

export type FlowFile = {
  name: string;
  type: string;
  sizeBytes: number;
  /** Pages as counted by the server from the stored bytes. */
  pageCount: number;
  /** Server-chosen Storage path from POST /api/uploads; the file is uploaded. */
  path: string;
};

// Re-exported so flow components have one import for the step vocabulary.
export type { FlowStepId };

export const flowSteps: { id: FlowStepId; label: string; href: string }[] = [
  { id: "shop", label: "Shop", href: "/start-printing" },
  { id: "upload", label: "Upload", href: "/start-printing/upload" },
  { id: "options", label: "Options", href: "/start-printing/options" },
  { id: "review", label: "Review", href: "/start-printing/review" },
  { id: "track", label: "Track", href: "/start-printing/track" },
];

const STORAGE_KEY = "campusprint.flow.v3";

type FlowSnapshot = {
  /** Display copy of the chosen shop; the server re-reads the real one. */
  shop: FlowShop | null;
  /** In the order the student wants them printed. */
  files: FlowFile[];
  options: PrintOptions;
  /** Set once POST /api/orders succeeds. */
  orderId: string | null;
  /** False until sessionStorage has been read, so guards don't fire too early. */
  ready: boolean;
};

const emptyFlow: FlowSnapshot = {
  shop: null,
  files: [],
  options: defaultPrintOptions,
  orderId: null,
  ready: false,
};

/*
 * The flow lives in a module-level store rather than component state. It keeps
 * one copy of the order for the whole journey, survives navigation between
 * steps, and is mirrored into sessionStorage so a refresh mid-flow doesn't
 * lose the order. It holds only what the student chose; prices shown from it
 * are estimates; the server prices the order itself.
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

export function selectShop(shop: FlowShop) {
  write({ shop });
}

export function addFile(file: FlowFile) {
  write({ files: [...snapshot.files, file] });
}

/** Forgets the file in this order. The upload stays in private Storage, unattached. */
export function removeFile(path: string) {
  write({ files: snapshot.files.filter((f) => f.path !== path) });
}

export function moveFile(path: string, by: -1 | 1) {
  const files = [...snapshot.files];
  const from = files.findIndex((f) => f.path === path);
  const to = from + by;
  if (from < 0 || to < 0 || to >= files.length) return;
  [files[from], files[to]] = [files[to], files[from]];
  write({ files });
}

export function setOptions(patch: Partial<PrintOptions>) {
  write({ options: { ...snapshot.options, ...patch } });
}

export function setCopies(copies: number) {
  const clamped = Math.min(MAX_COPIES, Math.max(MIN_COPIES, copies));
  write({ options: { ...snapshot.options, copies: clamped } });
}

export function setOrderId(orderId: string) {
  write({ orderId });
}

/** Shapes the snapshot for the pure policy in lib/flow-access.ts. */
export function toProgress(flow: FlowSnapshot): FlowProgress {
  return {
    hasShop: Boolean(flow.shop),
    hasFile: flow.files.length > 0,
    placed: Boolean(flow.orderId),
  };
}

export type FlowValue = FlowSnapshot & {
  /** Pages across all documents. */
  pageCount: number;
  price: PriceBreakdown | null;
  selectShop: typeof selectShop;
  addFile: typeof addFile;
  removeFile: typeof removeFile;
  moveFile: typeof moveFile;
  setOptions: typeof setOptions;
  setCopies: typeof setCopies;
  setOrderId: typeof setOrderId;
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

  const { shop, files } = flow;

  const pageCount = files.reduce((sum, f) => sum + f.pageCount, 0);

  const price = useMemo(
    () =>
      shop
        ? calculatePrice({ shop, options: flow.options, pageCounts: files.length ? files.map((f) => f.pageCount) : [1] })
        : null,
    [shop, flow.options, files],
  );

  const canAccess = useCallback(
    (step: FlowStepId) => canAccessStep(step, toProgress(flow)),
    [flow],
  );

  const completedSteps = useMemo<Record<FlowStepId, boolean>>(
    () => ({
      shop: Boolean(shop),
      upload: files.length > 0,
      options: Boolean(shop) && files.length > 0,
      review: Boolean(flow.orderId),
      track: false,
    }),
    [shop, files, flow.orderId],
  );

  return {
    ...flow,
    pageCount,
    price,
    selectShop,
    addFile,
    removeFile,
    moveFile,
    setOptions,
    setCopies,
    setOrderId,
    resetFlow,
    canAccess,
    completedSteps,
  };
}
