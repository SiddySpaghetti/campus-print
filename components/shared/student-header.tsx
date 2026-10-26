import Link from "next/link";
import { Bell } from "lucide-react";

import { Logo, LogoMark } from "@/components/shared/logo";
import { Container } from "@/components/shared/section";
import { getPageSession } from "@/lib/server/auth";

const navLink =
  "rounded-full px-2.5 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:bg-paper-deep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Header for every signed-in student page: home, My orders, notifications
 * (with the unread count, read through RLS so only the student's own) and
 * sign out. `children` renders under it (the print flow's step rail).
 *
 * It renders nothing for non-students and never guards: a layout can't see
 * the URL, so each page calls requireStudentPage itself with its own `next`.
 */
export async function StudentHeader({ children }: { children?: React.ReactNode }) {
  const { supabase, user, profile } = await getPageSession();
  if (!user || !profile || profile.deleted_at || profile.role !== "student") return null;
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);
  const unread = count ?? 0;

  return (
    <header className="border-b border-line bg-paper/80 backdrop-blur-md">
      <Container>
        <div className="flex h-16 items-center justify-between gap-3 md:h-18">
          <Link
            href="/"
            aria-label="CampusPrint home"
            className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            {/* The wordmark doesn't fit beside the nav below 375px. */}
            <Logo className="max-[375px]:hidden" />
            <LogoMark className="min-[375px]:hidden" />
          </Link>

          <nav aria-label="Account" className="flex min-w-0 items-center gap-1">
            <Link href="/start-printing" className={`${navLink} hidden sm:inline-flex`}>
              Print
            </Link>
            <Link href="/orders" className={navLink}>
              My orders
            </Link>
            <Link
              href="/notifications"
              className={`${navLink} relative inline-flex items-center`}
              aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
            >
              <Bell aria-hidden="true" className="size-4" strokeWidth={1.75} />
              {unread ? (
                <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums tracking-normal text-ink">
                  {unread > 9 ? "9+" : unread}
                </span>
              ) : null}
            </Link>
            <form action="/auth/signout" method="post" className="flex min-w-0 items-center gap-2 pl-2">
              <span className="hidden truncate text-[13px] text-muted-foreground md:inline">{user.email}</span>
              <button type="submit" className={navLink}>
                Sign out
              </button>
            </form>
          </nav>
        </div>
        {children}
      </Container>
    </header>
  );
}
