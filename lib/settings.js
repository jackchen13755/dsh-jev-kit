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
    cacheTtlMs: 900000,
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
//# sourceMappingURL=settings.js.map