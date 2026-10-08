/** Student flow logic: price estimate and step access. Run: npm run test:security */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stepDisposition } from "../lib/flow-access";
import { calculatePrice, defaultPrintOptions } from "../lib/pricing";
import type { FlowShop } from "../lib/shops";

const shop = { ratesPaise: { bw_a4: 150, colour_a4: 1000 } } as FlowShop;

describe("price estimate", () => {
  it("uses the shop's per-sheet rate and the database's sheet maths", () => {
    const p = calculatePrice({ shop, options: { ...defaultPrintOptions, sides: "double", copies: 2 }, pageCount: 5 });
    assert.deepEqual(p, { ratePerSheet: 1.5, sheetsPerCopy: 3, sheets: 6, total: 9 });
  });
  it("is null for an option the shop doesn't offer", () => {
    assert.equal(calculatePrice({ shop, options: { ...defaultPrintOptions, paper: "a3" }, pageCount: 1 }), null);
  });
});

describe("step access", () => {
  const placed = { hasShop: true, hasFile: true, placed: true };
  it("a placed order can't re-enter the middle of the flow", () => {
    assert.equal(stepDisposition("review", placed), "forward-to-tracking");
    assert.equal(stepDisposition("shop", placed), "start-new-order");
    assert.equal(stepDisposition("track", placed), "open");
  });
  it("can't skip ahead", () => {
    assert.equal(stepDisposition("review", { hasShop: true, hasFile: false, placed: false }), "send-to-start");
  });
});
