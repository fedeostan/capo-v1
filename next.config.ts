import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Service-worker headers per the Next.js PWA guide: never cache sw.js so
  // deploys take effect immediately, and lock its CSP down to same-origin.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
