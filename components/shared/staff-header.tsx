import Link from "next/link";

import { Logo } from "@/components/shared/logo";
import { Container } from "@/components/shared/section";

const navLink =
  "rounded-full px-2.5 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:bg-paper-deep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Header for the shop and admin dashboards: logo, area name, account, sign out. */
export function StaffHeader({ area, email }: { area: string; email: string | undefined }) {
  return (
    <header className="border-b border-line bg-paper/80 backdrop-blur-md">
      <Container>
        <div className="flex h-16 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/"
              aria-label="CampusPrint home"
              className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Logo />
            </Link>
            <span className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {area}
            </span>
          </div>
          <form action="/auth/signout" method="post" className="flex min-w-0 items-center gap-2">
            <span className="hidden truncate text-[13px] text-muted-foreground md:inline">{email}</span>
            <button type="submit" className={navLink}>
              Sign out
            </button>
          </form>
        </div>
      </Container>
    </header>
  );
}
