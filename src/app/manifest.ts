import type { MetadataRoute } from "next";

/** Installable app: opens standalone, with shortcuts to the screens used on site. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Arcadia Home: site expenses",
    short_name: "Arcadia",
    description: "Construction site expenses, labour, materials and bills.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    lang: "en-IN",
    background_color: "#f4f7f4",
    theme_color: "#14532d",
    categories: ["business", "finance", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Log by voice", short_name: "Voice", url: "/voice", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Pay labour", short_name: "Labour", url: "/labour", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Materials", url: "/materials", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
