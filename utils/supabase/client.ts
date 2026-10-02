import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for Client Components and other browser code.
 *
 * `createBrowserClient` is a singleton per set of arguments, so calling this
 * on every render is fine — you get the same underlying client back.
 */
export function createClient() {
  return createBrowserClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  );
}

/** Fails loudly at the call site rather than on a confusing network error. */
function requireEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_ANON_KEY") {
  // Indexed access would break the build-time inlining of NEXT_PUBLIC_ vars,
  // so these are read as static property accesses.
  const value =
    name === "NEXT_PUBLIC_SUPABASE_URL"
      ? process.env.NEXT_PUBLIC_SUPABASE_URL
      : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!value) {
    throw new Error(
      `Missing ${name}. Add it to .env.local and restart the dev server.`,
    );
  }

  return value;
}
