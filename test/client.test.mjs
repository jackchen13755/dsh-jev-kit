/**
 * Offline smoke test for the browser half.
 *
 * A client bundle cannot be imported and asserted on like a module: it is a
 * script that registers itself with `window.__ModuleLoader__` and needs React.
 * So this test *is* the browser — it supplies the globals the bundle touches, runs
 * `apply` against a stub slots service, renders the card, and asserts the parts
 * that can be wrong without looking wrong: the seat registrations, the controls
 * that must exist, and the colour rule that decides which channel to retire.
 *
 * No network, no browser, no key.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')

/** A React small enough to render a tree we can walk. */
function stubReact () {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

/** Load the bundle and return the plugin face it registered. */
async function boot ({ locale = 'zh' } = {}) {
  let registration
  globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  /*
   * Re-execute the source rather than `import()` it: ESM caches modules, so only
   * the first test would ever see a registration. Running the text is also what
   * the browser does on every page load.
   */
  new Function(fs.readFileSync(bundlePath, 'utf8'))()
  assert.ok(registration, 'the bundle registers itself with __ModuleLoader__')
  assert.equal(registration.id, '@dsh-external/dsh-jev-kit')
  const React = stubReact()
  const plugin = registration.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
  const seats = {}
  const applied = []
  const slots = {
    inject: (name, callback) => { applied.push(name); callback() },
    register: (meta, component) => { seats[meta.id ?? meta.key] = component },
  }
  plugin.apply({ slots, locale: { current: locale } })
  return { plugin, seats, applied, React }
}

/** Walk a rendered tree. */
const find = (node, predicate) => {
  if (node === null || node === undefined || typeof node !== 'object') return []
  const own = predicate(node) ? [node] : []
  const children = Array.isArray(node.children) ? node.children : []
  return [...own, ...children.flatMap((child) => find(child, predicate))]
}

const textOf = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(' '))

test('the card mounts in both seats it declares', async () => {
  const { seats, applied } = await boot()
  assert.deepEqual(applied.sort(), ['plugins.bundle.config', 'settings.section'])
  assert.equal(typeof seats['jev-kit'], 'function', 'the settings section is registered under its id')
  assert.equal(typeof seats['@dsh-external/dsh-jev-kit'], 'function', 'and so is the plugin page')
})

test('the card renders its controls and its empty state', async () => {
  const { seats } = await boot()
  const tree = seats['jev-kit']()
  const text = textOf(tree)
  assert.match(text, /Jev 决策工具箱/)
  assert.match(text, /启用/)
  assert.match(text, /账本窗口/)
  assert.match(text, /复制 Markdown/)
  // The on/off switch is a checkbox, and the window buttons are 1/7/30 days.
  const checkboxes = find(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkboxes.length, 1, 'exactly one switch: enabled')
  const buttons = find(tree, (node) => node.type === 'button').map(textOf)
  for (const label of ['1d', '7d', '30d', '刷新', '复制 Markdown']) assert.ok(buttons.includes(label), `missing button ${label}`)
  // With no ledger the card says so instead of showing a green light.
  assert.match(text, /还没有判定记录/)
  // The catalogue is present as a details section, not as 23 lines of noise.
  assert.equal(find(tree, (node) => node.type === 'details').length, 1)
})

test('the colour rule retires silent channels and never greens an unmeasured one', async () => {
  const { plugin } = await boot()
  const { classify } = plugin.__internals
  const t = plugin.__internals.S.zh
  const report = {
    total: 40,
    window: { days: 7 },
    channels: [
      { channel: 'private_scan', group: 'P', n: 5, flagged: 0, warn: 0, latency: { p50: 700, p95: 900 } },
      { channel: 'scope_check', group: 'P', n: 30, flagged: 0, warn: 0, latency: { p50: 800, p95: 1200 } },
      { channel: 'log_triage', group: 'C', n: 25, flagged: 3, warn: 1, latency: { p50: 600, p95: 800 } },
      { channel: 'risk', group: 'B', n: 40, flagged: 0, warn: 2, latency: { p50: 500, p95: 700 } },
    ],
  }
  const verdict = classify(report, t)
  const byChannel = Object.fromEntries(verdict.rows.map((row) => [row.channel, row]))
  assert.equal(byChannel.private_scan.level, 'unknown', 'five samples prove nothing — and must not look measured')
  assert.equal(byChannel.scope_check.level, 'retire', 'thirty samples, never non-neutral: retire or reword')
  assert.equal(byChannel.log_triage.level, 'bad', 'a flag is the channel earning its keep')
  assert.equal(byChannel.risk.level, 'warn')
  assert.equal(verdict.retire, 1)
  assert.equal(verdict.level, 'warn')
  assert.match(verdict.text, /1 个通道/)
  // No records at all is its own answer, not a pass.
  assert.equal(classify({ total: 0, channels: [] }, t).level, 'unknown')
})

test('the copied Markdown reports the same numbers the card shows', async () => {
  const { plugin } = await boot()
  const { toMarkdown, classify, S } = plugin.__internals
  const report = { total: 3, window: { days: 1 }, channels: [{ channel: 'flaky', group: 'C', n: 3, flagged: 1, warn: 0, latency: { p50: 640, p95: 900 } }] }
  const markdown = toMarkdown(report, { version: '0.1.3' }, classify(report, S.zh).rows, S.zh)
  assert.match(markdown, /### Jev 决策工具箱 v0\.1\.3/)
  assert.match(markdown, /\| flaky \| C \| 3 \| 1 \| 0 \| 640ms \| 900ms \|/)
})

test('the bundle is a ModuleLoader bundle, not an ES module', () => {
  const source = fs.readFileSync(bundlePath, 'utf8')
  assert.match(source, /__ModuleLoader__\.load\(/)
  assert.doesNotMatch(source, /^\s*(import|export)\s/m, 'no import/export: the loader would reject it')
})
