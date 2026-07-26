"use client";
import { useSyncExternalStore } from "react";

/**
 * Whether the dev-mode user has opted into the escalation ladder for their own requests.
 *
 * OFF by default, matching the server default, because the ladder is a measured cost with no
 * measured benefit: ~75% more latency and ~55% more model calls for a null accuracy delta (see
 * docs/superpowers/plans/2026-07-24-escalation-eval-results.md). This toggle exists so the agentic
 * behaviour can still be demonstrated on demand — turn it on, verify a label, and the verdict card's
 * attempt trail shows exactly what the loop tried — without imposing the cost on everyday use or
 * needing a redeploy.
 *
 * Mirrors hooks/use-dev-tier.ts's store pattern (localStorage's own "storage" event only fires in
 * OTHER tabs, so writers notify subscribers directly).
 */
const STORAGE_KEY = "devEscalation";
type Listener = () => void;
const listeners = new Set<Listener>();

function getSnapshot(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

function getServerSnapshot(): boolean {
  return false;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setDevEscalation(value: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(value));
  listeners.forEach((listener) => listener());
}

export function useDevEscalation(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
