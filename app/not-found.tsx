import Link from "next/link";

import { Logo } from "@/components/shared/logo";
import { Container } from "@/components/shared/section";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Page not found" };

/** Branded 404 for unmatched URLs and `notFound()` calls. */
export default function NotFound() {
  return (
    <main id="main" className="flex flex-1 flex-col">
      <Container className="flex min-h-dvh flex-col items-center justify-center py-16 text-center">
        <Link href="/" aria-label="CampusPrint home" className="mb-10 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Logo />
        </Link>
        <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">404</p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.02em] text-ink">
          This page isn&apos;t in the tray
        </h1>
        <p className="mt-3 max-w-sm text-[15px] text-muted-foreground">
          The link may be wrong or the page may have moved.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button asChild size="lg">
            <Link href="/">Go to home</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/start-printing">Start printing</Link>
          </Button>
        </div>
      </Container>
    </main>
  );
}
