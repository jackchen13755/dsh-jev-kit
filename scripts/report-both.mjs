#!/usr/bin/env node
/**
 * One report for both plugins: what did Jev actually do for me?
 *
 * The two plugins keep separate ledgers on purpose — `dsh-jev-lens` records an
 * automatic guard (every shell command, every screened page) and `dsh-jev-kit`
 * records on-demand judgments (the channels a caller reaches for). Two shapes, two
 * ledgers. But the question a person actually asks is singular, so this reads both
 * and answers it in one screen.
 *
 * It is a **script, not a plugin route**, deliberately: reading another plugin's
 * *data* is fine, while importing its code would couple two independently
 * installable packages — the kit would then break when the lens is uninstalled, which
 * is the exact opposite of the point.
 *
 * Usage:
 *   node scripts/report-both.mjs [days]
 *   DSH_HOME=/path/to/.dsh node scripts/report-both.mjs 7
 *
 * @module dsh-jev-kit/scripts/report-both
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DAYS = Math.max(1, Math.min(365, Number(process.argv[2]) || 1))
const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const STORES = {
  lens: path.join(HOME, 'storages', 'dsh_jev_lens'),
  kit: path.join(HOME, 'storages', 'dsh_jev_kit'),
}

/** Every JSONL row from the last `days` daily files of one store. */
function readLedger (dir, days) {
  const rows = []
  const today = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const when = new Date(today.getTime() - i * 86_400_000)
    const file = path.join(dir, `ledger-${when.toISOString().slice(0, 10)}.jsonl`)
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { /* a torn final line is not a reason to fail */ }
    }
  }
  return rows
}

const byKind = (rows, kind) => rows.filter(row => row.kind === kind)
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const pct = (x) => `${(x * 100).toFixed(0)}%`
const usd = (x) => `$${x.toFixed(6)}`

/** Aggregate everything this report needs, so the rendering stays dumb. */
function collect (days) {
  const lens = readLedger(STORES.lens, days)
  const kit = readLedger(STORES.kit, days)

  const commands = byKind(lens, 'command')
  const skipped = byKind(lens, 'degraded')
  const screens = byKind(lens, 'screen')
  const prefilterSkips = byKind(lens, 'screen-skip')
  const outcomes = byKind(lens, 'command-outcome')
  const decisions = byKind(kit, 'decision')
  const trials = byKind(kit, 'trial')

  const lensTokens = sum(commands.map(row => row.inputTokens ?? 0)) + sum(screens.map(row => row.inputTokens ?? 0))
  const kitChars = sum(decisions.map(row => row.chars ?? 0))
  const kitTokens = Math.round(kitChars / 4)
  const inputTokens = lensTokens + kitTokens

  const skipReasons = new Map()
  for (const row of skipped) skipReasons.set(row.reason, (skipReasons.get(row.reason) ?? 0) + 1)

  const kitChannels = new Map()
  for (const row of decisions) {
    const own = kitChannels.get(row.channel) ?? { n: 0, flag: 0, warn: 0, cached: 0, ms: [] }
    own.n++
    if (row.level === 'flag') own.flag++
    if (row.level === 'warn') own.warn++
    if (row.via === 'cache') own.cached++
    if (row.ms) own.ms.push(row.ms)
    kitChannels.set(row.channel, own)
  }

  /*
   * Benchmark numbers come from the **last run only**, not from the trial rows.
   * Accumulating trial rows mixes runs made against different corpora and different
   * wording — the first version of this report printed "jev: 1689/1822", which was a
   * blend of 14 runs and meant nothing. `bench.json` is what the last run actually
   * measured, and it also names the engines and the apply-ready table.
   */
  let lastBench = null
  try {
    lastBench = JSON.parse(fs.readFileSync(path.join(STORES.kit, 'bench.json'), 'utf8'))
  } catch { /* no run recorded yet */ }

  return {
    days,
    lens: {
      commands: commands.length,
      skipped: skipped.length,
      coverage: commands.length + skipped.length === 0 ? 1 : commands.length / (commands.length + skipped.length),
      skipReasons: [...skipReasons.entries()].sort((a, b) => b[1] - a[1]),
      screens: screens.length,
      screenFlagged: screens.filter(row => row.flagged === true).length,
      prefilterSkips: prefilterSkips.length,
      screenLatency: median(screens.map(row => row.ms ?? 0)),
      outcomes: outcomes.length,
      sessions: new Set(commands.map(row => row.session).filter(Boolean)).size,
    },
    kit: {
      decisions: decisions.length,
      cached: decisions.filter(row => row.via === 'cache').length,
      channels: [...kitChannels.entries()].sort((a, b) => b[1].n - a[1].n),
      benchRuns: byKind(kit, 'bench').length,
      lastBench: lastBench === null ? null : lastBench,
    },
    tokens: { lens: lensTokens, kit: kitTokens, total: inputTokens, usd: (inputTokens * 0.042) / 1e6 },
  }
}

function median (values) {
  const xs = values.filter(value => value > 0).sort((a, b) => a - b)
  return xs.length === 0 ? 0 : xs[Math.floor(xs.length / 2)]
}

function render (data) {
  const lines = [
    `**Jev 合账报告（最近 ${data.days} 天）**`,
    '',
    `判断总数 **${data.lens.commands + data.kit.decisions}** 次 · 估算输入 ${data.tokens.total} tok · 成本 ≈ **${usd(data.tokens.usd)}**`,
    `（自动 ${data.lens.commands} 次 · 按需 ${data.kit.decisions} 次；输出不计费，缓存命中 ${data.kit.cached} 次不发请求）`,
    '',
    '## 自动通道（dsh-jev-lens）',
  ]

  if (data.lens.commands + data.lens.skipped === 0) {
    lines.push('本窗口没有判定记录（lens 可能处于 `mode: off`，或刚装上）。')
  } else {
    lines.push(
      `- **判定覆盖 ${pct(data.lens.coverage)}**（判定 ${data.lens.commands} · 跳过 ${data.lens.skipped}）`,
      `- 配对结果 ${data.lens.outcomes} 条${data.lens.outcomes < 10 ? '（< 10，谈不上结论）' : ''} · 覆盖 ${data.lens.sessions} 个会话`,
      `- 抓取筛查 ${data.lens.screens} 次（命中 ${data.lens.screenFlagged}）· 规则前置省下 ${data.lens.prefilterSkips} 次请求 · 筛查 p50 ${data.lens.screenLatency}ms`,
    )
    if (data.lens.skipReasons.length) {
      lines.push('', '跳过原因（这是"仪器何时瞎了"的答案）：', '',
        '| 原因 | 次数 |', '|---|---|',
        ...data.lens.skipReasons.slice(0, 6).map(([reason, n]) => `| \`${reason}\` | ${n} |`))
    }
  }

  lines.push('', '## 按需通道（dsh-jev-kit）')
  if (data.kit.decisions === 0) {
    lines.push('本窗口没有被调用过——通道的价值只有在被调用时才兑现。（`/jev-kit scan` 与推送钩子是两个入口。）')
  } else {
    lines.push('', '| 通道 | 次数 | ⛔ | ⚠️ | 缓存 |', '|---|---|---|---|---|',
      ...data.kit.channels.map(([channel, own]) => `| \`${channel}\` | ${own.n} | ${own.flag} | ${own.warn} | ${own.cached} |`))
  }
  if (data.kit.lastBench) {
    const bench = data.kit.lastBench
    const when = new Date(bench.at).toISOString().slice(0, 16).replace('T', ' ')
    lines.push('', `**最近一轮基准**（${when}，${bench.fixtures} 条夹具，引擎 ${bench.engines.join(' + ')}）——只报这一轮，不累加历史（不同语料/措辞的轮次混在一起没有意义）：`)
    for (const fit of (bench.details ?? []).filter(row => row.trustworthy)) {
      lines.push(`  · \`${fit.channel}\` 现用 ${Number(fit.current).toFixed(2)} → 建议 ${Number(fit.recommended).toFixed(2)}（交叉验证 ${pct(fit.accuracyCrossVal)}，n=${fit.n}）`)
    }
    const applied = Object.keys(bench.thresholds ?? {})
    lines.push(applied.length ? `  · 应用就绪的阈值：${applied.map(c => `\`${c}\``).join(' · ')}` : '  · 本轮没有值得改动的阈值')
  } else if (data.kit.benchRuns) {
    lines.push('', `历史上有 ${data.kit.benchRuns} 轮基准，但没有找到 \`bench.json\`（清理过？）。`)
  }

  lines.push(
    '',
    '## 怎么读这份报告',
    '',
    '1. **先看覆盖率**：判定覆盖远低于 100% 时，"没问题"只是"没看见"。',
    '2. **再看按需通道有没有被用**：这里空着，说明工具存在但入口没进工作流。',
    '3. **最后看跳过原因**：key 被拒、熔断、预算都曾经在一天里让守卫停摆过。',
    '',
    '**没测出来 ≠ 没问题**：本报告的每个比例都只在有样本时才有意义。',
  )
  return lines.join('\n')
}

const data = collect(DAYS)
process.stdout.write(render(data) + '\n')
