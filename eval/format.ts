/** Shared "n/a" convention for a caught/total ratio with an empty denominator (both eval/run.ts
 *  and eval/print-history.ts render this). 0/0 means "no violations were planted in this set", not
 *  "100% caught" — rendering it as 100% silently misreads as a perfect security result. D6c,
 *  2026-07-25 hardening. */
export function formatRatioPct(caught: number, total: number): string {
  return total === 0 ? "n/a" : `${Math.round((caught / total) * 100)}%`;
}
