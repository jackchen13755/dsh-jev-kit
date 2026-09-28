const DEFAULT_EDGES = 1;
const DEFAULT_MIN_KEEP_RATIO = 0.25;
/** Characters in a unit, as the budget counts them. */
const sizeOf = (unit) => unit.text.length;
/**
 * Plan a prune of `units` given one relevance score each.
 *
 * @param units - segments, in their original order (see `segments.ts`).
 * @param scores - per-segment relevance in [0,1]; `undefined` means "never judged" and
 *   is treated as 0.5, deliberately neutral rather than zero.
 * @param options - budget, edge count and floor.
 * @returns the plan; `keep` is parallel to `units` so a caller can reconstruct the text.
 */
export function planPrune(units, scores, options) {
    const totalChars = units.reduce((sum, unit) => sum + sizeOf(unit), 0);
    const keep = units.map(() => false);
    const decidedBy = units.map(() => 'dropped');
    if (!units.length) {
        return { keep, decidedBy, kept: [], dropped: [], keptChars: 0, droppedChars: 0, totalChars: 0, baselineKeptChars: 0, edges: { head: 0, tail: 0 }, floorDecided: true, reason: '没有分段，无可剪' };
    }
    /*
     * Head and tail are counted separately rather than as one symmetric `edgeCount`: two
     * ends of a two-segment result are two segments, and clamping to `floor((n-1)/2)`
     * would have protected *no* end on short inputs — the case where the whole result is
     * the head and the tail.
     */
    const want = Math.max(0, Math.floor(options.edgeSegments ?? DEFAULT_EDGES));
    const head = Math.min(want, units.length);
    const tail = Math.min(want, units.length - head);
    for (let i = 0; i < head; i++) {
        keep[i] = true;
        decidedBy[i] = 'edge';
    }
    for (let i = units.length - tail; i < units.length; i++) {
        keep[i] = true;
        decidedBy[i] = 'edge';
    }
    const scoreOf = (index) => {
        const value = scores[index];
        return typeof value === 'number' && Number.isFinite(value) ? value : 0.5;
    };
    /*
     * Rank the rest by score, ties by original position. `index` is carried so the sort is
     * stable in meaning, not just in implementation.
     */
    const rest = units
        .map((_, index) => index)
        .filter(index => !keep[index])
        .sort((a, b) => scoreOf(b) - scoreOf(a) || a - b);
    let keptChars = units.reduce((sum, unit, index) => sum + (keep[index] ? sizeOf(unit) : 0), 0);
    const ratio = Math.max(0, Math.min(1, options.minKeepRatio ?? DEFAULT_MIN_KEEP_RATIO));
    const floorChars = Math.min(totalChars, Math.max(keptChars, Math.ceil(totalChars * ratio)));
    const budget = Math.max(0, options.budgetChars);
    for (const index of rest) {
        const size = sizeOf(units[index]);
        // Below the floor the budget is not consulted at all — that is what "the floor beats
        // the budget" means; above it, only what fits is taken. Which of the two applied is
        // recorded, because "kept to reach the floor" and "kept on its own merit" are
        // different statements about the same segment.
        const byFloor = keptChars < floorChars;
        if (!byFloor && keptChars + size > budget)
            continue;
        keep[index] = true;
        decidedBy[index] = byFloor ? 'floor' : 'budget';
        keptChars += size;
    }
    const kept = units.filter((_, index) => keep[index]);
    const dropped = units.filter((_, index) => !keep[index]);
    const droppedChars = totalChars - keptChars;
    /*
     * `floorDecided` means one specific, useful thing: the result ended up **above the
     * budget** because the edges/floor won. That is the case a caller must be able to see,
     * since it is the only way the budget is not honoured — and a budget silently exceeded
     * is what makes a "we saved tokens" claim wrong.
     */
    const floorDecided = keptChars > budget;
    const reason = floorDecided
        ? `保留 ${kept.length}/${units.length} 段 · ${keptChars}/${totalChars} 字符（超出预算 ${budget}：边界+地板 ${floorChars} 恒定保留）`
        : `保留 ${kept.length}/${units.length} 段 · ${keptChars}/${totalChars} 字符（预算 ${budget} 内按分数选取）`;
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
    };
}
/** The kept text, in original order — what a caller would actually return. */
export const keptText = (units, plan, joiner = '\n\n') => units.filter((_, index) => plan.keep[index]).map(unit => unit.text).join(joiner);
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
export function summarizeDecisions(scores, plan) {
    const counts = { edge: 0, floor: 0, budget: 0, dropped: 0, unjudged: 0 };
    plan.decidedBy.forEach((decision, index) => {
        counts[decision]++;
        const score = scores[index];
        if (!(typeof score === 'number' && Number.isFinite(score)))
            counts.unjudged++;
    });
    return counts;
}
//# sourceMappingURL=prune.js.map