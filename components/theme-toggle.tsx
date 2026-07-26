// components/theme-toggle.tsx
"use client";
import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

export type Theme = "light" | "dark" | "system";

// Runs before hydration (inlined in <head>) to set the class pre-paint — prevents a flash of the wrong theme.
export const THEME_INIT_SCRIPT =
  '(function(){try{var t=localStorage.getItem("theme")||"system";var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();';

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "System", Icon: Monitor },
  { value: "dark", label: "Dark", Icon: Moon },
];

export function ThemeToggle() {
  // null = stored value not read yet. Gates the apply effect below so it never runs with the
  // "system" default before hydration — otherwise it would flash the DOM to the OS preference
  // (clobbering what THEME_INIT_SCRIPT already set pre-paint) and briefly overwrite the stored
  // preference in localStorage.
  const [theme, setTheme] = useState<Theme | null>(null);

  // Read the stored choice on mount (client-only, avoids SSR/hydration mismatch).
  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time client-only read; apply effect is gated on the null sentinel
    setTheme(stored === "light" || stored === "dark" || stored === "system" ? stored : "system");
  }, []);

  // Apply + persist on change; while on "system", track OS changes live.
  useEffect(() => {
    if (theme === null) return; // don't touch the DOM or storage before hydrating
    applyTheme(theme);
    localStorage.setItem("theme", theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const selected = theme ?? "system";

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={selected === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={`flex h-11 w-11 items-center justify-center rounded-md transition-colors ${
            selected === value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <Icon aria-hidden className="h-5 w-5" />
        </button>
      ))}
    </div>
  );
}
