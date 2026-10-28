/**
 * K2's per-page A4 B&W tiers and the pilot shop list, on the REAL migrations
 * (PGlite). Production-like shops, prices and historical orders are seeded
 * BEFORE 20261025120300 runs, so its data steps are tested against the state
 * they will meet. Server totals come from create_order_verified; the browser
 * estimate (lib/pricing.ts) is built from the same rows the app reads through
 * RLS and must match to the paisa. Run: npm run test:security
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, it } from "node:test";

import type { PGlite, Transaction } from "@electric-sql/pglite";

import { formatPerPageRange, type PrintShop } from "../lib/data/print-shops";
import { calculatePrice, pageTierRate, type ColourMode, type PaperSize, type SideMode } from "../lib/pricing";
import { perPageRange, toFlowShops, type FlowShop } from "../lib/shops";
import { freshSupabaseDb } from "./supabase-pglite";

const STUDENT = "00000000-0000-4000-8000-00000000e001";
const K2 = "00000000-0000-4000-8000-00000000e0a1";
const SITARAM = "00000000-0000-4000-8000-00000000e0a2";
const HARSH = "00000000-0000-4000-8000-00000000e0a3";
const SOURABH = "00000000-0000-4000-8000-00000000e0a4";
const HIST_K2 = "00000000-0000-4000-8000-00000000e0b1";
const HIST_HARSH = "00000000-0000-4000-8000-00000000e0b2";
const K2_KEEPER = "00000000-0000-4000-8000-00000000e002";
const ADMIN = "00000000-0000-4000-8000-00000000e003";

/** Production as of 2026-10-25 (slugs, prices), plus two historical orders. */
const PRODUCTION_LIKE = `
  insert into auth.users (id) values ('${STUDENT}');
  insert into public.shops (id, name, slug, order_prefix, is_verified, is_open, online_payment) values
    ('${K2}', 'K2 Print Store', 'k2-print-store', 'K', true, true, true),
    ('${SITARAM}', 'Sitaram Prints', 'sitaram-prints', 'S', true, true, true),
    ('${HARSH}', 'Harsh Bhaiya', '', 'H', true, true, false),
    ('${SOURABH}', 'Sourabh ', 'Ab', 'B', true, true, false);
  insert into public.shop_pricing (shop_id, service, colour_mode, paper_size, price_paise) values
    ('${K2}', 'print', 'bw', 'a3', 1000), ('${K2}', 'print', 'bw', 'a4', 200),
    ('${K2}', 'print', 'colour', 'a3', 2500), ('${K2}', 'print', 'colour', 'a4', 1000),
    ('${SITARAM}', 'print', 'bw', 'a3', 500), ('${SITARAM}', 'print', 'bw', 'a4', 200),
    ('${SITARAM}', 'print', 'colour', 'a3', 2000), ('${SITARAM}', 'print', 'colour', 'a4', 1000),
    ('${HARSH}', 'print', 'bw', 'a3', 1000), ('${HARSH}', 'print', 'bw', 'a4', 500),
    ('${HARSH}', 'print', 'colour', 'a3', 2000), ('${HARSH}', 'print', 'colour', 'a4', 1000);
  insert into public.orders (id, student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets,
                             rate_per_sheet_paise, total_paise, payment_method, order_number) values
    ('${HIST_K2}', '${STUDENT}', '${K2}', 'bw', 'a4', 'single', 1, 5, 5, 200, 1000, 'PAY_AT_COUNTER', 'K-OLD1'),
    ('${HIST_HARSH}', '${STUDENT}', '${HARSH}', 'bw', 'a4', 'double', 2, 3, 4, 500, 2000, 'PAY_AT_COUNTER', 'H-OLD1');
  insert into auth.users (id) values ('${K2_KEEPER}'), ('${ADMIN}');
  update public.profiles set role = 'shopkeeper', shop_id = '${K2}' where id = '${K2_KEEPER}';
  update public.profiles set role = 'admin' where id = '${ADMIN}';
  create schema snap;
  create table snap.shops as select * from public.shops;
  create table snap.orders as select * from public.orders;
`;

let db: PGlite;
let flowShops: Record<string, FlowShop>;

const as = <T>(role: "authenticated" | "service_role", sub: string | null, fn: (tx: Transaction) => Promise<T>) =>
  db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    if (sub) await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, role })]);
    return fn(tx);
  });

type Opts = { pages: (number | string)[]; copies?: number; colour?: ColourMode; paper?: PaperSize; sides?: SideMode };
type Created = { total_paise: number; rate_per_sheet_paise: number; pricing_unit: string; sheets: number };

/** What POST /api/orders does after inspecting the files: create_order_verified with server page counts. */
async function createOrder(shopId: string, o: Opts): Promise<Created> {
  await db.exec("delete from private.rate_limits");
  const files: Record<string, unknown>[] = [];
  for (const p of o.pages) {
    const path = `${STUDENT}/${randomUUID()}/${randomUUID()}.pdf`;
    await db.query(
      `insert into storage.objects (bucket_id, name, owner, metadata) values ('print-files', $1, $2, '{"size": "1000", "mimetype": "application/pdf"}')`,
      [path, STUDENT],
    );
    files.push({ storage_path: path, original_name: "a.pdf", mime_type: "application/pdf", size_bytes: 1000, page_count: p });
  }
  return as("service_role", null, async (tx) =>
    (await tx.query<Created>(
      "select total_paise, rate_per_sheet_paise, pricing_unit, sheets from public.create_order_verified($1, $2, $3, $4, $5, $6, $7::jsonb, null, 'PAY_AT_COUNTER')",
      [STUDENT, shopId, o.colour ?? "bw", o.paper ?? "a4", o.sides ?? "single", o.copies ?? 1, JSON.stringify(files)],
    )).rows[0]);
}

const estimatePaise = (shopId: string, o: Opts) => {
  const price = calculatePrice({
    shop: flowShops[shopId],
    options: { colour: o.colour ?? "bw", paper: o.paper ?? "a4", sides: o.sides ?? "single", copies: o.copies ?? 1 },
    pageCount: o.pages.reduce<number>((n, p) => n + Number(p), 0),
  });
  return price && Math.round(price.total * 100);
};

before(async () => {
  db = await freshSupabaseDb({ "20261025120300": PRODUCTION_LIKE });
  // Exactly what getListedShops reads, through the same RLS, as the signed-in student.
  const { listed, pricing, tiers } = await as("authenticated", STUDENT, async (tx) => ({
    listed: (await tx.query<{ id: string; listed: boolean }>("select id, listed from public.public_shops")).rows,
    pricing: (await tx.query<{ shop_id: string; colour_mode: string; paper_size: string; price_paise: number }>(
      "select shop_id, colour_mode, paper_size, price_paise from public.shop_pricing where service = 'print'")).rows,
    tiers: (await tx.query<{ shop_id: string; colour_mode: string; paper_size: string; price_paise: number; min_pages: number }>(
      "select shop_id, colour_mode, paper_size, min_pages, price_paise from public.shop_page_price_tiers")).rows,
  }));
  const shops = listed.filter((s) => s.listed !== false).map((s) => ({ id: s.id }) as PrintShop);
  flowShops = Object.fromEntries(toFlowShops(shops, pricing, tiers).map((s) => [s.id, s]));
});

describe("K2 A4 B&W: per page, by billable pages (pages x copies)", () => {
  const cases: [string, Opts, number][] = [
    ["1 page", { pages: [1] }, 500],
    ["2 pages", { pages: [2] }, 1000],
    ["3 pages", { pages: [3] }, 1500],
    ["4 pages", { pages: [4] }, 1200],
    ["8 pages", { pages: [8] }, 2400],
    ["9 pages", { pages: [9] }, 1800],
    ["10 pages", { pages: [10] }, 2000],
    ["1 page x 3 copies = 3", { pages: [1], copies: 3 }, 1500],
    ["2 pages x 2 copies = 4", { pages: [2], copies: 2 }, 1200],
    ["4 pages x 2 copies = 8", { pages: [4], copies: 2 }, 2400],
    ["3 pages x 3 copies = 9", { pages: [3], copies: 3 }, 1800],
    ["two files 2 + 2 = 4", { pages: [2, 2] }, 1200],
    ["double-sided is still per page", { pages: [10], sides: "double" }, 2000],
    ["100 pages x 20 copies", { pages: [100], copies: 20 }, 400000],
  ];
  for (const [name, o, paise] of cases) {
    it(`${name}: Rs${paise / 100}, and the estimate matches`, async () => {
      const row = await createOrder(K2, o);
      assert.deepEqual([row.total_paise, row.pricing_unit], [paise, "page"]);
      assert.equal(row.total_paise % row.rate_per_sheet_paise, 0); // rate x pages, whole paise
      assert.equal(estimatePaise(K2, o), paise);
    });
  }
});

describe("unchanged: K2 A3 and colour, other shops, historical orders", () => {
  const cases: [string, string, Opts, number][] = [
    ["K2 A3 B&W per sheet", K2, { pages: [3], paper: "a3" }, 3000],
    ["K2 A3 B&W double-sided per sheet", K2, { pages: [3], paper: "a3", sides: "double" }, 2000],
    ["K2 A4 colour per sheet", K2, { pages: [3], colour: "colour" }, 3000],
    ["K2 A3 colour per sheet", K2, { pages: [1], colour: "colour", paper: "a3", copies: 2 }, 5000],
    ["Sitaram A4 B&W per sheet (no tiers)", SITARAM, { pages: [3] }, 600],
    ["Sitaram A4 B&W 10 pages per sheet", SITARAM, { pages: [10] }, 2000],
    ["Sitaram A4 B&W double-sided per sheet", SITARAM, { pages: [3], sides: "double" }, 400],
  ];
  for (const [name, shop, o, paise] of cases) {
    it(`${name}: Rs${paise / 100}, and the estimate matches`, async () => {
      const row = await createOrder(shop, o);
      assert.deepEqual([row.total_paise, row.pricing_unit], [paise, "sheet"]);
      assert.equal(estimatePaise(shop, o), paise);
    });
  }

  it("only K2 has tiers, only for A4 B&W", async () => {
    const t = (await db.query<{ shop_id: string; colour_mode: string; paper_size: string; min_pages: number; price_paise: number }>(
      "select shop_id, colour_mode, paper_size, min_pages, price_paise from public.shop_page_price_tiers order by min_pages")).rows;
    assert.deepEqual(t.map((r) => [r.shop_id, r.colour_mode, r.paper_size, r.min_pages, r.price_paise]), [
      [K2, "bw", "a4", 1, 500], [K2, "bw", "a4", 4, 300], [K2, "bw", "a4", 9, 200],
    ]);
  });

  it("existing prices and orders are untouched by the migration", async () => {
    const pricing = await db.query("select 1 from public.shop_pricing p join public.shops s on s.id = p.shop_id where s.slug = 'k2-print-store' and p.colour_mode = 'bw' and p.paper_size = 'a4' and p.price_paise = 200");
    assert.equal(pricing.rows.length, 1);
    const changed = await db.query(`
      select o.id from public.orders o join snap.orders s on s.id = o.id
       where (to_jsonb(o) - 'pricing_unit') is distinct from to_jsonb(s)`);
    assert.deepEqual(changed.rows, []);
    const units = await db.query<{ pricing_unit: string }>("select pricing_unit from public.orders where id in ($1, $2)", [HIST_K2, HIST_HARSH]);
    assert.deepEqual(units.rows.map((r) => r.pricing_unit), ["sheet", "sheet"]);
  });
});

describe("pilot shop list: only K2 and Sitaram take new orders", () => {
  it("other shops are unlisted; Sitaram and K2 rows are otherwise identical; nothing else changed", async () => {
    const rows = (await db.query<{ id: string; listed: boolean; same: boolean }>(`
      select s.id, s.listed, (to_jsonb(s) - 'listed') = to_jsonb(p) as same
        from public.shops s join snap.shops p on p.id = s.id order by s.id`)).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.deepEqual([byId[K2].listed, byId[SITARAM].listed, byId[HARSH].listed, byId[SOURABH].listed], [true, true, false, false]);
    assert.equal(byId[K2].same && byId[SITARAM].same, true); // not even updated_at moved
    const flags = await db.query("select 1 from public.shops where not is_verified or deleted_at is not null");
    assert.deepEqual(flags.rows, []); // verification flags untouched
  });

  it("server-side: an unlisted shop's order is refused whatever the browser sends", async () => {
    for (const shop of [HARSH, SOURABH]) {
      await assert.rejects(createOrder(shop, { pages: [1] }), (e: { code?: string }) => e.code === "P0002");
    }
  });

  it("the picker hides unlisted shops, but past orders keep the shop's name", async () => {
    assert.deepEqual(Object.keys(flowShops).sort(), [K2, SITARAM].sort());
    const name = await as("authenticated", STUDENT, async (tx) =>
      (await tx.query<{ name: string }>("select name from public.public_shops where id = $1", [HARSH])).rows[0]?.name);
    assert.equal(name, "Harsh Bhaiya");
  });

  it("shop cards (signed out): K2's B&W shows Rs2-Rs5/page from public_shops.page_tiers, Sitaram stays per sheet", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.query("set local role anon");
      return (await tx.query<{ id: string; page_tiers: unknown }>("select id, page_tiers from public.public_shops")).rows;
    });
    const tiers = (id: string) => rows.find((r) => r.id === id)?.page_tiers;
    assert.deepEqual(perPageRange(tiers(K2), "bw"), { min: 2, max: 5 });
    assert.equal(formatPerPageRange(perPageRange(tiers(K2), "bw")!), "₹2–₹5/page");
    assert.equal(perPageRange(tiers(K2), "colour"), null);
    assert.equal(perPageRange(tiers(SITARAM), "bw"), null);
    assert.equal(perPageRange(undefined, "bw"), null); // before the migration: no column
  });
});

describe("who may change the shop list and the tiers", () => {
  const denied = (e: { code?: string }) => e.code === "42501";

  it("a shopkeeper can't list/unlist shops or edit tiers (not even their own)", async () => {
    await assert.rejects(as("authenticated", K2_KEEPER, (tx) => tx.query("update public.shops set listed = false where id = $1", [K2])), denied);
    await assert.rejects(as("authenticated", K2_KEEPER, (tx) => tx.query(
      "insert into public.shop_page_price_tiers (shop_id, colour_mode, paper_size, min_pages, price_paise) values ($1, 'bw', 'a4', 20, 1)", [K2])), denied);
    const n = await as("authenticated", K2_KEEPER, async (tx) =>
      (await tx.query("update public.shop_page_price_tiers set price_paise = 1 where shop_id = $1", [K2])).affectedRows);
    assert.equal(n, 0);
    const own = await as("authenticated", K2_KEEPER, async (tx) =>
      (await tx.query("select 1 from public.shop_page_price_tiers where shop_id = $1", [K2])).rows.length);
    assert.equal(own, 3); // can read their own tiers
  });

  it("a student can read tiers but not change them", async () => {
    const n = await as("authenticated", STUDENT, async (tx) =>
      (await tx.query("update public.shop_page_price_tiers set price_paise = 1")).affectedRows);
    assert.equal(n, 0);
  });

  it("admins are not locked out: they can relist a shop, manage tiers, and run the order lifecycle", async () => {
    await as("authenticated", ADMIN, async (tx) => {
      assert.equal((await tx.query("update public.shops set listed = true where id = $1", [SOURABH])).affectedRows, 1);
      await tx.query("insert into public.shop_page_price_tiers (shop_id, colour_mode, paper_size, min_pages, price_paise) values ($1, 'bw', 'a4', 1, 100)", [SOURABH]);
      assert.equal((await tx.query("delete from public.shop_page_price_tiers where shop_id = $1", [SOURABH])).affectedRows, 1);
      assert.equal((await tx.query("update public.shops set listed = false where id = $1", [SOURABH])).affectedRows, 1);
      assert.equal((await tx.query("update public.orders set status = 'CANCELLED', status_reason = 'Shop closed' where id = $1", [HIST_HARSH])).affectedRows, 1);
      throw new Error("rollback"); // leave the fixture as it was
    }).catch((e: Error) => assert.equal(e.message, "rollback"));
    assert.equal((await db.query<{ status: string }>("select status from public.orders where id = $1", [HIST_HARSH])).rows[0].status, "PENDING");
  });
});

describe("invalid inputs and the estimate maths", () => {
  it("copies, page counts and totals are validated by the database", async () => {
    for (const o of [{ pages: [1], copies: 0 }, { pages: [1], copies: 21 }, { pages: ["x"] }, { pages: [600, 600] }]) {
      await assert.rejects(createOrder(K2, o as Opts));
    }
  });

  it("pageTierRate picks the highest tier not above the pages, in any order; none below the first", () => {
    const tiers = [{ minPages: 9, pricePaise: 200 }, { minPages: 1, pricePaise: 500 }, { minPages: 4, pricePaise: 300 }];
    assert.deepEqual([1, 3, 4, 8, 9, 10, 1000].map((n) => pageTierRate(tiers, n)), [500, 500, 300, 300, 200, 200, 200]);
    assert.equal(pageTierRate([{ minPages: 4, pricePaise: 300 }], 3), null);
    assert.equal(pageTierRate(undefined, 3), null);
  });

  it("estimates are exact (integer paise, no float drift)", () => {
    for (let pages = 1; pages <= 50; pages++) {
      for (const copies of [1, 3, 7, 20]) {
        const p = estimatePaise(K2, { pages: [pages], copies })!;
        assert.ok(Number.isInteger(p));
        assert.equal(p, pages * copies * (pages * copies >= 9 ? 200 : pages * copies >= 4 ? 300 : 500));
      }
    }
  });
});
