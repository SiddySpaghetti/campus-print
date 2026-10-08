/**
 * Strict, dependency-free request validation. Pure functions with relative
 * imports only, so they can be unit-tested with plain Node.
 *
 * Rule of thumb: every value that came from a browser is hostile. Unknown
 * fields are rejected, enums are matched exactly, numbers must be integers in
 * range, and ids must be canonical lower-case UUIDs.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const COLOUR_MODES = ["bw", "colour"] as const;
export const PAPER_SIZES = ["a4", "a3"] as const;
export const SIDES = ["single", "double"] as const;
export const MIME_TO_EXT = {
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
} as const;
export type AllowedMime = keyof typeof MIME_TO_EXT;

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_COPIES = 20;
export const MAX_FILES_PER_ORDER = 10;
export const MAX_NOTE_LENGTH = 500;

export class ValidationError extends Error {
  name = "ValidationError";
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** `<user-id>/<upload-uuid>/<file-uuid>.<ext>`, lower-case, nothing else. */
export function isOwnedStoragePath(path: unknown, userId: string): path is string {
  if (typeof path !== "string" || path.length > 200) return false;
  const re = new RegExp(
    `^${userId}/[0-9a-f-]{36}/[0-9a-f-]{36}\\.(pdf|png|jpg|jpeg)$`,
  );
  if (!isUuid(userId) || !re.test(path)) return false;
  const [, upload, file] = path.split("/");
  return isUuid(upload) && isUuid(file.replace(/\.[a-z]+$/, ""));
}

/** Display name only: never used for a path. Control chars and slashes removed. */
export function sanitizeFileName(name: unknown): string {
  if (typeof name !== "string") return "document";
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 255);
  return cleaned || "document";
}

function exactKeys(obj: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ValidationError("unexpected field");
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("body must be an object");
  }
  return value as Record<string, unknown>;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError("invalid option");
  }
  return value as T;
}

export type CreateOrderInput = {
  shopId: string;
  colour: (typeof COLOUR_MODES)[number];
  paper: (typeof PAPER_SIZES)[number];
  sides: (typeof SIDES)[number];
  copies: number;
  note: string | null;
  files: { path: string; name: string }[];
};

/**
 * Note what is deliberately ABSENT: price, total, rate, page count, size and
 * MIME type. The browser cannot supply them; the server derives every one.
 */
export function parseCreateOrder(body: unknown, userId: string): CreateOrderInput {
  const b = asObject(body);
  exactKeys(b, ["shopId", "colour", "paper", "sides", "copies", "note", "files"]);

  if (!isUuid(b.shopId)) throw new ValidationError("invalid shop");
  const copies = b.copies;
  if (!Number.isInteger(copies) || (copies as number) < 1 || (copies as number) > MAX_COPIES) {
    throw new ValidationError("invalid copies");
  }
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string" || b.note.length > MAX_NOTE_LENGTH) {
      throw new ValidationError("invalid note");
    }
    note = b.note.trim() || null;
  }

  if (!Array.isArray(b.files) || b.files.length < 1 || b.files.length > MAX_FILES_PER_ORDER) {
    throw new ValidationError("invalid files");
  }
  const seen = new Set<string>();
  const files = b.files.map((f) => {
    const o = asObject(f);
    exactKeys(o, ["path", "name"]);
    if (!isOwnedStoragePath(o.path, userId)) throw new ValidationError("invalid file path");
    if (seen.has(o.path)) throw new ValidationError("duplicate file");
    seen.add(o.path);
    return { path: o.path, name: sanitizeFileName(o.name) };
  });

  return {
    shopId: b.shopId,
    colour: oneOf(b.colour, COLOUR_MODES),
    paper: oneOf(b.paper, PAPER_SIZES),
    sides: oneOf(b.sides, SIDES),
    copies: copies as number,
    note,
    files,
  };
}

export type UploadRequest = { mime: AllowedMime; ext: string; sizeBytes: number; name: string };

export function parseUploadRequest(body: unknown): UploadRequest {
  const b = asObject(body);
  exactKeys(b, ["mime", "extension", "sizeBytes", "name"]);
  const mime = oneOf(b.mime, Object.keys(MIME_TO_EXT) as AllowedMime[]);
  const ext = typeof b.extension === "string" ? b.extension.toLowerCase() : "";
  if (!(MIME_TO_EXT[mime] as readonly string[]).includes(ext)) {
    throw new ValidationError("extension does not match type");
  }
  const size = b.sizeBytes;
  if (!Number.isInteger(size) || (size as number) < 1 || (size as number) > MAX_FILE_BYTES) {
    throw new ValidationError("invalid size");
  }
  return { mime, ext, sizeBytes: size as number, name: sanitizeFileName(b.name) };
}

/**
 * Post-login redirect target. Same-origin relative paths only, so a crafted
 * `?next=` can't bounce a freshly signed-in user to another site.
 */
export function safeNextPath(value: unknown, fallback = "/start-printing"): string {
  if (typeof value !== "string" || value.length > 200) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) {
    return fallback;
  }
  return value;
}

/** For `[id]` route params. */
export function parseUuidParam(value: unknown): string {
  if (!isUuid(value)) throw new ValidationError("invalid id");
  return value;
}
