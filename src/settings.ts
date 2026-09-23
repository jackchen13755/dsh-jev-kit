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
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_API_KEY_REF = 'TYPESAFE_API_KEY'

export interface KitSettings {
  /** Master switch. Off means no request is made; the tools still list the catalogue. */
  enabled: boolean
  /** Credential reference resolved per operation. */
  apiKeyRef: string
  /** Hard ceiling for one judgment request (background work, never on the turn's critical path). */
  requestTimeoutMs: number
  /** Ceiling for one whole tool call, across every item it judges. */
  callBudgetMs: number
  /** Most items one call may judge (a diff can be thousands of lines). */
  maxItems: number
  /** In-flight requests. */
  concurrency: number
  /**
   * Foreground lane: the budget one judgment gets when something is waiting on it.
   *
   * `requestTimeoutMs` is a *batch* ceiling — 8s is fine when a hook is the only caller.
   * A lane that holds a turn must be an order of magnitude smaller, or "helping" costs
   * more than it saves; lens puts its critical-path screen at 1.2s for the same reason.
   */
  foregroundTimeoutMs: number
  /**
   * In-flight limit for foreground judgments, deliberately separate from `concurrency`.
   *
   * Sharing one limiter means a foreground call queues behind whatever batch is in
   * flight, which turns a background instrument into foreground latency — the one thing
   * an advisory tool must never add.
   */
  foregroundConcurrency: number
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
  autoTriage: 'off' | 'shadow'
  /**
   * Channels the automatic lane may fire, by id. One channel, not the catalogue: an
   * automatic lane that fires everything is a bill with no reader.
   */
  autoChannels: string[]
  /** Ceiling on automatic judgments per session — the lane must not outspend the turn. */
  autoMaxPerSession: number
  /**
   * Which engine serves which channel, by channel id (e.g. `{ log_triage: 'laya' }`).
   *
   * `engines` picks one engine for the whole catalogue, which forces a single choice
   * between paying the hosted model for trivia and putting the hard channels on a
   * weaker reader. The bench already measures separation per channel *per engine*, so
   * the evidence to route on exists; this is the knob that spends it. A channel absent
   * here uses the first configured engine.
   */
  engineByChannel: Record<string, string>
  /** Verdict cache TTL. Same input answers the same way, so this is pure saving. */
  cacheTtlMs: number
  cacheMaxEntries: number
  /** Consecutive failures before the breaker short-circuits. */
  breakerFailures: number
  breakerCooldownMs: number
  /** Per-session and per-day request ceilings. */
  sessionCallLimit: number
  dailyCallLimit: number
  /** Extra redaction patterns applied before anything leaves the machine. */
  redactExtra: string[]
  /**
   * Per-string cap applied to states sent to a *local* engine, in characters
   * (0 disables). Hosted engines keep the full state: their cost is not per token
   * in the same way, and truncation there would lose information for nothing.
   */
  localStateChars: number
  /** Cap on array fields (candidate lists, requirement lists) for local engines. */
  localMaxItems: number
  /**
   * Channels turned off by name.
   *
   * The report's advice — "a channel that never produces a non-neutral verdict is
   * not earning its keep" — had no mechanism behind it: the only way to retire one
   * was to edit the source. A disabled channel refuses cleanly and says why, so a
   * catalogue of 23 can shrink to the ones that actually fire.
   */
  disabledChannels: string[]
  /**
   * Repository the card and `/jev-kit scan` read by default.
   *
   * The host process's cwd is *not* the workspace (measured on this machine: the host's cwd was the user's home directory, not the workspace),
   * so "scan the staged diff" without a path fails with git's confusing
   * `--no-index` message. Naming the repo once removes the guesswork.
   */
  defaultRepo: string
  /**
   * Per-channel decision thresholds, fitted from the benchmark corpus
   * (`POST /api/bench` returns an apply-ready table). Empty means the declared
   * defaults, which is not the same as "no opinion": a cut is always in force.
   */
  thresholds: Record<string, number>
}

export const KIT_DEFAULTS: KitSettings = {
  enabled: true,
  apiKeyRef: DEFAULT_API_KEY_REF,
  requestTimeoutMs: 8000,
  callBudgetMs: 90_000,
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
  cacheTtlMs: 86_400_000,
  cacheMaxEntries: 2000,
  breakerFailures: 3,
  breakerCooldownMs: 120_000,
  sessionCallLimit: 2000,
  dailyCallLimit: 20_000,
  redactExtra: [],
  localStateChars: 600,
  localMaxItems: 12,
  thresholds: {},
  disabledChannels: [],
  defaultRepo: '',
}

const BOUNDS: Record<string, [number, number]> = {
  requestTimeoutMs: [300, 60_000],
  callBudgetMs: [1_000, 900_000],
  maxItems: [1, 500],
  concurrency: [1, 16],
  foregroundTimeoutMs: [200, 30_000],
  foregroundConcurrency: [1, 16],
  autoMaxPerSession: [0, 500],
  cacheTtlMs: [0, 86_400_000],
  cacheMaxEntries: [0, 100_000],
  breakerFailures: [1, 100],
  breakerCooldownMs: [0, 3_600_000],
  sessionCallLimit: [0, 1_000_000],
  dailyCallLimit: [0, 10_000_000],
  localStateChars: [0, 8000],
  localMaxItems: [0, 200],
}

/** Validate a settings object, naming the field and its range. */
export function validate (value: KitSettings): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyRef)) return `apiKeyRef 必须形如 ENV_VAR_NAME（当前 ${JSON.stringify(value.apiKeyRef)}）`
  for (const channel of value.disabledChannels ?? []) {
    if (!/^[a-z][a-z0-9_:-]*$/.test(channel)) return `disabledChannels 里有不合法的通道名：${JSON.stringify(channel)}`
  }
  if (value.autoTriage !== 'off' && value.autoTriage !== 'shadow') return `autoTriage 只能是 off / shadow（当前 ${JSON.stringify(value.autoTriage)}）`
  for (const channel of value.autoChannels ?? []) {
    if (!/^[a-z][a-z0-9_:-]*$/.test(channel)) return `autoChannels 里有不合法的通道名：${JSON.stringify(channel)}`
  }
  for (const [channel, engine] of Object.entries(value.engineByChannel ?? {})) {
    if (typeof engine !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(engine)) return `engineByChannel.${channel} 必须是引擎 id（当前 ${JSON.stringify(engine)}）`
  }
  for (const [channel, cut] of Object.entries(value.thresholds ?? {})) {
    if (typeof cut !== 'number' || !Number.isFinite(cut) || cut < 0 || cut > 1) return `thresholds.${channel} 必须在 0–1 之间（当前 ${JSON.stringify(cut)}）`
  }
  for (const [field, [min, max]] of Object.entries(BOUNDS)) {
    const number = (value as unknown as Record<string, unknown>)[field]
    if (typeof number !== 'number' || !Number.isFinite(number)) return `${field} 必须是数字`
    if (number < min || number > max) return `${field} 必须在 ${min}–${max} 之间（当前 ${number}）`
  }
  return undefined
}

/** Merge an untrusted patch onto a base, dropping anything unusable. */
export function merge (base: KitSettings, patch: unknown): KitSettings {
  const input = (patch ?? {}) as Partial<KitSettings>
  const out: KitSettings = { ...base }
  if (typeof input.enabled === 'boolean') out.enabled = input.enabled
  if (typeof input.apiKeyRef === 'string' && input.apiKeyRef.trim()) out.apiKeyRef = input.apiKeyRef.trim()
  if (Array.isArray(input.redactExtra)) out.redactExtra = input.redactExtra.filter((x): x is string => typeof x === 'string')
  if (Array.isArray(input.disabledChannels)) out.disabledChannels = input.disabledChannels.filter((x): x is string => typeof x === 'string')
  if (Array.isArray(input.autoChannels)) out.autoChannels = input.autoChannels.filter((x): x is string => typeof x === 'string')
  if (input.autoTriage === 'off' || input.autoTriage === 'shadow') out.autoTriage = input.autoTriage
  if (typeof input.defaultRepo === 'string') out.defaultRepo = input.defaultRepo.trim()
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
    const merged: Record<string, number> = { ...(base.thresholds ?? {}) }
    for (const [channel, cut] of Object.entries(input.thresholds as Record<string, unknown>)) {
      if (cut === null) { delete merged[channel]; continue }
      if (typeof cut === 'number' && Number.isFinite(cut) && cut >= 0 && cut <= 1) merged[channel] = cut
    }
    out.thresholds = merged
  }
  if (input.engineByChannel && typeof input.engineByChannel === 'object') {
    /*
     * Merged for the same reason `thresholds` is: a patch that names one channel must
     * not silently drop the routing of every other one.
     */
    const routes: Record<string, string> = { ...(base.engineByChannel ?? {}) }
    for (const [channel, engine] of Object.entries(input.engineByChannel as Record<string, unknown>)) {
      if (engine === null) { delete routes[channel]; continue }
      if (typeof engine === 'string' && engine.trim()) routes[channel] = engine.trim()
    }
    out.engineByChannel = routes
  }
  for (const field of Object.keys(BOUNDS) as Array<keyof KitSettings>) {
    const value = input[field]
    if (typeof value === 'number' && Number.isFinite(value)) (out[field] as number) = value
  }
  return out
}

const file = (dir: string): string => path.join(dir, 'config.json')

/** Stored settings, or `undefined` when there are none (or they are unreadable). */
export function loadStored (dir: string): Partial<KitSettings> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(dir), 'utf8')) as Partial<KitSettings>
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Persist settings, owner-only. Returns false when it could not land. */
export function saveStored (dir: string, value: KitSettings): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file(dir), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
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
export function autoPlan (input: {
  mode: KitSettings['autoTriage']
  autoChannels: string[]
  channel: string
  isError: boolean
  usedThisSession: number
  cap: number
}): 'shadow' | 'skip' {
  if (input.mode === 'off') return 'skip'
  if (!input.autoChannels.includes(input.channel)) return 'skip'
  // Only failures: a successful call has nothing to triage, and firing on every call
  // would make the lane cost more than the round trip it is meant to save.
  if (!input.isError) return 'skip'
  if (input.cap <= 0 || input.usedThisSession >= input.cap) return 'skip'
  return 'shadow'
}
