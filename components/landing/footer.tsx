import Link from "next/link";

import { Logo } from "@/components/shared/logo";
import { Container } from "@/components/shared/section";
import { siteConfig } from "@/lib/site";

const link =
  "rounded-full text-[13px] text-muted-foreground transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Landing footer. No contact details until real ones exist. */
export function Footer() {
  return (
    <footer className="border-t border-line">
      <Container className="flex flex-col gap-6 py-10 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-3">
          <Link href="/" aria-label={`${siteConfig.name} home`} className="w-fit rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Logo />
          </Link>
          <p className="text-[13px] text-muted-foreground">{siteConfig.tagline}</p>
        </div>

        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-6 gap-y-3">
            {siteConfig.nav.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className={link}>
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <Link href={siteConfig.cta.primary.href} className={link}>
                {siteConfig.cta.primary.label}
              </Link>
            </li>
            <li>
              <Link href="/login" className={link}>
                Sign in
              </Link>
            </li>
          </ul>
        </nav>
      </Container>

      <Container className="flex flex-col gap-1 border-t border-line py-5 text-[12px] text-muted-foreground sm:flex-row sm:justify-between">
        <p>
          &copy; {new Date().getFullYear()} {siteConfig.name}
        </p>
        {/* Skiper UI's free licence requires attribution for the hero crowd canvas. */}
        <p>
          Crowd canvas by Skiper UI, illustrations by{" "}
          <a href="https://www.openpeeps.com/" className="underline underline-offset-2 hover:text-ink" target="_blank" rel="noopener noreferrer">
            Open Peeps
          </a>
        </p>
      </Container>
    </footer>
  );
}
