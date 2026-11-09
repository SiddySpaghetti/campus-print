/**
 * The shop dashboard's new-order detection, kept free of React so it can be
 * tested on its own. A notification's id is the event's identity: it chimes once,
 * however many polls or tabs see it.
 */
export type MonitorAlert = { id: string; type: string; title: string };

/** Worth a sound: an order to decide on, or a paid one that can now be printed. */
export const CHIME_TYPES = new Set(["new_order", "order_paid"]);

/** More than the unread list ever shows (20), so an old alert can't look new again. */
const MAX_SEEN = 200;

/**
 * `seen` is null on a device's first visit: everything already there is recorded
 * silently, so opening the dashboard never chimes for old orders.
 */
export function takeNewAlerts(seen: readonly string[] | null, alerts: readonly MonitorAlert[]) {
  const known = new Set(seen ?? []);
  const fresh = alerts.filter((a) => !known.has(a.id));
  return {
    fresh: seen === null ? [] : fresh,
    chime: seen !== null && fresh.some((a) => CHIME_TYPES.has(a.type)),
    seen: [...fresh.map((a) => a.id), ...(seen ?? [])].slice(0, MAX_SEEN),
  };
}

type VisibilityTarget = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
export type MonitorTick = { visible: boolean; returned: boolean };

/**
 * Calls `tick` every `visibleMs` while the tab is visible and every `hiddenMs`
 * while it isn't, and once straight away on coming back. Browsers may slow the
 * hidden timer further; that only delays the check.
 */
export function pollByVisibility(
  tick: (state: MonitorTick) => void,
  { visibleMs, hiddenMs }: { visibleMs: number; hiddenMs: number },
  doc: VisibilityTarget = document,
) {
  let visible = doc.visibilityState !== "hidden";
  const start = () => setInterval(() => tick({ visible, returned: false }), visible ? visibleMs : hiddenMs);
  let timer = start();
  const onChange = () => {
    const now = doc.visibilityState !== "hidden";
    if (now === visible) return;
    visible = now;
    clearInterval(timer);
    if (visible) tick({ visible: true, returned: true });
    timer = start();
  };
  doc.addEventListener("visibilitychange", onChange);
  return () => {
    clearInterval(timer);
    doc.removeEventListener("visibilitychange", onChange);
  };
}
