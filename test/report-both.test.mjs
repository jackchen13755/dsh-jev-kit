/**
 * The combined report is a deliverable, so it gets a test rather than a hope.
 *
 * It runs the script against a synthetic `DSH_HOME` with two ledgers — the shape the
 * plugins actually write — and asserts the three things that make it useful: coverage
 * is stated, skip reasons are named, and the benchmark line reports the *last* run
 * instead of accumulating every run ever made.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'scripts', 'report-both.mjs')
const today = new Date().toISOString().slice(0, 10)

function withHome (rows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-both-'))
  const write = (store, lines) => {
    const dir = path.join(home, 'storages', store)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `ledger-${today}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  }
  write('dsh_jev_lens', rows.lens ?? [])
  write('dsh_jev_kit', rows.kit ?? [])
  if (rows.bench) {
    fs.writeFileSync(path.join(home, 'storages', 'dsh_jev_kit', 'bench.json'), JSON.stringify(rows.bench))
  }
  return home
}

const run = (home) => execFileSync(process.execPath, [script, '1'], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })

test('coverage and skip reasons lead the automatic half of the report', () => {
  const home = withHome({
    lens: [
      ...Array.from({ length: 30 }, (_, i) => ({ t: i, kind: 'command', p: 0.02, decision: 'allow', via: 'jev', session: 's1', inputTokens: 100 })),
      ...Array.from({ length: 10 }, (_, i) => ({ t: 100 + i, kind: 'degraded', where: 'command', reason: 'auth:rejected-403' })),
      { t: 200, kind: 'screen', tool: 'web_fetch', p: 0.9, flagged: true, chars: 9000, ms: 1200, via: 'jev', inputTokens: 2000 },
      { t: 201, kind: 'screen-skip', tool: 'web_fetch', chars: 4000, reason: 'prefilter:clean' },
    ],
    kit: [{ t: 300, kind: 'decision', channel: 'private_scan', group: 'P', level: 'flag', values: {}, via: 'jev', chars: 400, ms: 500 }],
  })
  const text = run(home)
  assert.match(text, /判定覆盖 75%/, 'coverage is stated before any verdict')
  assert.match(text, /auth:rejected-403/)
  assert.match(text, /规则前置省下 1 次请求/)
  assert.match(text, /`private_scan` \| 1 \| 1/, 'on-demand usage is listed per channel')
})

test('the benchmark line reports the last run, never an accumulation', () => {
  const home = withHome({
    kit: [
      // Trial rows from two different eras: accumulating them would print a blend.
      ...Array.from({ length: 50 }, (_, i) => ({ t: i, kind: 'trial', engine: 'laya', channel: 'flaky', fixture: `f${i}`, ok: false })),
    ],
    bench: {
      at: Date.now(), fixtures: 281, engines: ['jev'], thresholds: { risk: 0.42 },
      details: [{ channel: 'risk', current: 0.6, recommended: 0.42, accuracyNow: 0.86, accuracyFitted: 0.96, accuracyCrossVal: 0.96, n: 22, changes: true, separation: 0.95, trustworthy: true }],
      hashes: {},
    },
  })
  const text = run(home)
  assert.match(text, /最近一轮基准/)
  assert.match(text, /281 条夹具/)
  assert.match(text, /`risk` 现用 0\.60 → 建议 0\.42（交叉验证 96%，n=22）/)
  assert.doesNotMatch(text, /laya: \d+\/\d+/, 'stale trial rows must not be summed into a claim')
})

test('an empty window says so instead of implying health', () => {
  const home = withHome({ lens: [], kit: [] })
  const text = run(home)
  assert.match(text, /本窗口没有判定记录/)
  assert.match(text, /没测出来 ≠ 没问题/)
})
