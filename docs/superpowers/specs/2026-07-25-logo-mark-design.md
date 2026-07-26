# Logo mark and favicon — design

**Date:** 2026-07-25
**Status:** implemented — `bb6b8be` (mark + favicon), refined by `539a432` (glyph widened) and
`4b2e319` (tie lowered, header tile to 48px). The first commit alone is **not** what shipped; the
mark changed materially twice after it, for the reasons in §2.
**Supersedes:** the `ShieldCheck` mark introduced with the header in
[2026-07-24-uswds-inspired-theme-design.md](2026-07-24-uswds-inspired-theme-design.md)

## 1. Why the shield had to go

The header used lucide's `ShieldCheck` in an amber square. It was competent — legible at 24px,
5.07:1 white-on-amber — but wrong on two counts:

1. **The metaphor is inverted.** A shield means _protection_. ProofCheck protects nothing; it
   holds two records against each other and reports where they disagree. The product's verb is
   comparison.
2. **It contradicts its own positioning.** The theme spec states: _"None of this is a government
   site, so no seal/flag/`.gov` banner — a small disclaimer line covers that."_ A shield on navy
   is the core visual vocabulary of exactly that. The disclaimer strip does the real work here, so
   this was a tension rather than a defect — but it argued against keeping the shield.

A third consideration — ubiquity — is recorded last on purpose because it is the weakest of them:
shield+check is the most-used "verified" glyph in software, which makes the mark anonymous, not
wrong. On its own it would not have justified the change.

## 2. The mark

Two **unequal, bottom-aligned columns** — the application data and the extracted label — with one
field **tied across them** in amber.

| Element        | Means                                              |
| -------------- | -------------------------------------------------- |
| Left column    | the application data (what the producer claims)    |
| Right column   | the extracted label (what the model actually read) |
| Amber crossbar | one field held across both and checked             |

### The letterform problem, and the wrong diagnosis of it

The first draft used **equal** columns with a **centred** bar. It read as a capital **H** — a
wordmark initial that isn't even in the name.

The diagnosis at the time was symmetry: equal columns plus a centred bar give the glyph both
bilateral and vertical symmetry, and symmetry is what constitutes a letterform, so breaking the
vertical symmetry should kill it. The columns were made unequal and bottom-aligned on that basis.

**That diagnosis was wrong.** It is recorded here rather than quietly replaced, because it is an
easy conclusion to reach again. Unequal columns did not stop the mark reading as a letter — review
still read a letterform in it, and one plausible reading was a lowercase "h" (tall left stem, short
right stem, joined near the top), which is arguably a _more_ specific letter than the capital H it
replaced. Symmetry was never the operative property. **Two stems joined by a crossbar** is the
property, and asymmetric stems merely move you to a different letter.

Worth noting how the wrong diagnosis survived: it was "verified" by asserting `verticallySymmetric:
false` on the rendered SVG. That check passed, and proved nothing — it measured a proxy that could
not answer the question. The mark was only ever going to be settled by looking at it.

**What actually fixed it** was raised in review: move the tie out of the centre band. A bar sitting
low across two columns is not read as a crossbar joining two stems. See _Tie position_ below.

**The unequal columns were kept anyway**, on their own merit rather than the discredited reasoning:
they carry the meaning — two records that do not agree — which equal columns do not.

### Geometry

Drawn on a 40×40 grid with a container `rx="6"`. **One geometry, used everywhere** — the header
mark, `app/icon.svg`, and the `.ico` are identical.

| Element      | Geometry                       |
| ------------ | ------------------------------ |
| Left column  | `x=6 y=4 w=9.5 h=32 r=2.5`     |
| Right column | `x=24.5 y=13 w=9.5 h=23 r=2.5` |
| Amber tie    | `x=6 y=24 w=28 h=6.5 r=3.25`   |
| Glyph extent | 70% wide × 80% tall            |

**Tie position.** The tie sits in the bottom third (centre 27.25 on a 40 grid), not centred. A bar
centred between two stems is read as a crossbar, which is what pulled earlier drafts toward a
letterform. Low enough and it reads as a line drawn across two columns instead. Not lower than
this: past about `y=26` it merges with the columns' base and becomes an underline.

**Header size.** The tile is 48px (`h-12`), which costs no layout — the 50px wordmark lockup
already sets the header height, measured identical at 77px with both a 40px and a 48px mark. 48px
is close to the ceiling: at 56px the nav wraps and the header jumps to 175px. The container radius
must track the tile size to keep the shadow on the mark's corners — `rx="6"` on a 40-unit viewBox
is `6 × 48/40 = 7.2px`, hence `rounded-[7.2px]` rather than a named Tailwind radius.

An earlier draft inset the header glyph further (55% × 70%) than the icon, on the theory that the
icon needed a fuller tile to stay legible at 16px. That was the wrong correction to make in one
place only, for two reasons:

1. **Uneven padding.** 55% × 70% left 9px of horizontal air against 6px of vertical, so the glyph
   looked narrow and the tile looked oversized for its contents.
2. **Optical weight.** The header variant is navy columns on a paper square, so a smaller glyph
   means _more_ visible paper — ~75% of the tile by area, making the mark the brightest and
   heaviest element in the header, louder than the wordmark beside it. Widening the columns fixes
   the airiness and drops the paper to ~64% in the same change.

Unifying also removes a maintenance hazard: three hand-synced definitions with three different
numbers. They must still be kept in sync by hand — there is no shared source, since the header
needs a React component and the favicon needs a build-time rasterizer — but now they are checkable
by eye, because all three should read the same.

**Known cost of unifying.** The low tie is right for the header at 48px but slightly worse at 16px:
it leaves only ~2px of column below the bar, which washes out, and the bar's top edge lands
mid-pixel and produces one muddy blend row. The favicon consequently trends toward "underline"
rather than "crossed". This was accepted rather than fixed — at 16px the mark functions as a colour
and shape signature rather than a readable diagram, and re-diverging the geometry to buy a subtle
improvement would restore the maintenance hazard above. If the favicon ever needs to be crisper,
raising its tie to about `y=20` is the fix, and it must then be documented as a deliberate
divergence in all three files.

### Colors

Fixed across light and dark rather than themed. A logo shouldn't shift with the page theme, and
the same precedent already applies to the three verdict banner gradients in `verdict-card.tsx`.

| Surface           | Square          | Columns         | Tie                                 |
| ----------------- | --------------- | --------------- | ----------------------------------- |
| Header (on navy)  | `#faf8f3` paper | `#142c46` navy  | `#a85a1a` (`--proof-amber`)         |
| Icon (on any tab) | `#142c46` navy  | `#faf8f3` paper | `#e08a3e` (`--proof-amber-on-navy`) |

Contrast within the mark (computed WCAG relative luminance; ≥3:1 required for meaningful
graphics). Every pair also clears the stricter 4.5:1 normal-text bar:

| Pair                                 | Ratio   |
| ------------------------------------ | ------- |
| navy columns / paper square          | 13.38:1 |
| paper columns / navy square          | 13.38:1 |
| amber tie / paper square (`#a85a1a`) | 4.78:1  |
| amber tie / navy square (`#e08a3e`)  | 5.33:1  |

These are `#142c46`/`#faf8f3` pairs and must be computed for those specific colors. The theme
spec's neighbouring rows are **not** reusable here: its 16.23:1 is `#1b1b1b` on paper, its 14.20:1
is pure white on navy, and its 5.07:1 is `--proof-amber` on the white `--card`, not on paper.

## 3. `--proof-amber-on-navy`

The theme plan specified `.wordmark::first-letter { color: var(--proof-amber) }` but the rule
never landed in `globals.css`, so the `wordmark` class was dead and the amber "P" never rendered.

Restoring it as specified would have shipped a contrast failure: `--proof-amber` (`#a85a1a`) is
only **2.80:1** against the navy header, below the 3:1 floor even counting the wordmark as large
bold text (20px/700). Light theme's amber is graded as a _background fill_, not as text on navy.

`--proof-amber-on-navy: #e08a3e` is therefore defined once in `:root` and **deliberately not
overridden in `.dark`** — the wordmark sits on navy in both themes, so it needs the on-dark value
in both. Measured: **5.33:1** light, **3.78:1** dark.

## 4. Favicon pipeline

`app/favicon.ico` was the unmodified Next.js default (25,931 bytes, untouched since the scaffold
commit). It is now generated by `scripts/generate-favicon.ts` — run `pnpm favicon`.

The mark is nothing but rounded rectangles, so the script needs no image dependency:

1. Rasterize each size by 8× supersampling the rect geometry (rounded corners tested against the
   inset centre), producing straight-alpha RGBA.
2. Encode PNG with `node:zlib` `deflateSync` — hand-rolled CRC32 and chunk framing.
3. Wrap the PNGs in an ICO container at 16/32/48px. PNG-in-ICO is Vista+ and universal in current
   browsers.

`pnpm favicon --print` dumps an ASCII raster of each size. This exists because the failure mode
that matters is small-size legibility, and it is not visible in a scaled vector preview — the
first draft's glyph looked fine as SVG and read as a cramped 50%-filled tile at true 16px.

`app/icon.svg` ships alongside the `.ico`; Next.js emits a `<link rel="icon">` for each, so the
SVG serves modern browsers and the `.ico` covers the rest.

## 5. Rejected alternatives

| Option                    | Why not                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlapping panels        | Best concept and clearest at 40px, but the 2.5px strokes fall to ~1px at 16px and the outlines merge. Would have needed a divergent simplified favicon.           |
| Offset bars               | Safest legibility, zero letterform risk, but the most abstract — reads as a text-alignment glyph. Kept as the fallback if the columns mark ever proves confusing. |
| Bottle / label silhouette | Communicates the domain but not the verification, and bottle icons are their own cliché.                                                                          |
| Approval stamp, scales    | Still trust-and-authority vocabulary, so it keeps the seal-adjacency tension from §1.                                                                             |
| Typographic "P"           | Maximum restraint and zero cliché risk, but redundant next to a wordmark whose first letter is already the amber accent.                                          |

## 6. Out of scope

- The broader visual design pass on the rest of the UI.
- The `text-sm` (14px) sample-tag lines inside the sample buttons. Their parent buttons' labels
  are already 16px; raising the tags would flatten the hierarchy inside the button.
