#!/usr/bin/env node
/**
 * i18n gate — enforce "only add keys, never rewrite existing copy" as a check.
 *
 * The rule is a standing preference, and until now it was kept by memory and
 * discipline. This script turns it into a gate on commit:
 *
 *   · **extraction** (here, because the repository is on disk): which entries are
 *     *added* by the staged locale file, and what the existing catalogue says.
 *   · **judgment** (the plugin): for each new entry — is there already a key with
 *     this meaning (then do not add one), and does the wording use the same term as
 *     the established copy (or does it invent a second word for the same thing)?
 *
 * Split that way on purpose: the plugin must not learn how to read a repository's
 * locale layout, and the hook must not contain a model.
 *
 * Usage:
 *   node scripts/i18n-gate.mjs <repo> [--staged|--head] [--pattern 'zh-CN']
 *   JEV_KIT_ENDPOINT=http://127.0.0.1:3080/dsh-jev-kit/api/i18n-check
 *
 * Exit codes: 0 = clean (or nothing to check), 1 = findings, 2 = could not check
 * (reported loudly, and a hook treats "could not check" as "do not block").
 *
 * @module dsh-jev-kit/scripts/i18n-gate
 */
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const repo = args.find(arg => !arg.startsWith('-')) ?? process.cwd()
const pattern = (() => {
  const index = args.indexOf('--pattern')
  return index >= 0 ? (args[index + 1] ?? 'zh-CN') : 'zh-CN'
})()
const endpoint = process.env.JEV_KIT_ENDPOINT ?? 'http://127.0.0.1:3080/dsh-jev-kit/api/i18n-check'
const MAX_NEW = Number(process.env.JEV_I18N_MAX ?? 20)

const git = (...argv) => {
  try {
    return execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    return error?.stdout?.toString?.() ?? ''
  }
}

/** Flatten a locale file into `key: text` pairs (nested keys joined with dots). */
function flatten (json, prefix = '') {
  const out = []
  if (json === null || typeof json !== 'object') return out
  for (const [key, value] of Object.entries(json)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object') out.push(...flatten(value, path))
    else out.push({ key: path, text: String(value) })
  }
  return out
}

function parse (text) {
  try { return JSON.parse(text) } catch { return null }
}

// Which locale files does this commit touch?
const changed = git('diff', '--cached', '--name-only')
  .split('\n')
  .map(line => line.trim())
  .filter(line => line.length > 0 && line.includes(pattern) && line.endsWith('.json'))

if (changed.length === 0) {
  console.log(`i18n gate: 本次提交没有改动含 “${pattern}” 的词条文件，跳过。`)
  process.exit(0)
}

let newKeys = []
let existing = []
for (const file of changed) {
  const stagedRaw = git('show', `:${file}`)
  const headRaw = git('show', `HEAD:${file}`)
  const staged = parse(stagedRaw)
  if (staged === null) { console.error(`i18n gate: ⚠️ 读不到暂存版本 ${file}，跳过该文件`); continue }
  const head = parse(headRaw) ?? {}
  const stagedFlat = flatten(staged)
  const headKeys = new Set(flatten(head).map(entry => entry.key))
  /*
   * The catalogue the new entries are judged against is the **pre-commit** one.
   * Feeding the staged file wholesale made every new key match *itself* — the gate
   * then reported "已有同义 key" for every addition, which is worse than useless
   * because it trains people to bypass it. Caught end-to-end, fixed here.
   */
  existing.push(...stagedFlat.filter(entry => headKeys.has(entry.key)))
  newKeys.push(...stagedFlat.filter(entry => !headKeys.has(entry.key)).map(entry => ({ ...entry, file })))
}

if (newKeys.length === 0) {
  console.log(`i18n gate: ${changed.length} 个词条文件有改动，但没有新增 key（符合"只新增、不改写"的纪律）。`)
  process.exit(0)
}

const capped = newKeys.slice(0, MAX_NEW)
if (newKeys.length > capped.length) {
  console.error(`i18n gate: ⚠️ 新增 ${newKeys.length} 条，本次只检查前 ${capped.length} 条（JEV_I18N_MAX 可调）`)
}

let response
try {
  response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newKeys: capped, existing: existing.slice(0, 60) }),
    signal: AbortSignal.timeout(180_000),
  })
} catch (error) {
  console.error(`i18n gate: ⚠️ 判定服务不可达（${endpoint}）——本次不阻塞提交，但这不代表词条没问题。`)
  console.error(`          ${error?.message ?? error}`)
  process.exit(2)
}

if (!response.ok) {
  console.error(`i18n gate: ⚠️ 服务返回 ${response.status}——本次不阻塞提交，但这不代表词条没问题。`)
  process.exit(2)
}

const body = await response.json()
console.log(body.markdown ?? '')
if (body.flagged > 0) {
  for (const finding of body.findings ?? []) {
    console.log(`  · ${finding.where} — ${finding.headline}`)
  }
  console.log('\n按纪律处理：同义时复用现有 key；术语与既有说法不一致时改措辞，而不是新造一套说法。')
  console.log('确认无误可放行：JEV_ALLOW_COMMIT=1 git commit（本提交）或 JEV_SKIP_I18N=1。')
  process.exit(1)
}
process.exit(0)
