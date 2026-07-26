"use client";
import { useMemo, useRef, useState } from "react";
import { Download, FileSpreadsheet, Sparkles } from "lucide-react";
import { buildSampleCsv, buildTemplateCsv, parseApplicationsCsv, toResultsCsv, type BatchRow } from "@/lib/csv";
import { BATCH_SAMPLES } from "@/lib/samples";
import { useBatch } from "@/hooks/use-batch";
import { BatchTable } from "@/components/batch-table";

function download(name: string, content: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const FILE_INPUT_CLASS =
  "block w-full cursor-pointer rounded-lg border border-input bg-card text-base text-muted-foreground shadow-sm file:mr-4 file:cursor-pointer file:border-0 file:border-r file:border-border file:bg-muted file:px-4 file:py-3 file:text-base file:font-semibold file:text-foreground hover:file:bg-muted/70";

export default function BatchPage() {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [files, setFiles] = useState<Map<string, File>>(new Map());
  const [loadingSample, setLoadingSample] = useState(false);
  const csvRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<HTMLInputElement>(null);
  const { items, running, run } = useBatch();

  const unmatchedImages = useMemo(
    () => [...files.keys()].filter((name) => !rows.some((r) => r.filename === name)),
    [files, rows],
  );

  // Fills both inputs with the bundled demo batch. The CSV is round-tripped through
  // parseApplicationsCsv rather than constructing BatchRows directly, so this exercises the same
  // ingestion path as a hand-authored upload — a parser regression breaks the demo too, instead of
  // hiding behind a shortcut. Both file inputs are cleared because their displayed filenames would
  // otherwise contradict the state we just set.
  const loadSampleBatch = async () => {
    setLoadingSample(true);
    try {
      const images = await Promise.all(
        BATCH_SAMPLES.map(async (sample): Promise<[string, File]> => {
          const res = await fetch(`/samples/${sample.name}`);
          if (!res.ok) throw new Error(`Could not load ${sample.name} (HTTP ${res.status}).`);
          return [sample.name, new File([await res.blob()], sample.name, { type: "image/png" })];
        }),
      );
      const { rows: parsed, errors } = parseApplicationsCsv(buildSampleCsv());
      setRows(parsed);
      setCsvErrors(errors);
      setFiles(new Map(images));
      if (csvRef.current) csvRef.current.value = "";
      if (imagesRef.current) imagesRef.current.value = "";
    } catch (e) {
      // Leave nothing half-loaded: a partial batch would silently verify fewer labels than claimed.
      setRows([]);
      setFiles(new Map());
      setCsvErrors([e instanceof Error ? e.message : "Could not load the sample batch."]);
    } finally {
      setLoadingSample(false);
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Batch verification
        </h1>
        <p className="mt-2 max-w-2xl text-lg text-muted-foreground">
          Check many labels at once: load the sample batch below, or fill the CSV template and upload it with the
          matching label images. ProofCheck verifies each one, and a single bad row never blocks the rest.
        </p>
      </div>

      <div className="space-y-6">
        <section className="rounded-2xl border border-border bg-card shadow-sm">
          <div className="space-y-6 px-5 py-6 sm:px-6">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void loadSampleBatch()}
                  disabled={loadingSample || running}
                  className="inline-flex items-center gap-2 rounded-lg border-2 border-proof bg-card px-4 py-2.5 text-base font-semibold text-foreground shadow-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Sparkles aria-hidden className="h-5 w-5 text-proof" />
                  {loadingSample
                    ? "Loading sample batch…"
                    : `Load a sample batch (${BATCH_SAMPLES.length} labels & images)`}
                </button>
                <button
                  type="button"
                  onClick={() => download("proofcheck-template.csv", buildTemplateCsv())}
                  className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-base font-semibold text-foreground shadow-sm transition-colors hover:bg-muted"
                >
                  <FileSpreadsheet aria-hidden className="h-5 w-5 text-proof" />
                  Download CSV template
                </button>
              </div>
              {/* "No CSV to hand?" rather than "New here?" — see the matching note on the single-label
                  page: the latter reads as a comment on the user's experience, and half of TTB's
                  agents have been doing this work for decades. */}
              <p className="text-base text-muted-foreground">
                No CSV to hand? The sample batch fills in both fields below with {BATCH_SAMPLES.length} bundled labels —
                four approved, three rejected, and one that needs correction — so you can press{" "}
                <strong>Verify batch</strong> straight away.
              </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="csv" className="block text-lg font-medium text-foreground">
                  Applications CSV
                </label>
                <input
                  ref={csvRef}
                  id="csv"
                  type="file"
                  accept=".csv,text/csv"
                  className={FILE_INPUT_CLASS}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const { rows: parsed, errors } = parseApplicationsCsv(await f.text());
                    setRows(parsed);
                    setCsvErrors(errors);
                    setFiles(new Map());
                    if (imagesRef.current) imagesRef.current.value = "";
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="images" className="block text-lg font-medium text-foreground">
                  Label images
                </label>
                <input
                  ref={imagesRef}
                  id="images"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  className={FILE_INPUT_CLASS}
                  onChange={(e) =>
                    setFiles(new Map([...(e.target.files ?? [])].map((f): [string, File] => [f.name, f])))
                  }
                />
              </div>
            </div>

            {csvErrors.length > 0 ? (
              <div
                role="alert"
                className="rounded-xl border border-verdict-non-compliant/30 bg-verdict-non-compliant-bg p-4"
              >
                <p className="mb-1 text-base font-semibold text-verdict-non-compliant">CSV problems</p>
                <ul className="list-disc space-y-1 pl-5 text-base text-verdict-non-compliant">
                  {csvErrors.map((er, i) => (
                    <li key={i}>{er}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {unmatchedImages.length > 0 ? (
              <p className="text-base text-verdict-needs-correction">
                Images with no CSV row (skipped): {unmatchedImages.join(", ")}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={running || rows.length === 0 || files.size === 0}
                onClick={() => void run(rows, files)}
                className="rounded-lg bg-primary px-5 py-3 text-lg font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
              >
                {running ? "Verifying…" : `Verify batch (${rows.length} labels)`}
              </button>
              <button
                type="button"
                disabled={items.length === 0 || running}
                onClick={() => download("proofcheck-results.csv", toResultsCsv(items))}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-3 text-lg font-semibold text-foreground shadow-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download aria-hidden className="h-5 w-5" />
                Download results CSV
              </button>
            </div>
          </div>
        </section>

        {items.length > 0 ? (
          <div aria-live="polite">
            <BatchTable items={items} files={files} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
