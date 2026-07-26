"use client";
import { useState } from "react";
import type { BatchItem } from "@/lib/csv";
import type { Overall } from "@/lib/schema";
import { OVERALL_LABELS } from "@/lib/schema";
import { VerdictCard } from "@/components/verdict-card";

// role="img" so the aria-label is actually honoured: on a bare <span> (implicit role=generic) an
// aria-label is PROHIBITED by ARIA 1.2, flagged by axe as aria-prohibited-attr, and dropped outright
// by several browser/AT pairings — the attribute would be present in the DOM (and pass a
// getByLabelText assertion) while announcing nothing.
const PILL_STYLE: Record<Overall, string> = {
  APPROVED: "border-verdict-compliant/30 bg-verdict-compliant-bg text-verdict-compliant",
  NEEDS_CORRECTION: "border-verdict-needs-correction/30 bg-verdict-needs-correction-bg text-verdict-needs-correction",
  REJECTED: "border-verdict-non-compliant/30 bg-verdict-non-compliant-bg text-verdict-non-compliant",
};

function StatusPill({ item }: { item: BatchItem }) {
  if (item.status === "done") {
    const overall = item.result?.overall;
    // Defensive: a done row should always carry a result, but if it does not, say so rather than
    // announcing an empty pill.
    if (!overall) {
      return (
        <span
          role="img"
          aria-label={`Result for ${item.filename}: unknown`}
          className="inline-block rounded-full border border-border bg-muted px-3 py-1 text-base font-medium text-muted-foreground"
        >
          unknown
        </span>
      );
    }
    return (
      <span
        role="img"
        aria-label={`Result for ${item.filename}: ${OVERALL_LABELS[overall]}`}
        className={`inline-block rounded-full border px-3 py-1 text-base font-bold ${PILL_STYLE[overall]}`}
      >
        {OVERALL_LABELS[overall]}
      </span>
    );
  }
  if (item.status === "error") {
    return (
      <span
        role="img"
        aria-label={`Error for ${item.filename}: ${item.error ?? "unknown error"}`}
        className="inline-block rounded-full border border-verdict-non-compliant/30 bg-verdict-non-compliant-bg px-3 py-1 text-base font-bold text-verdict-non-compliant"
      >
        ERROR
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={`Status for ${item.filename}: ${item.status}`}
      className="inline-block rounded-full border border-border bg-muted px-3 py-1 text-base font-medium text-muted-foreground"
    >
      {item.status}
    </span>
  );
}

export function BatchTable({ items, files }: { items: BatchItem[]; files?: Map<string, File> }) {
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [sortIssuesFirst, setSortIssuesFirst] = useState(true);
  // Ranks straight off `overall` now that it carries the middle state; previously this had to look
  // for a NEEDS_CORRECTION field itself, because `overall` could not express one.
  const rank = (it: BatchItem) =>
    it.status === "error"
      ? 0
      : it.result?.overall === "REJECTED"
        ? 1
        : it.result?.overall === "NEEDS_CORRECTION"
          ? 2
          : 3;
  const sorted = sortIssuesFirst ? [...items].sort((a, b) => rank(a) - rank(b)) : items;

  return (
    <section className="rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
        <h2 className="text-xl font-semibold text-foreground">Results ({items.length})</h2>
        <label className="flex items-center gap-2 text-base text-muted-foreground">
          <input
            type="checkbox"
            checked={sortIssuesFirst}
            onChange={(e) => setSortIssuesFirst(e.target.checked)}
            className="h-4 w-4"
          />
          Show problems first
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-base">
          <thead>
            <tr className="border-b border-border text-left text-sm uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-semibold sm:px-6">Image</th>
              <th className="px-5 py-3 font-semibold">Result</th>
              <th className="px-5 py-3 font-semibold">Detail</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((it) => {
              const open = openRow === it.filename;
              const detailsId = `batch-details-${it.filename.replace(/[^a-zA-Z0-9]/g, "-")}`;
              const issueCount =
                it.status === "done" && it.result
                  ? it.result.fields.filter((f) => f.verdict !== "COMPLIANT").length
                  : 0;
              const issueWord = issueCount === 1 ? "issue" : "issues";
              return (
                <tr key={it.filename} className="border-b border-border align-top last:border-b-0">
                  <td className="px-5 py-4 font-mono text-sm break-all text-foreground sm:px-6">{it.filename}</td>
                  <td className="px-5 py-4">
                    <StatusPill item={it} />
                  </td>
                  <td className="px-5 py-4">
                    {it.status === "done" && it.result ? (
                      <>
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={detailsId}
                          // Scoped to the filename: two rows with the same issue count would
                          // otherwise share one accessible name in a 200-300 row batch.
                          aria-label={
                            open
                              ? `Hide details for ${it.filename}`
                              : `View details for ${it.filename} (${issueCount} ${issueWord})`
                          }
                          className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
                          onClick={() => setOpenRow(open ? null : it.filename)}
                        >
                          {open ? "Hide details" : `View details (${issueCount} ${issueWord})`}
                        </button>
                        {open ? (
                          <div id={detailsId} className="mt-3 max-w-2xl">
                            <VerdictCard result={it.result} image={files?.get(it.filename) ?? null} />
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">{it.error ?? ""}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
