export declare const DEFAULT_API_KEY_REF = "TYPESAFE_API_KEY";
export interface KitSettings {
    /** Master switch. Off means no request is made; the tools still list the catalogue. */
    enabled: boolean;
    /** Credential reference resolved per operation. */
    apiKeyRef: string;
    /** Hard ceiling for one judgment request (background work, never on the turn's critical path). */
    requestTimeoutMs: number;
    /** Ceiling for one whole tool call, across every item it judges. */
    callBudgetMs: number;
    /** Most items one call may judge (a diff can be thousands of lines). */
    maxItems: number;
    /** In-flight requests. */
    concurrency: number;
    /** Verdict cache TTL. Same input answers the same way, so this is pure saving. */
    cacheTtlMs: number;
    cacheMaxEntries: number;
    /** Consecutive failures before the breaker short-circuits. */
    breakerFailures: number;
    breakerCooldownMs: number;
    /** Per-session and per-day request ceilings. */
    sessionCallLimit: number;
    dailyCallLimit: number;
    /** Extra redaction patterns applied before anything leaves the machine. */
    redactExtra: string[];
    /**
     * Per-string cap applied to states sent to a *local* engine, in characters
     * (0 disables). Hosted engines keep the full state: their cost is not per token
     * in the same way, and truncation there would lose information for nothing.
     */
    localStateChars: number;
    /** Cap on array fields (candidate lists, requirement lists) for local engines. */
    localMaxItems: number;
    /**
     * Channels turned off by name.
     *
     * The report's advice — "a channel that never produces a non-neutral verdict is
     * not earning its keep" — had no mechanism behind it: the only way to retire one
     * was to edit the source. A disabled channel refuses cleanly and says why, so a
     * catalogue of 23 can shrink to the ones that actually fire.
     */
    disabledChannels: string[];
    /**
     * Per-channel decision thresholds, fitted from the benchmark corpus
     * (`POST /api/bench` returns an apply-ready table). Empty means the declared
     * defaults, which is not the same as "no opinion": a cut is always in force.
     */
    thresholds: Record<string, number>;
}
export declare const KIT_DEFAULTS: KitSettings;
/** Validate a settings object, naming the field and its range. */
export declare function validate(value: KitSettings): string | undefined;
/** Merge an untrusted patch onto a base, dropping anything unusable. */
export declare function merge(base: KitSettings, patch: unknown): KitSettings;
/** Stored settings, or `undefined` when there are none (or they are unreadable). */
export declare function loadStored(dir: string): Partial<KitSettings> | undefined;
/** Persist settings, owner-only. Returns false when it could not land. */
export declare function saveStored(dir: string, value: KitSettings): boolean;
