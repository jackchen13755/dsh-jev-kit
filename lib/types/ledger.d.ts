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
export interface ChannelReport {
    channel: string;
    group: string;
    n: number;
    /** How often the channel came back non-neutral. */
    flagged: number;
    warn: number;
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
}
/** Aggregate the ledger by channel — the only honest way to rank this catalogue. */
export declare function summarize(records: LedgerRecord[], days: number, usdPerMTok?: number): KitReport;
/** Human-readable report. */
export declare function render(report: KitReport): string;
