"use client";

import { ThemeProvider } from "@/lib/theme";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServiceWorkerRegistration } from "@/components/pwa";

/** App-wide client providers. Session data is provided by the (app) layout. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <TooltipProvider>
        {children}
        <Toaster position="top-center" />
        <ServiceWorkerRegistration />
      </TooltipProvider>
    </ThemeProvider>
  );
}
