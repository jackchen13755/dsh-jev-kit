/**
 * The kit's own settings, stored next to its ledger.
 *
 * Deliberately the same shape as the lens's: the credential reference is shared
 * (`TYPESAFE_API_KEY`), so configuring the key once configures both, and the
 * runtime knobs that matter for a batch tool — item cap, concurrency, hard
 * timeouts — are all settable without touching a patch file.
 *
 * @module dsh-jev-kit/settings
 */
import fs from 'node:fs';
import path from 'node:path';
export const DEFAULT_API_KEY_REF = 'TYPESAFE_API_KEY';
export const KIT_DEFAULTS = {
    enabled: true,
    apiKeyRef: DEFAULT_API_KEY_REF,
    requestTimeoutMs: 8000,
    callBudgetMs: 90000,
    maxItems: 40,
    concurrency: 4,
    foregroundTimeoutMs: 1200,
    foregroundConcurrency: 2,
    autoTriage: 'shadow',
    autoChannels: ['failure_triage'],
    autoMaxPerSession: 24,
    engineByChannel: {},
    /*
     * 24h, not 15 minutes. A verdict is a deterministic function of (state, questions,
     * cuts) and the cache key includes all three, so a longer TTL cannot replay a verdict
     * made under different rules — it only stops re-buying answers already bought. Lens
     * keeps its screen cache for the same 24h for the same reason.
     */
    cacheTtlMs: 86400000,
    cacheMaxEntries: 2000,
    breakerFailures: 3,
    breakerCooldownMs: 120000,
    sessionCallLimit: 2000,
    dailyCallLimit: 20000,
    redactExtra: [],
    localStateChars: 600,
    localMaxItems: 12,
    thresholds: {},
    disabledChannels: [],
    defaultRepo: '',
};
const BOUNDS = {
    requestTimeoutMs: [300, 60000],
    callBudgetMs: [1000, 900000],
    maxItems: [1, 500],
    concurrency: [1, 16],
    foregroundTimeoutMs: [200, 30000],
    foregroundConcurrency: [1, 16],
    autoMaxPerSession: [0, 500],
    cacheTtlMs: [0, 86400000],
    cacheMaxEntries: [0, 100000],
    breakerFailures: [1, 100],
    breakerCooldownMs: [0, 3600000],
    sessionCallLimit: [0, 1000000],
    dailyCallLimit: [0, 10000000],
    localStateChars: [0, 8000],
    localMaxItems: [0, 200],
};
/** Validate a settings object, naming the field and its range. */
export function validate(value) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyRef))
        return `apiKeyRef 必须形如 ENV_VAR_NAME（当前 ${JSON.stringify(value.apiKeyRef)}）`;
    for (const channel of value.disabledChannels ?? []) {
        if (!/^[a-z][a-z0-9_:-]*$/.test(channel))
            return `disabledChannels 里有不合法的通道名：${JSON.stringify(channel)}`;
    }
    if (value.autoTriage !== 'off' && value.autoTriage !== 'shadow')
        return `autoTriage 只能是 off / shadow（当前 ${JSON.stringify(value.autoTriage)}）`;
    for (const channel of value.autoChannels ?? []) {
        if (!/^[a-z][a-z0-9_:-]*$/.test(channel))
            return `autoChannels 里有不合法的通道名：${JSON.stringify(channel)}`;
    }
    for (const [channel, engine] of Object.entries(value.engineByChannel ?? {})) {
        if (typeof engine !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(engine))
            return `engineByChannel.${channel} 必须是引擎 id（当前 ${JSON.stringify(engine)}）`;
    }
    for (const [channel, cut] of Object.entries(value.thresholds ?? {})) {
        if (typeof cut !== 'number' || !Number.isFinite(cut) || cut < 0 || cut > 1)
            return `thresholds.${channel} 必须在 0–1 之间（当前 ${JSON.stringify(cut)}）`;
    }
    for (const [field, [min, max]] of Object.entries(BOUNDS)) {
        const number = value[field];
        if (typeof number !== 'number' || !Number.isFinite(number))
            return `${field} 必须是数字`;
        if (number < min || number > max)
            return `${field} 必须在 ${min}–${max} 之间（当前 ${number}）`;
    }
    return undefined;
}
/** Merge an untrusted patch onto a base, dropping anything unusable. */
export function merge(base, patch) {
    const input = (patch ?? {});
    const out = { ...base };
    if (typeof input.enabled === 'boolean')
        out.enabled = input.enabled;
    if (typeof input.apiKeyRef === 'string' && input.apiKeyRef.trim())
        out.apiKeyRef = input.apiKeyRef.trim();
    if (Array.isArray(input.redactExtra))
        out.redactExtra = input.redactExtra.filter((x) => typeof x === 'string');
    if (Array.isArray(input.disabledChannels))
        out.disabledChannels = input.disabledChannels.filter((x) => typeof x === 'string');
    if (Array.isArray(input.autoChannels))
        out.autoChannels = input.autoChannels.filter((x) => typeof x === 'string');
    if (input.autoTriage === 'off' || input.autoTriage === 'shadow')
        out.autoTriage = input.autoTriage;
    if (typeof input.defaultRepo === 'string')
        out.defaultRepo = input.defaultRepo.trim();
    if (input.thresholds && typeof input.thresholds === 'object') {
        /*
         * Merged, not replaced — and a key the patch does not mention is left alone.
         *
         * This used to write exactly the entries in the patch, so applying a fitted table
         * deleted every cut the fit did not cover. That is how `private_scan.internal`, a
         * per-axis cut measured by hand precisely because a single cut cried wolf on plain
         * code, silently reverted to the all-axes 0.06: the pre-push gate then flagged
         * ordinary comments and table headers as "internal information". The fit only ever
         * concerns the channels it measured; the settings are not its to delete.
         *
         * Removal stays expressible: an explicit `null` deletes that key.
         */
        const merged = { ...(base.thresholds ?? {}) };
        for (const [channel, cut] of Object.entries(input.thresholds)) {
            if (cut === null) {
                delete merged[channel];
                continue;
            }
            if (typeof cut === 'number' && Number.isFinite(cut) && cut >= 0 && cut <= 1)
                merged[channel] = cut;
        }
        out.thresholds = merged;
    }
    if (input.engineByChannel && typeof input.engineByChannel === 'object') {
        /*
         * Merged for the same reason `thresholds` is: a patch that names one channel must
         * not silently drop the routing of every other one.
         */
        const routes = { ...(base.engineByChannel ?? {}) };
        for (const [channel, engine] of Object.entries(input.engineByChannel)) {
            if (engine === null) {
                delete routes[channel];
                continue;
            }
            if (typeof engine === 'string' && engine.trim())
                routes[channel] = engine.trim();
        }
        out.engineByChannel = routes;
    }
    for (const field of Object.keys(BOUNDS)) {
        const value = input[field];
        if (typeof value === 'number' && Number.isFinite(value))
            out[field] = value;
    }
    return out;
}
const file = (dir) => path.join(dir, 'config.json');
/** Stored settings, or `undefined` when there are none (or they are unreadable). */
export function loadStored(dir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/** Persist settings, owner-only. Returns false when it could not land. */
export function saveStored(dir, value) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file(dir), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Whether the automatic lane may fire, and what it may do — as a pure function.
 *
 * Kept out of the observer so the policy can be tested without a running host: an
 * automatic lane's worst failure is not being wrong, it is being unbounded.
 *
 * @param input - the mode, the call's outcome, and what this session has spent.
 * @returns `shadow` when the lane should judge and record, else `skip`.
 */
export function autoPlan(input) {
    if (input.mode === 'off')
        return 'skip';
    if (!input.autoChannels.includes(input.channel))
        return 'skip';
    // Only failures: a successful call has nothing to triage, and firing on every call
    // would make the lane cost more than the round trip it is meant to save.
    if (!input.isError)
        return 'skip';
    if (input.cap <= 0 || input.usedThisSession >= input.cap)
        return 'skip';
    return 'shadow';
}
//# sourceMappingURL=settings.js.map