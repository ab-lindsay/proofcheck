"use client";
import { useRef, useState } from "react";
import { useDevMode, setDevMode } from "@/hooks/use-dev-mode";
import { DevModeConfirm } from "@/components/dev-mode-confirm";

export function DevModeToggle() {
  const enabled = useDevMode();
  const [confirming, setConfirming] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Dev mode"
        title="Dev mode: technical debugging tools for testing"
        onClick={() => (enabled ? setDevMode(false) : setConfirming(true))}
        className={`rounded-md px-2.5 py-1.5 text-sm font-semibold uppercase tracking-wide transition-colors ${
          enabled
            ? "bg-white/20 text-primary-foreground"
            : "text-primary-foreground/60 hover:bg-white/10 hover:text-primary-foreground/90"
        }`}
      >
        Dev
      </button>
      <DevModeConfirm
        anchorRef={buttonRef}
        open={confirming}
        onConfirm={() => {
          setDevMode(true);
          setConfirming(false);
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
