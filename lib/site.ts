/**
 * Site-wide navigation and CTA targets. Anchors must match a section `id` on
 * the landing page; the primary CTA is a route, so navbar and hero both enter
 * the print flow.
 */
export const siteConfig = {
  name: "CampusPrint",
  tagline: "Print. Pay. Pick up. No queue.",
  nav: [
    { label: "How it works", href: "#how-it-works" },
    { label: "Shops", href: "#shops" },
  ],
  cta: {
    primary: { label: "Start printing", href: "/start-printing" },
    // The shop list is on the landing page itself and needs no sign-in.
    secondary: { label: "Find a shop", href: "#shops" },
  },
} as const;
