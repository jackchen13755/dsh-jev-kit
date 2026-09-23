import { type ChannelState, type Verdict } from './channels.js';
import type { JevAnswer, JevQuestion } from '@dsh-external/dsh-jev-core';
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
    /** Scored by ordering only; excluded from the pass rate. */
    thresholdFree?: boolean;
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
    thresholdFree?: boolean;
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
    /** In-sample accuracy at the fitted cut — optimistic by construction. */
    accuracyFitted: number;
    /**
     * k-fold estimate: the cut is fitted on k-1 folds and scored on the held-out
     * one. This is the number to believe; the in-sample figure is kept only to show
     * how much of the gain was the fit memorising its own data.
     */
    accuracyCrossVal: number;
    n: number;
    /** True when the fitted cut actually changes a decision on this corpus. */
    changes: boolean;
    /** Gap between the highest negative and the lowest positive (NaN if one side is empty). */
    margin: number;
    /**
     * How the recommended cut was chosen. `margin` = midpoint of the gap (chosen when
     * every cut in the gap is equally accurate); `accuracy` = the grid point that won.
     */
    recommendedBy: 'margin' | 'accuracy';
    /**
     * Separation on the same values. A cut fitted on a channel that barely orders
     * its cases is overfitting: the "best" threshold there is an artefact of which
     * side happened to land where, and it will not survive the next corpus.
     */
    separation: number | undefined;
    /** True when the fitted cut is worth acting on (enough separation to trust it). */
    trustworthy: boolean;
}
/**
 * A short fingerprint of a channel's wording.
 *
 * Wording *is* the calibration: this project has already shipped one polarity
 * inversion and one reworded channel, and in both cases the thresholds silently
 * stopped meaning what they meant. Recording the hash makes "the questions
 * changed" a fact the report can state instead of something a reader has to
 * remember, and the benchmark can refuse to compare a fit from before the change.
 */
export declare function questionHash(channelId: string): string;
/** The wording fingerprint of every channel, for the report and the check mode. */
export declare const questionHashes: () => Record<string, string>;
/** Separation below which a fitted threshold is noise rather than calibration. */
export declare const FITTABLE_SEPARATION = 0.75;
/**
 * What to do about a fitted cut — the three states, decided in one place.
 *
 * `bench`'s own report and the settings card show the same fits, so the rule lives
 * here rather than in each renderer: two copies of it drift, and a drifted threshold
 * rule silently retunes a channel. The three states are different answers, and
 * giving the wrong one is its own kind of lie:
 *
 *   · `noisy`      — separation too low; the "best" cut here is an artefact of which
 *                    case happened to land where. Do not follow it.
 *   · `adjustable` — separated, and moving the cut gains more than two points on the
 *                    held-out folds.
 *   · `optimal`    — separated, but moving it gains no more than two points out of
 *                    sample: the current value is already the held-out optimum.
 */
export type FitVerdict = 'adjustable' | 'optimal' | 'noisy';
/**
 * @param fit - a fitted threshold row.
 * @returns which of the three states it is in.
 */
export declare const fitVerdictOf: (fit: {
    separation?: number;
    trustworthy: boolean;
    changes: boolean;
    accuracyNow: number;
    accuracyFitted: number;
}) => FitVerdict;
/** Colour marker per fit verdict — the same reason the channel table has one: colour
 *  does not survive a copy-paste, and a recommendation has to survive the trip. */
export declare const FIT_VERDICT_MARK: Record<FitVerdict, string>;
/** Apply a fitted table (channel id → cut). Values outside 0..1 are ignored. */
export declare function setThresholdOverrides(map: Record<string, number> | undefined): void;
/** The effective cut for a channel: an applied override, else the declared default. */
export declare function thresholdOf(channel: string, fallback?: number): number;
/** The currently applied overrides, for status reporting. */
export declare const thresholdOverrides: () => Record<string, number>;
/** Apply-ready JSON: every trustworthy fit, ready to paste into settings. */
export declare function fittedTable(fits: ThresholdFit[]): Record<string, number>;
/** Fit one cut per numeric channel from labelled values. */
export declare function fitThresholds(fixtures: Fixture[], trials: Trial[], current?: Record<string, number>): ThresholdFit[];
/** What a benchmark run leaves behind for the card and for change detection. */
export interface BenchRecord {
    at: number;
    fixtures: number;
    engines: string[];
    /** Apply-ready table (trustworthy fits only). */
    thresholds: Record<string, number>;
    /** The per-channel numbers behind that table. */
    details: ThresholdFit[];
    /** Wording fingerprints at the time of the run. */
    hashes: Record<string, string>;
}
/**
 * Channels whose questions changed since the recorded run.
 *
 * A separation number measured against different wording is not a regression and not
 * an improvement — it is a different question. Naming them is the difference between
 * "the numbers moved" and "the ruler changed".
 */
export declare function wordingDrift(record: BenchRecord | undefined, current?: Record<string, string>): string[];
export interface EngineReport {
    engine: string;
    label: string;
    status: 'ok' | 'unavailable' | 'error';
    note?: string;
    trials: Trial[];
    pass: number;
    /** Thresholded fixtures only; ordering-only channels are counted separately. */
    total: number;
    thresholdFree: number;
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
