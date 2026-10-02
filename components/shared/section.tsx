import { cn } from "@/lib/utils";

type SectionProps = React.ComponentProps<"section"> & {
  /** Classes for the inner max-width container. */
  containerClassName?: string;
  /** Vertical rhythm. `none` lets the section control its own padding. */
  spacing?: "default" | "compact" | "none";
};

const spacingClasses = {
  default: "py-20 md:py-32",
  compact: "py-12 md:py-20",
  none: "",
} as const;

export function Section({
  className,
  containerClassName,
  spacing = "default",
  children,
  ...props
}: SectionProps) {
  return (
    <section className={cn(spacingClasses[spacing], className)} {...props}>
      <Container className={containerClassName}>{children}</Container>
    </section>
  );
}

/** The shared 1120px content column with mobile-first gutters. */
export function Container({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("mx-auto w-full max-w-[1120px] px-5 md:px-8", className)}
      {...props}
    />
  );
}
