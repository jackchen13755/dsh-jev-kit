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
}

export const KIT_DEFAULTS: KitSettings = {
  enabled: true,
  apiKeyRef: DEFAULT_API_KEY_REF,
  requestTimeoutMs: 8000,
  callBudgetMs: 90_000,
  maxItems: 40,
  concurrency: 4,
  cacheTtlMs: 900_000,
  cacheMaxEntries: 2000,
  breakerFailures: 3,
  breakerCooldownMs: 120_000,
  sessionCallLimit: 2000,
  dailyCallLimit: 20_000,
  redactExtra: [],
  localStateChars: 600,
  localMaxItems: 12,
}

const BOUNDS: Record<string, [number, number]> = {
  requestTimeoutMs: [300, 60_000],
  callBudgetMs: [1_000, 900_000],
  maxItems: [1, 500],
  concurrency: [1, 16],
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
