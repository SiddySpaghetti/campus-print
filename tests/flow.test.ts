/** Student flow logic: price estimate, step access, landing links. Run: npm run test:security */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { stepDisposition } from "../lib/flow-access";
import { calculatePrice, defaultPrintOptions } from "../lib/pricing";
import type { FlowShop } from "../lib/shops";
import { siteConfig } from "../lib/site";

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

describe("landing links", () => {
  it("every #anchor in the nav and CTAs matches a section id on the landing page", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../components/landing");
    const ids = new Set(
      readdirSync(dir).flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1])),
    );
    const hrefs = [...siteConfig.nav, ...Object.values(siteConfig.cta)].map((l) => l.href);
    for (const href of hrefs.filter((h) => h.startsWith("#"))) {
      assert.ok(ids.has(href.slice(1)), `${href} has no matching section`);
    }
  });
});
