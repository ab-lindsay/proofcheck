/**
 * The ProofCheck mark: two columns (the application and the label) with one field tied
 * across them — the comparison the app actually performs. Replaces a generic shield-check,
 * which read as protection rather than comparison and sat in government-seal vocabulary the
 * theme spec explicitly avoids (see 2026-07-25-logo-mark-design.md).
 *
 * Colors are deliberately fixed across light/dark rather than themed. A logo shouldn't shift
 * with the page theme, and the same precedent already applies to the three verdict banner
 * gradients in `verdict-card.tsx`.
 *
 * Contrast within the mark (computed WCAG relative luminance; ≥3:1 for meaningful graphics).
 * These are #142c46/#faf8f3 pairs — do NOT reuse the theme spec's 16.23:1 or 14.20:1 rows, which
 * are for #1b1b1b-on-paper and white-on-navy respectively:
 *   navy columns  / paper square 13.38:1
 *   paper columns / navy square  13.38:1
 *   amber tie     / paper square  4.78:1  (#a85a1a)
 *   amber tie     / navy square   5.33:1  (#e08a3e)
 */

const NAVY = "#142c46";
const PAPER = "#faf8f3";
/** On-navy amber. Light theme's `--proof-amber` (#a85a1a) is only 2.80:1 against navy. */
const AMBER_ON_NAVY = "#e08a3e";
/** On-paper amber, matching `--proof-amber`. */
const AMBER_ON_PAPER = "#a85a1a";

type ProofMarkProps = {
  /**
   * `paper` — light square, for placing on the navy header.
   * `navy` — inverted square, for placing on light surfaces.
   */
  variant?: "paper" | "navy";
  className?: string;
};

export function ProofMark({ variant = "paper", className }: ProofMarkProps) {
  const square = variant === "paper" ? PAPER : NAVY;
  const columns = variant === "paper" ? NAVY : PAPER;
  const tie = variant === "paper" ? AMBER_ON_PAPER : AMBER_ON_NAVY;

  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden focusable="false">
      <rect width="40" height="40" rx="6" fill={square} />
      {/* Columns are deliberately unequal and bottom-aligned. Two equal columns with a centred
          bar has both bilateral and vertical symmetry, which is what makes a letterform — the
          symmetric draft read as a capital "H". The inequality also carries the meaning: two
          records that don't agree.

          Geometry is identical to app/icon.svg and the SHAPES constant in
          scripts/generate-favicon.ts. Keep all three in sync. An earlier draft inset the glyph
          further here (55% x 70% of the tile) than in the icon; that left more air at the sides
          than the top, and made the paper square ~75% of the tile by area — the heaviest element
          in the header, louder than the wordmark it sits beside. */}
      <rect x="6" y="4" width="9.5" height="32" rx="2.5" fill={columns} />
      <rect x="24.5" y="13" width="9.5" height="23" rx="2.5" fill={columns} />
      {/* The tie sits in the bottom third rather than centred. A bar centred between two stems is
          read as a crossbar, which is what pulled the earlier drafts toward a letterform; low
          enough and it reads as a line drawn across two columns instead. Not lower than this —
          past ~y=26 it merges with the columns' base and becomes an underline. */}
      <rect x="6" y="24" width="28" height="6.5" rx="3.25" fill={tie} />
    </svg>
  );
}
