"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/utils/supabase/client";

type State = "idle" | "sending" | "sent" | "error";

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("idle");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setState("sending");
    const callback = new URL("/auth/callback", window.location.origin);
    callback.searchParams.set("next", next);
    const { error } = await createClient().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callback.toString() },
    });
    setState(error ? "error" : "sent");
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
  );
}
