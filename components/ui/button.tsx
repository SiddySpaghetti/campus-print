import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Based on shadcn/ui Button (21st.dev #1323), restyled for CampusPrint:
// pill shapes, ink-on-paper primary, 48px touch target at `lg`.
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full text-sm font-medium whitespace-nowrap transition-[background-color,color,border-color,box-shadow,translate] duration-200 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-ink text-paper hover:bg-ink/85",
        accent:
          "bg-accent text-ink shadow-[inset_0_0_0_1px_rgb(17_17_17/0.08)] hover:brightness-95",
        outline:
          "border border-line bg-card text-ink hover:border-ink/25 hover:bg-paper-deep",
        ghost: "text-ink hover:bg-paper-deep",
        link: "rounded-none px-0 text-ink underline decoration-line decoration-2 underline-offset-4 hover:decoration-ink",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
      },
      size: {
        default: "h-10 px-5",
        sm: "h-9 px-4",
        lg: "h-12 px-6 text-[15px]",
        icon: "size-10",
        "icon-sm": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
