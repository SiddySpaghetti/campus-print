import type { NextConfig } from "next";

/**
 * Baseline response headers. Deliberately conservative: no Content-Security-
 * Policy yet (the motion/GSAP landing page and Razorpay Checkout will need a
 * tailored one, and a wrong CSP breaks pages) — add one when payments go live.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
