import Link from "next/link";

import { FlowSteps } from "@/components/flow/flow-steps";
import { PaperBackdrop } from "@/components/flow/paper-backdrop";
import { Logo } from "@/components/shared/logo";
import { Container } from "@/components/shared/section";

/**
 * Frame for the whole print flow. Flow state lives in a module-level store
 * (see flow-state.tsx), so it survives navigation between these steps while
 * the header and step rail stay put.
 */
export default function StartPrintingLayout({ children }: LayoutProps<"/start-printing">) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col">
        <PaperBackdrop />

        <header className="border-b border-line bg-paper/80 backdrop-blur-md">
          <Container>
            <div className="flex h-16 items-center justify-between gap-4 md:h-18">
              <Link
                href="/"
                aria-label="CampusPrint home"
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
              >
                <Logo />
              </Link>
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Demo flow
              </span>
            </div>
            <FlowSteps />
          </Container>
        </header>

      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
