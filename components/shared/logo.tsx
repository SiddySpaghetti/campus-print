import { cn } from "@/lib/utils";

/** Mark: an ink tile holding a sheet of paper with a highlighter-lime fold. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      aria-hidden="true"
      className={cn("size-7 shrink-0", className)}
    >
      <rect width="28" height="28" rx="8" fill="var(--ink)" />
      <path d="M9 7h7l4 4v10H9z" fill="var(--paper)" />
      <path d="M16 7v4h4z" fill="var(--accent)" />
      <path
        d="M11.5 14.5h6M11.5 17.5h4"
        stroke="var(--ink)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span className="font-display text-lg font-semibold tracking-[-0.02em]">
        CampusPrint
      </span>
    </span>
  );
}
