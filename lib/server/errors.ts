/**
 * Safe error responses. Users only ever see the fixed messages below; the real
 * error is logged server-side (message + code only, never payloads, tokens,
 * file paths or personal data).
 */

export type SafeError = { status: number; code: string; message: string };

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const SAFE = {
  unauthenticated: { status: 401, code: "unauthenticated", message: "Please sign in." },
  forbidden: { status: 403, code: "forbidden", message: "You can't do that." },
  badRequest: { status: 400, code: "bad_request", message: "Invalid request." },
  badOptions: { status: 400, code: "invalid_options", message: "Invalid print options." },
  badFile: { status: 422, code: "file_rejected", message: "File could not be processed." },
  shopUnavailable: { status: 409, code: "shop_unavailable", message: "This shop isn't taking orders right now." },
  rateLimited: { status: 429, code: "rate_limited", message: "Too many requests. Please wait a moment and try again." },
  createFailed: { status: 500, code: "create_failed", message: "Unable to create order." },
  cancelFailed: { status: 409, code: "cancel_failed", message: "Order could not be cancelled." },
  statusFailed: { status: 409, code: "status_failed", message: "This order can't be moved to that status. Refresh and try again." },
  notFound: { status: 404, code: "not_found", message: "Not found." },
  notPrintable: { status: 409, code: "not_printable", message: "This order is closed, so its files can't be downloaded." },
  unpaid: { status: 409, code: "unpaid", message: "This order hasn't been paid yet, so it can't be printed." },
  downloadFailed: { status: 502, code: "download_failed", message: "The document couldn't be prepared. Try again." },
  payFailed:{ status: 502, code: "payment_unavailable", message: "Payment couldn't be started. Please try again." },
  notConfigured: { status: 503, code: "unavailable", message: "This feature isn't available right now." },
  internal: { status: 500, code: "internal", message: "Something went wrong." },
} as const satisfies Record<string, SafeError>;

/** Postgres/PostgREST error shape. Only `code` is ever inspected. */
type DbError = { code?: string; message?: string };

/**
 * Maps a database error to a fixed, safe response. The message text from the
 * database is deliberately NOT used.
 */
export function mapDbError(error: DbError, fallback: SafeError): SafeError {
  switch (error.code) {
    case "RL001":
      return SAFE.rateLimited;
    case "22023":
      return SAFE.badOptions;
    case "42501":
    case "28000":
      return SAFE.forbidden;
    case "P0002":
    case "P0001":
      return fallback === SAFE.createFailed ? SAFE.shopUnavailable : fallback;
    case "23505":
      return SAFE.badFile;
    default:
      return fallback;
  }
}

/** Log the cause without leaking user data: scope + error code + a short message. */
export function logServerError(scope: string, error: unknown) {
  const e = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof e?.code === "string" ? e.code : undefined;
  const name = typeof e?.name === "string" ? e.name : "Error";
  const message = typeof e?.message === "string" ? e.message.slice(0, 200) : "";
  console.error(`[${scope}]`, JSON.stringify({ name, code, message }));
}

export function errorResponse(error: SafeError, headers?: HeadersInit) {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status, headers },
  );
}

/**
 * Wraps a Route Handler so that nothing but a SafeError can ever leave it.
 * HttpError and validation failures map to fixed messages; anything else is
 * logged and becomes a generic 500.
 */
export async function handle(scope: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status >= 500) logServerError(scope, error);
      const known = Object.values(SAFE).find((s) => s.code === error.code);
      return errorResponse(known ?? SAFE.internal);
    }
    const name = (error as { name?: string })?.name;
    if (name === "ValidationError") return errorResponse(SAFE.badRequest);
    if (name === "FileRejected") return errorResponse(SAFE.badFile);
    logServerError(scope, error);
    return errorResponse(SAFE.internal);
  }
}

/** Small JSON bodies only; rejects oversized or malformed input. */
export async function readJson(request: Request, maxBytes = 20_000): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new HttpError(400, SAFE.badRequest.code, SAFE.badRequest.message);
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(400, SAFE.badRequest.code, SAFE.badRequest.message);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, SAFE.badRequest.code, SAFE.badRequest.message);
  }
}
