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
import type { Unit } from './segments.js';
export interface PruneOptions {
    /** Characters allowed in the kept result. The floor and the edges still win over it. */
    budgetChars: number;
    /** Segments always kept at the head and at the tail. Default 1 each. */
    edgeSegments?: number;
    /**
     * Share of the original characters kept no matter what the scores say (0–1).
     *
     * Default 0.25: a quarter of the text is the difference between "condensed" and
     * "gutted", and the real corpus judgement here is weak (see `calibration.ts` — this
     * is a pruning candidate, not a score we currently trust as a probability).
     */
    minKeepRatio?: number;
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
export type PruneDecision = 'edge' | 'floor' | 'budget' | 'dropped';
export interface PrunePlan {
    /** Parallel to the input units: keep or drop. */
    keep: boolean[];
    /** Parallel to the input units: which rule decided it (see {@link PruneDecision}). */
    decidedBy: PruneDecision[];
    kept: Unit[];
    dropped: Unit[];
    keptChars: number;
    droppedChars: number;
    totalChars: number;
    /** What keeping everything would have kept. The denominator for any "saved" claim. */
    baselineKeptChars: number;
    /** How many segments the edge rule pinned at each end. */
    edges: {
        head: number;
        tail: number;
    };
    /** True when the floor/edges — not the scores — set the size of the result. */
    floorDecided: boolean;
    /** One line a caller can log verbatim: why the plan looks the way it does. */
    reason: string;
}
/**
 * Plan a prune of `units` given one relevance score each.
 *
 * @param units - segments, in their original order (see `segments.ts`).
 * @param scores - per-segment relevance in [0,1]; `undefined` means "never judged" and
 *   is treated as 0.5, deliberately neutral rather than zero.
 * @param options - budget, edge count and floor.
 * @returns the plan; `keep` is parallel to `units` so a caller can reconstruct the text.
 */
export declare function planPrune(units: Unit[], scores: Array<number | undefined>, options: PruneOptions): PrunePlan;
/** The kept text, in original order — what a caller would actually return. */
export declare const keptText: (units: Unit[], plan: PrunePlan, joiner?: string) => string;
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
export declare function summarizeDecisions(scores: Array<number | undefined>, plan: PrunePlan): Record<PruneDecision, number> & {
    unjudged: number;
};
