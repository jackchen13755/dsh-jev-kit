/**
 * The kit's ledger: one row per judgment, metadata only.
 *
 * It exists for the reason the whole toolkit exists measured rather than
 * asserted: without a record of what was asked, what answered, how long it took
 * and whether the caller acted on it, "Jev is useful here" is a feeling. No
 * bodies: a redacted, capped excerpt at most, never the full text under judgment.
 *
 * @module dsh-jev-kit/ledger
 */
import fs from 'node:fs'
import path from 'node:path'
import { percentiles } from '@dsh-external/dsh-jev-core'
import { CHANNEL_LIST } from './channels.js'

/** The full catalogue, so the report can name what was never used. */
const ALL_CHANNELS = CHANNEL_LIST.map(channel => channel.id)

export type LedgerRecord =
  | {
    t: number; kind: 'decision'; channel: string; group: string; level: string
    /** The verdict's headline numbers (probabilities, choices, scores). */
    values: Record<string, number | string | undefined>
    ms?: number; via?: 'jev' | 'cache'; chars: number; item?: number
    /**
     * Which entry produced this judgment: `hook`, `card`, `command`, `test`, or a
     * session id.
     *
     * Without it the ledger cannot answer the only question that decides where to
     * build next — "which entry point is actually earning its keep?". Measured
     * 2026-09-23 before adding it: 593 of 608 judgments came from one entry (the
     * push hook) and there was no way to see that from the rows themselves.
     */
    session?: string
    /** Wording fingerprint of the channel at decision time (drift detection). */
    qh?: string
    /** Set when the caller reported whether it acted on the advice. */
    acted?: boolean
  }
  | {
    t: number; kind: 'trial'; engine: string; channel: string; fixture: string
    ok: boolean; value?: number | string; level?: string; ms?: number; error?: string
  }
  | { t: number; kind: 'bench'; engines: string[]; fixtures: number }
  | { t: number; kind: 'degraded'; channel: string; reason: string }
  | { t: number; kind: 'error'; channel: string; message: string }
  /**
   * Somebody reported, after the fact, whether the advice was acted on.
   *
   * A separate row rather than a field set on the decision row, because this file is
   * append-only by design: the gate that learns "the finding was fixed" learns it on a
   * *later* push, and rewriting an earlier line to say so would trade an auditable
   * record for a tidier one. Without any such row the ledger could prove the instrument
   * fired but never that it changed anything — measured 2026-09-23: `acted` was set on
   * 0 of 1024 judgments.
   */
  | { t: number; kind: 'acted'; channel: string; entry?: string; note?: string; acted: boolean }

export const ledgerFile = (dir: string, when = new Date()): string =>
  path.join(dir, `ledger-${when.toISOString().slice(0, 10)}.jsonl`)

/** Append one row. Best-effort by design: measurement never breaks a task. */
export function append (dir: string, record: LedgerRecord): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(ledgerFile(dir), JSON.stringify(record) + '\n')
  } catch { /* a ledger write must never be the reason a task fails */ }
}

/** Load the last `days` daily files, oldest first. */
export function load (dir: string, days: number, now = new Date()): LedgerRecord[] {
  const out: LedgerRecord[] = []
  for (let i = days - 1; i >= 0; i--) {
    const file = ledgerFile(dir, new Date(now.getTime() - i * 86_400_000))
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line) as LedgerRecord) } catch { /* torn line */ }
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Sample size below which a channel's silence means nothing. */
export const MIN_SAMPLE = 20

/**
 * The one recommendation this table makes about a channel.
 *
 * `useful` is not a euphemism: a channel earns its keep by coming back non-neutral,
 * and that is what its marker draws the eye to.
 */
export type Verdict = 'useful' | 'warn' | 'retire' | 'thin'

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
export const verdictOf = (row: { n: number, flagged: number, warn: number }): Verdict =>
  row.flagged > 0 ? 'useful' : row.warn > 0 ? 'warn' : row.n >= MIN_SAMPLE ? 'retire' : 'thin'

/**
 * Colour marker per verdict.
 *
 * The report is read in Markdown and in a terminal, where a row cannot be coloured, so
 * the marker has to survive copy-paste — which is why the levels get a symbol rather
 * than staying implicit in the numbers.
 */
export const VERDICT_MARK: Record<Verdict, string> = { useful: '🔴', warn: '🟡', retire: '⬛', thin: '⚪' }

export interface ChannelReport {
  channel: string
  group: string
  n: number
  /** How often the channel came back non-neutral. */
  flagged: number
  warn: number
  /** What to do about it — see {@link verdictOf}. */
  level: Verdict
  cached: number
  latency: { p50: number; p95: number; max: number; mean: number }
  /** Of the rows where the caller said whether it acted. */
  acted: number
  actedYes: number
}

export interface KitReport {
  window: { days: number; records: number }
  total: number
  cost: { inputTokens: number; usd: number; savedCalls: number }
  channels: ChannelReport[]
  health: { degraded: number; errors: number }
  /** Benchmark trials, grouped by engine — the evidence for moving a channel. */
  bench: { trials: number; byEngine: Record<string, { n: number, pass: number }> }
  /**
   * Channels never used for real work.
   *
   * The corpus proves a channel *can* judge; only usage proves anyone wants it.
   * Measured 2026-09-23: 16 of 23 channels had never been called outside the
   * benchmark — the report should say so rather than implying they are in service.
   */
  unusedChannels: string[]
  /**
   * Judgments per entry point.
   *
   * This is the number that decides where the next integration goes: a channel with
   * a working entry accumulates calls on its own, a channel without one stays at
   * zero no matter how good its wording is.
   */
  byEntry: Array<{ entry: string, n: number, flag: number }>
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** Aggregate the ledger by channel — the only honest way to rank this catalogue. */
export function summarize (records: LedgerRecord[], days: number, usdPerMTok = 0.042): KitReport {
  const decisions = records.filter((r): r is Extract<LedgerRecord, { kind: 'decision' }> => r.kind === 'decision')
  /** Late reports, from a caller that could only know afterwards (a push gate, mostly). */
  const actedReports = records.filter((r): r is Extract<LedgerRecord, { kind: 'acted' }> => r.kind === 'acted')
  const byChannel = new Map<string, Extract<LedgerRecord, { kind: 'decision' }>[]>()
  for (const row of decisions) {
    const list = byChannel.get(row.channel) ?? []
    list.push(row)
    byChannel.set(row.channel, list)
  }
  const channels: ChannelReport[] = [...byChannel.entries()].map(([channel, rows]) => {
    const n = rows.length
    const flagged = rows.filter(r => r.level === 'flag').length
    const warn = rows.filter(r => r.level === 'warn').length
    return {
      channel,
      group: rows[0]?.group ?? '?',
      n,
      flagged,
      warn,
      level: verdictOf({ n, flagged, warn }),
      cached: rows.filter(r => r.via === 'cache').length,
      latency: percentiles(rows.map(r => r.ms ?? 0).filter(ms => ms > 0)),
      // Two ways to learn it: the caller said so at judgment time (`acted` on the
      // decision row), or a later report said so (an `acted` marker row). Same question.
      acted: rows.filter(r => r.acted !== undefined).length + actedReports.filter(r => r.channel === channel).length,
      actedYes: rows.filter(r => r.acted === true).length + actedReports.filter(r => r.channel === channel && r.acted !== false).length,
    }
  }).sort((a, b) => b.n - a.n)

  // Tokens are not recorded per row (the state size is), so the cost shown is an
  // estimate at the documented rate rather than a measurement pretending to be one.
  const chars = decisions.reduce((sum, r) => sum + r.chars, 0)
  const inputTokens = Math.round(chars / 4)
  return {
    window: { days, records: records.length },
    total: decisions.length,
    cost: { inputTokens, usd: Number(((inputTokens * usdPerMTok) / 1e6).toFixed(6)), savedCalls: decisions.filter(r => r.via === 'cache').length },
    channels,
    health: {
      degraded: records.filter(r => r.kind === 'degraded').length,
      errors: records.filter(r => r.kind === 'error').length,
    },
    byEntry: (() => {
      const counts = new Map<string, { n: number, flag: number }>()
      for (const row of decisions) {
        const entry = row.session ?? '(未记录)'
        const own = counts.get(entry) ?? { n: 0, flag: 0 }
        own.n++
        if (row.level === 'flag') own.flag++
        counts.set(entry, own)
      }
      return [...counts.entries()].map(([entry, own]) => ({ entry, ...own })).sort((a, b) => b.n - a.n)
    })(),
    unusedChannels: (() => {
      const used = new Set(decisions.map(row => row.channel))
      return ALL_CHANNELS.filter(channel => !used.has(channel))
    })(),
    bench: (() => {
      const trials = records.filter((r): r is Extract<LedgerRecord, { kind: 'trial' }> => r.kind === 'trial')
      const byEngine: Record<string, { n: number, pass: number }> = {}
      for (const trial of trials) {
        const own = byEngine[trial.engine] ?? { n: 0, pass: 0 }
        own.n++
        if (trial.ok) own.pass++
        byEngine[trial.engine] = own
      }
      return { trials: trials.length, byEngine }
    })(),
  }
}

/** Human-readable report. */
export function render (report: KitReport): string {
  const lines = [
    '**dsh-jev-kit · Jev 决策工具箱**',
    `窗口：最近 ${report.window.days} 天 · ${report.total} 次判断 · 估算成本 $${report.cost.usd}（≈${report.cost.inputTokens} input tok）· 命中缓存 ${report.cost.savedCalls}`,
    '',
    '| 判定 | 通道 | 组 | 次数 | ⚠️flag | △warn | 缓存 | p50 | p95 |',
    '|---|---|---|---|---|---|---|---|---|',
  ]
  for (const channel of report.channels) {
    lines.push(`| ${VERDICT_MARK[channel.level]} | ${channel.channel} | ${channel.group} | ${channel.n} | ${channel.flagged} | ${channel.warn} | ${channel.cached} | ${channel.latency.p50}ms | ${channel.latency.p95}ms |`)
  }
  if (!report.channels.length) lines.push('| （还没有判断记录） | | | | | | | | |')
  lines.push(
    '',
    `判定：🔴 有命中（去看它抓到了什么）· 🟡 只有 warn（观察）· ⬛ 样本够了却从未非中性（淘汰或改问句——本表唯一的行动项）· ⚪ 样本不足（不表态，样本 < ${MIN_SAMPLE}）`,
    '',
    report.health.degraded || report.health.errors
      ? `⚠️ 降级 ${report.health.degraded} · 失败 ${report.health.errors}（失败永远不记成"没问题"）`
      : '无降级、无失败',
    '',
    /*
     * Rendered only when there is something to say: a permanent "acted 0/0" line trains
     * the reader to ignore it, and this dimension is usually empty for an honest reason
     * (nobody reports back) rather than a good one.
     */
    report.channels.some(channel => channel.acted > 0)
      ? `被采纳：${report.channels.filter(channel => channel.acted > 0).map(channel => `\`${channel.channel}\` ${channel.actedYes}/${channel.acted}`).join(' · ')} —— 由调用方回填（"它响了"和"有人照做"是两件事）`
      : '',
    '',
    report.byEntry.length
      ? `按入口：${report.byEntry.map(row => `\`${row.entry}\`×${row.n}${row.flag ? `(⛔${row.flag})` : ''}`).join(' · ')} —— **没有入口的通道永远是 0，无论问句写得多好**`
      : '',
    report.unusedChannels.length
      ? `从未被真实调用过的通道（${report.unusedChannels.length}）：${report.unusedChannels.map(c => `\`${c}\``).join(' · ')} —— 评测能证明"它能判"，只有用法能证明"有人要"。停用它们：设置里的 disabledChannels。`
      : '每个通道都被真实调用过。',
    '',
    '读法：**这个表是用来淘汰通道的**。某个通道次数不少但 flag/warn 长期为 0，说明它在你的语料上不产生信息——那就别用了，别留着自我安慰。',
  )
  return lines.join('\n')
}
