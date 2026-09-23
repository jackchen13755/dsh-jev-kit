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

import { FIXTURES, separation, check, questionsFor, verdictFor, summarizeEngine, renderBench } from '../lib/bench.js'
import { CHANNEL_LIST, channelOf } from '../lib/channels.js'
import { selectEngines } from '../lib/engines.js'
import { percentiles } from '../lib/resilience.js'

test('every fixture states its ground truth and names a real channel', () => {
  const ids = FIXTURES.map(fixture => fixture.id)
  assert.equal(new Set(ids).size, ids.length, 'fixture ids are unique')
  for (const fixture of FIXTURES) {
    assert.ok(channelOf(fixture.channel), `${fixture.id} names a known channel`)
    assert.ok(fixture.truth.length > 6, `${fixture.id} must state what is true about the input`)
    assert.ok(Object.keys(questionsFor(fixture).questions).length > 0, `${fixture.id} must produce at least one question`)
  }
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

test('an unknown engine id surfaces instead of being silently dropped', () => {
  const known = [{ id: 'jev' }, { id: 'laya' }]
  const picked = selectEngines(['jev', 'laya', 'nope'], known)
  assert.deepEqual(picked.engines.map(engine => engine.id), ['jev', 'laya'])
  assert.deepEqual(picked.unknown, ['nope'])
  assert.deepEqual(selectEngines(['  JEV '], known).engines.map(engine => engine.id), ['jev'], 'case and space tolerant')
})
