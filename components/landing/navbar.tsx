"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Menu, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/shared/logo";
import { siteConfig } from "@/lib/site";

// Adapted from 21st.dev "Navbar 1" (#2046): a floating pill bar with a
// slide-in mobile menu. Restyled as a paper bar with a hairline border,
// and rebuilt with real links, ARIA state, and Escape-to-close.
export function Navbar() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header className="sticky top-0 z-50 px-3 pt-3 md:px-6 md:pt-4">
      <div className="mx-auto max-w-[1120px]">
        <div className="flex h-14 items-center justify-between rounded-full border border-line bg-paper/85 pl-4 pr-2 backdrop-blur-md md:h-16 md:pl-6">
          <Link
            href="/"
            aria-label={`${siteConfig.name} home`}
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            <Logo />
          </Link>

          <nav aria-label="Main" className="hidden md:block">
            <ul className="flex items-center gap-1">
              {siteConfig.nav.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="rounded-full px-3 py-2 text-sm font-medium text-muted-foreground lg:px-4 transition-colors hover:bg-paper-deep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex items-center gap-1">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex md:h-10 lg:px-5">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild size="sm" className="hidden sm:inline-flex md:h-10 md:px-5">
              <Link href={siteConfig.cta.primary.href}>
                {siteConfig.cta.primary.label}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            <Button
              ref={toggleRef}
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-expanded={open}
              aria-controls={menuId}
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? <X aria-hidden="true" className="size-5" /> : <Menu aria-hidden="true" className="size-5" />}
            </Button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {open ? (
            <motion.nav
              id={menuId}
              aria-label="Mobile"
              className="mt-2 overflow-hidden rounded-3xl border border-line bg-paper shadow-[0_12px_40px_-12px_rgb(17_17_17/0.18)] md:hidden"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              <ul className="flex flex-col p-2">
                {siteConfig.nav.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={close}
                      className="flex h-12 items-center rounded-2xl px-4 text-base font-medium text-ink transition-colors hover:bg-paper-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-2 border-t border-line p-3">
                <Button asChild variant="outline" size="lg" className="w-full">
                  <Link href="/login" onClick={close}>
                    Sign in
                  </Link>
                </Button>
                <Button asChild size="lg" className="w-full">
                  <Link href={siteConfig.cta.primary.href} onClick={close}>
                    {siteConfig.cta.primary.label}
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </motion.nav>
          ) : null}
        </AnimatePresence>
      </div>
    </header>
  );
}
