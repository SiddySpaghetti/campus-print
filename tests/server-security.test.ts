/**
 * Unit tests for the server-side security modules. Run: npm run test:security
 * (uses tsx via npx; no runtime dependency is added to the app).
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PDFDocument } from "pdf-lib";

import { SAFE, mapDbError } from "../lib/server/errors";
import { FileRejected, inspectFile, sniffMime } from "../lib/server/file-inspect";
import {
  onlinePaymentAllowed,
  razorpayAccount,
  razorpayAccounts,
  parsePaymentEvent,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "../lib/server/razorpay";
import {
  ValidationError,
  isOwnedStoragePath,
  isUuid,
  parseCreateOrder,
  parseUploadRequest,
  parseStatusChange,
  safeNextPath,
} from "../lib/server/validate";

const uid = randomUUID();
const goodPath = `${uid}/${randomUUID()}/${randomUUID()}.pdf`;
const base = {
  shopId: randomUUID(),
  colour: "bw",
  paper: "a4",
  sides: "single",
  copies: 1,
  files: [{ path: goodPath, name: "a.pdf" }],
};
const bad = (b: unknown) => assert.throws(() => parseCreateOrder(b, uid), ValidationError);

async function pdf(pages: number, objectStreams = false) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage();
  return await d.save({ useObjectStreams: objectStreams });
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

describe("input validation", () => {
  it("accepts a valid order", () => assert.equal(parseCreateOrder(base, uid).copies, 1));

  it("rejects client-supplied price / page_count / total (unexpected fields)", () => {
    for (const extra of ["price", "totalPaise", "pageCount", "page_count", "ratePerSheet", "subtotal", "amount"]) {
      bad({ ...base, [extra]: 1 });
    }
    bad({ ...base, files: [{ path: goodPath, name: "a.pdf", pageCount: 1 }] });
    bad({ ...base, files: [{ path: goodPath, name: "a.pdf", size: 1, mime: "application/pdf" }] });
  });

  it("rejects bad copies", () => {
    for (const copies of [0, -1, 21, 1000000, 1.5, "3", null, NaN, Infinity]) bad({ ...base, copies });
  });

  it("rejects invalid enums", () => {
    bad({ ...base, colour: "rainbow" });
    bad({ ...base, paper: "a5" });
    bad({ ...base, sides: "triple" });
    bad({ ...base, colour: "BW" });
  });

  it("rejects malformed UUIDs", () => {
    for (const shopId of ["x", "", "1", `${randomUUID()};drop`, randomUUID().toUpperCase(), null, 5]) {
      bad({ ...base, shopId });
    }
    assert.equal(isUuid(randomUUID()), true);
    assert.equal(isUuid("../../etc/passwd"), false);
  });

  it("rejects other users' paths, traversal, bucket root, wrong shapes", () => {
    const other = randomUUID();
    for (const path of [
      `${other}/${randomUUID()}/${randomUUID()}.pdf`,
      `${uid}/../${other}/${randomUUID()}/${randomUUID()}.pdf`,
      `${uid}/${randomUUID()}/../../x.pdf`,
      "loose.pdf",
      `${uid}/x.pdf`,
      `${uid}/${randomUUID()}/${randomUUID()}.exe`,
      `${uid}/${randomUUID()}/${randomUUID()}.PDF`,
      `/${uid}/${randomUUID()}/${randomUUID()}.pdf`,
      `${goodPath}\u0000.png`,
      `${goodPath}/`,
    ]) {
      assert.equal(isOwnedStoragePath(path, uid), false, path);
      bad({ ...base, files: [{ path, name: "x" }] });
    }
  });

  it("rejects too many / duplicate / empty files and oversized notes", () => {
    bad({ ...base, files: [] });
    bad({ ...base, files: [base.files[0], base.files[0]] });
    bad({
      ...base,
      files: Array.from({ length: 11 }, () => ({ path: `${uid}/${randomUUID()}/${randomUUID()}.pdf`, name: "a" })),
    });
    bad({ ...base, note: "x".repeat(501) });
  });

  it("rejects non-object bodies", () => {
    for (const b of [null, [], "x", 5]) bad(b);
  });

  it("upload request: type / extension / size rules", () => {
    assert.equal(parseUploadRequest({ mime: "application/pdf", extension: "pdf", sizeBytes: 1000, name: "a.pdf" }).ext, "pdf");
    for (const b of [
      { mime: "application/pdf", extension: "png", sizeBytes: 10, name: "a" },
      { mime: "application/x-msdownload", extension: "exe", sizeBytes: 10, name: "a" },
      { mime: "image/png", extension: "png", sizeBytes: 25 * 1024 * 1024 + 1, name: "a" },
      { mime: "image/png", extension: "png", sizeBytes: 0, name: "a" },
      { mime: "image/png", extension: "png", sizeBytes: -5, name: "a" },
      { mime: "image/png", extension: "png", sizeBytes: 10, name: "a", path: "../x" },
    ]) {
      assert.throws(() => parseUploadRequest(b), ValidationError);
    }
  });
});

describe("shop status changes", () => {
  it("accepts forward moves without a reason", () => {
    for (const status of ["ACCEPTED", "READY", "COMPLETED"]) {
      assert.deepEqual(parseStatusChange({ status }), { status, reason: null });
    }
  });
  it("has no bare 'start printing' move: only a document download starts printing", () => {
    assert.throws(() => parseStatusChange({ status: "PRINTING" }), ValidationError);
  });
  it("requires a short reason to reject or cancel", () => {
    assert.equal(parseStatusChange({ status: "REJECTED", reason: " blank file " }).reason, "blank file");
    for (const reason of [undefined, "", "   ", "x".repeat(201)]) {
      assert.throws(() => parseStatusChange({ status: "CANCELLED", reason }), ValidationError);
    }
  });
  it("rejects PENDING/PAID/unknown targets and any extra field (payment, price)", () => {
    for (const status of ["PENDING", "PAID", "paid", "accepted", 1, null]) {
      assert.throws(() => parseStatusChange({ status }), ValidationError);
    }
    for (const extra of ["payment_status", "total_paise", "shop_id"]) {
      assert.throws(() => parseStatusChange({ status: "ACCEPTED", [extra]: "PAID" }), ValidationError);
    }
  });
});

describe("post-login redirect", () => {
  it("keeps same-origin paths and rejects everything else", () => {
    assert.equal(safeNextPath("/start-printing/track?order=1"), "/start-printing/track?order=1");
    for (const v of ["//evil.com", "/\\evil.com", "https://evil.com", "evil", "/a\nb", 5, null, "/" + "a".repeat(300)]) {
      assert.equal(safeNextPath(v), "/start-printing", String(v));
    }
  });
});

describe("file inspection (server-side, content-based)", () => {
  it("counts the REAL pages of a 10-page PDF", async () => {
    const info = await inspectFile(await pdf(10), "pdf");
    assert.equal(info.pageCount, 10);
    assert.equal(info.mime, "application/pdf");
  });

  it("a client claim of page_count 1 or 9999 cannot reach pricing (field rejected; server count is 10)", async () => {
    bad({ ...base, files: [{ path: goodPath, name: "a", pageCount: 1 }] });
    bad({ ...base, files: [{ path: goodPath, name: "a", pageCount: 9999 }] });
    bad({ ...base, pageCount: 1 });
    assert.equal((await inspectFile(await pdf(10), "pdf")).pageCount, 10);
  });

  it("counts PDFs with compressed object streams (what the old regex missed)", async () => {
    assert.equal((await inspectFile(await pdf(7, true), "pdf")).pageCount, 7);
  });

  it("images are exactly one page", async () => {
    assert.equal((await inspectFile(PNG, "png")).pageCount, 1);
    assert.equal((await inspectFile(JPG, "jpg")).pageCount, 1);
    assert.equal((await inspectFile(JPG, "jpeg")).pageCount, 1);
  });

  it("rejects fake extensions / fake MIME (content decides)", async () => {
    await assert.rejects(inspectFile(PNG, "pdf"), FileRejected);
    await assert.rejects(inspectFile(await pdf(1), "png"), FileRejected);
    await assert.rejects(inspectFile(Buffer.from("MZ\x90\x00 not an image"), "png"), FileRejected);
    await assert.rejects(inspectFile(Buffer.from("<script>alert(1)</script>"), "pdf"), FileRejected);
    assert.equal(sniffMime(Buffer.from("hello")), null);
  });

  it("rejects empty, oversized, corrupt and absurdly long PDFs", async () => {
    await assert.rejects(inspectFile(new Uint8Array(0), "pdf"), FileRejected);
    await assert.rejects(inspectFile(new Uint8Array(25 * 1024 * 1024 + 1), "pdf"), FileRejected);
    await assert.rejects(inspectFile(Buffer.from("%PDF-1.7\nnot really a pdf"), "pdf"), FileRejected);
    await assert.rejects(inspectFile(await pdf(501), "pdf"), FileRejected);
    assert.equal((await inspectFile(await pdf(500), "pdf")).pageCount, 500);
  });
});

describe("webhook signature", () => {
  const secret = "test-secret-not-real";
  const body = JSON.stringify({ event: "payment.captured", payload: {} });
  const sign = (b: string, s = secret) => createHmac("sha256", s).update(b).digest("hex");

  it("accepts a correct signature", () => {
    assert.equal(verifyWebhookSignature(body, sign(body), secret), true);
  });

  it("rejects invalid, tampered, missing, wrong-secret and malformed signatures", () => {
    assert.equal(verifyWebhookSignature(body, sign(body, "other"), secret), false);
    assert.equal(verifyWebhookSignature(body + " ", sign(body), secret), false);
    assert.equal(verifyWebhookSignature(body, null, secret), false);
    assert.equal(verifyWebhookSignature(body, "", secret), false);
    assert.equal(verifyWebhookSignature(body, "zz".repeat(32), secret), false);
    assert.equal(verifyWebhookSignature(body, sign(body).slice(0, 62), secret), false);
    assert.equal(verifyWebhookSignature(body, sign(body), ""), false);
  });

  it("extracts only the fields it needs (no PII in the stored payload)", () => {
    const e = parsePaymentEvent({
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_1", order_id: "order_1", amount: 500, currency: "INR", email: "a@b.c", contact: "999", card: { last4: "1111" } },
        },
      },
    })!;
    assert.deepEqual(e.payload, { event: "payment.captured", order_id: "order_1", payment_id: "pay_1", amount: 500, currency: "INR" });
    assert.equal(JSON.stringify(e.payload).includes("a@b.c"), false);
  });

  it("refund events carry THIS refund's amount and id, never the payment's full amount", () => {
    for (const event of ["refund.processed", "refund.failed"]) {
      const e = parsePaymentEvent({
        event,
        payload: {
          refund: { entity: { id: "rfnd_ABC123", payment_id: "pay_1", amount: 150, currency: "INR", notes: { email: "a@b.c" } } },
          payment: { entity: { id: "pay_1", order_id: "order_1", amount: 500, amount_refunded: 150, currency: "INR", email: "a@b.c" } },
        },
      })!;
      assert.deepEqual(
        [e.eventType, e.paymentOrderId, e.paymentId, e.amountPaise, e.currency],
        [event, "order_1", "pay_1", 150, "INR"],
      );
      assert.deepEqual(e.payload, { event, order_id: "order_1", payment_id: "pay_1", refund_id: "rfnd_ABC123", amount: 150, currency: "INR" });
      assert.equal(JSON.stringify(e.payload).includes("a@b.c"), false);
    }
    // Without a payment entity the order is found by payment id; a refund without an amount stays unapplied (null).
    const bare = parsePaymentEvent({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_X12345", payment_id: "pay_2" } } } })!;
    assert.deepEqual([bare.paymentOrderId, bare.paymentId, bare.amountPaise], [null, "pay_2", null]);
  });
});

describe("online payment is Sitaram-only", () => {
  const SITARAM = "6f1c2a8e-1b2c-4d3e-8f90-123456789abc";
  const OTHER = "0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
  const env = { RAZORPAY_ENABLED_SHOP_ID: SITARAM, RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "s" };

  it("allows only the configured shop with its flag on and keys set", () => {
    assert.equal(onlinePaymentAllowed(SITARAM, true, env), true);
    assert.equal(onlinePaymentAllowed(SITARAM, true, { ...env, RAZORPAY_ENABLED_SHOP_ID: ` ${SITARAM.toUpperCase()} ` }), true);
  });

  it("fails closed on any other shop, flag, or missing config", () => {
    assert.equal(onlinePaymentAllowed(OTHER, true, env), false);
    assert.equal(onlinePaymentAllowed(SITARAM, false, env), false);
    assert.equal(onlinePaymentAllowed(SITARAM, undefined, env), false); // shop row / column missing
    assert.equal(onlinePaymentAllowed(SITARAM, "true", env), false);
    assert.equal(onlinePaymentAllowed(SITARAM, true, { ...env, RAZORPAY_ENABLED_SHOP_ID: undefined }), false);
    assert.equal(onlinePaymentAllowed(SITARAM, true, { ...env, RAZORPAY_ENABLED_SHOP_ID: "Sitaram Prints" }), false);
    assert.equal(onlinePaymentAllowed(SITARAM, true, { ...env, RAZORPAY_KEY_SECRET: undefined }), false);
    assert.equal(onlinePaymentAllowed(SITARAM, true, { ...env, RAZORPAY_KEY_ID: "" }), false);
  });
});

describe("each online shop uses its own Razorpay account", () => {
  const SITARAM = "6f1c2a8e-1b2c-4d3e-8f90-123456789abc";
  const K2 = "5497dc7f-b7ee-4f2b-b98f-5f68cbe31eb0";
  const OTHER = "0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
  const env = {
    RAZORPAY_ENABLED_SHOP_ID: SITARAM,
    RAZORPAY_KEY_ID: "rzp_test_sitaram",
    RAZORPAY_KEY_SECRET: "sitaram-secret",
    RAZORPAY_WEBHOOK_SECRET: "sitaram-hook",
    RAZORPAY_ENABLED_SHOP_ID_1: K2,
    RAZORPAY_KEY_ID_1: "rzp_test_k2",
    RAZORPAY_KEY_SECRET_1: "k2-secret",
  };

  it("hands each shop only its own keys", () => {
    assert.deepEqual(razorpayAccount(SITARAM, env), {
      shopId: SITARAM, keyId: "rzp_test_sitaram", keySecret: "sitaram-secret", webhookSecret: "sitaram-hook",
    });
    assert.deepEqual(razorpayAccount(K2, env), { shopId: K2, keyId: "rzp_test_k2", keySecret: "k2-secret", webhookSecret: null });
    assert.equal(razorpayAccount(OTHER, env), null);
    assert.equal(onlinePaymentAllowed(K2, true, env), true);
    assert.equal(onlinePaymentAllowed(OTHER, true, env), false);
  });

  it("fails closed on an incomplete set or two sets for one shop", () => {
    assert.equal(razorpayAccount(K2, { ...env, RAZORPAY_KEY_SECRET_1: undefined }), null);
    assert.equal(razorpayAccount(K2, { ...env, RAZORPAY_ENABLED_SHOP_ID_1: "K2 Print Store" }), null);
    assert.equal(razorpayAccount(SITARAM, { ...env, RAZORPAY_ENABLED_SHOP_ID_1: SITARAM }), null);
    assert.equal(razorpayAccounts({ ...env, RAZORPAY_ENABLED_SHOP_ID_1: undefined }).length, 1);
  });
});

describe("checkout signature", () => {
  const secret = "test-key-secret-not-real";
  const sign = (msg: string, s = secret) => createHmac("sha256", s).update(msg).digest("hex");
  const good = sign("order_ABC123|pay_XYZ789");

  it("accepts HMAC(stored order id|payment id)", () => {
    assert.equal(verifyCheckoutSignature("order_ABC123", "pay_XYZ789", good, secret), true);
  });

  it("rejects another order, another payment, wrong secret and junk", () => {
    assert.equal(verifyCheckoutSignature("order_OTHER1", "pay_XYZ789", good, secret), false);
    assert.equal(verifyCheckoutSignature("order_ABC123", "pay_OTHER1", good, secret), false);
    assert.equal(verifyCheckoutSignature("order_ABC123", "pay_XYZ789", sign("order_ABC123|pay_XYZ789", "x"), secret), false);
    assert.equal(verifyCheckoutSignature("order_ABC123", "pay_XYZ789", null, secret), false);
    assert.equal(verifyCheckoutSignature("order_ABC123", "pay_XYZ789", "zz".repeat(32), secret), false);
    assert.equal(verifyCheckoutSignature("order_ABC123", "pay_XYZ789", good, ""), false);
  });
});

describe("error handling never leaks database internals", () => {
  const leakyMessage =
    'duplicate key value violates unique constraint "order_files_storage_path_key" on public.order_files';
  it("maps DB errors to fixed safe messages", () => {
    for (const code of ["23505", "42501", "P0002", "P0001", "22023", "RL001", "XX000", undefined]) {
      const text = JSON.stringify(mapDbError({ code, message: leakyMessage }, SAFE.createFailed));
      for (const forbidden of ["order_files", "violates", "public.", "constraint", "duplicate key", "SELECT"]) {
        assert.equal(text.includes(forbidden), false, `${code}: ${forbidden}`);
      }
    }
    assert.equal(mapDbError({ code: "RL001" }, SAFE.createFailed).status, 429);
  });
});

describe("source hygiene: no secrets in client code, no sensitive logging", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (["node_modules", ".next", ".git"].includes(n)) return [];
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const files = ["app", "components", "lib", "utils"]
    .flatMap((d) => walk(join(root, d)))
    .filter((f) => /\.(ts|tsx)$/.test(f));
  const rel = (f: string) => f.slice(root.length + 1).replace(/\\/g, "/");

  it("service-role key / payment secrets are referenced only from server modules", () => {
    const allowed = ["utils/supabase/admin.ts", "app/api/", "lib/server/"];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/SERVICE_ROLE_KEY|RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET/.test(src)) {
        assert.ok(allowed.some((a) => rel(f).startsWith(a)), `${rel(f)} references a server secret`);
        assert.equal(/^["']use client["']/m.test(src), false, `${rel(f)} is a client component`);
      }
    }
  });

  it("no NEXT_PUBLIC_ variable holds a secret", () => {
    for (const f of files) {
      assert.equal(/NEXT_PUBLIC_[A-Z_]*(SECRET|SERVICE|PRIVATE|WEBHOOK)/.test(readFileSync(f, "utf8")), false, rel(f));
    }
  });

  it("console logging never includes tokens, headers, bodies, paths or secrets", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/console\.[a-z]+\(([^;]*)\)/g)) {
        const code = m[1].replace(/"[^"]*"|`[^`]*`/g, "");
        assert.equal(/(token|authorization|password|secret|cookie|headers|rawBody|body\b|storage_path|\.path\b|email|key)/i.test(code), false, `${rel(f)}: ${m[0]}`);
      }
    }
  });
});
