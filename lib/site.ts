/**
 * Site-wide navigation and CTA targets.
 * Section anchors point at landing sections that are built in later phases;
 * the primary CTA is a route, so navbar and hero both enter the print flow.
 */
export const siteConfig = {
  name: "CampusPrint",
  tagline: "Print. Pay. Pick up. No queue.",
  nav: [
    { label: "How it works", href: "#how-it-works" },
    { label: "Print options", href: "#print-options" },
    { label: "Shops", href: "#shops" },
  ],
  cta: {
    primary: { label: "Start printing", href: "/start-printing" },
    secondary: { label: "Find a shop", href: "/start-printing" },
  },
} as const;
