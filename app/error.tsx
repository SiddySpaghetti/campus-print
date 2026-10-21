"use client";

import Link from "next/link";

import { Logo } from "@/components/shared/logo";
import { Container } from "@/components/shared/section";
import { Button } from "@/components/ui/button";

/**
 * Fallback when a page fails to render, e.g. a dashboard whose database read
 * failed (pages throw rather than show an empty list). In production the error
 * message from a Server Component is generic; only the digest is shown, so it
 * can be matched to the server log.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main id="main" className="flex flex-1 flex-col">
      <Container className="flex min-h-dvh flex-col items-center justify-center py-16 text-center">
        <Link href="/" aria-label="CampusPrint home" className="mb-10 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Logo />
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink">
          Something went wrong
        </h1>
        <p role="alert" className="mt-3 max-w-sm text-[15px] text-muted-foreground">
          We couldn&apos;t load this page. Please try again in a moment.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button type="button" size="lg" onClick={() => retry()}>
            Try again
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/">Go to home</Link>
          </Button>
        </div>
        {error.digest ? (
          <p className="mt-6 font-mono text-[11px] text-muted-foreground">Reference: {error.digest}</p>
        ) : null}
      </Container>
    </main>
  );
}
