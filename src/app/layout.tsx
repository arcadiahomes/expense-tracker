import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";
import Script from "next/script";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Providers } from "@/components/providers";
import { THEME_INIT_SCRIPT } from "@/lib/theme-script";
import "./globals.css";

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Arcadia Home", template: "%s | Arcadia Home" },
  description: "Construction site expense management for Arcadia Home.",
  applicationName: "Arcadia Home",
  // iOS home-screen install (iOS reads these, not the manifest).
  appleWebApp: { capable: true, title: "Arcadia", statusBarStyle: "default" },
  // Long amounts and bill numbers aren't phone numbers.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Content can use the full screen on notched phones; padding uses env(safe-area-inset-*).
  // Zoom is never disabled.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f7f4" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1410" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className={`${figtree.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
      </head>
      <body className="min-h-full">
        <Providers>{children}</Providers>
        <SpeedInsights />
      </body>
    </html>
  );
}
