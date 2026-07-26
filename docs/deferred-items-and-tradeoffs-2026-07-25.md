# ProofCheck — Deferred Items & Trade-offs (2026-07-25)

Companion to
[`docs/superpowers/specs/2026-07-25-local-ocr-latency-and-language-packs-design.md`](superpowers/specs/2026-07-25-local-ocr-latency-and-language-packs-design.md).

§1–§2 are loose ends left open after the local-ocr English-only change (`3eec1d8`); both were found
_while_ doing that work and neither belongs inside it. §3–§5 are the items left open by the batch
endpoint and batch eval tier (`88b74e5`, fixes in `ac305bd`) — see the Outcome section of
[`docs/superpowers/plans/2026-07-25-batch-eval-tier.md`](superpowers/plans/2026-07-25-batch-eval-tier.md)
for what that work did and did not do. Everything here is recorded with its evidence so a future
session doesn't have to re-derive any of it.

**Status as of 2026-07-26** (per the codebase-cleanup plan,
[`docs/superpowers/plans/2026-07-25-codebase-cleanup.md`](superpowers/plans/2026-07-25-codebase-cleanup.md)):
§1 (format landmine), §2 (tolerant scoring), and §5 (openapi validation) are resolved — see each
section for commits and evidence. §3 (ladder batch budget) and §4 (batch endpoint has no caller)
remain open; neither was in that plan's scope. §6 is a standing process note, not a bug — still
current.

---

## 1. `pnpm format` reformats 114 files — a landmine in every feature commit

**Status:** RESOLVED 2026-07-26. `8269f90` did the one deliberate reformat commit this section
recommended — by then only 15 files needed it (most of the tree had already been formatted
incidentally by other work in the intervening hours), and nine files held uncommitted by concurrent
sessions were excluded via a second `--ignore-path` rather than reformatted mid-edit. `pnpm test`
(599/599), `eslint`, and `tsc` all stayed clean. `.github/workflows/ci.yml` now runs
`pnpm format:check` as its own step, so an unformatted file can no longer land silently — the
question this section closed on. The narrower hazard in §6 below (a reformat commit touching files
another session has open) is unrelated to whether the gate exists and still applies whenever one is
run.

**What's wrong.** Main added the prettier config and `format` / `format:check` scripts (**`b8e7ee6`** —
this section previously cited `50c8995`, which is mislabeled: its message says prettier but its
contents are `lib/matching/fuzzy.ts` and two test files. See `c147dc2` for why, and §6 below for the
staging mistake that caused it) but the repo was never actually formatted. So `pnpm format` — the obvious thing to run after
touching a file — rewrites **114 files, roughly 4100 insertions / 2700 deletions** across the whole
tree.

**Why it matters.** Two concrete failure modes, one of which already happened:

1. It swamps the change it's supposed to tidy. Running it during the English-only work turned a
   9-file diff into a 114-file diff; the actual change became unreviewable and the merge was reset
   and redone without it.
2. It hands every in-flight branch a mass conflict. Four sessions were working this repo
   concurrently on 2026-07-25 (see §3); a repo-wide reformat landing in main would have conflicted
   with all of them at once.

**Verified facts.** `.github/workflows/ci.yml` runs `pnpm lint` (bare `eslint`) and **not**
`format:check`, so main's unformatted state fails nothing today. `lint` is safe to run; `format` is
not, in the sense that its blast radius is the entire repo rather than your change.

**Recommended fix.** One deliberate commit, run when no session has uncommitted work:

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test   # then commit, touching nothing else
```

Then decide whether `format:check` joins CI. If it does, it should land in the _same_ commit as the
formatting, or CI goes red on the next push. Until that happens, the practical rule is: **format
only the files you touched** (`pnpm prettier --write <paths>`), never the tree.

---

## 2. `tolerant: true` scoring rewards an extractor for giving up

**Status:** RESOLVED 2026-07-26 (the scoring bug itself; the self-consistency-voting and
tier-escalation implications below remain forward-looking, not yet exercised). `cfdfb2f` (22:18:05)
was the original fix, stopping the pooling of `COMPLIANT`/`NEEDS_CORRECTION` into one `correct`
count; `2619e5f` (22:47:02) followed it, extracting that classification out into
[`eval/field-scoring.ts`](../eval/field-scoring.ts)'s `classifyFieldVerdict` — a small pure function
with its own test, in response to a code-review finding on `cfdfb2f` that the new classification had
no regression test of its own (see `.superpowers/sdd/2026-07-25-codebase-cleanup/progress.md`'s
Task 8 section). Extracting it into a named, tested function means a regression fails a unit test,
not just a quieter console number — see that file's header comment. The headline per-field breakdown
is now `compliant / needsCorrection / nonCompliant` — exactly the fix
sketched below — so an extractor that gives up on a field no longer scores identically to one that
read it right. `tolerant` survives as a field on eval entries, but now only gates the pass/fail check
(whether a `NEEDS_CORRECTION` is accepted for that entry) — it no longer touches the compliance
breakdown. The re-baselining question this section raised — every committed `eval/history.jsonl`
figure was computed under the old rule — is still live as of this writing: that file is being
touched by other in-flight work in this same cleanup pass, so confirm its numbers reflect the new
scoring before citing them as current.

Original finding, kept for context:

**What's wrong.** [`eval/run.ts`](../eval/run.ts) builds each entry's accepted-verdict set as:

```ts
const base: Verdict[] = entry.tolerant ? ["MATCH", "REVIEW"] : ["MATCH"];
```

Every one of the 46 real-world entries carries `tolerant: true`. The intent is sound and documented
— a field genuinely unreadable in a bad photograph shouldn't be scored as an extraction failure. But
REVIEW is also what an **absent or low-confidence** field degrades to, so the scoring ranks outcomes:

| extractor behaviour           | verdict    | scored         |
| ----------------------------- | ---------- | -------------- |
| reads the field correctly     | MATCH      | ✅ correct     |
| **returns `null` / gives up** | **REVIEW** | **✅ correct** |
| reads it wrong                | MISMATCH   | ❌ incorrect   |

**Abstaining scores identically to being right, and strictly better than guessing.**

**This is not hypothetical — it produced a false result we nearly shipped a design around.** During
the language-pack investigation, `eng+fra+spa+ita+por` appeared to beat `eng` by +2 on `brandName`
(33/46 vs 31/46). The entire delta was two photographs of **one bottle** (`OLD TUB`, an English
brand name):

| sample                              | expected  | `eng`                                          | `eng+fra+spa`                       |
| ----------------------------------- | --------- | ---------------------------------------------- | ----------------------------------- |
| `spirits-old-tub-bourbon-front.jpg` | `OLD TUB` | `"SO ACADL BOTTLED AT"` (conf 0.21) → MISMATCH | **`null`** (conf 0.00) → REVIEW ✅  |
| `spirits-old-tub-bourbon-back.jpg`  | `OLD TUB` | `"orp Tug"` (conf 0.46) → MISMATCH             | `"QLD Tug"` (conf 0.66) → REVIEW ✅ |

Neither configuration ever read the brand name. The extra packs made the extractor _less certain_ —
on the front label it returned **nothing at all** — and the scoring counted that as an improvement.
An earlier draft of the language spec was going to keep two language packs on the strength of that
+2.

**Why it was the highest-value open item.** Every future accuracy change is measured with this ruler.
**Self-consistency voting** is the sharpest case: its core mechanism is _"when independent ballots
disagree, lower the merged confidence"_ — which converts MISMATCH into REVIEW, which this scoring
counts as a gain. Voting could measure an improvement while reading nothing better, and the numbers
would not reveal it. The same hazard applies to deskew and tier escalation. Fix the ruler before
building more things to measure with it.

**Sketch of a fix, as originally proposed** (not a design — that needed brainstorming; superseded by
what actually shipped, per the Status note above). Stop pooling the two outcomes: report
`matched / reviewed / missed` per field rather than a single `correct` count, so "the extractor gave
up" is visible instead of indistinguishable from "the extractor was right." Open questions a spec
must answer: what the headline number becomes; whether `tolerant` survives at all or is replaced by
per-field expected-verdict sets; and how to handle the re-baselining, since every committed
`perField` figure in `eval/history.jsonl` was computed under the old rule and would no longer be
comparable. (In the event, `tolerant` survived as a pass/fail-only gate rather than being replaced
outright — see Status.)

---

## 3. The escalation ladder shares one budget across a whole batch

**Status:** still open, confirmed unchanged 2026-07-26 —
[`app/api/batch/route.ts`](../app/api/batch/route.ts) still computes
`budgetMs: Math.max(0, LADDER_BUDGET_MS - (Date.now() - opts.requestStart))` off the request start.
Not in scope for the 2026-07-25 codebase-cleanup plan. Needs a design decision rather than a patch.
Low urgency — the ladder is off by default (invariant 9) so this is inert unless
`ESCALATION_ENABLED=1` or dev mode's "Re-read weak fields" is set.

**What's wrong.** [`app/api/batch/route.ts`](../app/api/batch/route.ts) computes each item's ladder
budget from the _request_ start:

```ts
budgetMs: Math.max(0, LADDER_BUDGET_MS - (Date.now() - opts.requestStart));
```

That is correct for `/api/verify`, where one request is one label. In a batch it means the budget is
consumed by whichever items run first: with `CONCURRENCY = 5`, items in the sixth wave onward see
`budgetMs: 0` and silently skip the ladder entirely. So `escalate=1` on a large batch measures
something other than what it claims — the first five labels get a ladder, the rest quietly don't.

**Why the obvious fix is wrong.** Giving each item its own `LADDER_BUDGET_MS` makes total batch
latency unbounded: 50 images at concurrency 5 is 10 sequential waves, each able to spend a full ladder
budget, against a function timeout. That trades a silent skip for a hard timeout, which is worse.

**Recommended fix.** Per-item budget _plus_ an overall batch deadline, so an item gets a real ladder
allowance while the batch as a whole still terminates. That needs a decision on what the batch
deadline should be relative to the platform's function timeout, which is why it is not bolted onto the
batch work.

**Deliberately untested.** No test pins the current behaviour, because a test would enshrine
behaviour we believe is wrong. If you fix this, the test comes with the fix.

---

## 4. `POST /api/batch` unused in production UI — now documented as intentional

**Status:** RESOLVED 2026-07-26 — the design choice (client fan-out vs. server batch) is now
documented in README and ARCHITECTURE as an intentional trade-off, not a deferred item or oversight.
[`hooks/use-batch.ts`](../hooks/use-batch.ts) sends N concurrent `/api/verify` requests (≤5 at a time)
for real-time progress updates (queued → running → done per row), which matters for the 200–300 label
batches the brief describes. The `/api/batch` endpoint exists for programmatic/eval use and is fully
tested; switching the UI to it would require adding Server-Sent Events or similar for progress updates.

Original finding (kept for context): Task 5 of the batch plan had a `TODO` keeping the client on
`/api/verify`, so there was nothing to implement. The endpoint is publicly reachable but
undocumented-to-users, which is defensible for programmatic use but means its guards carry the full
weight of protecting it with no UI-shaped traffic pattern to constrain what arrives.

---

## 5. `openapi.yaml` is not validated by anything

**Status:** RESOLVED 2026-07-26. `4bac02f` added [`openapi.test.ts`](../openapi.test.ts) plus `yaml`
as a devDependency — exactly the recommended fix below: it parses `openapi.yaml`, asserts every
`$ref` resolves against `components.schemas`, and asserts the documented `BatchRowResult` properties
equal the keys of `BatchRowResultSchema.shape`. The spec can no longer drift from
`lib/batch-schema.ts` silently — a shape change on either side now fails a test.

**What's wrong.** [`openapi.yaml`](../openapi.yaml) documents `/api/verify` and `/api/batch`, and
nothing parses it. The repo has no YAML dependency, `.github/workflows/ci.yml` has no spec step, and
no test reads it. When `/api/batch` was documented, the best available check was structural —
indentation against sibling keys, every `$ref` resolving to a defined schema, no tabs, no duplicate
schema names, and a manual diff of `BatchRowResult`'s properties against `lib/batch-schema.ts`. A
genuine parse was not possible: neither a `yaml` package nor a usable Python was present, and adding a
dependency to lint one file was not worth doing unasked.

**Why it matters.** The spec can drift from the routes with nothing to catch it, and it is the
artifact an external consumer would trust. `lib/batch-schema.ts` is now strict, so the _route_ cannot
silently change shape — but the _document_ describing it can fall out of step freely.

**Recommended fix.** Add `yaml` as a devDependency and a single test that parses the spec, asserts
every `$ref` resolves, and asserts the documented `BatchRowResult` properties equal the keys of
`BatchRowResultSchema`. That last assertion is the valuable one: it makes the doc fail when the
contract moves. Cheap, and it turns a manual check into a gate.

---

## 6. Also of note: process observations from a four-session day

Not bugs, but they cost real time on 2026-07-25 and are cheap to avoid.

**Status:** still current, not stale — reconfirmed 2026-07-26. Executing this same plan's Task 12
(this document's own update) hit a live instance of the pattern described below: the working tree
changed out from under the task mid-run, with `docs/ARCHITECTURE.md` itself gaining an uncommitted
edit from another session between one read and the next. `git status --short`'s modified-file count
moved in both directions over the course of the single task: ~18 files at the first check, growing
to ~22 as more concurrent sessions' uncommitted work accumulated, then dropping to ~5 (4 belonging to
other sessions, 1 this task's own edit) once several of those sessions committed their WIP —
including `docs/ARCHITECTURE.md` itself, landing fully resolved without this task ever touching it.
The explicit-pathspec discipline below is what made committing safely possible through all of that.

**Duplicated work across sessions.** Two sessions independently diagnosed the same local-ocr latency
cause, wrote the same ablation experiment, and implemented near-identical fixes to the same two
files. The collision was only caught because a merge was blocked by a dirty working tree. The
reconciliation (`3eec1d8`) took the better half of each — `verdictFor()` from one, the three-case
test file and CI gate from the other — so nothing was wasted, but the duplication was avoidable.
Worth noting one session's first measurement was invalid (`DEFAULT_OCR_LANGS` imported as
`undefined`, so it compared `eng` against `eng`); the surviving measurement passes explicit language
strings into `createWorker` inside a single process with a logged confirmation per configuration,
which closes that hole and is the method to reuse.

**One working tree, four sessions.** All four ran in the main checkout, so uncommitted work
interleaved: at one point `lib/vision/local-ocr.test.ts` asserted the five-pack string while
`lib/vision/local-ocr.ts` already said `"eng"`, and a session unrelated to that work tripped over
the inconsistency. A bare `git add -A` in a shared checkout will also sweep another session's
in-flight files — that is how `9c631bb` deleted the local-ocr latency spec, which had to be restored
by `1d9e1e1`. **Use explicit pathspecs when staging in a shared checkout**, or give each session its
own worktree.

**Staging explicitly is not sufficient — the commit needs the pathspec too.** `50c8995` was created by
`git add <three paths> && git commit`, which looks careful and is not: the intended paths had just been
committed by another session moments earlier (`b8e7ee6`), so `git add` contributed nothing, and the
bare `git commit` then committed **the whole index** — which held a third session's staged
`lib/matching` work. Hence a commit labelled "prettier config" containing matcher changes, and §1 of
this document citing the wrong SHA for a week until it was traced. The reliable form is
`git commit -- <paths>`, which ignores everything else in the index; also worth checking
`git diff --cached --quiet` before any bare or `--allow-empty` commit. And re-read `git status`
immediately before committing: in a four-session day the file set changed between a status check and a
commit seconds later more than once.

**A gate that measures a proxy proves nothing.** The five-language worker shipped behind a passing
latency gate. That gate timed _cold-vs-warm worker init on one small synthetic label_ — not
per-request cost on realistic input — and passed with a reported 4–13× margin while the real
per-request cost on photographs was over budget. It was also run **post-hoc**, after the feature had
already shipped (`74f791f` says so plainly). The margin read as reassurance and was measuring the
wrong axis. This is the third instance of the same class in this repo, the others being
`check-latency` measuring only 13 small synthetic samples and `check-latency` being unable to reach
the cloud tier at all. The 2026-07-25 fix moves the keyless latency check into CI on real
photographs and gates `max` as well as `p95`; the general lesson is that a measurement scoped as
"manual, run once" stops describing the system as the system changes.

---

## 7. Label image viewer — deferred minors (2026-07-26)

**Status:** deferred after final whole-branch code review confirmed all 4 items are safe to stay as-is. Feature complete and merged (commits `88899e6..0454a5e`). Plan: `docs/superpowers/plans/2026-07-25-label-image-viewer.md`. Spec: `docs/superpowers/specs/2026-07-25-label-image-viewer-design.md`.

**What shipped.** A zoomable in-app viewer for label images, surfaced from `VerdictCard` in both single-label and batch modes. Allows reviewers to visually check things the extractor can't verify (e.g. bold formatting on the health warning statement). Hand-rolled zoom/pan via CSS transforms, native `<dialog>` modal, no new dependencies. All 7 tasks completed with TDD throughout (16 new tests, all passing). Final review verdict: **Ready to merge: Yes**.

**Deferred items (per final code review, none block merge):**

### 7a. StrictMode double-invoke overhead in `usePreviewUrl`

**Where:** `hooks/use-preview-url.ts:10-27`

**What:** The effect-based `URL.createObjectURL` + cleanup pattern runs twice per mount in dev mode under React Strict Mode (Next.js App Router defaults `reactStrictMode: true` when unset), causing one extra create+revoke cycle per mount.

**Why deferred:** Dev-only performance noise, zero production impact, inherent to the effect-based resource-synchronizing pattern. The inline comment (lines 10-16) already documents why this approach is correct vs `useMemo` (which would be impure and leak blobs under StrictMode). Sanctioned React behavior per react.dev/reference/react/useEffect#connecting-to-an-external-system.

**Fix priority:** Not worth fixing — this is the correct pattern.

### 7b. Batch table test mocking hygiene

**Where:** `components/batch-table.test.tsx` (multiple `beforeEach` blocks)

**What:** Tests reassign `URL.createObjectURL = vi.fn(...)` directly instead of via `vi.spyOn(URL, 'createObjectURL').mockImplementation(...)`, so `vi.restoreAllMocks()` doesn't actually restore the original methods.

**Why deferred:** Only becomes a footgun if a future test block is added after the current ones and expects unmocked URL methods. Current suite doesn't exhibit the failure mode.

**Fix priority:** Low. Worth fixing proactively if batch-table tests are touched again (one-line change that future-proofs the suite).

### 7c. Partial file map coverage gap

**Where:** `components/batch-table.test.tsx` — no test exercises a `files` map with some-but-not-all filenames present

**What:** Tests cover "no files map at all" (viewer triggers never render) but not "map exists, but this row's filename isn't in it".

**Why deferred:** The `files?.get(it.filename) ?? null` fallback makes this safe; just a coverage gap. Behavior is correct (row shows no viewer trigger if its file is absent from the map).

**Fix priority:** Low. Could add a test like `files = new Map([["a.png", fileA]])` with `items = [{filename: "a.png", ...}, {filename: "b.png", ...}]` and assert the second row shows no trigger.

### 7d. Transient preview URL flash on file replacement

**Where:** `components/upload-zone.tsx:34` (refactored to call `usePreviewUrl` in Task 2)

**What:** On file replacement, `UploadZone` shows the old preview URL for one intermediate render frame until `usePreviewUrl`'s effect flushes with the new URL.

**Why deferred:** Inherent to Task 1's hook design (state update during render → effect runs after commit). No observed UX impact in practice (RTL's `act()` flushes effects before assertions, so tests don't see it). The original pre-refactor code (inline `URL.createObjectURL` in the `choose` callback) updated synchronously, but extracting the hook into shared state was the correct architectural decision — reintroducing inline URL creation would lose the shared lifecycle and reintroduce duplication with `LabelImageViewer`.

**Fix priority:** Not worth fixing — would require reverting the DRY win from Task 2.
