export type LedgerRecord = {
    t: number;
    kind: 'decision';
    channel: string;
    group: string;
    level: string;
    /** The verdict's headline numbers (probabilities, choices, scores). */
    values: Record<string, number | string | undefined>;
    ms?: number;
    via?: 'jev' | 'cache';
    chars: number;
    item?: number;
    /**
     * Which entry produced this judgment: `hook`, `card`, `command`, `test`, or a
     * session id.
     *
     * Without it the ledger cannot answer the only question that decides where to
     * build next — "which entry point is actually earning its keep?". Measured
     * 2026-09-23 before adding it: 593 of 608 judgments came from one entry (the
     * push hook) and there was no way to see that from the rows themselves.
     */
    session?: string;
    /** Wording fingerprint of the channel at decision time (drift detection). */
    qh?: string;
    /** Set when the caller reported whether it acted on the advice. */
    acted?: boolean;
} | {
    t: number;
    kind: 'trial';
    engine: string;
    channel: string;
    fixture: string;
    ok: boolean;
    value?: number | string;
    level?: string;
    ms?: number;
    error?: string;
} | {
    t: number;
    kind: 'bench';
    engines: string[];
    fixtures: number;
} | {
    t: number;
    kind: 'degraded';
    channel: string;
    reason: string;
} | {
    t: number;
    kind: 'error';
    channel: string;
    message: string;
};
export declare const ledgerFile: (dir: string, when?: Date) => string;
/** Append one row. Best-effort by design: measurement never breaks a task. */
export declare function append(dir: string, record: LedgerRecord): void;
/** Load the last `days` daily files, oldest first. */
export declare function load(dir: string, days: number, now?: Date): LedgerRecord[];
/** Sample size below which a channel's silence means nothing. */
export declare const MIN_SAMPLE = 20;
/**
 * The one recommendation this table makes about a channel.
 *
 * `useful` is not a euphemism: a channel earns its keep by coming back non-neutral,
 * and that is what its marker draws the eye to.
 */
export type Verdict = 'useful' | 'warn' | 'retire' | 'thin';
/**
 * Judged from the counts, in one place.
 *
 * The card, the copied Markdown and `/jev-kit report` all render this table, so "when
 * do I retire a channel" is decided once here — two implementations of it drift the
 * moment one of them is edited, which is the same failure mode as a route and its
 * client disagreeing about a payload.
 *
 * @param row - the counts that decide it.
 * @returns the verdict.
 */
export declare const verdictOf: (row: {
    n: number;
    flagged: number;
    warn: number;
}) => Verdict;
/**
 * Colour marker per verdict.
 *
 * The report is read in Markdown and in a terminal, where a row cannot be coloured, so
 * the marker has to survive copy-paste — which is why the levels get a symbol rather
 * than staying implicit in the numbers.
 */
export declare const VERDICT_MARK: Record<Verdict, string>;
export interface ChannelReport {
    channel: string;
    group: string;
    n: number;
    /** How often the channel came back non-neutral. */
    flagged: number;
    warn: number;
    /** What to do about it — see {@link verdictOf}. */
    level: Verdict;
    cached: number;
    latency: {
        p50: number;
        p95: number;
        max: number;
        mean: number;
    };
    /** Of the rows where the caller said whether it acted. */
    acted: number;
    actedYes: number;
}
export interface KitReport {
    window: {
        days: number;
        records: number;
    };
    total: number;
    cost: {
        inputTokens: number;
        usd: number;
        savedCalls: number;
    };
    channels: ChannelReport[];
    health: {
        degraded: number;
        errors: number;
    };
    /** Benchmark trials, grouped by engine — the evidence for moving a channel. */
    bench: {
        trials: number;
        byEngine: Record<string, {
            n: number;
            pass: number;
        }>;
    };
    /**
     * Channels never used for real work.
     *
     * The corpus proves a channel *can* judge; only usage proves anyone wants it.
     * Measured 2026-09-23: 16 of 23 channels had never been called outside the
     * benchmark — the report should say so rather than implying they are in service.
     */
    unusedChannels: string[];
    /**
     * Judgments per entry point.
     *
     * This is the number that decides where the next integration goes: a channel with
     * a working entry accumulates calls on its own, a channel without one stays at
     * zero no matter how good its wording is.
     */
    byEntry: Array<{
        entry: string;
        n: number;
        flag: number;
    }>;
}
/** Aggregate the ledger by channel — the only honest way to rank this catalogue. */
export declare function summarize(records: LedgerRecord[], days: number, usdPerMTok?: number): KitReport;
/** Human-readable report. */
export declare function render(report: KitReport): string;
