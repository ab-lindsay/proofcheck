"use client";
import { useCallback, useRef, useState } from "react";
import type { ApplicationData, BeverageType, VerificationResult } from "@/lib/schema";
import type { ExtractionTrace } from "@/lib/vision/escalation/types";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDevTier } from "@/hooks/use-dev-tier";
import { useDevEscalation } from "@/hooks/use-dev-escalation";
import { useDevBedrockModel } from "@/hooks/use-dev-model";

export type VerifyResponse = VerificationResult & {
  tier: string;
  provider: string;
  beverageType: BeverageType;
  /** Optional so batch rows and older cached responses stay assignable. */
  extraction?: ExtractionTrace;
};

interface State {
  loading: boolean;
  result: VerifyResponse | null;
  error: string | null;
}

export function useVerify() {
  const [state, setState] = useState<State>({ loading: false, result: null, error: null });
  // Request generation: reset() and each new verify() bump it, and a resolving fetch only commits
  // its outcome if the generation is unchanged. Without this, a response that was superseded
  // mid-flight (user switched sample/image, reset() ran) still lands — showing label A's verdict
  // beside label B's image and application data.
  const generation = useRef(0);
  const devMode = useDevMode();
  const devTier = useDevTier();
  const devEscalation = useDevEscalation();
  const devBedrockModel = useDevBedrockModel();
  const verify = useCallback(
    async (app: ApplicationData, file: File, source?: "sample" | "upload") => {
      const gen = ++generation.current;
      setState({ loading: true, result: null, error: null });
      const fd = new FormData();
      fd.set("application", JSON.stringify(app));
      fd.set("image", file);
      if (source) fd.set("source", source);
      if (devMode) fd.set("devTier", devTier);
      if (devMode) fd.set("devBedrockModel", devBedrockModel);
      // Only ever sent to turn the ladder ON. Absent means "use the server default", which is off.
      if (devMode && devEscalation) fd.set("escalate", "1");
      try {
        const res = await fetch("/api/verify", { method: "POST", body: fd, signal: AbortSignal.timeout(30_000) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Verification failed.");
        if (generation.current !== gen) return; // superseded by reset() or a newer verify — drop it
        setState({ loading: false, result: body as VerifyResponse, error: null });
      } catch (e) {
        if (generation.current !== gen) return;
        const msg =
          e instanceof Error && e.name === "AbortError"
            ? "Request timed out — try a smaller or clearer image."
            : e instanceof Error
              ? e.message
              : "Verification failed.";
        setState({ loading: false, result: null, error: msg });
      }
    },
    [devMode, devTier, devEscalation, devBedrockModel],
  );
  // Clear a prior verdict when the inputs change (image removed/replaced) so a stale APPROVED/REJECTED is
  // never shown for an image that hasn't been verified — including one still in flight, which the
  // generation bump invalidates.
  const reset = useCallback(() => {
    generation.current++;
    setState({ loading: false, result: null, error: null });
  }, []);
  return { ...state, verify, reset };
}
