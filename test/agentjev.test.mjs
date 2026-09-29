/**
 * Offline tests for the local AgentJev-0.6B engine and the per-engine cut table.
 *
 * No network, no key, no host: the AgentJev server is stood up here as a stub that
 * speaks its published contract, which is the point of the test — the engine's job is
 * *translation*, and a translation tested against the kit's own shape would pass
 * while the real server rejected every request.
 *
 * Why these tests exist at all: the kit now reads answers from two engines whose
 * probabilities are not on the same scale (`retry` cuts at 0.16 locally, 0.60 hosted).
 * Reading a local answer with the hosted cut is the false-positive storm this project
 * already shipped once, so both the translation and the per-engine cut table are
 * pinned here rather than left to the first live call.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { agentJevEngine, fromAgentJevAnswers, toAgentJevQuestions } from '../lib/engines.js'
import { readerThresholds, withReaderThresholds, readerThreshold } from '../lib/channels.js'
import { KIT_DEFAULTS, merge, validate } from '../lib/settings.js'

const QUESTIONS = {
  irreversible: { type: 'noul', instructions: 'Would it be irreversible?', criteria: { true: 'yes it is', false: 'no it is not' } },
  next: { type: 'choice', instructions: 'What next?', criteria: { read: 'read the test', write: 'rewrite it' } },
  severity: { type: 'score', instructions: 'How bad?', criteria: ['none', 'mild', 'bad', 'severe'] },
}

const ANSWER = {
  api_version: 'agentjev.decision.v1',
  results: [{ id: '0', answers: [
    { id: 'irreversible', type: 'boolean', probability: 0.75, value: true, distribution: { true: 0.75, false: 0.25 } },
    { id: 'next', type: 'choice', value: 'read', top_probability: 0.6, margin: 0.2, distribution: { read: 0.6, write: 0.4 } },
    { id: 'severity', type: 'score', score: 1.8, level: 2, legend: ['none', 'mild', 'bad', 'severe'], distribution: { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4 } },
  ] }],
  usage: { questions: 3, candidate_paths: 8, generated_tokens: 0, wall_ms: 462.2 },
}

/** A stub that records what it was sent, so the wire shape is asserted, not assumed. */
async function stub (handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined
      seen.push({ method: req.method, url: req.url, body: parsed })
      handler(req, res, parsed)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { seen, endpoint: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

const json = (res, status, value) => {
  const payload = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

/* ── the translation ─────────────────────────────────────────────────── */

test('the kit\'s questions become AgentJev\'s own three shapes', () => {
  const wire = toAgentJevQuestions(QUESTIONS)
  assert.deepEqual(wire.map(item => item.type), ['boolean', 'choice', 'score'])
  assert.deepEqual(wire.map(item => item.id), ['irreversible', 'next', 'severity'])
  // `noul` keeps its two criteria; `choice` sends them as `options`; `score` as `levels`.
  assert.deepEqual(wire[0].criteria, { true: 'yes it is', false: 'no it is not' })
  assert.deepEqual(wire[1].options, { read: 'read the test', write: 'rewrite it' })
  assert.deepEqual(wire[2].levels, ['none', 'mild', 'bad', 'severe'])
  for (const item of wire) assert.equal(item.instructions.length > 0, true, 'the wording travels')
})

test('AgentJev\'s answers normalise back into the kit\'s shape', () => {
  const { answers, ms } = fromAgentJevAnswers(ANSWER)
  assert.equal(answers.irreversible.noul, 0.75)
  assert.equal(answers.irreversible.type, 'noul')
  assert.equal(answers.next.choice, 'read')
  assert.equal(answers.severity.score, 1.8)
  // The distribution survives, so a reader can show it rather than only its argmax.
  assert.deepEqual(answers.next.probabilities, { read: 0.6, write: 0.4 })
  assert.equal(ms, 462.2)
})

test('a response without answers is an error, not an empty verdict set', () => {
  // "Nothing to flag" and "the model never answered" must not be the same object.
  assert.throws(() => fromAgentJevAnswers({ results: [] }), /no `results\[\]\.answers`/)
  assert.throws(() => fromAgentJevAnswers({ results: [{ answers: [] }] }), /no usable answers/)
  assert.throws(() => fromAgentJevAnswers(null), /no `results\[\]\.answers`/)
})

/* ── the engine ──────────────────────────────────────────────────────── */

test('the engine speaks the real contract to a real socket', async () => {
  const server = await stub((req, res) => {
    if (req.url === '/health') return json(res, 200, { status: 'ready' })
    if (req.url === '/api/evaluate') return json(res, 200, ANSWER)
    json(res, 404, { error: 'not found' })
  })
  try {
    const engine = agentJevEngine({ endpoint: server.endpoint })
    assert.equal(engine.id, 'agentjev')
    assert.equal(await engine.available(), true)

    const result = await engine.ask({ text: 'a diff' }, QUESTIONS, { timeoutMs: 5000 })
    assert.equal(result.answers.irreversible.noul, 0.75)
    assert.equal(result.ms, 462.2)

    const sent = server.seen.find(entry => entry.url === '/api/evaluate')
    assert.equal(sent.method, 'POST')
    assert.deepEqual(sent.body.state, { text: 'a diff' })
    assert.equal(Array.isArray(sent.body.questions), true, 'questions go as a list, not a map')
  } finally {
    await server.close()
  }
})

test('an unreachable endpoint is unavailable, and says so instead of guessing', async () => {
  // Port 1 is reserved and nothing listens there; the probe must not hang or throw.
  const engine = agentJevEngine({ endpoint: 'http://127.0.0.1:1' })
  assert.equal(await engine.available(), false)
  await assert.rejects(() => engine.ask({ text: 'x' }, QUESTIONS, { timeoutMs: 1500 }))
  assert.equal(await agentJevEngine({ endpoint: '' }).available(), false)
})

test('an over-length refusal keeps the server\'s own words', async () => {
  const server = await stub((req, res) => json(res, 400, { error: 'question \'x\' needs 3000 tokens; limit 2048. Shorten the input; nothing was truncated.' }))
  try {
    const engine = agentJevEngine({ endpoint: server.endpoint })
    await assert.rejects(
      () => engine.ask({ text: 'x' }, QUESTIONS, { timeoutMs: 5000 }),
      error => /needs 3000 tokens/.test(error.message),
      'the token count has to survive, or the caller cannot tell "refused" from "clean"',
    )
  } finally {
    await server.close()
  }
})

/* ── per-engine cuts ─────────────────────────────────────────────────── */

test('a reader can run under another engine\'s cuts and the old table comes back', () => {
  withReaderThresholds({ retry: 0.16 }, () => {
    assert.equal(readerThreshold('retry', 0.6), 0.16, 'the engine\'s cut wins')
    assert.equal(readerThreshold('other', 0.5), 0.5, 'unnamed channels keep their default')
  })
  assert.equal(readerThreshold('retry', 0.6), 0.6, 'restored after the read')
  assert.deepEqual(readerThresholds(), {}, 'no residue in the module-level table')
})

test('a reader that throws still restores the table', () => {
  assert.throws(() => withReaderThresholds({ retry: 0.16 }, () => { throw new Error('reader blew up') }), /blew up/)
  assert.equal(readerThreshold('retry', 0.6), 0.6)
})

/* ── settings ────────────────────────────────────────────────────────── */

test('the fallback ships off the measured evidence, not off a hunch', () => {
  assert.equal(KIT_DEFAULTS.fallbackEngine, 'agentjev')
  // Only the local fits that cleared cross-validation: retry 90%, private_scan 81%.
  assert.deepEqual(KIT_DEFAULTS.fallbackChannels, ['retry', 'private_scan'])
  assert.deepEqual(KIT_DEFAULTS.engineThresholds.agentjev, { retry: 0.16, private_scan: 0.63 })
  // Channels that lost on measurement must not be routed to the weaker reader.
  for (const loser of ['sufficient', 'memory_write', 'scope_check']) {
    assert.equal(KIT_DEFAULTS.fallbackChannels.includes(loser), false, `${loser} stays on the hosted engine`)
  }
  assert.deepEqual(KIT_DEFAULTS.engines, ['jev'], 'the hosted engine is still the primary')
})

test('the new knobs are settable through the API — and validated', () => {
  const patched = merge(KIT_DEFAULTS, {
    agentjevEndpoint: 'http://127.0.0.1:8149/',
    fallbackEngine: 'agentjev',
    fallbackChannels: ['retry'],
    engineThresholds: { agentjev: { scope_check: 0.86 } },
  })
  assert.equal(patched.agentjevEndpoint, 'http://127.0.0.1:8149/')
  assert.deepEqual(patched.fallbackChannels, ['retry'])
  assert.equal(validate(patched), undefined)

  // Merged per engine and per channel: a patch naming one channel must not drop the fitted rest.
  assert.deepEqual(patched.engineThresholds.agentjev, { retry: 0.16, private_scan: 0.63, scope_check: 0.86 })
  const cleared = merge(patched, { engineThresholds: { agentjev: { scope_check: null } } })
  assert.deepEqual(cleared.engineThresholds.agentjev, { retry: 0.16, private_scan: 0.63 }, 'null deletes one key')

  assert.match(validate(merge(KIT_DEFAULTS, { layaEndpoint: 'ftp://nope' })) ?? '', /layaEndpoint 必须是 http/)
  assert.match(validate(merge(KIT_DEFAULTS, { fallbackEngine: 'Agent Jev' })) ?? '', /fallbackEngine 必须是引擎 id/)
  /*
   * Two different defences, asserted separately: `merge` drops an out-of-range cut
   * (a patch can never widen the table), and `validate` refuses a settings object that
   * arrived some other way — a hand-edited config.json is the realistic path.
   */
  assert.equal(merge(KIT_DEFAULTS, { engineThresholds: { agentjev: { retry: 1.4 } } }).engineThresholds.agentjev.retry, 0.16)
  assert.match(validate({ ...KIT_DEFAULTS, engineThresholds: { agentjev: { retry: 1.4 } } }) ?? '', /必须在 0–1 之间/)
  assert.match(validate(merge(KIT_DEFAULTS, { fallbackChannels: ['NOPE!'] })) ?? '', /fallbackChannels 里有不合法的通道名/)
})

test('an empty fallbackEngine turns the fallback off cleanly', () => {
  const off = merge(KIT_DEFAULTS, { fallbackEngine: '' })
  assert.equal(off.fallbackEngine, '')
  assert.equal(validate(off), undefined)
  // The channels may stay configured; the empty engine id is what disables it.
  assert.deepEqual(off.fallbackChannels, ['retry', 'private_scan'])
})
