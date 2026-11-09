"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Volume2, VolumeX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { pollByVisibility, takeNewAlerts, type MonitorAlert } from "@/lib/new-order-alerts";
import { createClient } from "@/utils/supabase/client";

const SEEN_KEY = "campusprint.shop.seen-alerts";
const SOUND_KEY = "campusprint.shop.sound";
const VISIBLE_MS = 15_000;
/**
 * A window fully covered by others counts as hidden, not just a background tab.
 * ponytail: browsers slow hidden timers to about once a minute after ~5 minutes;
 * a Web Worker timer would avoid that if shops find a minute too slow.
 */
const HIDDEN_MS = 30_000;
/** Longest a visible queue may go without a full re-render (e.g. an order auto-cancelled). */
const FULL_REFRESH_MS = 60_000;

// Blocked storage: this page load still works, and the next one seeds silently.
let memorySeen: string[] | null = null;
function readSeen(): string[] | null {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return memorySeen;
  }
}
function writeSeen(seen: string[]) {
  memorySeen = seen;
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Kept in memory above.
  }
}

/** One tab at a time decides what's new, so two tabs can't both chime for one order. */
function withLock<T>(fn: () => T): Promise<T> {
  return navigator.locks ? (navigator.locks.request("campusprint-shop-alerts", fn) as Promise<T>) : Promise.resolve(fn());
}

const soundListeners = new Set<() => void>();
function isMuted() {
  try {
    return window.localStorage.getItem(SOUND_KEY) === "off";
  } catch {
    return false;
  }
}
function setMuted(muted: boolean) {
  try {
    window.localStorage.setItem(SOUND_KEY, muted ? "off" : "on");
  } catch {
    // The preference lasts for this page load only.
  }
  for (const listener of soundListeners) listener();
}
function subscribeSound(listener: () => void) {
  soundListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    soundListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Two short notes, synthesised: no audio file to load or to fail. */
function playChime(context: AudioContext) {
  [880, 1175].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + index * 0.18;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.4, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.18);
  });
}

/**
 * Watches for new orders on the shop dashboard. Replaces the 15-second full-page
 * refresh with one small query on the shopkeeper's own unread notifications
 * (RLS: notifications_select_own; index: notifications_unread_idx). Visible tab:
 * every 15s, re-rendering the page only when something arrived or once a minute.
 * Hidden or covered: every 30s, with no re-render at all; coming back re-renders once.
 * Browsers may slow a hidden tab further, and a sleeping PC checks nothing.
 *
 * Sound needs one click on the page first (browser autoplay rules), so until then
 * the control says so and new orders still show here and in the tab title.
 */
export function ShopMonitor({ userId, alerts, pendingCount }: { userId: string; alerts: MonitorAlert[]; pendingCount: number }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const muted = useSyncExternalStore(subscribeSound, isMuted, () => false);
  const audio = useRef<AudioContext | null>(null);
  const [soundReady, setSoundReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [unseen, setUnseen] = useState(0);
  const [checkFailed, setCheckFailed] = useState(false);

  // A click or key press is what browsers need before a page may make sound.
  useEffect(() => {
    const unlock = () => {
      audio.current ??= new AudioContext();
      void audio.current.resume().then(() => setSoundReady(true));
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      void audio.current?.close();
      audio.current = null;
    };
  }, []);

  /** Returns whether anything new arrived. Safe to call with the same list repeatedly. */
  const take = useCallback(async (list: readonly MonitorAlert[]) => {
    const { fresh, chime } = await withLock(() => {
      const result = takeNewAlerts(readSeen(), list);
      writeSeen(result.seen);
      return result;
    });
    if (fresh.length === 0) return false;
    setNotice(fresh.length === 1 ? fresh[0].title : `${fresh.length} new updates: ${fresh[0].title}`);
    if (chime) {
      setUnseen((n) => n + (document.visibilityState === "hidden" ? fresh.length : 0));
      if (!isMuted() && audio.current?.state === "running") playChime(audio.current);
    }
    return true;
  }, []);

  // Each server render brings the latest alerts; `take` ignores what it has seen.
  useEffect(() => {
    void Promise.resolve().then(() => take(alerts));
  }, [alerts, take]);

  useEffect(() => {
    const supabase = createClient();
    let lastFullRefresh = Date.now();
    let checking = false;
    const refresh = () => {
      lastFullRefresh = Date.now();
      startTransition(() => router.refresh());
    };
    return pollByVisibility(
      async ({ visible, returned }) => {
        if (returned) setUnseen(0);
        if (checking) return;
        checking = true;
        const { data, error } = await supabase
          .from("notifications")
          .select("id, type, title")
          .eq("user_id", userId)
          .is("read_at", null)
          .order("created_at", { ascending: false })
          .limit(20)
          .returns<MonitorAlert[]>();
        checking = false;
        setCheckFailed(Boolean(error));
        const arrived = data ? await take(data) : false;
        if (visible && (arrived || returned || Date.now() - lastFullRefresh >= FULL_REFRESH_MS)) refresh();
      },
      { visibleMs: VISIBLE_MS, hiddenMs: HIDDEN_MS },
    );
  }, [router, take, userId]);

  // The count stays in the tab title, so a background tab shows it too.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    const count = pendingCount + unseen;
    document.title = count > 0 ? `(${count}) ${base}` : base;
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={muted}
          onClick={() => setMuted(!muted)}
        >
          {muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
          {muted ? "Sound off" : "Sound on"}
        </Button>
        {!muted && !soundReady ? (
          <span className="text-[12px] text-muted-foreground">Click anywhere on this page to allow the sound.</span>
        ) : !muted ? (
          <span className="text-[12px] text-muted-foreground">If this window is hidden or covered, a new order can take up to a minute to sound.</span>
        ) : null}
      </div>
      {checkFailed ? (
        <p role="alert" className="text-[13px] font-medium text-destructive">
          Can&apos;t check for new orders right now. Retrying…
        </p>
      ) : null}
      {notice ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-ink/20 bg-accent/15 px-3 py-2 text-[14px] font-medium text-ink">
          <span className="min-w-0 [overflow-wrap:anywhere]">{notice}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </div>
  );
}
