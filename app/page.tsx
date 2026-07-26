"use client";
import { useState, type ReactNode } from "react";
import { ClipboardCheck, Loader2, Sparkles } from "lucide-react";
import type { ApplicationData } from "@/lib/schema";
import { SAMPLES, type Sample } from "@/lib/samples";
import { useVerify } from "@/hooks/use-verify";
import { useDevMode } from "@/hooks/use-dev-mode";
import { ApplicationForm } from "@/components/application-form";
import { UploadZone } from "@/components/upload-zone";
import { VerdictCard } from "@/components/verdict-card";

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-3 border-b border-border px-5 py-4 sm:px-6">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
          {n}
        </span>
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      </div>
      <div className="px-5 py-5 sm:px-6">{children}</div>
    </section>
  );
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [isSample, setIsSample] = useState(false);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [preset, setPreset] = useState<ApplicationData | undefined>(undefined);
  const [formKey, setFormKey] = useState(0);
  const [sampleError, setSampleError] = useState<string | null>(null);
  // Bumped once per verification and used as VerdictCard's key, so each verdict gets a FRESH card.
  // Without it React keeps the same instance across results and its per-field feedback state carries
  // over — label B would show "helpful" marks the user only ever gave to label A.
  const [runId, setRunId] = useState(0);
  const { loading, result, error, verify, reset } = useVerify();
  const devMode = useDevMode();
  // "Advanced" samples are named after the defect they demonstrate (e.g. "Title-case warning"),
  // which reads as confusing next to the brand-named ones in a first-time user's gallery — a
  // usability test confirmed it. Dev mode reveals them for anyone exploring how ProofCheck catches
  // a mistake, without cluttering the default, non-technical-user-facing view.
  const visibleSamples = devMode ? SAMPLES : SAMPLES.filter((s) => !s.advanced);

  // A user-provided file always goes through real extraction (never the mock tier).
  const onUpload = (f: File | null) => {
    setFile(f);
    setIsSample(false);
    setPreviewSrc(null);
    reset(); // drop any prior verdict — it doesn't belong to this image
  };

  const loadSample = async (sample: Sample) => {
    setSampleError(null);
    reset();
    try {
      const res = await fetch(`/samples/${sample.name}`);
      if (!res.ok) throw new Error(`Failed to load sample (HTTP ${res.status}).`);
      const blob = await res.blob();
      setFile(new File([blob], sample.name, { type: "image/png" }));
      // `real: true` samples run the live pipeline — never the mock tier. (The route would reject
      // the sample claim anyway via the content-hash gate; this keeps the intent explicit.)
      setIsSample(!sample.real);
      setPreviewSrc(`/samples/${sample.name}`);
      setPreset(sample.app);
      setFormKey((k) => k + 1);
    } catch (e) {
      setSampleError(e instanceof Error ? e.message : "Could not load the sample image.");
    }
  };

  const onSubmit = (app: ApplicationData) => {
    if (file) {
      setRunId((n) => n + 1);
      void verify(app, file, isSample ? "sample" : "upload");
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">Verify a label</h1>
        <p className="mt-2 max-w-2xl text-lg text-muted-foreground">
          Add a label image and its application details, then press <strong>Verify label</strong>. ProofCheck checks
          every field and explains each result in plain English.
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-2 lg:items-start">
        <div className="space-y-6">
          <Step n={1} title="Add the label image">
            <UploadZone file={file} onFile={onUpload} previewSrc={previewSrc} />
            {/* Kept below the upload zone on purpose. Uploading is the primary action for an agent
                working a queue all day; the samples are for someone who has no label image to hand.
                Promoting them above the drop zone would tax the everyday user to serve the newcomer.
                "No label handy?" rather than "New here?" — the latter reads as a comment on the
                user's experience, and half of TTB's agents have been doing this for decades. */}
            <div className="mt-5 rounded-xl border border-border bg-muted/50 p-4">
              <p className="flex items-center gap-2 text-base font-semibold text-foreground">
                <Sparkles aria-hidden className="h-5 w-5 shrink-0 text-proof" />
                No label handy? Load a ready-made sample
              </p>
              <p className="mb-3 mt-1 text-base text-muted-foreground">
                Fills in the image <em>and</em> the application details below, so you can press{" "}
                <strong>Verify label</strong> straight away.
              </p>
              <div className="flex flex-wrap gap-2">
                {visibleSamples.map((sample) => (
                  <button
                    key={sample.name}
                    type="button"
                    onClick={() => void loadSample(sample)}
                    title={sample.label}
                    className="flex min-w-0 flex-col items-start rounded-xl border border-border bg-card px-4 py-2.5 text-left shadow-sm transition-colors hover:border-proof hover:bg-accent"
                  >
                    <span className="max-w-full text-base font-semibold text-foreground truncate">{sample.label}</span>
                    <span className="max-w-full text-sm text-muted-foreground truncate">{sample.tag}</span>
                  </button>
                ))}
              </div>
              {sampleError ? (
                <p role="alert" className="mt-2 text-base font-medium text-verdict-non-compliant">
                  {sampleError}
                </p>
              ) : null}
            </div>
          </Step>

          <Step n={2} title="Enter the application details">
            <ApplicationForm
              key={formKey}
              defaultValues={preset}
              onSubmit={onSubmit}
              busy={loading}
              fileAttached={file !== null}
            />
          </Step>
        </div>

        <div className="lg:sticky lg:top-24">
          <h2 className="mb-3 text-xl font-semibold text-foreground">Result</h2>
          <section aria-live="polite" aria-label="Verification result">
            {loading ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card px-6 py-20 text-center shadow-sm">
                <Loader2 aria-hidden className="h-9 w-9 animate-spin text-primary" />
                <p className="text-xl font-medium text-muted-foreground">Checking the label…</p>
              </div>
            ) : error ? (
              <div
                className="rounded-2xl border border-verdict-non-compliant/30 bg-verdict-non-compliant-bg px-6 py-5 shadow-sm"
                role="alert"
              >
                <p className="text-xl font-semibold text-verdict-non-compliant">Verification failed</p>
                <p className="mt-1 text-lg text-verdict-non-compliant">{error}</p>
                {/* Submits the application form itself rather than replaying a snapshot captured at
                    first submit: the form stays mounted and editable beside this card, so a user who
                    corrects a field after the error must get a verdict computed from the corrected
                    value, not the one that failed. No loading state — the branch above replaces this
                    whole card with the spinner for the duration of the retry. */}
                {file ? (
                  <button
                    type="submit"
                    form="application-form"
                    className="mt-4 rounded-lg bg-primary px-4 py-2 text-base font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring/40"
                  >
                    Try again
                  </button>
                ) : null}
              </div>
            ) : result ? (
              <VerdictCard key={runId} result={result} image={file} />
            ) : (
              <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-border bg-card/60 px-6 py-20 text-center">
                <ClipboardCheck aria-hidden className="h-12 w-12 text-muted-foreground" />
                <p className="max-w-sm text-xl text-muted-foreground">
                  Your result — <strong className="text-foreground">approved</strong>,{" "}
                  <strong className="text-foreground">needs correction</strong>, or{" "}
                  <strong className="text-foreground">rejected</strong> — and a plain-English reason for every field
                  will appear here.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
