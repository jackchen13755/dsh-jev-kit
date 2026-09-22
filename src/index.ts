/**
 * `dsh-jev-kit` — Jev as a set of named decisions a caller can reach for.
 *
 * The design commitments, each of which is a reaction to a measured failure:
 *
 *   · **Tools, not hooks.** Nothing here intercepts a tool call, blocks it, or
 *     asks a human. A toolkit that could gate would inherit every failure mode of
 *     a gate — including the `approval: never` trap, where an ask quietly becomes
 *     a refusal whose reason claims the user declined something they never saw.
 *     It also means this plugin registers no `pre/post-execute` middleware, so
 *     hot-reloading it cannot deadlock the call that triggers the reload.
 *   · **One request per unit, all its questions at once.** Independent questions
 *     over the same state run in parallel for the price of one; asking them
 *     separately would triple the latency for nothing.
 *   · **Bounded on every axis.** Per request, per call, per item count, per
 *     session, per day. A 5000-line diff must cost a bounded amount, not an
 *     accidental invoice.
 *   · **The ledger decides what survives.** A channel that never produces a
 *     non-neutral verdict on real input is dead weight, and the report says so.
 *
 * @module dsh-jev-kit
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createJev, compileExtraPatterns, redact, JevError, type Jev, type JevQuestion } from './jev.js'
import { createBreaker, createLimiter, percentiles } from './resilience.js'
import { createCache, keyOf } from './cache.js'
import { serviceOf, type CredentialsService, type Logger, type WebRequestLike, type WebResponseLike, type WebServerLike } from './host.js'
import { CHANNEL_LIST, channelOf, type ChannelSpec, type ChannelState, type Verdict } from './channels.js'
import { hunksOf, unitsOf, type Unit } from './segments.js'
import { append, load, render, summarize, type LedgerRecord } from './ledger.js'
import { KIT_DEFAULTS, loadStored, merge, saveStored, validate, type KitSettings } from './settings.js'

export const name = '@dsh-external/dsh-jev-kit'
export const inject = ['tools']

const API_PREFIX = '/dsh-jev-kit/api'

/** The version comes from the manifest, so a bug report cannot quote a stale one. */
const VERSION: string = (() => {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Structural view of the host context. Compiles against `dsh-tools` alone. */
export interface KitContext {
  tools: { register (definition: unknown): () => void }
  effect (callback: () => unknown, label?: string): void
  inject? (deps: string[], callback: (scope: KitContext) => void): void
  commands?: { register (definition: unknown): () => void }
  webServer?: WebServerLike
  logger?: Logger
}

export interface Config extends KitSettings {
  endpoint: string
  model: string
  /** Explicit key, for a profile that has no credentials seam. */
  apiKey: string
  apiKeyFile: string
  ledgerDir: string
  redact: boolean
}

const DEFAULTS: Config = {
  ...KIT_DEFAULTS,
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  // Pinned, never an alias: a moving model would move every threshold with it.
  model: 'jev-1.13.0',
  apiKey: '',
  apiKeyFile: '',
  ledgerDir: '',
  redact: true,
}

/** One channel's result over one unit. */
interface ItemResult {
  where: string
  verdict: Verdict
  ms?: number
  via: 'jev' | 'cache'
  chars: number
}

/** A whole tool call's result. */
interface CallResult {
  channel: string
  title: string
  items: ItemResult[]
  skipped: number
  stopReason?: string
  degraded: number
  errors: string[]
}

/** Resolve the key from the credential store, then the environment, then a file. */
export function resolveKey (config: Config, env: NodeJS.ProcessEnv = process.env): { key: string, source: string } {
  if (config.apiKey.trim()) return { key: config.apiKey.trim(), source: 'config.apiKey' }
  if (env.TYPESAFE_API_KEY?.trim()) return { key: env.TYPESAFE_API_KEY.trim(), source: 'env:TYPESAFE_API_KEY' }
  const file = config.apiKeyFile.trim()
  if (file) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim()
      if (value) return { key: value, source: `file:${file}` }
    } catch { /* fall through */ }
  }
  return { key: '', source: 'missing' }
}

export function apply (ctx: KitContext, input: Partial<Config> = {}): void {
  const base: Config = { ...DEFAULTS, ...input }
  let config: Config = base
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const ledgerDir = base.ledgerDir.trim() || path.join(dshHome, 'storages', 'dsh_jev_kit')

  const logger = serviceOf<Logger>(ctx, 'logger')
  const services: { credentials?: CredentialsService } = {}
  try {
    ctx.inject?.(['credentials'], (scope: KitContext) => {
      services.credentials = serviceOf<CredentialsService>(scope, 'credentials')
    })
  } catch { /* no credentials seam: the key comes from config, env or a file */ }

  const state = {
    startedAt: Date.now(),
    sessionCalls: new Map<string, number>(),
    day: new Date().toISOString().slice(0, 10),
    dayCalls: 0,
    reasons: new Map<string, number>(),
  }
  const reason = (why: string): void => { state.reasons.set(why, (state.reasons.get(why) ?? 0) + 1) }

  const keyState = { value: '', source: 'missing' }
  let jev: Jev | null = null
  const auth = { fingerprint: '', at: 0, status: 0, message: '' }

  const breaker = createBreaker({ failures: config.breakerFailures, cooldownMs: config.breakerCooldownMs })
  const limiter = createLimiter(config.concurrency)
  const cache = createCache<{ verdict: Verdict, ms: number }>(config.cacheMaxEntries, config.cacheTtlMs)

  let extraKey = '\u0000unset'
  let extraCompiled: RegExp[] = []
  const extraPatterns = (): RegExp[] => {
    const current = config.redactExtra.join('\u0000')
    if (current !== extraKey) { extraKey = current; extraCompiled = compileExtraPatterns(config.redactExtra) }
    return extraCompiled
  }
  const prep = (text: string): string => (config.redact ? redact(text, extraPatterns()) : text)

  async function ensureJev (): Promise<Jev | null> {
    let found = resolveKey(config)
    const service = services.credentials
    if (service && typeof service.resolve === 'function') {
      try {
        const resolved = await service.resolve(config.apiKeyRef.trim() || DEFAULTS.apiKeyRef)
        if (resolved?.value) found = { key: resolved.value, source: `credential:${resolved.source ?? config.apiKeyRef}` }
      } catch { /* fall through to the static sources */ }
    }
    if (found.key !== keyState.value) {
      keyState.value = found.key
      keyState.source = found.source
      auth.fingerprint = ''
      breaker.ok()
      jev = found.key
        ? createJev({ endpoint: config.endpoint, model: config.model, apiKey: found.key, timeoutMs: config.requestTimeoutMs, maxRetries: 1 })
        : null
    }
    return jev
  }

  function authBlocked (): boolean {
    if (!auth.fingerprint) return false
    if (Date.now() - auth.at >= config.breakerCooldownMs) { auth.fingerprint = ''; return false }
    reason(`auth:rejected-${auth.status}`)
    return true
  }

  function noteAuthFailure (error: unknown): void {
    if (!(error instanceof JevError) || (error.status !== 401 && error.status !== 403)) return
    auth.fingerprint = keyState.source
    auth.at = Date.now()
    auth.status = error.status
    auth.message = error.message.slice(0, 200)
  }

  function budgetOk (session: string): boolean {
    if (!config.enabled) return false
    const today = new Date().toISOString().slice(0, 10)
    if (today !== state.day) { state.day = today; state.dayCalls = 0 }
    if (state.dayCalls >= config.dailyCallLimit) { reason('budget:daily'); return false }
    const used = state.sessionCalls.get(session) ?? 0
    if (used >= config.sessionCallLimit) { reason('budget:session'); return false }
    state.dayCalls++
    state.sessionCalls.set(session, used + 1)
    return true
  }

  /* ── the runner ─────────────────────────────────────────────────────── */

  /** Judge one unit with one channel. Cache first, then one batched request. */
  async function judge (channel: ChannelSpec, channelState: ChannelState, session: string): Promise<ItemResult | null> {
    const questions = channel.questions(channelState)
    if (!Object.keys(questions).length) return null
    const chars = JSON.stringify(channelState).length
    const cacheKey = keyOf([channel.id, VERSION, prep(JSON.stringify(channelState))])
    const cached = cache.get(cacheKey)
    if (cached) {
      append(ledgerDir, { t: Date.now(), kind: 'decision', channel: channel.id, group: channel.group, level: cached.verdict.level, values: cached.verdict.values, via: 'cache', chars, ms: cached.ms })
      return { where: '', verdict: cached.verdict, via: 'cache', chars }
    }
    if (authBlocked()) { append(ledgerDir, { t: Date.now(), kind: 'degraded', channel: channel.id, reason: `auth:rejected-${auth.status}` }); return null }
    const transport = await ensureJev()
    if (!transport) { reason('no-key'); append(ledgerDir, { t: Date.now(), kind: 'degraded', channel: channel.id, reason: 'no-key' }); return null }
    if (breaker.isOpen()) { reason('degraded:breaker-open'); append(ledgerDir, { t: Date.now(), kind: 'degraded', channel: channel.id, reason: 'degraded:breaker-open' }); return null }
    if (!budgetOk(session)) { append(ledgerDir, { t: Date.now(), kind: 'degraded', channel: channel.id, reason: 'budget' }); return null }

    /*
     * The state is redacted as a whole and handed over as an object: the question
     * wording names its fields, so the field names must survive redaction.
     */
    const redacted: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(channelState as Record<string, unknown>)) {
      if (typeof value === 'string') redacted[field] = prep(value)
      else if (Array.isArray(value)) redacted[field] = value.map(item => (typeof item === 'string' ? prep(item) : item))
      else if (value && typeof value === 'object') redacted[field] = prep(JSON.stringify(value))
      else if (value !== undefined) redacted[field] = value
    }
    if (channelState.candidates) redacted.candidates = channelState.candidates.map(candidate => prep(candidate))
    if (channelState.requirements) redacted.requirements = channelState.requirements.map(requirement => prep(requirement))

    let answer
    try {
      answer = await limiter.run(() => transport.ask(redacted, questions, { timeoutMs: config.requestTimeoutMs, maxRetries: 1 }))
    } catch (error) {
      noteAuthFailure(error)
      breaker.fail()
      reason(error instanceof JevError && error.status === 401 ? 'error:auth' : 'error:request')
      append(ledgerDir, { t: Date.now(), kind: 'error', channel: channel.id, message: error instanceof Error ? error.message : String(error) })
      return null
    }
    breaker.ok()
    auth.fingerprint = ''
    const verdict = channel.read(answer.answers, channelState)
    cache.set(cacheKey, { verdict, ms: answer.ms })
    append(ledgerDir, { t: Date.now(), kind: 'decision', channel: channel.id, group: channel.group, level: verdict.level, values: verdict.values, via: 'jev', ms: answer.ms, chars })
    return { where: '', verdict, ms: answer.ms, via: 'jev', chars }
  }

  /** Judge every unit, bounded by item count and by the call's own budget. */
  async function runUnits (channelId: string, units: Unit[], session: string, extra: ChannelState = {}): Promise<CallResult> {
    const channel = channelOf(channelId)
    if (!channel) throw new Error(`unknown channel: ${channelId}`)
    const started = Date.now()
    const capped = units.slice(0, config.maxItems)
    const items: ItemResult[] = []
    let degraded = 0
    const errors: string[] = []
    let stopReason: string | undefined

    let cursor = 0
    const workers = Array.from({ length: Math.min(config.concurrency, capped.length) }, async () => {
      while (cursor < capped.length) {
        if (Date.now() - started > config.callBudgetMs) { stopReason = `超出单次调用预算 ${config.callBudgetMs}ms，提前结束`; return }
        const index = cursor++
        const unit = capped[index] as Unit
        const channelState: ChannelState = { text: unit.text, ...extra }
        const result = await judge(channel, channelState, session)
        if (result) items.push({ ...result, where: unit.where })
        else degraded++
      }
    })
    await Promise.all(workers)

    items.sort((a, b) => units.findIndex(u => u.where === a.where) - units.findIndex(u => u.where === b.where))
    return {
      channel: channel.id,
      title: channel.title,
      items,
      skipped: Math.max(0, units.length - capped.length),
      stopReason,
      degraded,
      errors,
    }
  }

  /** Run an `per: input` channel once. */
  async function runInput (channelId: string, channelState: ChannelState, session: string): Promise<CallResult> {
    const channel = channelOf(channelId)
    if (!channel) throw new Error(`unknown channel: ${channelId}`)
    const result = await judge(channel, channelState, session)
    return {
      channel: channel.id,
      title: channel.title,
      items: result ? [result] : [],
      skipped: 0,
      degraded: result ? 0 : 1,
      errors: [],
    }
  }

  /* ── rendering ──────────────────────────────────────────────────────── */

  const sessionOf = (exec: unknown): string =>
    (exec as { agent?: { session?: { id?: string } } })?.agent?.session?.id ?? 'unknown'

  function renderCall (result: CallResult, note?: string): string {
    const head = [`**${result.channel}** · ${result.title}`, note ?? ''].filter(Boolean)
    const body: string[] = []
    for (const item of result.items) {
      const icon = item.verdict.level === 'flag' ? '⛔' : item.verdict.level === 'warn' ? '⚠️' : item.verdict.level === 'ok' ? '✓' : '·'
      const where = item.where ? `${item.where} — ` : ''
      body.push(`${icon} ${where}${item.verdict.headline}${item.via === 'cache' ? '（缓存）' : ''}`)
      for (const detail of item.verdict.details ?? []) body.push(`    ${detail}`)
    }
    const neutral = result.items.filter(item => item.verdict.level === 'info').length
    const summary = result.items.length
      ? `${result.items.length} 条判定：⛔${result.items.filter(i => i.verdict.level === 'flag').length} ⚠️${result.items.filter(i => i.verdict.level === 'warn').length} ✓${result.items.filter(i => i.verdict.level === 'ok').length} ·中性 ${neutral}`
      : '没有可判定的内容'
    const warns = [
      result.skipped ? `（超过单次上限，跳过了 ${result.skipped} 条——分批再跑）` : '',
      result.degraded ? `（${result.degraded} 条未能判定：key/熔断/预算，已 fail-open）` : '',
      result.stopReason ?? '',
    ].filter(Boolean)
    return [...head, '', summary, ...warns, '', ...body].join('\n')
  }

  function statusPayload (): Record<string, unknown> {
    return {
      version: VERSION,
      uptimeMs: Date.now() - state.startedAt,
      enabled: config.enabled,
      model: config.model,
      key: { ref: config.apiKeyRef, configured: keyState.value !== '', source: keyState.source },
      auth: auth.fingerprint ? { rejected: true, status: auth.status, at: auth.at, message: auth.message } : { rejected: false },
      settings: {
        requestTimeoutMs: config.requestTimeoutMs,
        callBudgetMs: config.callBudgetMs,
        maxItems: config.maxItems,
        concurrency: config.concurrency,
        cacheTtlMs: config.cacheTtlMs,
      },
      channels: CHANNEL_LIST.length,
      health: {
        breakerOpen: breaker.state.open,
        failures: breaker.state.failures,
        inFlight: limiter.active,
        queued: limiter.queued,
        cache: { hits: cache.stats.hits, misses: cache.stats.misses, size: cache.stats.size },
        requests: jev?.stats.calls ?? 0,
        inputTokens: jev?.stats.inputTokens ?? 0,
      },
      budget: { dayCalls: state.dayCalls, dailyCallLimit: config.dailyCallLimit, sessionCallLimit: config.sessionCallLimit },
      reasons: [...state.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      ledger: ledgerDir,
    }
  }

  const reasonTable = (): string => {
    const entries = [...state.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    return entries.length ? entries.map(([why, n]) => `${String(n).padStart(4)} × ${why}`).join('\n') : '无（每次调用都走到了判定）'
  }

  /* ── tools ──────────────────────────────────────────────────────────── */

  const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [])

  const tool = (definition: unknown, label: string): void => { ctx.effect(() => ctx.tools.register(definition), label) }
  // `as const` on the discriminant: hoisting this descriptor out of the tool
  // literal widens `type` to `string`, which the output contract rejects.
  const textOut = { schema: { type: 'string' as const }, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: String(v) }] }

  tool(defineTool({
    name: 'jev_kit_channels',
    description: 'List every decision channel this toolkit can make (id, group, what it replaces). Use it before jev_kit_decide.',
    parameters: { group: { type: 'string', description: 'Filter: P (priorities) | A (agent loop) | B (guards) | C (batch triage) | D (memory)' } },
    output: textOut,
    async execute (args: { group?: string }) {
      const wanted = str(args?.group).trim().toUpperCase()
      const rows = CHANNEL_LIST.filter(channel => !wanted || channel.group === wanted)
      const groupName: Record<string, string> = {
        P: 'P · 三件优先事项', A: 'A · 替掉一次 frontier 往返', B: 'B · 守卫与门禁（只给建议）', C: 'C · 批量分诊', D: 'D · 记忆与检索',
      }
      const lines: string[] = []
      for (const group of ['P', 'A', 'B', 'C', 'D']) {
        const own = rows.filter(channel => channel.group === group)
        if (!own.length) continue
        lines.push(`**${groupName[group]}**`)
        for (const channel of own) lines.push(`  · \`${channel.id}\`（${channel.per === 'item' ? '逐条' : '整体'}）— ${channel.title}：${channel.intent}`)
        lines.push('')
      }
      lines.push('用法：`jev_kit_decide { channel, text, task, candidates, requirements }`；隐私/范围/记忆/分诊/选择有专用工具，见各自描述。')
      return lines.join('\n')
    },
  }), 'jev-kit channels tool')

  tool(defineTool({
    name: 'jev_kit_decide',
    description: 'Run one named Jev decision channel over the state you pass (see jev_kit_channels). Advisory only: it returns a typed verdict and never blocks anything.',
    parameters: {
      channel: { type: 'string', description: 'Channel id, e.g. sufficient / route / failure_triage / risk / review_triage' },
      text: { type: 'string', description: 'The text under judgment (segment, hunk, tool result, comment…)' },
      task: { type: 'string', description: 'The user request or task the judgment is relative to, when the channel needs one' },
      other: { type: 'string', description: 'Second text for pair judgments (memory_conflict)' },
      candidates: { type: 'array', items: { type: 'string' }, description: 'Shortlist for choice channels (pick, tag_session)' },
      requirements: { type: 'array', items: { type: 'string' }, description: 'Checklist for evidence_check' },
      candidateNoun: { type: 'string', description: 'What the candidates are (component, test, skill…)' },
    },
    output: textOut,
    async execute (args: Record<string, unknown>, exec: unknown) {
      const channelId = str(args?.channel)
      const channel = channelOf(channelId)
      if (!channel) return `未知通道 "${channelId}"。先用 jev_kit_channels 看目录。`
      const channelState: ChannelState = {
        text: str(args?.text), task: str(args?.task) || undefined, other: str(args?.other) || undefined,
        candidates: list(args?.candidates), requirements: list(args?.requirements),
        candidateNoun: str(args?.candidateNoun) || undefined,
      }
      if (channel.per === 'item') {
        const units: Unit[] = channelState.text ? [{ text: channelState.text, where: '' }] : []
        if (!units.length) return '该通道需要 `text`。'
        return renderCall(await runUnits(channel.id, units, sessionOf(exec), { task: channelState.task, other: channelState.other, candidates: channelState.candidates, requirements: channelState.requirements, candidateNoun: channelState.candidateNoun }))
      }
      return renderCall(await runInput(channel.id, channelState, sessionOf(exec)))
    },
  }), 'jev-kit decide tool')

  tool(defineTool({
    name: 'jev_kit_scan_private',
    description: 'Priority 1 — semantic privacy scan for a pre-push check: finds credentials, personal data and internal details that a regex pass misses. Pass a `diff` (only added lines are scanned) or a `text`. Advisory: it reports findings, it does not edit anything.',
    parameters: {
      diff: { type: 'string', description: 'Unified diff to scan (added lines only)' },
      text: { type: 'string', description: 'Or free text to scan instead' },
      maxItems: { type: 'number', description: 'Cap on units judged (default from settings)' },
    },
    output: textOut,
    async execute (args: Record<string, unknown>, exec: unknown) {
      const artifact = str(args?.diff) || str(args?.text)
      if (!artifact) return '需要 `diff` 或 `text`。'
      const cap = typeof args?.maxItems === 'number' ? Math.max(1, Math.min(200, args.maxItems)) : config.maxItems
      const units = unitsOf(artifact, cap)
      if (!units.length) return '没有可扫描的内容（diff 里没有新增行，或文本太短）。'
      const result = await runUnits('private_scan', units, sessionOf(exec))
      const findings = result.items.filter(item => item.verdict.level === 'flag')
      return renderCall(result, findings.length
        ? `⚠️ ${findings.length} 处疑似泄漏 —— 逐条确认后再推送（正则扫描仍要照跑，两者互补）`
        : '未发现语义层面的泄漏（正则扫描仍要照跑：token 形态、手机号这类由正则负责）')
    },
  }), 'jev-kit private scan tool')

  tool(defineTool({
    name: 'jev_kit_scope_check',
    description: 'Priority 3 — change-scope gate: judges each diff hunk against the task and reports hunks the task did not ask for. Advisory; it never reverts or edits.',
    parameters: {
      task: { type: 'string', description: 'What the user asked for' },
      diff: { type: 'string', description: 'Unified diff of the change' },
      maxItems: { type: 'number', description: 'Cap on hunks judged' },
    },
    output: textOut,
    async execute (args: Record<string, unknown>, exec: unknown) {
      const task = str(args?.task)
      const diff = str(args?.diff)
      if (!task || !diff) return '需要 `task` 和 `diff`。'
      const cap = typeof args?.maxItems === 'number' ? Math.max(1, Math.min(200, args.maxItems)) : config.maxItems
      const units = hunksOf(diff, cap)
      if (!units.length) return 'diff 里没有可判定的 hunk。'
      return renderCall(await runUnits('scope_check', units, sessionOf(exec), { task }), '按你自己的纪律「只改要求改的地方」逐 hunk 对照')
    },
  }), 'jev-kit scope tool')

  tool(defineTool({
    name: 'jev_kit_memory',
    description: 'Priority 2 + group D — memory judgments: mode=write (worth remembering? which track?), mode=conflict (do two memories contradict or duplicate?), mode=rerank (score each candidate memory against a query, best first).',
    parameters: {
      mode: { type: 'string', enum: ['write', 'conflict', 'rerank'], description: 'Which memory judgment' },
      text: { type: 'string', description: 'The turn/lesson text (write) or the first memory (conflict)' },
      other: { type: 'string', description: 'The second memory (conflict)' },
      query: { type: 'string', description: 'What you are trying to answer (rerank)' },
      candidates: { type: 'array', items: { type: 'string' }, description: 'Candidate memories (rerank)' },
    },
    output: textOut,
    async execute (args: Record<string, unknown>, exec: unknown) {
      const mode = str(args?.mode) || 'write'
      const text = str(args?.text)
      if (mode === 'write') {
        if (!text) return 'mode=write 需要 `text`。'
        return renderCall(await runUnits('memory_write', [{ text, where: '' }], sessionOf(exec)))
      }
      if (mode === 'conflict') {
        const other = str(args?.other)
        if (!text || !other) return 'mode=conflict 需要 `text` 与 `other` 两条记忆。'
        return renderCall(await runUnits('memory_conflict', [{ text, where: '' }], sessionOf(exec), { other }))
      }
      const query = str(args?.query)
      const candidates = list(args?.candidates)
      if (!query || !candidates.length) return 'mode=rerank 需要 `query` 与 `candidates`。'
      const units: Unit[] = candidates.slice(0, config.maxItems).map((candidate, index) => ({ text: candidate, where: `#${index + 1}` }))
      const result = await runUnits('recall_rerank', units, sessionOf(exec), { task: query })
      const ordered = [...result.items].sort((a, b) => Number(b.verdict.values.answers_query ?? 0) - Number(a.verdict.values.answers_query ?? 0))
      const table = ordered.map((item, index) => `${index + 1}. ${item.where} score=${item.verdict.values.answers_query ?? '—'} ${item.where ? '' : ''}`).join('\n')
      return `${renderCall(result, '只排序，不设阈值：分数是排序信号，不是概率')}\n\n**按分数排序**\n${table}`
    },
  }), 'jev-kit memory tool')

  tool(defineTool({
    name: 'jev_kit_triage',
    description: 'Group C — batch triage over many items: kind=log (error / warning worth acting on / noise), kind=alert (same incident as an open one?), kind=bug (code/config/data/perf/ux + reproducible?), kind=flaky (flaky or a real regression?).',
    parameters: {
      kind: { type: 'string', enum: ['log', 'alert', 'bug', 'flaky'], description: 'Which triage channel' },
      items: { type: 'array', items: { type: 'string' }, description: 'The lines / alerts / reports / failures to triage' },
      context: { type: 'string', description: 'Context for pair/relative judgments: the open alert (alert), the change or test (flaky)' },
      maxItems: { type: 'number', description: 'Cap on items judged' },
    },
    output: textOut,
    async execute (args: Record<string, unknown>, exec: unknown) {
      const kind = str(args?.kind) || 'log'
      const channelId = kind === 'log' ? 'log_triage' : kind === 'alert' ? 'alert_dedup' : kind === 'bug' ? 'bug_triage' : 'flaky'
      const items = list(args?.items)
      if (!items.length) return '需要 `items`。'
      const cap = typeof args?.maxItems === 'number' ? Math.max(1, Math.min(500, args.maxItems)) : Math.min(config.maxItems, 200)
      const context = str(args?.context)
      const units: Unit[] = items.slice(0, cap).map((item, index) => ({ text: item, where: `#${index + 1}` }))
      const result = await runUnits(channelId, units, sessionOf(exec), context ? { other: context, task: context } : {})
      const groups = new Map<string, number>()
      for (const item of result.items) {
        const label = String(item.verdict.headline)
        groups.set(label, (groups.get(label) ?? 0) + 1)
      }
      const tally = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${label} × ${n}`).join(' · ')
      return `${renderCall(result)}\n\n**汇总**：${tally || '—'}`
    },
  }), 'jev-kit triage tool')

  tool(defineTool({
    name: 'jev_kit_pick',
    description: 'Group C — choose one candidate (component, test file, skill, doc) that best matches a task, with an explicit "none of these" escape so a wrong list cannot force a bad answer.',
    parameters: {
      task: { type: 'string', description: 'What you are trying to do' },
      candidates: { type: 'array', items: { type: 'string' }, description: 'The shortlist (≤60)' },
      noun: { type: 'string', description: 'What the candidates are, e.g. component / test / skill' },
    },
    output: textOut,
    async execute (args: Record<string, unknown>, exec: unknown) {
      const task = str(args?.task)
      const candidates = list(args?.candidates)
      if (!task || !candidates.length) return '需要 `task` 与 `candidates`。'
      return renderCall(await runInput('pick', { task, candidates: candidates.slice(0, 60), candidateNoun: str(args?.noun) || 'option' }, sessionOf(exec)))
    },
  }), 'jev-kit pick tool')

  tool(defineTool({
    name: 'jev_kit_status',
    description: 'Kit status: key source, budget, breaker, cache, and why calls were skipped.',
    parameters: {},
    output: textOut,
    async execute () {
      // Resolve the credential first: a status that reports "missing" merely
      // because nothing has asked yet is a status that lies about its own state.
      await ensureJev()
      const payload = statusPayload()
      const policy = `enabled=${config.enabled} · model=${config.model} · 通道 ${CHANNEL_LIST.length} 个`
      return [
        `**dsh-jev-kit** v${VERSION}`,
        policy,
        `key=${keyState.source}${keyState.value ? '' : '  ⚠️ 未解析到 key：所有判断都会被跳过（fail-open）'}`,
        `超时 单次 ${config.requestTimeoutMs}ms · 单次调用预算 ${config.callBudgetMs}ms · 每次最多 ${config.maxItems} 条 · 并发 ${config.concurrency}`,
        `预算 今日 ${state.dayCalls}/${config.dailyCallLimit} · 本会话 ${config.sessionCallLimit}`,
        `运行态 熔断 ${breaker.state.open ? 'OPEN' : 'closed'} · 在飞 ${limiter.active}/排队 ${limiter.queued} · 缓存 ${cache.stats.hits}/${cache.stats.hits + cache.stats.misses} 命中（${cache.stats.size} 条）· 累计请求 ${jev?.stats.calls ?? 0}`,
        `ledger ${ledgerDir}`,
        '',
        '跳过原因：',
        reasonTable(),
        '',
        `目录：jev_kit_channels${payload.auth && (payload.auth as { rejected?: boolean }).rejected ? '（⚠️ key 被拒，10 分钟内静默）' : ''}`,
      ].join('\n')
    },
  }), 'jev-kit status tool')

  tool(defineTool({
    name: 'jev_kit_report',
    description: 'Aggregate the kit ledger by channel. Read it to retire channels that never fire: a channel with many calls and no non-neutral verdict is not earning its keep.',
    parameters: { days: { type: 'number', description: 'Days of ledger to include (default 7)' } },
    output: textOut,
    async execute (args: { days?: number }) {
      const days = Math.max(1, Math.min(90, Math.round(args?.days ?? 7)))
      return render(summarize(load(ledgerDir, days), days))
    },
  }), 'jev-kit report tool')

  /* ── settings + status over HTTP (for a card, and for curl) ─────────── */

  function installApi (host: KitContext): void {
    if (typeof host.inject !== 'function') return
    try {
      host.inject(['webServer'], (scope: KitContext) => {
        const server = serviceOf<WebServerLike>(scope, 'webServer') ?? scope.webServer
        if (!server || typeof server.register !== 'function') return
        const send = (res: WebResponseLike, status: number, body: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        scope.effect(() => server.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: async (req: WebRequestLike, res: WebResponseLike) => {
            const route = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
            try {
              if (req.method === 'GET' && (route === 'status' || route === '')) {
                await ensureJev() // same reason as the tool: never report "missing" before looking
                send(res, 200, statusPayload())
                return
              }
              if (req.method === 'GET' && route === 'report') {
                const url = new URL(req.url ?? '/', 'http://127.0.0.1')
                const days = Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get('days') ?? 7)) || 7))
                send(res, 200, { ok: true, days, report: summarize(load(ledgerDir, days), days), markdown: render(summarize(load(ledgerDir, days), days)) })
                return
              }
              if (req.method === 'GET' && route === 'channels') {
                send(res, 200, { ok: true, channels: CHANNEL_LIST.map(c => ({ id: c.id, group: c.group, title: c.title, intent: c.intent, per: c.per })) })
                return
              }
              send(res, 404, { ok: false, error: `unknown route ${route}` })
            } catch (error) {
              send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
        }), 'jev-kit api')
      })
    } catch { /* no webServer service: the tools still work */ }
  }

  /* ── slash command ──────────────────────────────────────────────────── */

  try {
    ctx.inject?.(['commands'], (scope: KitContext) => {
      scope.effect(() => scope.commands?.register({
        name: 'jev-kit',
        description: 'Jev 决策工具箱：channels / report [days] / status',
        input: { hint: 'channels | report [days] | status' },
        handler: (invocation: { rawInput: string }) => {
          const [, sub, arg] = invocation.rawInput.trim().split(/\s+/)
          if (sub === 'report') {
            const days = Math.max(1, Math.min(90, Number(arg) || 7))
            return { kind: 'success' as const, text: render(summarize(load(ledgerDir, days), days)) }
          }
          if (sub === 'channels') {
            const lines = ['**dsh-jev-kit 通道目录**']
            for (const channel of CHANNEL_LIST) lines.push(`· ${channel.group} \`${channel.id}\` — ${channel.title}`)
            return { kind: 'success' as const, text: lines.join('\n') }
          }
          return {
            kind: 'success' as const,
            text: [
              `dsh-jev-kit v${VERSION} · enabled=${config.enabled} · key=${keyState.source} · 通道 ${CHANNEL_LIST.length}`,
              `ledger ${ledgerDir}`,
              '用法：/jev-kit channels · /jev-kit report [days] · /jev-kit status',
            ].join('\n'),
          }
        },
      }), 'jev-kit command')
    })
  } catch { /* commands service absent */ }

  /* ── stored settings, then the API ──────────────────────────────────── */

  const stored = loadStored(ledgerDir)
  if (stored) {
    const candidate = merge(KIT_DEFAULTS, stored)
    const problem = validate(candidate)
    if (problem) logger?.warn?.(`[dsh-jev-kit] 已存设置不可用（${problem}），改用默认值`)
    else config = { ...config, ...candidate }
  }
  installApi(ctx)
}

/** Exported for the offline tests: the pieces that must not need a host to check. */
export { CHANNEL_LIST, channelOf } from './channels.js'
export { unitsOf, hunksOf, diffUnits, textUnits, isDiff } from './segments.js'
export { summarize as summarizeLedger } from './ledger.js'
export type { JevQuestion }
