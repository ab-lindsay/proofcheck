// hooks/use-dev-mode.ts
"use client";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "devMode";
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

// Persists the choice and notifies every mounted useDevMode() subscriber in this tab —
// localStorage's own "storage" event only fires in OTHER tabs, not the one that wrote it.
export function setDevMode(value: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(value));
  listeners.forEach((listener) => listener());
}

export function useDevMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
