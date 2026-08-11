import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // completeTaskWithPhotos posts image files through a Server Action, and
      // the framework default is 1 MB — six site photos do not fit in that.
      //
      // 4 MB, not more, and the ceiling is not ours: a Vercel Function refuses
      // a request body over 4.5 MB before Next.js ever sees it, so anything
      // above this would fail in production while passing locally. The limit
      // applies to the RAW multipart body, boundaries and part headers
      // included, which is where the remaining ~500 KB of headroom goes.
      //
      // Six photos fit because the completion sheet re-encodes each one to
      // ~1600px JPEG in the browser first (downscaleToJpeg) — typically
      // 200–500 KB. Raising TASK_PHOTO_MAX_PER_UPLOAD without revisiting that
      // maths is how this starts failing on the biggest photos only.
      bodySizeLimit: '4mb',
    },
  },
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
