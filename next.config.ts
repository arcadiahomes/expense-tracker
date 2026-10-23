import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // pdfkit and exceljs read their own data files at runtime; keep them as plain Node requires.
  serverExternalPackages: ["pdfkit", "exceljs"],
  // PDF reports, invoices and receipts embed these fonts (and the mark), read from disk at request time.
  outputFileTracingIncludes: {
    "/api/reports/**": ["./src/assets/fonts/**"],
    "/api/invoices/**": ["./src/assets/fonts/**", "./src/assets/arcadia-mark.png"],
  },
  async headers() {
    return [
      {
        // Every response: no framing (clickjacking), HTTPS only, and only the device features
        // the app uses (microphone for voice entry, camera for receipt photos). The CSP doesn't
        // restrict scripts (Next.js inlines its own), only framing, plugins, <base> and form targets.
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()" },
        ],
      },
      {
        // Every page and API response is per-user financial data: never store it in a shared
        // (CDN, proxy) or browser cache. Build assets and PWA files are excluded below.
        source: "/((?!_next/static|_next/image|icons/|manifest.webmanifest|sw.js|offline.html|favicon.ico|icon.png|apple-icon.png).*)",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // The service worker must be revalidated on every load so updates roll out.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
  partialPrefetching: true,
  experimental: {
    // Receipts and bill files go through server actions. 4 MB files (MAX_RECEIPT_BYTES) plus
    // form fields; Vercel refuses bodies over 4.5 MB anyway.
    serverActions: { bodySizeLimit: "4.5mb" },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
