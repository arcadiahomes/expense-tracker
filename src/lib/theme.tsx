"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { DARK_QUERY, STORAGE_KEY } from "./theme-script";

/**
 * Minimal light/dark/system theme, replacing next-themes. Its client-rendered
 * <script> triggers a React 19 warning; the no-flash script now lives in the
 * root layout (THEME_INIT_SCRIPT in theme-script.ts). Same storage key, so saved choices carry over.
 */

export type Theme = "light" | "dark" | "system";

const CHANGE_EVENT = "app-theme-change";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function subscribeTheme(cb: () => void) {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

function subscribeSystem(cb: () => void) {
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "system" as Theme);
  const systemDark = useSyncExternalStore(
    subscribeSystem,
    () => window.matchMedia(DARK_QUERY).matches,
    () => false,
  );
  const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolvedTheme === "dark");
    root.classList.toggle("light", resolvedTheme === "light");
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice lasts until reload.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
