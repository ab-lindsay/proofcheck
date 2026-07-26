"use client";
import { useEffect, useState } from "react";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDevBedrockModel, setDevBedrockModel, type DevBedrockModel } from "@/hooks/use-dev-model";

const OPTIONS: { value: DevBedrockModel; label: string; title: string }[] = [
  {
    value: "haiku",
    label: "Haiku 4.5",
    title: "Fastest, lowest cost — passes 5s p95 budget (4431ms)",
  },
  {
    value: "opus",
    label: "Opus 4.5",
    title: "Highest accuracy (89%) — exceeds 5s p95 budget (7586ms)",
  },
];

const DISABLED_TITLE = "No cloud API key configured on the server — this choice has no effect until one is";

export function ModelPicker() {
  const devMode = useDevMode();
  const model = useDevBedrockModel();
  // Fail closed, mirroring tier-switcher.tsx's own gate: never assume Bedrock is reachable. Gated
  // on cloudAvailable alone (not "is devTier cloud") — route.ts applies devBedrockModel whenever the
  // *selected* provider is bedrock, which "auto" routes to too whenever a key is configured, not
  // only a forced "cloud" devTier. Without this, picking a model here silently does nothing whenever
  // no key is configured — a control that looks live but isn't.
  const [cloudAvailable, setCloudAvailable] = useState(false);

  useEffect(() => {
    if (!devMode) return;
    let cancelled = false;
    fetch("/api/verify")
      .then((res) => (res.ok ? res.json() : { cloudAvailable: false }))
      .then((body: { cloudAvailable?: boolean }) => {
        if (!cancelled) setCloudAvailable(body.cloudAvailable === true);
      })
      .catch(() => {
        if (!cancelled) setCloudAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [devMode]);

  if (!devMode) return null;

  return (
    <div
      role="radiogroup"
      aria-label="Bedrock model"
      aria-disabled={!cloudAvailable || undefined}
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1"
    >
      {OPTIONS.map(({ value, label, title }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={model === value}
          aria-disabled={!cloudAvailable || undefined}
          title={cloudAvailable ? title : DISABLED_TITLE}
          onClick={() => {
            if (!cloudAvailable) return;
            setDevBedrockModel(value);
          }}
          className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            !cloudAvailable
              ? "cursor-not-allowed text-muted-foreground/40"
              : model === value
                ? value === "opus"
                  ? "bg-amber-500 text-amber-950"
                  : "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
