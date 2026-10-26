/**
 * Runs every PART of supabase/tests/security_checks.sql — the script meant for
 * the Supabase SQL editor — against the real migrations in PGlite, and requires
 * each report to say "FAIL count: 0". Parts A–C impersonate three real
 * accounts and a shop with slug abc-xerox, so those are seeded here first;
 * PART D brings its own fixtures. Run: npm run test:security
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { freshSupabaseDb, ROOT } from "./supabase-pglite";

const SQL = readFileSync(join(ROOT, "supabase/tests/security_checks.sql"), "utf8");
const PARTS = [...SQL.matchAll(/^-- =+ (PART [A-Z]): ([^\n=]+?) =*\n(?:--[^\n]*\n)*(do \$\$[\s\S]*?^end \$\$;)/gm)].map((m) => ({
  name: `${m[1]}: ${m[2].trim()}`,
  block: m[3],
}));

/**
 * pg_cron does not exist in PGlite, so PART B's two "job is scheduled" lines
 * can only fail here. They are checked on the real project instead (read-only:
 * `select jobname, schedule, active from cron.job`). Nothing else may fail.
 */
const NOT_RUNNABLE_HERE = ["FAIL cron job missing/inactive", "FAIL prune job missing"];

let db: PGlite;

before(async () => {
  db = await freshSupabaseDb();
  await db.exec(`
    create schema cron;
    create table cron.job (jobname text, schedule text, command text, active boolean);
    grant usage on schema cron to service_role, authenticated;
    grant select on cron.job to service_role, authenticated;
    insert into auth.users (id, email, aud, role) values
      ('b0525bd1-1533-414a-9463-c6cd16bf5d8e', 'student@example.invalid', 'authenticated', 'authenticated'),
      ('37ee3d16-d5a7-4105-88f3-8485579ca862', 'shopkeeper@example.invalid', 'authenticated', 'authenticated'),
      ('21841d3f-08a6-4fae-881e-7e1b816d69ed', 'admin@example.invalid', 'authenticated', 'authenticated');
    insert into public.shops (name, slug, order_prefix, is_verified, is_open) values ('ABC Xerox', 'abc-xerox', 'A', true, true);
    update public.profiles set role = 'shopkeeper', shop_id = (select id from public.shops where slug = 'abc-xerox')
      where id = '37ee3d16-d5a7-4105-88f3-8485579ca862';
    update public.profiles set role = 'admin' where id = '21841d3f-08a6-4fae-881e-7e1b816d69ed';
    insert into public.shop_pricing (shop_id, service, colour_mode, paper_size, price_paise)
      select id, 'print', c, 'a4', p from public.shops, (values ('bw', 200), ('colour', 1000)) v(c, p) where slug = 'abc-xerox';
  `);
});

describe("supabase/tests/security_checks.sql (every part, real migrations)", () => {
  it("finds all parts", () => assert.deepEqual(PARTS.map((p) => p.name.slice(0, 6)), ["PART A", "PART B", "PART C", "PART D"]));

  for (const part of PARTS) {
    it(part.name, async () => {
      const report = await db.exec(part.block).then(
        () => "",
        (e: unknown) => String((e as Error).message),
      );
      assert.match(report, /REPORT \(everything rolled back\)/, `no report: ${report}`);
      const fails = report.split("\n").filter((l) => l.startsWith("FAIL"));
      const unexpected = fails.filter((l) => !NOT_RUNNABLE_HERE.includes(l.trim()));
      assert.deepEqual(unexpected, [], report);
      assert.ok(report.split("\n").filter((l) => l.startsWith("PASS")).length > 5, "too few checks ran");
    });
  }
});
