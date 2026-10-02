import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * `cookies()` is async in this version of Next, so this function is too —
 * always `await createClient()`. Create a new client per request; never share
 * one across requests, or you risk leaking one user's session into another's.
 *
 * `getAll`/`setAll` are the supported cookie methods; the older
 * `get`/`set`/`remove` trio is deprecated in @supabase/ssr and mishandles
 * edge cases around token refresh.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    requireEnv(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components can't write cookies. That's expected — a
            // refreshed session is persisted by the middleware instead, so
            // this is safe to swallow *only* if middleware is in place.
          }
        },
      },
    },
  );
}

function requireEnv(name: string, value: string | undefined) {
  if (!value) {
    throw new Error(
      `Missing ${name}. Add it to .env.local and restart the dev server.`,
    );
  }

  return value;
}
