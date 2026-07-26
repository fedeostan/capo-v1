import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The three date tabs became filters on /tarefas. Kept as redirects rather
  // than deleted outright: they are in installed PWAs' history and in the
  // agent's older prompt text. 307, not 308 — a permanent redirect is cached
  // in browsers indefinitely and would make reinstating these paths painful.
  async redirects() {
    return [
      { source: "/hoje", destination: "/tarefas?quando=hoje", permanent: false },
      { source: "/amanha", destination: "/tarefas?quando=amanha", permanent: false },
      { source: "/atrasadas", destination: "/tarefas?quando=atrasadas", permanent: false },
    ];
  },
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
