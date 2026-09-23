/**
 * The benchmark: fixtures with ground truth, run through every configured engine.
 *
 * The question "should this decision move to a local model?" cannot be answered by
 * a model card, because the models are calibrated differently — Laya ships
 * over-confident and needs per-domain temperature fitting, while Jev's probability
 * is documented as a ranking signal rather than a probability. Judging both with
 * one threshold would measure calibration, not capability.
 *
 * So the primary metric here is **separation**: for each channel, do the fixtures
 * whose answer should come out high actually score above the ones that should come
 * out low? That is threshold-free and transfers across engines. The thresholded
 * pass rate is reported next to it, as a secondary, because it is how the channel
 * really decides.
 *
 * Two further commitments:
 *
 *   · **Ground truth is set by construction.** A fixture's expectation comes from
 *     what a human would say about that text (it does contain a connection string
 *     with a password; that hunk really is a drive-by addition), never from what
 *     any model answered. The expectation never reaches the engine.
 *   · **A categorical answer is not a probability.** Choice fixtures are scored by
 *     exact match, and contribute nothing to separation, rather than being
 *     flattened into a number that would look like a probability.
 *
 * @module dsh-jev-kit/bench
 */
import { type ChannelState, type Verdict } from './channels.js';
import type { JevAnswer, JevQuestion } from './jev.js';
export type Expectation = 
/** The primary field should come out above the channel's threshold. */
{
    kind: 'high';
    field: string;
}
/** …and here it should come out below it. */
 | {
    kind: 'low';
    field: string;
}
/** A categorical answer with exactly one right value. */
 | {
    kind: 'choice';
    field: string;
    equals: string;
};
export interface Fixture {
    id: string;
    /**
     * The kit channel to judge with, or `-` when the fixture supplies its own
     * questions. Supplying them verbatim is how a *different* plugin's wording gets
     * measured without copying its channel here: a copy would drift, and then the
     * benchmark would compare two adapters instead of two engines.
     */
    channel: string;
    /** What a human would say is true about this input — the scoring key. */
    truth: string;
    expect: Expectation;
    state: ChannelState;
    /** Raw questions, used as-is when present (see `channel`). */
    questions?: Record<string, JevQuestion>;
    /** Verdict reader for a raw fixture; defaults to reading `expect.field`. */
    read?: (answers: Record<string, JevAnswer>) => Verdict;
}
export declare const COMMAND_FIXTURES: Fixture[];
/**
 * Everything the benchmark runs: the generated corpus (dozens of cases per
 * channel, truth by construction) plus the original hand-written anchor set,
 * which is kept because it was the first thing ever measured and a change in its
 * numbers is a signal about the harness, not about a model.
 */
export declare const FIXTURES: Fixture[];
export interface Trial {
    fixture: string;
    channel: string;
    engine: string;
    ok: boolean;
    /** Why it failed, when it did. */
    why?: string;
    value?: number | string;
    level?: string;
    ms?: number;
    error?: string;
}
/**
 * Rank-based separation between the fixtures that should score high and those that
 * should score low, with ties counted as half.
 *
 * This is the metric that survives differing calibration: it asks only whether the
 * engine *orders* the cases correctly, which is what a threshold can then be fitted
 * to. It is deliberately not called AUC-with-confidence — with two fixtures per
 * channel it is a coarse number, and the report says so.
 */
export declare function separation(high: number[], low: number[]): number | undefined;
/** Does this verdict satisfy the fixture's expectation? */
export declare function check(fixture: Fixture, verdict: Verdict): {
    ok: boolean;
    value?: number | string;
    why?: string;
};
/**
 * The threshold a channel's own corpus says it should use.
 *
 * Separation being high while the pass rate is low is not a contradiction: it
 * means the engine *orders* cases correctly but its probabilities do not sit where
 * the hand-picked cut assumes. Jev documents its probability as a ranking signal
 * rather than a probability, and a local model ships over-confident — so the cut
 * belongs to the corpus, not to a guess. This is the empirical accuracy-maximising
 * cut over every midpoint between observed values.
 */
export interface ThresholdFit {
    channel: string;
    current: number;
    recommended: number;
    accuracyNow: number;
    accuracyFitted: number;
    n: number;
    /** True when the fitted cut actually changes a decision on this corpus. */
    changes: boolean;
}
/** Fit one cut per numeric channel from labelled values. */
export declare function fitThresholds(fixtures: Fixture[], trials: Trial[], current?: Record<string, number>): ThresholdFit[];
export interface EngineReport {
    engine: string;
    label: string;
    status: 'ok' | 'unavailable' | 'error';
    note?: string;
    trials: Trial[];
    pass: number;
    total: number;
    latency: {
        p50: number;
        p95: number;
    };
    byChannel: Array<{
        channel: string;
        n: number;
        pass: number;
        separation?: number;
        p50: number;
    }>;
    /** Per-channel cut the corpus itself implies (see {@link fitThresholds}). */
    thresholds: ThresholdFit[];
}
/** Summarise one engine's trials into the numbers the decision actually needs. */
export declare function summarizeEngine(engine: string, label: string, fixtures: Fixture[], trials: Trial[], percentile: (values: number[]) => {
    p50: number;
    p95: number;
}): EngineReport;
/** The comparison, as text. Claims only what the numbers support. */
export declare function renderBench(reports: EngineReport[], fixtures: Fixture[], verbose?: boolean): string;
/** Question set for one fixture, with the payload the caller would really send. */
export declare function questionsFor(fixture: Fixture): {
    questions: Record<string, JevQuestion>;
    state: ChannelState;
};
/** Read a fixture's verdict from raw answers: its own reader, its channel's, or a plain field read. */
export declare function verdictFor(fixture: Fixture, answers: Record<string, JevAnswer>): Verdict;
