"use client";
import { useSyncExternalStore } from "react";

export type DevBedrockModel = "haiku" | "opus";

const STORAGE_KEY = "devBedrockModel";
const VALID_MODELS: readonly DevBedrockModel[] = ["haiku", "opus"];
type Listener = () => void;
const listeners = new Set<Listener>();

function isDevBedrockModel(value: string | null): value is DevBedrockModel {
  return value !== null && (VALID_MODELS as readonly string[]).includes(value);
}

function getSnapshot(): DevBedrockModel {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isDevBedrockModel(stored) ? stored : "haiku";
}

function getServerSnapshot(): DevBedrockModel {
  return "haiku";
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setDevBedrockModel(value: DevBedrockModel): void {
  localStorage.setItem(STORAGE_KEY, value);
  listeners.forEach((listener) => listener());
}

export function useDevBedrockModel(): DevBedrockModel {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
