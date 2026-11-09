/** New-order chime detection and the monitor's polling rates. Run: npm run test:security */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { pollByVisibility, takeNewAlerts, type MonitorTick } from "../lib/new-order-alerts";

const alert = (id: string, type = "new_order") => ({ id, type, title: `Alert ${id}` });

describe("which notifications chime", () => {
  it("a first visit records what's there silently", () => {
    const r = takeNewAlerts(null, [alert("a"), alert("b")]);
    assert.deepEqual([r.fresh, r.chime], [[], false]);
    assert.deepEqual(r.seen, ["a", "b"]);
  });

  it("the same order never chimes twice, however many polls or tabs see it", () => {
    const first = takeNewAlerts([], [alert("a")]);
    assert.equal(first.chime, true);
    const again = takeNewAlerts(first.seen, [alert("a")]);
    assert.deepEqual([again.fresh, again.chime], [[], false]);
  });

  it("marked read then listed again later: still not new", () => {
    const seen = takeNewAlerts([], [alert("a")]).seen;
    const after = takeNewAlerts(seen, []);
    assert.equal(takeNewAlerts(after.seen, [alert("a")]).chime, false);
  });

  it("only new and newly paid orders make a sound; other updates are just shown", () => {
    assert.equal(takeNewAlerts([], [alert("a", "order_paid")]).chime, true);
    const other = takeNewAlerts([], [alert("b", "order_cancelled_by_student")]);
    assert.equal(other.chime, false);
    assert.equal(other.fresh.length, 1);
  });

  it("several new at once chime once, and the list stays bounded", () => {
    const r = takeNewAlerts(Array.from({ length: 300 }, (_, i) => `old${i}`), [alert("a"), alert("b")]);
    assert.equal(r.fresh.length, 2);
    assert.equal(r.seen.length, 200);
    assert.deepEqual(r.seen.slice(0, 2), ["a", "b"]);
  });
});

describe("monitor polling", () => {
  const fakeDoc = (state: DocumentVisibilityState) => {
    const target = new EventTarget();
    const doc = Object.assign(target, { visibilityState: state });
    const set = (next: DocumentVisibilityState) => {
      doc.visibilityState = next;
      target.dispatchEvent(new Event("visibilitychange"));
    };
    return { doc, set };
  };
  const RATES = { visibleMs: 15_000, hiddenMs: 60_000 };

  it("checks fast while visible, slowly while hidden, and once on return", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const { doc, set } = fakeDoc("visible");
      const ticks: MonitorTick[] = [];
      const stop = pollByVisibility((t) => ticks.push(t), RATES, doc as never);
      mock.timers.tick(30_000);
      assert.deepEqual(ticks, [{ visible: true, returned: false }, { visible: true, returned: false }]);

      ticks.length = 0;
      set("hidden");
      assert.equal(ticks.length, 0, "hiding the tab doesn't check by itself");
      mock.timers.tick(59_999);
      assert.equal(ticks.length, 0, "the slower rate applies");
      mock.timers.tick(1);
      assert.deepEqual(ticks, [{ visible: false, returned: false }], "hidden tabs keep monitoring");

      ticks.length = 0;
      set("visible");
      assert.deepEqual(ticks, [{ visible: true, returned: true }]);
      set("visible"); // a repeated event is not a second return
      assert.equal(ticks.length, 1);
      mock.timers.tick(14_999);
      assert.equal(ticks.length, 1, "the interval restarts from the return");
      mock.timers.tick(1);
      assert.equal(ticks.length, 2);

      stop();
      mock.timers.tick(120_000);
      set("hidden");
      set("visible");
      assert.equal(ticks.length, 2, "cleanup removes both the interval and the listener");
    } finally {
      mock.timers.reset();
    }
  });

  it("a tab opened in the background monitors at the slow rate", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const { doc } = fakeDoc("hidden");
      let ticks = 0;
      const stop = pollByVisibility(() => ticks++, RATES, doc as never);
      mock.timers.tick(120_000);
      assert.equal(ticks, 2);
      stop();
    } finally {
      mock.timers.reset();
    }
  });
});
