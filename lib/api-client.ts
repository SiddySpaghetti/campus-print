/**
 * POSTs JSON to one of our API routes. Throws an Error carrying the route's
 * fixed, user-safe message. A 401 sends the user to sign in again.
 */
export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);

  if (!response) throw new Error("Network error. Check your connection and try again.");
  if (response.status === 401) {
    // A full load (not router.push) so every server check re-runs on the new session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!response.ok || !data) {
    throw new Error(data?.error?.message ?? "Something went wrong.");
  }
  return data;
}
