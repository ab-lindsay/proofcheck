import type { DiffToken } from "@/lib/ttb/warning-diff";
import { diffWarningTokens } from "@/lib/ttb/warning-diff";

/** Which comparison the surrounding field actually went through.
 *
 *  `warning` — the health warning statement, judged byte-exact by lib/matching/warning.ts. The token
 *  kinds map onto that check's own NEEDS_CORRECTION/NON_COMPLIANT boundary, so verdict colours are meaningful.
 *
 *  `field` — every other text field, judged by lib/matching/fuzzy.ts, where case and punctuation
 *  differences are normalized away before comparison and can be a COMPLIANT. Verdict colours would
 *  contradict the row's own pill (amber "needs review" highlights inside a green COMPLIANT row), so this
 *  variant highlights neutrally and says plainly that the differences it shows may not be decisive.
 */
type Variant = "warning" | "field";

const LINE_LABELS: Record<Variant, { canonical: string; extracted: string }> = {
  warning: { canonical: "On file (canonical)", extracted: "Extracted from label" },
  field: { canonical: "Application", extracted: "Extracted from label" },
};

function markClass(kind: DiffToken["kind"], variant: Variant): string {
  if (variant === "field") return "rounded-sm bg-muted text-foreground underline decoration-dotted decoration-2";
  return kind === "diverge"
    ? "rounded-sm bg-verdict-non-compliant-bg text-verdict-non-compliant"
    : "rounded-sm bg-verdict-needs-correction-bg text-verdict-needs-correction";
}

function caption(variant: Variant, hasDifference: boolean): string {
  if (variant === "warning") {
    return hasDifference
      ? "Checked character-by-character, never guessed — highlighted text is exactly where the two differ."
      : "Checked character-by-character, never guessed — every character matches the mandatory text.";
  }
  return hasDifference
    ? "Character-by-character view — highlighted text is where the two differ. This field's verdict allows for " +
        "differences in case, punctuation and minor spelling, so a highlight here does not always mean a mismatch."
    : "Character-by-character view — every character matches the application.";
}

function Line({ label, tokens, variant }: { label: string; tokens: DiffToken[]; variant: Variant }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <div className="text-sm font-semibold text-muted-foreground">{label}</div>
      <div className="font-mono text-sm leading-relaxed break-words">
        {tokens.map((t, i) =>
          t.kind === "same" ? (
            <span key={i}>{t.text}</span>
          ) : (
            <mark key={i} className={markClass(t.kind, variant)}>
              {t.text}
            </mark>
          ),
        )}
      </div>
    </div>
  );
}

export function CharacterDiff({
  canonical,
  extracted,
  variant = "warning",
}: {
  canonical: string;
  extracted: string;
  variant?: Variant;
}) {
  const { canonical: canonicalTokens, extracted: extractedTokens } = diffWarningTokens(canonical, extracted);
  const hasDifference =
    canonicalTokens.some((t) => t.kind !== "same") || extractedTokens.some((t) => t.kind !== "same");
  const labels = LINE_LABELS[variant];
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/60 p-3">
      <Line label={labels.canonical} tokens={canonicalTokens} variant={variant} />
      <Line label={labels.extracted} tokens={extractedTokens} variant={variant} />
      {/* Always shown, both ways. Hiding this when the text matched made the feature look broken
          exactly when it succeeded: a reviewer saw two identical blocks with nothing saying what
          they were looking at. "Every character matches" is the assurance an APPROVED most needs. */}
      <p className="text-sm text-muted-foreground">{caption(variant, hasDifference)}</p>
    </div>
  );
}
