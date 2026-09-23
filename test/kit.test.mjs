/**
 * Offline tests for the kit: the channel catalogue, the splitters, the ledger and
 * the settings. No network, no key, no host.
 *
 * The channel tests deliberately pin *polarity* — that a high probability on a
 * question means what the question's wording says it means — because that is the
 * bug class this project has already shipped once (a restorability question read
 * backwards turned a guard into its own opposite).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CHANNELS, CHANNEL_LIST, channelOf, DEFAULT_THRESHOLDS } from '../lib/channels.js'
import { isDiff, diffUnits, textUnits, hunksOf, unitsOf } from '../lib/segments.js'
import { append, load, summarize, render, verdictOf, MIN_SAMPLE } from '../lib/ledger.js'
import { KIT_DEFAULTS, merge, validate, loadStored, saveStored } from '../lib/settings.js'
import { trimState } from '../lib/engines.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-kit-'))

const answer = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [
  key,
  typeof value === 'number' ? { type: 'noul', noul: value } : { type: 'choice', choice: value },
]))

/* ── the catalogue ───────────────────────────────────────────────────── */

test('every channel is well formed and uniquely named', () => {
  const ids = CHANNEL_LIST.map(channel => channel.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  for (const channel of CHANNEL_LIST) {
    assert.match(channel.id, /^[a-z][a-z0-9_]*$/, `${channel.id} is snake_case`)
    assert.ok(['P', 'A', 'B', 'C', 'D'].includes(channel.group), `${channel.id} has a known group`)
    assert.ok(channel.title.length > 3, `${channel.id} has a title`)
    assert.ok(channel.intent.length > 10, `${channel.id} says what it replaces`)
    assert.ok(channel.questions({ text: 'x', task: 'y', candidates: ['a'] }).constructor === Object)
  }
  // The catalogue is the product: if it shrinks, that is a decision, not an accident.
  assert.ok(CHANNEL_LIST.length >= 23, `expected a full catalogue, got ${CHANNEL_LIST.length}`)
  for (const group of ['P', 'A', 'B', 'C', 'D']) {
    assert.ok(CHANNEL_LIST.some(channel => channel.group === group), `group ${group} is populated`)
  }
})

test('channel ids tolerate - and _ spelling drift', () => {
  assert.equal(channelOf('private-scan')?.id, 'private_scan')
  assert.equal(channelOf(' PRIVATE_SCAN ')?.id, 'private_scan')
  assert.equal(channelOf('nope'), undefined)
})

test('every backticked name in a question is a field the caller actually sends', () => {
  /*
   * The wording is the calibration, and a question that names a field the payload
   * does not contain makes the model guess which string it means — a live call
   * still answered correctly by luck, which is exactly why this is asserted rather
   * than eyeballed. The canonical vocabulary is the whole ChannelState surface the
   * tools populate.
   */
  const canonical = new Set(['text', 'task', 'other', 'candidates', 'requirements', 'candidateNoun', 'extra'])
  for (const channel of CHANNEL_LIST) {
    const questions = channel.questions({ text: 'TEXT', task: 'TASK', other: 'OTHER', candidates: ['CAND'], requirements: ['REQ'], candidateNoun: 'thing' })
    const serialized = JSON.stringify(questions)
    const named = [...serialized.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map(match => match[1])
    assert.ok(named.length > 0, `${channel.id} should name the field it judges`)
    for (const name of new Set(named)) {
      assert.ok(canonical.has(name), `${channel.id} names \`${name}\`, which no tool ever sends (canonical: ${[...canonical].join(', ')})`)
    }
  }
})

/* ── polarity, the bug class we already shipped once ─────────────────── */

test('private_scan flags a secret and stays quiet on placeholders', () => {
  const read = (values) => CHANNELS.private_scan.read(answer(values), { text: 'x' })
  const dirty = read({ secret: 0.97, personal: 0.8, internal: 0.1 })
  assert.equal(dirty.level, 'flag')
  assert.match(dirty.headline, /凭据|个人信息/)
  const clean = read({ secret: 0.04, personal: 0.03, internal: 0.02 })
  assert.equal(clean.level, 'info')
  assert.match(clean.headline, /未发现/)
})

test('scope_check treats a low in_scope as out of scope', () => {
  const read = (values) => CHANNELS.scope_check.read(answer(values), { text: 'h' })
  assert.equal(read({ in_scope: 0.1, necessary: 0.1 }).level, 'flag')
  /*
   * `necessary` must NOT drive the level: measured live, it scored 0.20 on the
   * change the task explicitly asked for, which would have made a correct verdict
   * amber. Only in_scope decides.
   */
  assert.equal(read({ in_scope: 0.83, necessary: 0.2 }).level, 'info')
  assert.equal(read({ in_scope: 0.9, necessary: 0.9 }).level, 'info')
  assert.match(read({ in_scope: 0.9, necessary: 0.1 }).details[0], /不参与判定/)
})

test('sufficient only says stop when coverage is high AND nothing is missing', () => {
  const read = (values) => CHANNELS.sufficient.read(answer(values), {})
  assert.equal(read({ answers: 0.95, missing: 0.05 }).level, 'ok')
  // High coverage with a missing piece is not "done" — the polarity that matters.
  assert.equal(read({ answers: 0.95, missing: 0.9 }).level, 'info')
  assert.equal(read({ answers: 0.4, missing: 0.1 }).level, 'info')
})

test('memory_write only keeps something when it is durable and has a track', () => {
  const read = (values) => CHANNELS.memory_write.read(answer(values), {})
  assert.equal(read({ worth: 0.9, track: 'pitfall', reusable: 0.8 }).level, 'info')
  assert.match(read({ worth: 0.9, track: 'pitfall', reusable: 0.8 }).headline, /建议记住（pitfall）/)
  assert.match(read({ worth: 0.9, track: 'none', reusable: 0.9 }).headline, /建议不记/)
  assert.match(read({ worth: 0.1, track: 'rule', reusable: 0.1 }).headline, /建议不记/)
})

test('pick surfaces the no-match escape instead of forcing a bad answer', () => {
  const state = { candidates: ['alpha component', 'beta component'], candidateNoun: 'component' }
  const questions = CHANNELS.pick.questions(state)
  assert.ok(Object.keys(questions.best.criteria).includes('none_of_these'))
  const chosen = CHANNELS.pick.read(answer({ best: 'c1' }), state)
  assert.match(chosen.headline, /beta component/)
  const none = CHANNELS.pick.read(answer({ best: 'none_of_these' }), state)
  assert.equal(none.level, 'warn')
  // An answer naming a candidate that does not exist must not invent one.
  assert.match(CHANNELS.pick.read(answer({ best: 'c9' }), state).headline, /没有合适/)
})

test('ranking channels sort but never threshold', () => {
  assert.equal(DEFAULT_THRESHOLDS.rank, 0)
  assert.equal(DEFAULT_THRESHOLDS.recall_rerank, 0)
  assert.equal(CHANNELS.rank.read(answer({ relevance: 5 }), {}).level, 'info')
})

test('a missing answer is reported as unanswered, never as a negative', () => {
  const verdict = CHANNELS.private_scan.read(answer({ personal: 0.9 }), { text: 'x' })
  assert.equal(verdict.values.secret, undefined)
  assert.ok((verdict.details ?? []).some(line => line.includes('未作答')))
  assert.equal(verdict.level, 'flag') // the one answered positive still counts
})

test('retry stops on a deterministic failure and allows one more try on a transient one', () => {
  const read = (values) => CHANNELS.retry.read(answer(values), {})
  assert.match(read({ plausible: 0.9, deterministic: 0.05 }).headline, /可以再试一次/)
  assert.match(read({ plausible: 0.1, deterministic: 0.9 }).headline, /别重试/)
  // Plausible on its own is not enough: a visible deterministic cause still stops.
  assert.match(read({ plausible: 0.8, deterministic: 0.8 }).headline, /别重试/)
})

test('i18n_key prefers reusing an existing key over adding a synonym', () => {
  const state = { candidates: ['profile.email.label: 邮箱', 'profile.email.invalid: 请输入有效的邮箱地址'] }
  const reuse = CHANNELS.i18n_key.read(answer({ reuse: 'k1', consistent: 0.9 }), state)
  assert.equal(reuse.level, 'warn')
  assert.match(reuse.headline, /已有同义 key/)
  assert.match(reuse.headline, /profile\.email\.invalid/)
  const fresh = CHANNELS.i18n_key.read(answer({ reuse: 'none', consistent: 0.9 }), state)
  assert.equal(fresh.level, 'info')
  // New key but a second way of saying the same thing: warn, do not block.
  const off = CHANNELS.i18n_key.read(answer({ reuse: 'none', consistent: 0.2 }), state)
  assert.equal(off.level, 'warn')
  assert.match(off.headline, /术语/)
})

test('state trimming caps tokens, marks the cut, and leaves short states alone', () => {
  const long = 'x'.repeat(1000)
  const trimmed = trimState({ text: long, task: 'short', candidates: ['a', 'b', 'c', 'd'], nested: 7 }, { maxChars: 100, maxItems: 2 })
  assert.match(String(trimmed.state.text), /^x{100}…\[truncated 900 chars\]$/, 'the cut is announced, not silent')
  assert.equal(trimmed.state.task, 'short', 'short values are untouched')
  assert.deepEqual(trimmed.state.candidates, ['a', 'b'], 'arrays are capped')
  assert.equal(trimmed.state.nested, 7)
  assert.ok(trimmed.trimmed >= 2)
  // 0 disables both limits, and an untouched state is returned as-is.
  assert.equal(trimState({ text: long }, { maxChars: 0, maxItems: 0 }).trimmed, 0)
  assert.equal(trimState({ text: long }, { maxChars: 0, maxItems: 0 }).state.text, long)
})

/* ── splitters ───────────────────────────────────────────────────────── */

const SAMPLE_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 111..222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,5 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+// NOTE: staging db password is hunter2',
  ' export { a, b }',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -10,2 +10,3 @@',
  ' title',
  '+contact: someone@example.internal',
].join('\n')

test('a diff is recognised, and only added lines are scanned', () => {
  assert.equal(isDiff(SAMPLE_DIFF), true)
  assert.equal(isDiff('just some prose\n\nwith paragraphs'), false)
  const units = diffUnits(SAMPLE_DIFF, 12, 40)
  const joined = units.map(unit => unit.text).join('\n')
  assert.ok(joined.includes('hunter2'), 'the added secret is scanned')
  assert.ok(!joined.includes('const a = 1'), 'context lines are not scanned')
  assert.ok(!joined.includes('-const b = 2'), 'removed lines are not scanned')
  assert.ok(units.every(unit => unit.text.startsWith('# ')), 'each unit says which file it came from')
  assert.ok(units.some(unit => unit.where.startsWith('src/app.ts')), 'the unit carries file:line provenance')
})

test('long added runs are grouped, not flooded', () => {
  const many = ['+++ b/big.ts', '@@ -1 +1 @@', ...Array.from({ length: 100 }, (_, i) => `+line ${i}`)].join('\n')
  const units = diffUnits(many, 12, 40)
  assert.ok(units.length <= 40, 'the cap holds')
  assert.ok(units.length >= 8, 'and it still groups a dozen lines at a time')
  assert.ok(units.every(unit => unit.text.split('\n').length <= 13), 'a unit is one run plus its header')
})

test('prose units drop blocks too short to judge and cap the rest', () => {
  const prose = ['short', '', 'This paragraph is comfortably long enough to be worth judging.', '', 'x'.repeat(4000)].join('\n\n')
  const units = textUnits(prose, 40, 24)
  assert.equal(units.length, 2, 'the eleven-character block is skipped')
  assert.ok(units.every(unit => unit.text.length <= 1500), 'each unit is bounded')
  assert.equal(unitsOf(prose).length, 2)
})

test('hunks keep their header, which is what makes the judgment possible', () => {
  const hunks = hunksOf(SAMPLE_DIFF, 40)
  assert.equal(hunks.length, 2)
  assert.ok(hunks[0].text.includes('@@ -1,3 +1,5 @@'), 'the hunk header survives')
  assert.match(hunks[0].text, /src\/app\.ts/)
  assert.match(hunks[1].text, /README\.md/)
  /*
   * Prose is not a change: a scope check over paragraphs would manufacture
   * verdicts about text nobody proposed changing. No hunks, and the tool says
   * exactly that rather than judging something else.
   */
  assert.deepEqual(hunksOf('plain text\nmore text'), [])
  // A header-less list of added lines still yields runs, because that *is* a change.
  assert.equal(hunksOf('+one\n+two\n-three').length, 1)
})

/* ── ledger + settings ───────────────────────────────────────────────── */

test('the report names which entry point produced the judgments', () => {
  /*
   * Why this matters more than any per-channel number: on 2026-09-23, 593 of 608
   * judgments came from a single entry (the push hook) while 22 channels sat at
   * zero. Without an entry column the ledger cannot tell "unused channel" from
   * "unwired channel" — and only the second is worth building.
   */
  const dir = tmp()
  const now = Date.now()
  append(dir, { t: now, kind: 'decision', channel: 'private_scan', group: 'P', level: 'flag', values: {}, via: 'jev', chars: 10, ms: 500, session: 'hook' })
  append(dir, { t: now + 1, kind: 'decision', channel: 'private_scan', group: 'P', level: 'info', values: {}, via: 'jev', chars: 10, ms: 500, session: 'hook' })
  append(dir, { t: now + 2, kind: 'decision', channel: 'log_triage', group: 'C', level: 'info', values: {}, via: 'jev', chars: 10, ms: 500, session: 'session-abc' })
  const report = summarize(load(dir, 1, new Date(now)), 1)
  assert.deepEqual(report.byEntry[0], { entry: 'hook', n: 2, flag: 1 })
  assert.equal(report.byEntry[1].entry, 'session-abc')
  const text = render(report)
  assert.match(text, /按入口/)
  assert.match(text, /`hook`×2\(⛔1\)/)
  assert.match(text, /没有入口的通道永远是 0/)
})

test('the ledger groups by channel and never counts a failure as neutral', () => {
  const dir = tmp()
  const now = Date.now()
  append(dir, { t: now, kind: 'decision', channel: 'private_scan', group: 'P', level: 'flag', values: { secret: 0.9 }, via: 'jev', ms: 500, chars: 100 })
  append(dir, { t: now + 1, kind: 'decision', channel: 'private_scan', group: 'P', level: 'info', values: { secret: 0.01 }, via: 'cache', chars: 100 })
  append(dir, { t: now + 2, kind: 'decision', channel: 'log_triage', group: 'C', level: 'ok', values: {}, via: 'jev', ms: 400, chars: 50 })
  append(dir, { t: now + 3, kind: 'error', channel: 'log_triage', message: 'Jev unavailable' })
  const report = summarize(load(dir, 1, new Date(now)), 1)
  assert.equal(report.total, 3)
  const scan = report.channels.find(channel => channel.channel === 'private_scan')
  assert.equal(scan.n, 2)
  assert.equal(scan.flagged, 1)
  assert.equal(scan.cached, 1)
  assert.equal(report.health.errors, 1)
  assert.match(render(report), /private_scan/)
  assert.match(render(report), /淘汰通道/)
})

test('settings reject out-of-range values and ignore unusable patches', () => {
  assert.equal(validate(KIT_DEFAULTS), undefined)
  assert.match(String(validate({ ...KIT_DEFAULTS, maxItems: 10_000 })), /maxItems 必须在 1–500/)
  assert.match(String(validate({ ...KIT_DEFAULTS, apiKeyRef: 'not a ref' })), /apiKeyRef/)
  const merged = merge(KIT_DEFAULTS, { maxItems: 12, concurrency: 'lots', redactExtra: ['x', 3], nope: true })
  assert.equal(merged.maxItems, 12)
  assert.equal(merged.concurrency, KIT_DEFAULTS.concurrency)
  assert.deepEqual(merged.redactExtra, ['x'])
  assert.equal(merged.nope, undefined)
})

test('settings round-trip through storage and survive corruption', () => {
  const dir = tmp()
  assert.equal(loadStored(dir), undefined)
  assert.equal(saveStored(dir, { ...KIT_DEFAULTS, maxItems: 7 }), true)
  assert.equal(loadStored(dir)?.maxItems, 7)
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600)
  fs.writeFileSync(path.join(dir, 'config.json'), '{ broken')
  assert.equal(loadStored(dir), undefined)
})
