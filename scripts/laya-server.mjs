/**
 * Local Laya engine for dsh-jev-kit's cross-engine benchmark.
 *
 * Speaks the kit's deliberately boring contract, backed by `@receptron/laya`
 * (ONNX Runtime, no Python at runtime):
 *
 *   GET  /health   → 200 { ok, model, ready }
 *   POST /         ← { state: {...}, questions: {...} }
 *                  → { answers: {...}, ms, usage }
 *
 * Why this file exists at all, rather than pointing the kit straight at the SDK:
 * the kit sends questions in its own schema, and the one field that must not be
 * lost in translation is the `noul` criteria pair — it is what records which
 * direction "true" pointed. Dropping it would turn a polarity-audited question
 * into an unaudited one, and a flipped answer would look like a model failure
 * instead of a wiring bug. So it is folded into the instructions, explicitly.
 *
 * Run:  node server.mjs [--port 8791] [--subfolder english|multilingual]
 * First start downloads ~1.7 GB of weights to ~/.cache/receptron-laya.
 */

import http from 'node:http'
import { Laya } from '@receptron/laya'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
const PORT = Number(args.get('port') ?? process.env.LAYA_PORT ?? 8791)
const SUBFOLDER = args.get('subfolder') ?? process.env.LAYA_SUBFOLDER ?? 'english'
const VERBOSE = args.has('verbose') || process.env.LAYA_VERBOSE === '1'

/**
 * The kit's question schema → Laya's.
 *
 * `noul` carries `{true,false}` wording in the kit; Laya takes instructions only,
 * so the pair is appended as two explicit sentences. `choice` and `score` already
 * line up (option map / ordered list).
 */
function toLayaQuestions (questions) {
  const out = {}
  for (const [key, question] of Object.entries(questions ?? {})) {
    const instructions = String(question?.instructions ?? '')
    if (question?.type === 'noul') {
      const criteria = question.criteria ?? {}
      const yes = typeof criteria.true === 'string' ? criteria.true : 'yes'
      const no = typeof criteria.false === 'string' ? criteria.false : 'no'
      out[key] = { type: 'noul', instructions: `${instructions} Answer true if: ${yes}. Answer false if: ${no}.` }
    } else if (question?.type === 'choice') {
      out[key] = { type: 'choice', instructions, criteria: question.criteria ?? {} }
    } else if (question?.type === 'score') {
      out[key] = { type: 'score', instructions, criteria: question.criteria ?? [] }
    } else {
      throw new Error(`unsupported question type: ${question?.type}`)
    }
  }
  return out
}

/**
 * The SDK's answers → the kit's answer shape (`{ <key>: { noul | choice | score } }`).
 *
 * `probabilities` are kept when the SDK returns them: the kit ignores them today,
 * but a benchmark that throws away the distribution cannot later ask whether one
 * engine's soft answers are better than the other's.
 */
function normaliseAnswers (result, questions) {
  const raw = result?.answers ?? {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const kind = questions?.[key]?.type
    if (!value || typeof value !== 'object') { out[key] = { noul: Number(value) }; continue }
    const entry = {}
    if (typeof value.noul === 'number') entry.noul = value.noul
    if (typeof value.choice === 'string') entry.choice = value.choice
    if (typeof value.score === 'number') entry.score = value.score
    if (value.probabilities !== undefined) entry.probabilities = value.probabilities
    // A build that answers a noul as a bare probability under another name still
    // produces a scored answer instead of an empty one.
    if (entry.noul === undefined && kind === 'noul') {
      for (const field of ['probability', 'p', 'score', 'value']) {
        if (typeof value[field] === 'number') { entry.noul = value[field]; break }
      }
    }
    out[key] = entry
  }
  return out
}

const server = http.createServer(async (req, res) => {
  const send = (status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    send(200, { ok: true, model: 'laya', subfolder: SUBFOLDER, ready: laya !== null })
    return
  }
  if (req.method !== 'POST') { send(405, { ok: false, error: `method ${req.method} not allowed` }); return }
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const questions = request.questions ?? {}
    const layaQuestions = toLayaQuestions(questions)
    const started = Date.now()
    const result = await model.systemOne(request.state ?? {}, layaQuestions)
    const answers = normaliseAnswers(result, questions)
    if (VERBOSE) {
      console.log(`  → ${Object.keys(answers).length} answers in ${Date.now() - started} ms · keys=${Object.keys(answers).join(',')}`)
    }
    send(200, { answers, ms: Date.now() - started, usage: result?.usage ?? null })
  } catch (error) {
    // Never an empty answer set: the kit must be able to tell "the engine failed"
    // from "nothing was flagged".
    console.error('[laya] error:', error?.message ?? error)
    send(500, { ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? error}` })
  }
})

let laya = null
let model = null

console.log(`[laya] loading checkpoint "${SUBFOLDER}" (first run downloads ~1.7 GB to ~/.cache/receptron-laya)…`)
const startedAt = Date.now()
laya = await Laya.load({ subfolder: SUBFOLDER === 'english' ? undefined : SUBFOLDER })
model = laya
console.log(`[laya] model ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)

// Warm the graph once: the first forward pass pays the session build, and a cold
// first call would otherwise be charged to whichever fixture happened to run first.
const warmStart = Date.now()
try {
  await model.systemOne({ text: 'warmup' }, { reachable: { type: 'noul', instructions: 'Is the text non-empty?' } })
  console.log(`[laya] warm in ${Date.now() - warmStart} ms`)
} catch (error) {
  console.error('[laya] warmup failed:', error?.message ?? error)
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[laya] listening on http://127.0.0.1:${PORT} · subfolder=${SUBFOLDER}`)
  console.log('[laya] kit setting: engines = ["jev", "laya"] · layaEndpoint = http://127.0.0.1:' + PORT)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n[laya] ${signal} — closing`)
    try { await laya?.close?.() } catch { /* best effort */ }
    process.exit(0)
  })
}
