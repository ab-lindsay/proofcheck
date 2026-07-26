"use client";
import { useSyncExternalStore } from "react";

/**
 * "auto" means "route exactly as the app does with dev mode off" — genuine bundled samples go to
 * their mock fixtures, everything else to cloud (or local-ocr when keyless). It is the DEFAULT so
 * that toggling dev mode never changes a verdict. The other values are deliberate overrides that
 * bypass fixture routing to exercise a real extractor.
 */
export type DevTier = "auto" | "local-ocr" | "local-llm" | "cloud";

const STORAGE_KEY = "devTier";
const VALID_TIERS: readonly DevTier[] = ["auto", "local-ocr", "local-llm", "cloud"];
type Listener = () => void;
const listeners = new Set<Listener>();

function isDevTier(value: string | null): value is DevTier {
  return value !== null && (VALID_TIERS as readonly string[]).includes(value);
}

function getSnapshot(): DevTier {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isDevTier(stored) ? stored : "auto";
}

function getServerSnapshot(): DevTier {
  return "auto";
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Persists the choice and notifies every mounted useDevTier() subscriber in this tab — mirrors
// hooks/use-dev-mode.ts's pattern (localStorage's own "storage" event only fires in OTHER tabs).
export function setDevTier(value: DevTier): void {
  localStorage.setItem(STORAGE_KEY, value);
  listeners.forEach((listener) => listener());
}

export function useDevTier(): DevTier {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
