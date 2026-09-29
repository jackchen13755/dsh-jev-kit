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
    /**
     * Foreground lane: the budget one judgment gets when something is waiting on it.
     *
     * `requestTimeoutMs` is a *batch* ceiling — 8s is fine when a hook is the only caller.
     * A lane that holds a turn must be an order of magnitude smaller, or "helping" costs
     * more than it saves; lens puts its critical-path screen at 1.2s for the same reason.
     */
    foregroundTimeoutMs: number;
    /**
     * In-flight limit for foreground judgments, deliberately separate from `concurrency`.
     *
     * Sharing one limiter means a foreground call queues behind whatever batch is in
     * flight, which turns a background instrument into foreground latency — the one thing
     * an advisory tool must never add.
     */
    foregroundConcurrency: number;
    /**
     * The automatic lane: should a failed tool call be triaged without anyone asking?
     *
     * Measured on 2026-09-23: every channel designed to *replace* a frontier round trip —
     * `sufficient`, `route`, `duplicate_call`, `evidence_check` — had **zero** calls, and
     * the family's own conclusion was that the bottleneck is entry points, not channels.
     * Lens has an automatic lane (`pre`/`post-execute`, shadow by default); kit had none,
     * which is why 14 of 23 channels sat at zero: they had no moment at which to fire.
     *
     *   · `off`    — no automatic judgment at all.
     *   · `shadow` — judge and record, say nothing. The default, because the first job of
     *                an automatic lane is to prove it would have been right; the report
     *                then shows what it said, and the entry shows up in `byEntry`.
     *
     * A `warn` mode (surface the verdict as a note on the tool result) is the next step:
     * it needs the note channel from `@deepseek-ai/dsh-llm`, which is a dependency this
     * package does not yet declare, so it is deliberately not claimed here.
     */
    autoTriage: 'off' | 'shadow';
    /**
     * Channels the automatic lane may fire, by id. One channel, not the catalogue: an
     * automatic lane that fires everything is a bill with no reader.
     */
    autoChannels: string[];
    /** Ceiling on automatic judgments per session — the lane must not outspend the turn. */
    autoMaxPerSession: number;
    /**
     * Which engine serves which channel, by channel id (e.g. `{ log_triage: 'laya' }`).
     *
     * `engines` picks one engine for the whole catalogue, which forces a single choice
     * between paying the hosted model for trivia and putting the hard channels on a
     * weaker reader. The bench already measures separation per channel *per engine*, so
     * the evidence to route on exists; this is the knob that spends it. A channel absent
     * here uses the first configured engine.
     */
    engineByChannel: Record<string, string>;
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
     * Repository the card and `/jev-kit scan` read by default.
     *
     * The host process's cwd is *not* the workspace (measured on this machine: the host's cwd was the user's home directory, not the workspace),
     * so "scan the staged diff" without a path fails with git's confusing
     * `--no-index` message. Naming the repo once removes the guesswork.
     */
    defaultRepo: string;
    /**
     * Per-channel decision thresholds, fitted from the benchmark corpus
     * (`POST /api/bench` returns an apply-ready table). Empty means the declared
     * defaults, which is not the same as "no opinion": a cut is always in force.
     */
    thresholds: Record<string, number>;
    /**
     * Per-*engine* cuts, layered over `thresholds` when that engine answers.
     *
     * A cut is calibrated against the engine that produced the probability, and the
     * engines do not share a scale: on the 317-fixture corpus AgentJev-0.6B orders
     * `retry` at separation 0.93 but cuts at 0.16 where the hosted engine cuts at
     * 0.60. Without this map, `engineByChannel` and the fallback would judge local
     * answers with hosted cuts — reported as sorting high, actually flagging almost
     * everything, which is the 2026-09-23 false-positive storm again.
     *
     * Keys are engine ids; values are the same channel/axis keys as `thresholds`
     * (including per-axis ones such as `private_scan.internal`). A key this map does
     * not name keeps the value from `thresholds`, so an engine override is partial
     * by construction rather than a replacement that silently drops the rest.
     */
    engineThresholds: Record<string, Record<string, number>>;
    /**
     * Engines in priority order; the first one serves interactive judgments.
     */
    engines: string[];
    /** Local decision engine (Laya) endpoint, empty when none is running. */
    layaEndpoint: string;
    /** Local AgentJev-0.6B endpoint — it speaks its own contract (see `engines.ts`). */
    agentjevEndpoint: string;
    /**
     * Engine that answers when the routed one cannot, by id, or empty for no fallback.
     *
     * Measured on 2026-09-28 with the full 317-fixture suite: the hosted engine needs
     * 28–32 s for the suite and p50 ~320 ms per call, the local AgentJev-0.6B 122.5 s
     * and p50 1015 ms — but in one window 64 of 317 hosted calls blew the 8 s budget
     * and the suite took 276 s. The local engine cannot time out on a network it does
     * not use, so it is the availability floor: when the hosted engine short-circuits
     * (breaker), has no key, or errors out, a qualifying channel gets an answer
     * instead of "not judged" — marked as a fallback everywhere it is reported.
     *
     * Auth rejection is deliberately *not* a fallback trigger: a bad key is a
     * configuration fault a human must see, not an outage to paper over.
     */
    fallbackEngine: string;
    /**
     * Channels the fallback may serve, by id. Empty means every channel.
     *
     * Defaulted to the channels whose local fit cleared the benchmark's own
     * cross-validation gate (`retry` 90%, `private_scan` 81%); `scope_check`'s local
     * fit scored 55% and is therefore excluded, separation notwithstanding.
     */
    fallbackChannels: string[];
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
/**
 * Whether the automatic lane may fire, and what it may do — as a pure function.
 *
 * Kept out of the observer so the policy can be tested without a running host: an
 * automatic lane's worst failure is not being wrong, it is being unbounded.
 *
 * @param input - the mode, the call's outcome, and what this session has spent.
 * @returns `shadow` when the lane should judge and record, else `skip`.
 */
export declare function autoPlan(input: {
    mode: KitSettings['autoTriage'];
    autoChannels: string[];
    channel: string;
    isError: boolean;
    usedThisSession: number;
    cap: number;
}): 'shadow' | 'skip';
