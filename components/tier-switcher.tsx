"use client";
import { useEffect, useRef, useState } from "react";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDevTier, setDevTier, type DevTier } from "@/hooks/use-dev-tier";

const OPTIONS: { value: DevTier; label: string; title: string }[] = [
  {
    value: "auto",
    label: "Auto",
    title: "Same routing as normal use — bundled samples return their fixtures, so verdicts match the gallery",
  },
  { value: "local-ocr", label: "Local OCR", title: "Force real OCR, even on bundled samples" },
  { value: "local-llm", label: "Local LLM", title: "Force the local vision LLM (needs Ollama running)" },
  { value: "cloud", label: "Cloud", title: "Force the configured cloud model" },
];

export function TierSwitcher() {
  const devMode = useDevMode();
  const tier = useDevTier();
  // Fail closed: Cloud starts (and stays, on any error) disabled until the server explicitly
  // confirms a key is configured — never assume it's available.
  const [cloudAvailable, setCloudAvailable] = useState(false);

  // Read inside the fetch callback below via a ref (not a `tier` dependency on the effect) so we
  // always see the latest selection at the moment the fetch resolves, without re-fetching every
  // time the tier changes (which a `tier` dependency would cause, including from our own
  // self-correction below). Updated in its own effect, not during render.
  const tierRef = useRef(tier);
  useEffect(() => {
    tierRef.current = tier;
  }, [tier]);

  useEffect(() => {
    if (!devMode) return;
    let cancelled = false;
    const settle = (available: boolean) => {
      if (cancelled) return;
      setCloudAvailable(available);
      // Cloud is no longer the default (that's "auto"), so a "cloud" selection here was either
      // chosen explicitly or persisted from a session where a key existed. Either way it would now
      // 400 on every verify, so drop back to "auto" — the app's normal routing, and the only choice
      // guaranteed to work. Never touch a non-Cloud selection.
      if (!available && tierRef.current === "cloud") {
        setDevTier("auto");
      }
    };
    fetch("/api/verify")
      .then((res) => (res.ok ? res.json() : { cloudAvailable: false }))
      .then((body: { cloudAvailable?: boolean }) => settle(body.cloudAvailable === true))
      .catch(() => settle(false));
    return () => {
      cancelled = true;
    };
  }, [devMode]);

  if (!devMode) return null;

  return (
    <div
      role="radiogroup"
      aria-label="Extraction tier"
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1"
    >
      {OPTIONS.map(({ value, label, title }) => {
        const disabled = value === "cloud" && !cloudAvailable;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={tier === value}
            aria-disabled={disabled || undefined}
            title={disabled ? "No cloud API key configured on the server" : title}
            onClick={() => {
              if (disabled) return;
              setDevTier(value);
            }}
            className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
              tier === value
                ? "bg-primary text-primary-foreground"
                : disabled
                  ? "cursor-not-allowed text-muted-foreground/40"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
