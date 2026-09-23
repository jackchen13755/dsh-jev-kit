/**
 * Offline tests for the cross-engine benchmark: fixture integrity, the scoring
 * maths, and the rule that an unreachable engine is reported, never assumed.
 *
 * The fixtures carry ground truth that a human would agree with ("this text does
 * contain a live-looking connection string"). These tests exist to keep that
 * property: a fixture without a stated truth, or one whose expectation names a
 * field its channel never produces, would silently turn the benchmark into a
 * measurement of nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { COMMAND_FIXTURES, FIXTURES, check, fitThresholds, fittedTable, questionHash, questionsFor, renderBench, separation, setThresholdOverrides, summarizeEngine, thresholdOf, verdictFor, wordingDrift } from '../lib/bench.js'
import { CHANNEL_LIST, channelOf } from '../lib/channels.js'
import { selectEngines } from '../lib/engines.js'
import { percentiles } from '@dsh-external/dsh-jev-core'

test('every fixture states its ground truth and names a real channel', () => {
  const ids = FIXTURES.map(fixture => fixture.id)
  assert.equal(new Set(ids).size, ids.length, 'fixture ids are unique')
  for (const fixture of FIXTURES) {
    // Either it names a real channel, or it brings its own questions (`-` + questions).
    assert.ok(channelOf(fixture.channel) || fixture.questions, `${fixture.id} must name a channel or supply its own questions`)
    // Short is fine ("删表" states the truth); empty or vague is not.
    assert.ok(fixture.truth.trim().length >= 2, `${fixture.id} must state what is true about the input`)
    assert.ok(Object.keys(questionsFor(fixture).questions).length > 0, `${fixture.id} must produce at least one question`)
  }
  assert.ok(COMMAND_FIXTURES.length >= 10, 'the auto-channel wording needs a real command set')
  assert.equal(COMMAND_FIXTURES.filter(fixture => fixture.expect.kind === 'high').length,
    COMMAND_FIXTURES.filter(fixture => fixture.expect.kind === 'low').length, 'dangerous and safe commands in balance')
  // Separation is only computable where a channel has both a high and a low case.
  const byChannel = new Map()
  for (const fixture of FIXTURES) {
    if (fixture.expect.kind === 'choice') continue
    const sides = byChannel.get(fixture.channel) ?? new Set()
    sides.add(fixture.expect.kind)
    byChannel.set(fixture.channel, sides)
  }
  const comparable = [...byChannel.values()].filter(sides => sides.size === 2).length
  assert.ok(comparable >= 5, `expected several channels to be comparable, got ${comparable}`)
  // The catalogue as a whole stays covered: a channel with no fixtures is unmeasured.
  const covered = new Set(FIXTURES.map(fixture => fixture.channel))
  assert.ok(covered.size >= 8, `fixtures should touch the catalogue broadly, got ${covered.size}/${CHANNEL_LIST.length}`)
})

test('every fixture scores a field its channel actually publishes', () => {
  /*
   * The failure this guards against is subtle and was made once already: a
   * fixture named the *question* key (`answers`) while the channel publishes that
   * reading under a different name in its verdict (`covered`). The score then read
   * "unanswered" for a channel that had answered perfectly — a benchmark bug that
   * looks exactly like a model failure.
   */
  for (const channel of CHANNEL_LIST) {
    const own = FIXTURES.filter(fixture => fixture.channel === channel.id)
    // Raw-question fixtures are checked by construction below, not by channel reader.
    if (!own.length) continue
    const questions = channel.questions({ text: 'TEXT', task: 'TASK', other: 'OTHER', candidates: ['C1', 'C2'], requirements: ['R1'], candidateNoun: 'thing' })
    // A synthetic answer for every question, in the shape the reader expects.
    const answers = {}
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === 'noul') answers[key] = { type: 'noul', noul: 0.5 }
      else if (question.type === 'choice') answers[key] = { type: 'choice', choice: Object.keys(question.criteria)[0] }
      else answers[key] = { type: 'score', score: 3 }
    }
    const published = new Set(Object.keys(channel.read(answers, { text: 'T', candidates: ['C1', 'C2'] }).values))
    for (const fixture of own) {
      assert.ok(published.has(fixture.expect.field),
        `${fixture.id} scores \`${fixture.expect.field}\`, but ${channel.id} publishes only: ${[...published].join(', ')}`)
    }
  }
})

test('composed fixtures contain what they claim, at runtime', () => {
  /*
   * A fixture that compiles can still be garbage: a Python-style `%s` inside a
   * TypeScript string evaluates to NaN at runtime, which would have made one
   * privacy case a test of nothing. Assert the value, not the syntax.
   */
  const pem = FIXTURES.find(fixture => fixture.id.startsWith('priv_secret_') && String(fixture.state.text).includes('PRIVATE KEY'))
  assert.ok(pem, 'a private-key fixture exists')
  const text = String(pem.state.text)
  assert.match(text, /-----BEGIN RSA PRIVATE KEY-----\n[A-Za-z0-9+/=]{20,}\n-----END RSA PRIVATE KEY-----/, 'the PEM block has a body')
  assert.doesNotMatch(text, /NaN|%s|undefined/, 'no formatting leftovers')
  for (const fixture of FIXTURES) {
    assert.doesNotMatch(String(fixture.state.text ?? ''), /NaN|%s\b/, `${fixture.id} has no formatting leftovers`)
  }
})

test('separation is threshold-free and counts ties as half', () => {
  assert.equal(separation([0.9], [0.1]), 1)
  assert.equal(separation([0.1], [0.9]), 0)
  assert.equal(separation([0.5], [0.5]), 0.5)
  assert.equal(separation([0.9, 0.8], [0.2, 0.1]), 1)
  assert.equal(separation([0.9, 0.1], [0.2, 0.8]), 0.5)
  // No one-sided comparison is not "perfect": it is undefined.
  assert.equal(separation([0.9], []), undefined)
  assert.equal(separation([], [0.1]), undefined)
})

test('check honours the three expectation shapes', () => {
  const high = FIXTURES.find(fixture => fixture.expect.kind === 'high')
  const low = FIXTURES.find(fixture => fixture.expect.kind === 'low')
  const choice = FIXTURES.find(fixture => fixture.expect.kind === 'choice')
  assert.equal(check(high, { level: 'flag', headline: '', values: { [high.expect.field]: 0.9 } }).ok, true)
  assert.equal(check(high, { level: 'info', headline: '', values: { [high.expect.field]: 0.2 } }).ok, false)
  assert.equal(check(low, { level: 'info', headline: '', values: { [low.expect.field]: 0.1 } }).ok, true)
  assert.equal(check(choice, { level: 'info', headline: '', values: { [choice.expect.field]: choice.expect.equals } }).ok, true)
  assert.equal(check(choice, { level: 'info', headline: '', values: { [choice.expect.field]: 'something-else' } }).ok, false)
  // An unanswered question is a failure, never a pass.
  assert.equal(check(high, { level: 'info', headline: '', values: {} }).ok, false)
})

test('a canned answer set produces the verdict the channel would produce live', () => {
  const fixture = FIXTURES.find(item => item.id === 'private_dirty')
  const verdict = verdictFor(fixture, {
    secret: { type: 'noul', noul: 0.9 },
    personal: { type: 'noul', noul: 0.7 },
    internal: { type: 'noul', noul: 0.8 },
  })
  assert.equal(verdict.level, 'flag')
  assert.equal(check(fixture, verdict).ok, true)
})

test('wording drift is detected from the recorded fingerprints, and only for questions', () => {
  /*
   * The gate that protects the calibration: a threshold measured against one wording
   * is not a threshold for another. It must fire when a *question* changes and stay
   * quiet for anything else — a title tweak is not a reason to re-fit, and a check
   * that fires on everything gets ignored.
   */
  const record = { at: Date.now(), fixtures: 1, engines: ['jev'], thresholds: {}, details: [], hashes: { private_scan: 'deadbeef00', risk: 'cafebabe00' } }
  const current = { private_scan: 'deadbeef00', risk: '0123456789' }
  assert.deepEqual(wordingDrift(record, current), ['risk'], 'only the channel whose questions moved')
  assert.deepEqual(wordingDrift(record, { ...current, risk: 'cafebabe00' }), [], 'identical fingerprints are not drift')
  assert.deepEqual(wordingDrift(undefined, current), [], 'no recorded run means nothing to compare')
  // The fingerprint itself must be stable across calls and distinct per channel.
  assert.equal(questionHash('risk'), questionHash('risk'))
  assert.notEqual(questionHash('risk'), questionHash('scope_check'))
  assert.match(questionHash('private_scan'), /^[0-9a-f]{10}$/)
})

test('a perfectly separated channel gets the midpoint, not the edge of the grid', () => {
  /*
   * The regression that shipped a false-positive storm: with clean fixtures at
   * 0.02–0.05 and dirty ones at 0.90+, every cut between the clusters is equally
   * accurate, so "first best wins" returned the lowest grid point — `private_scan`
   * came out at 0.04, which flags ordinary source code as leaked credentials.
   *
   * A cut in the middle of the gap is exactly as accurate and far more robust.
   */
  const fixtures = [
    { id: 'a', channel: 'private_scan', truth: 'clean', expect: { kind: 'low', field: 'x' }, state: { text: 'a' } },
    { id: 'b', channel: 'private_scan', truth: 'clean', expect: { kind: 'low', field: 'x' }, state: { text: 'b' } },
    { id: 'c', channel: 'private_scan', truth: 'dirty', expect: { kind: 'high', field: 'x' }, state: { text: 'c' } },
    { id: 'd', channel: 'private_scan', truth: 'dirty', expect: { kind: 'high', field: 'x' }, state: { text: 'd' } },
  ]
  const trials = [
    { fixture: 'a', channel: 'private_scan', engine: 'jev', ok: true, value: 0.02, level: 'info' },
    { fixture: 'b', channel: 'private_scan', engine: 'jev', ok: true, value: 0.05, level: 'info' },
    { fixture: 'c', channel: 'private_scan', engine: 'jev', ok: true, value: 0.90, level: 'flag' },
    { fixture: 'd', channel: 'private_scan', engine: 'jev', ok: true, value: 0.95, level: 'flag' },
  ]
  const report = summarizeEngine('jev', 'Jev', fixtures, trials, percentiles)
  const fit = report.thresholds.find(row => row.channel === 'private_scan')
  assert.equal(fit.recommendedBy, 'margin')
  assert.equal(fit.recommended, 0.48, 'midpoint of 0.05 and 0.90, rounded to 2dp')
  assert.ok(fit.recommended > 0.4, 'never a knife-edge cut')
  assert.equal(Number(fit.margin.toFixed(2)), 0.85)
})

test('an unreachable engine is reported as unavailable, not as passing', () => {
  const trials = [{ fixture: '(probe)', channel: '-', engine: 'laya', ok: false, error: 'unavailable: Laya (local, http://127.0.0.1:8791)' }]
  const report = summarizeEngine('laya', 'Laya', FIXTURES, trials, percentiles)
  assert.equal(report.status, 'unavailable')
  assert.equal(report.pass, 0)
  assert.equal(report.total, FIXTURES.length, 'the denominator stays the whole suite')
  const text = renderBench([report], FIXTURES)
  assert.match(text, /不可用/)
  assert.match(text, /不计为通过/)
  assert.doesNotMatch(text, /\| .* \| 0\/0 \|/) // no fabricated per-channel rows
})

test('the corpus fits its own threshold when the hand-picked cut is in the wrong place', () => {
  // Ordering is perfect, but every value sits far above the 0.5 cut assumed for
  // "low" cases: the channel is not wrong, its threshold is.
  const fixtures = [
    ...[0.91, 0.88].map((_, i) => ({ id: `hi${i}`, channel: 'risk', truth: 't', expect: { kind: 'high', field: 'irreversible' }, state: {} })),
    ...[0.72, 0.68, 0.61].map((_, i) => ({ id: `lo${i}`, channel: 'risk', truth: 't', expect: { kind: 'low', field: 'irreversible' }, state: {} })),
  ]
  const trials = [
    ...[0.91, 0.88].map((value, i) => ({ fixture: `hi${i}`, channel: 'risk', engine: 'x', ok: value >= 0.5, value })),
    ...[0.72, 0.68, 0.61].map((value, i) => ({ fixture: `lo${i}`, channel: 'risk', engine: 'x', ok: value < 0.5, value })),
  ]
  const [fit] = fitThresholds(fixtures, trials, { risk: 0.5 })
  assert.equal(fit.current, 0.5)
  assert.ok(fit.recommended > 0.72 && fit.recommended <= 0.88, `recommended cut between the groups, got ${fit.recommended}`)
  assert.equal(fit.accuracyNow, 0.4, 'the assumed cut gets two of five right')
  assert.equal(fit.accuracyFitted, 1, 'the fitted cut gets all five')
  assert.equal(fit.changes, true)
  assert.equal(fit.separation, 1, 'perfectly ordered groups')
  assert.equal(fit.trustworthy, true, 'a well-separated channel may be re-cut')
  // A channel with one side only cannot be fitted, and says nothing rather than guessing.
  assert.deepEqual(fitThresholds([fixtures[0]], [trials[0]], { risk: 0.5 }), [])
  // Interleaved groups: a cut can always be found that fits *this* corpus, which is
  // exactly why a low-separation fit is reported as untrustworthy rather than offered.
  const noisy = [
    ...[0.9, 0.1].map((_, i) => ({ id: `nhi${i}`, channel: 'flaky', truth: 't', expect: { kind: 'high', field: 'flaky' }, state: {} })),
    ...[0.8, 0.2].map((_, i) => ({ id: `nlo${i}`, channel: 'flaky', truth: 't', expect: { kind: 'low', field: 'flaky' }, state: {} })),
  ]
  const noisyTrials = [
    ...[0.9, 0.1].map((value, i) => ({ fixture: `nhi${i}`, channel: 'flaky', engine: 'x', ok: false, value })),
    ...[0.8, 0.2].map((value, i) => ({ fixture: `nlo${i}`, channel: 'flaky', engine: 'x', ok: false, value })),
  ]
  const [noisyFit] = fitThresholds(noisy, noisyTrials, { flaky: 0.6 })
  assert.equal(noisyFit.separation, 0.5, 'interleaved: chance')
  assert.equal(noisyFit.trustworthy, false, 'a chance-level channel must not be re-cut')
})

test('a fitted table can actually be applied, and only sane values survive', () => {
  const fixture = FIXTURES.find(item => item.channel === 'private_scan' && item.expect.kind === 'high')
  const verdict = { level: 'info', headline: '', values: { [fixture.expect.field]: 0.3 } }
  try {
    setThresholdOverrides(undefined)
    assert.equal(thresholdOf('private_scan'), 0.5, 'declared default when nothing is applied')
    assert.equal(check(fixture, verdict).ok, false, 'a 0.3 reading misses a 0.5 cut')
    // The corpus fitted 0.15 for this channel; applying it changes the decision.
    setThresholdOverrides({ private_scan: 0.15 })
    assert.equal(thresholdOf('private_scan'), 0.15)
    assert.equal(check(fixture, verdict).ok, true, 'the applied cut is what judges')
    // Garbage is dropped rather than silently narrowing every decision.
    setThresholdOverrides({ private_scan: 1.7, risk: Number.NaN, flaky: 0.4 })
    assert.equal(thresholdOf('private_scan'), 0.5, 'out-of-range value ignored')
    assert.equal(thresholdOf('risk'), 0.6, 'NaN ignored')
    assert.equal(thresholdOf('flaky'), 0.4)
    assert.deepEqual(fittedTable([
      { channel: 'a', current: 0.5, recommended: 0.2, accuracyNow: 0.8, accuracyFitted: 1, accuracyCrossVal: 0.95, n: 40, changes: true, separation: 1, trustworthy: true },
      { channel: 'b', current: 0.5, recommended: 0.9, accuracyNow: 0.5, accuracyFitted: 0.9, accuracyCrossVal: 0.5, n: 8, changes: true, separation: 0.4, trustworthy: false },
    ]), { a: 0.2 }, 'only trustworthy, changing fits are offered for application')
  } finally {
    setThresholdOverrides(undefined)
  }
})

test('an unknown engine id surfaces instead of being silently dropped', () => {
  const known = [{ id: 'jev' }, { id: 'laya' }]
  const picked = selectEngines(['jev', 'laya', 'nope'], known)
  assert.deepEqual(picked.engines.map(engine => engine.id), ['jev', 'laya'])
  assert.deepEqual(picked.unknown, ['nope'])
  assert.deepEqual(selectEngines(['  JEV '], known).engines.map(engine => engine.id), ['jev'], 'case and space tolerant')
})
