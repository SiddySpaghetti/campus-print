/**
 * Faint page furniture for the flow screens: a sheet outline, a hairline grid
 * and a couple of print registration marks. Decorative only, and deliberately
 * close to the paper colour so it never competes with content.
 */
export function PaperBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {/* Campus grid, faded out before it reaches the content */}
      <div
        className="absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--line) 1px, transparent 1px), linear-gradient(to bottom, var(--line) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage:
            "radial-gradient(ellipse 70% 55% at 50% 0%, #000 0%, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 70% 55% at 50% 0%, #000 0%, transparent 75%)",
        }}
      />

      {/* A sheet of paper drifting behind the content */}
      <div className="absolute -right-24 top-24 hidden h-64 w-48 rotate-[8deg] rounded-lg border border-line/70 lg:block" />
      <div className="absolute -left-20 top-72 hidden h-56 w-40 -rotate-[6deg] rounded-lg border border-line/70 lg:block" />

      {/* Registration marks */}
      <RegistrationMark className="left-6 top-28 hidden md:block" />
      <RegistrationMark className="right-8 bottom-40 hidden md:block" />
    </div>
  );
}

function RegistrationMark({ className }: { className?: string }) {
  return (
    <svg
      className={`absolute size-4 text-line ${className ?? ""}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 0v4M8 12v4M0 8h4M12 8h4" />
    </svg>
  );
}
