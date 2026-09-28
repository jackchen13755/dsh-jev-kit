/**
 * Pruning a large tool result: **which** segments to keep, decided so the model cannot
 * be the only thing standing between a reader and a lost answer.
 *
 * The judgment ("is this passage needed for the task?") is a channel like any other and
 * can be wrong in both directions. So it never decides alone — this module is the
 * envelope around it, and the envelope is pure, deterministic and testable:
 *
 *   · **Edges are always kept.** Command output carries its own framing: the command and
 *     the first lines say what ran, the last lines carry the failure or the summary. A
 *     relevance score cannot be trusted to notice that, and `tail -20` intuition is
 *     exactly what a truncation bug destroys first.
 *   · **A floor beats the budget.** `minKeepRatio` of the original characters stay
 *     regardless of what the scores say. A floor that loses to the budget is not a
 *     floor, so precedence is explicit: **edges → floor → budget**, in that order.
 *   · **Never empty**, even when every score is missing or hostile: the plan degrades to
 *     the edges plus a proportional slice, and says so.
 *   · **Unjudged is neutral, not zero.** A segment the model never scored is ranked at
 *     0.5 — punishing it would silently prefer the segments that happened to be judged,
 *     which is how "we pruned the thing we didn't look at" happens.
 *   · **Deterministic ties.** Equal scores keep earlier segments, so two runs on one
 *     input cannot disagree.
 *
 * The counterfactual is recorded too: `baselineKeptChars` is what *not* pruning would
 * have kept. Without it, "saved 40%" is a number with no denominator.
 *
 * **Measured on a realistic result (2026-09-28, one live run, `output_relevance`), and
 * the envelope is doing more work than the model.** A 2611-char `pnpm install` failure
 * (47 segments) pruned to 1189 chars. Ranking was directionally right — the 403 error
 * scored 0.92, the `.npmrc` explanation 0.83, the fix 0.90 — and the edge rule earned its
 * place immediately: the opening `$ pnpm install --frozen-lockfile` scored only **0.44**,
 * so a model-only policy would have dropped the command line. But the *margins* are thin
 * and the scale compresses into roughly 0.16–0.9: twelve `warn deprecated …` lines scored
 * **0.64–0.72** (nearly the real error) and took most of the budget, while repeated
 * progress lines sat at 0.16–0.33 rather than near zero, so a tight budget fills with the
 * least-bad noise. Two consequences, both load-bearing:
 *
 *   · the channel is a **ranker, not a probability** — never read a score here as "the
 *     model is 90% sure", and never set the budget from the scores alone;
 *   · a prune that matters must be **reviewed**, which is why the only entry point
 *     returns a plan and mutates nothing, and why the automatic lane is not wired to it.
 *
 * The corpus does not yet have `output_relevance` fixtures, so its separation is
 * unmeasured — that is the next step, and until then this is a measured *demo*, not a
 * calibrated channel (see `bench.ts` for why truth-by-construction is the only bar).
 *
 * @module dsh-jev-kit/prune
 */
import type { Unit } from './segments.js'

export interface PruneOptions {
  /** Characters allowed in the kept result. The floor and the edges still win over it. */
  budgetChars: number
  /** Segments always kept at the head and at the tail. Default 1 each. */
  edgeSegments?: number
  /**
   * Share of the original characters kept no matter what the scores say (0–1).
   *
   * Default 0.25: a quarter of the text is the difference between "condensed" and
   * "gutted", and the real corpus judgement here is weak (see `calibration.ts` — this
   * is a pruning candidate, not a score we currently trust as a probability).
   */
  minKeepRatio?: number
}

/**
 * Why one segment ended up where it did.
 *
 * The four reasons *are* the envelope, so naming them per segment is what lets a reader
 * watch it work instead of taking it on faith — and it is the only way to answer "did the
 * safety rules actually fire on this input, or was everything decided by the scores":
 *
 *   · `edge`    — pinned at the head or the tail, whatever its score said;
 *   · `floor`   — kept to reach the floor; its *order* decided it, not its score;
 *   · `budget`  — kept on its own score, inside the budget;
 *   · `dropped` — not kept.
 */
export type PruneDecision = 'edge' | 'floor' | 'budget' | 'dropped'

export interface PrunePlan {
  /** Parallel to the input units: keep or drop. */
  keep: boolean[]
  /** Parallel to the input units: which rule decided it (see {@link PruneDecision}). */
  decidedBy: PruneDecision[]
  kept: Unit[]
  dropped: Unit[]
  keptChars: number
  droppedChars: number
  totalChars: number
  /** What keeping everything would have kept. The denominator for any "saved" claim. */
  baselineKeptChars: number
  /** How many segments the edge rule pinned at each end. */
  edges: { head: number, tail: number }
  /** True when the floor/edges — not the scores — set the size of the result. */
  floorDecided: boolean
  /** One line a caller can log verbatim: why the plan looks the way it does. */
  reason: string
}

const DEFAULT_EDGES = 1
const DEFAULT_MIN_KEEP_RATIO = 0.25

/** Characters in a unit, as the budget counts them. */
const sizeOf = (unit: Unit): number => unit.text.length

/**
 * Plan a prune of `units` given one relevance score each.
 *
 * @param units - segments, in their original order (see `segments.ts`).
 * @param scores - per-segment relevance in [0,1]; `undefined` means "never judged" and
 *   is treated as 0.5, deliberately neutral rather than zero.
 * @param options - budget, edge count and floor.
 * @returns the plan; `keep` is parallel to `units` so a caller can reconstruct the text.
 */
export function planPrune (units: Unit[], scores: Array<number | undefined>, options: PruneOptions): PrunePlan {
  const totalChars = units.reduce((sum, unit) => sum + sizeOf(unit), 0)
  const keep = units.map(() => false)
  const decidedBy: PruneDecision[] = units.map(() => 'dropped')
  if (!units.length) {
    return { keep, decidedBy, kept: [], dropped: [], keptChars: 0, droppedChars: 0, totalChars: 0, baselineKeptChars: 0, edges: { head: 0, tail: 0 }, floorDecided: true, reason: '没有分段，无可剪' }
  }

  /*
   * Head and tail are counted separately rather than as one symmetric `edgeCount`: two
   * ends of a two-segment result are two segments, and clamping to `floor((n-1)/2)`
   * would have protected *no* end on short inputs — the case where the whole result is
   * the head and the tail.
   */
  const want = Math.max(0, Math.floor(options.edgeSegments ?? DEFAULT_EDGES))
  const head = Math.min(want, units.length)
  const tail = Math.min(want, units.length - head)
  for (let i = 0; i < head; i++) { keep[i] = true; decidedBy[i] = 'edge' }
  for (let i = units.length - tail; i < units.length; i++) { keep[i] = true; decidedBy[i] = 'edge' }

  const scoreOf = (index: number): number => {
    const value = scores[index]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0.5
  }

  /*
   * Rank the rest by score, ties by original position. `index` is carried so the sort is
   * stable in meaning, not just in implementation.
   */
  const rest = units
    .map((_, index) => index)
    .filter(index => !keep[index])
    .sort((a, b) => scoreOf(b) - scoreOf(a) || a - b)

  let keptChars = units.reduce((sum, unit, index) => sum + (keep[index] ? sizeOf(unit) : 0), 0)
  const ratio = Math.max(0, Math.min(1, options.minKeepRatio ?? DEFAULT_MIN_KEEP_RATIO))
  const floorChars = Math.min(totalChars, Math.max(keptChars, Math.ceil(totalChars * ratio)))
  const budget = Math.max(0, options.budgetChars)

  for (const index of rest) {
    const size = sizeOf(units[index] as Unit)
    // Below the floor the budget is not consulted at all — that is what "the floor beats
    // the budget" means; above it, only what fits is taken. Which of the two applied is
    // recorded, because "kept to reach the floor" and "kept on its own merit" are
    // different statements about the same segment.
    const byFloor = keptChars < floorChars
    if (!byFloor && keptChars + size > budget) continue
    keep[index] = true
    decidedBy[index] = byFloor ? 'floor' : 'budget'
    keptChars += size
  }

  const kept = units.filter((_, index) => keep[index])
  const dropped = units.filter((_, index) => !keep[index])
  const droppedChars = totalChars - keptChars
  /*
   * `floorDecided` means one specific, useful thing: the result ended up **above the
   * budget** because the edges/floor won. That is the case a caller must be able to see,
   * since it is the only way the budget is not honoured — and a budget silently exceeded
   * is what makes a "we saved tokens" claim wrong.
   */
  const floorDecided = keptChars > budget
  const reason = floorDecided
    ? `保留 ${kept.length}/${units.length} 段 · ${keptChars}/${totalChars} 字符（超出预算 ${budget}：边界+地板 ${floorChars} 恒定保留）`
    : `保留 ${kept.length}/${units.length} 段 · ${keptChars}/${totalChars} 字符（预算 ${budget} 内按分数选取）`
  return {
    keep,
    decidedBy,
    kept,
    dropped,
    keptChars,
    droppedChars,
    totalChars,
    baselineKeptChars: totalChars,
    edges: { head, tail },
    floorDecided,
    reason,
  }
}

/** The kept text, in original order — what a caller would actually return. */
export const keptText = (units: Unit[], plan: PrunePlan, joiner = '\n\n'): string =>
  units.filter((_, index) => plan.keep[index]).map(unit => unit.text).join(joiner)

/**
 * How many segments each rule accounted for.
 *
 * Exists so a caller can answer "did the safety net do anything here, or did the scores
 * decide everything" without re-walking the plan — and so the answer is computed the same
 * way in the tool, the route and the card.
 *
 * `unjudged` is counted separately from the four decisions because it is a statement about
 * the *input*, not about the rule that kept or dropped the segment: a segment with no score
 * was kept or dropped as a neutral 0.5, and that number is what says whether the prune was
 * decided by measurements or by the absence of them.
 */
export function summarizeDecisions (scores: Array<number | undefined>, plan: PrunePlan): Record<PruneDecision, number> & { unjudged: number } {
  const counts = { edge: 0, floor: 0, budget: 0, dropped: 0, unjudged: 0 }
  plan.decidedBy.forEach((decision, index) => {
    counts[decision]++
    const score = scores[index]
    if (!(typeof score === 'number' && Number.isFinite(score))) counts.unjudged++
  })
  return counts
}
