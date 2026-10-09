"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/utils/supabase/client";

type State = "idle" | "sending" | "sent" | "error";

/** Same-origin `/auth/callback?next=…`; `next` is already sanitized by the page and again by the callback. */
function callbackUrl(next: string) {
  const callback = new URL("/auth/callback", window.location.origin);
  callback.searchParams.set("next", next);
  return callback.toString();
}

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("idle");
  const [google, setGoogle] = useState<"idle" | "redirecting" | "error">("idle");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setState("sending");
    const { error } = await createClient().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl(next) },
    });
    setState(error ? "error" : "sent");
  };

  // Back from Google restores this page from bfcache with the button still "redirecting".
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setGoogle("idle");
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const signInWithGoogle = async () => {
    setGoogle("redirecting");
    // On success the browser navigates to Google, so "redirecting" stays until the page unloads.
    try {
      const { error } = await createClient().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: callbackUrl(next) },
      });
      if (error) setGoogle("error");
    } catch {
      setGoogle("error");
    }
  };

  if (state === "sent") {
    return (
      <p role="status" className="mt-6 text-[14px] text-ink">
        Check <span className="font-medium">{email.trim()}</span> for your sign-in link. Open it
        in this browser.
      </p>
    );
  }

  return (
    <>
      <div className="mt-6 flex flex-col gap-3">
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={signInWithGoogle}
          disabled={google === "redirecting"}
          aria-busy={google === "redirecting"}
        >
          <GoogleIcon />
          {google === "redirecting" ? "Redirecting to Google…" : "Continue with Google"}
        </Button>
        {google === "error" ? (
          <p role="alert" className="text-[13px] font-medium text-destructive">
            Couldn&apos;t start Google sign-in. Try again, or use your email below.
          </p>
        ) : null}
      </div>
      <div
        aria-hidden="true"
        className="mt-6 flex items-center gap-3 text-[12px] text-muted-foreground"
      >
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
        <label htmlFor="email" className="text-[13px] font-medium text-ink">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="h-11 rounded-xl border border-line bg-paper px-3 text-[15px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {state === "error" ? (
          <p role="alert" className="text-[13px] font-medium text-destructive">
            Couldn&apos;t send the link. Wait a minute and try again.
          </p>
        ) : null}
        <Button type="submit" size="lg" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : "Email me a sign-in link"}
        </Button>
      </form>
    </>
  );
}

/** Google "G" mark, inline so no icon dependency is needed. */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.29A7.2 7.2 0 0 1 4.91 12c0-.8.14-1.57.38-2.29V6.6H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.4l4.01-3.11z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.6l4.01 3.11C6.23 6.88 8.88 4.77 12 4.77z"
      />
    </svg>
  );
}
