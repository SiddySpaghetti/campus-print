import { cn } from "@/lib/utils";

type SectionHeadingProps = {
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  align?: "left" | "center";
  /** Heading level; sections below the hero use h2. */
  as?: "h1" | "h2" | "h3";
  id?: string;
  className?: string;
};

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "left",
  as: Heading = "h2",
  id,
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={cn(
        "flex max-w-2xl flex-col gap-4",
        align === "center" && "mx-auto items-center text-center",
        className,
      )}
    >
      {eyebrow ? (
        <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {eyebrow}
        </p>
      ) : null}
      <Heading
        id={id}
        className="font-display text-3xl font-semibold leading-[1.05] tracking-[-0.025em] text-balance md:text-5xl"
      >
        {title}
      </Heading>
      {description ? (
        <p className="text-base leading-relaxed text-muted-foreground text-pretty md:text-lg">
          {description}
        </p>
      ) : null}
    </div>
  );
}
