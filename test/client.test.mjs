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

/**
 * A React with real state, plus a mount driver, so a test can walk the card down the
 * path the browser walks: render → run effects → await the fetch → re-render.
 *
 * `stubReact` deliberately has neither working state nor running effects, so `load()`
 * never executes and the wire shape is never exercised. That is why a card rendering
 * "0 records · ledger window 0d" over a *full* ledger — the route answers with an
 * envelope and the card read the envelope as if it were the report — was able to pass
 * every assertion in this file.
 */
function liveReact () {
  const slot = { cursor: 0, values: [], effects: [], dirty: false }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => {
      const i = slot.cursor++
      if (i >= slot.values.length) slot.values[i] = typeof initial === 'function' ? initial() : initial
      return [slot.values[i], (next) => {
        slot.values[i] = typeof next === 'function' ? next(slot.values[i]) : next
        slot.dirty = true
      }]
    },
    useEffect: (fn) => { slot.effects.push(fn) },
    useCallback: (fn) => fn,
  }
  /** Render once, run the mount effects, then keep re-rendering while state moves. */
  const mount = async (Component) => {
    slot.effects = []
    slot.cursor = 0
    let tree = Component()
    for (const effect of slot.effects) await effect()
    for (let i = 0; i < 20; i++) {
      await settle()
      if (!slot.dirty) continue
      slot.dirty = false
      slot.cursor = 0
      tree = Component()
    }
    return tree
  }
  return { React, mount }
}

/** Load the bundle and return the plugin face it registered. */
async function boot ({ locale = 'zh', react } = {}) {
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
  const React = react ?? stubReact()
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

// React renders numbers as text, so a walker that only keeps strings would report every
// count column as empty — exactly the columns this file needs to assert on.
const textOf = (node) => typeof node === 'string' || typeof node === 'number'
  ? String(node)
  : (node?.children ?? []).map(textOf).join(' ')

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
  /*
   * Every action the host supports must be reachable from the card. This assertion
   * exists because a string patch once landed a *label* without its checkbox: the
   * suite stayed green, the UI silently lacked the control, and only a screenshot
   * caught it.
   */
  assert.ok(buttons.includes('扫描暂存改动'), 'the staged-diff scan is one click, not one remembered tool call')
  assert.ok(find(tree, (node) => node.type === 'button').length >= 6, 'scan + save + test + refresh + copy + apply')
  assert.match(text, /阈值（语料拟合）/, 'the fitted-threshold section renders')
  // The credential box is why the lens can be uninstalled without losing the UI for
  // the one secret the family needs. It must be a password input, and it must start
  // blank (a prefilled secret is a leaked secret).
  const passwords = find(tree, (node) => node.type === 'input' && node.props.type === 'password')
  assert.equal(passwords.length, 1, 'exactly one credential input')
  assert.equal(passwords[0].props.value, '', 'and it starts empty')
  assert.equal(passwords[0].props.autoComplete, 'off')
  assert.match(text, /Jev 凭据/, 'the credential section renders')
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
  assert.match(markdown, /\| 🔴 \| flaky \| C \| 3 \| 1 \| 0 \| 640ms \| 900ms \|/, 'every row carries its colour marker: the colour itself does not survive a paste')
})

test('a full ledger renders its channels, not "no records"', async () => {
  /*
   * `GET /api/report` answers with an envelope — `{ok, days, report, markdown}` — while
   * `classify` and `toMarkdown` take the report itself. Reading the envelope as if it
   * were the report is *silent*: every field is undefined, so the card rendered "0
   * records · ledger window 0d" and the copy button produced the same empty table, over
   * a ledger that had 4729 entries in it. A false all-clear on the one table whose only
   * job is to retire channels.
   *
   * The fixtures below are the real wire shapes, because the bug lived exactly in the
   * gap between them: a bare report is what the pure-function tests above pass in, and
   * it is not what the route sends.
   */
  const { React, mount } = liveReact()
  const bodies = {
    '/dsh-jev-kit/api/status': {
      version: '0.15.0',
      enabled: true,
      channels: 23,
      key: { configured: true, source: 'credential:file' },
      budget: { dayCalls: 0, dailyCallLimit: 20000 },
    },
    '/dsh-jev-kit/api/report?days=7': {
      ok: true,
      days: 7,
      report: {
        total: 735,
        window: { days: 7, records: 4729 },
        channels: [
          { channel: 'private_scan', group: 'P', n: 700, flagged: 78, warn: 0, latency: { p50: 488, p95: 894 } },
          { channel: 'flaky', group: 'C', n: 3, flagged: 3, warn: 0, latency: { p50: 513, p95: 986 } },
        ],
      },
    },
    // The envelope here is flat-ish (`applied`/`suggested`/`details` at the top level),
    // which is why this section never had the bug and must not "fix" it away.
    '/dsh-jev-kit/api/thresholds': {
      ok: true,
      applied: { risk: 0.42 },
      suggested: { scope_check: 0.1 },
      details: [{ channel: 'scope_check', current: 0.5, recommended: 0.1, accuracyCrossVal: 0.85, n: 20 }],
    },
  }
  globalThis.fetch = async (url) => ({ ok: true, json: async () => bodies[String(url)] })
  try {
    const { seats } = await boot({ react: React })
    const text = textOf(await mount(seats['jev-kit']))
    assert.doesNotMatch(text, /还没有判定记录/, 'an empty reading over a full ledger is the bug this test exists for')
    assert.match(text, /✅ 暂无需淘汰的通道/, 'the verdict line reads the real total')
    assert.match(text, /private_scan/, 'the table shows the channels the ledger actually holds')
    assert.match(text, /700/, 'and their counts')
    assert.match(text, /flaky/)
    assert.match(text, /scope_check/, 'the thresholds section keeps reading its own envelope')
  } finally {
    delete globalThis.fetch
  }
})

test('the report envelope is unwrapped, and a bare report still works', async () => {
  const { plugin } = await boot()
  const { unwrapReport } = plugin.__internals
  const report = { total: 735, window: { days: 7 }, channels: [{ channel: 'flaky' }] }
  assert.equal(unwrapReport({ ok: true, days: 7, report, markdown: '…' }), report, 'the envelope is what the route sends')
  assert.equal(unwrapReport(report), report, 'and a route that stops wrapping must not break the card')
  assert.equal(unwrapReport(null), null)
  assert.deepEqual(unwrapReport({ ok: true }), { ok: true })
})

test('the card takes the host verdict when it is there, and recomputes when it is not', async () => {
  /*
   * The verdict is computed host-side (`verdictOf`) so the card, the copied Markdown
   * and the tool cannot disagree. The local rule is a fallback for a payload that
   * predates the field, and both paths must land on the same marker.
   */
  const { plugin } = await boot()
  const { classify, S } = plugin.__internals
  const t = S.zh
  const hostSaid = classify({
    total: 30,
    channels: [
      { channel: 'a', group: 'P', n: 5, flagged: 0, warn: 0, level: 'retire', latency: {} },
      { channel: 'b', group: 'P', n: 30, flagged: 0, warn: 0, level: 'thin', latency: {} },
      { channel: 'c', group: 'P', n: 30, flagged: 2, warn: 0, level: 'useful', latency: {} },
      { channel: 'd', group: 'P', n: 30, flagged: 0, warn: 3, level: 'warn', latency: {} },
    ],
  }, t)
  const byChannel = Object.fromEntries(hostSaid.rows.map((row) => [row.channel, row]))
  assert.equal(byChannel.a.level, 'retire', 'the host verdict wins over the local sample count')
  assert.equal(byChannel.b.level, 'unknown', "the host's `thin` maps onto this card's unmeasured tone")
  assert.equal(byChannel.c.mark, '🔴')
  assert.equal(byChannel.d.mark, '🟡')
  assert.equal(byChannel.a.mark, '⬛')
  assert.equal(byChannel.b.mark, '⚪')
  // No `level` on the wire (an older host): the fallback must reproduce the same rule.
  const inferred = classify({
    total: 3,
    channels: [
      { channel: 'flaky', group: 'C', n: 3, flagged: 1, warn: 0, latency: {} },
      { channel: 'scope_check', group: 'P', n: 30, flagged: 0, warn: 0, latency: {} },
      { channel: 'retry', group: 'A', n: 30, flagged: 0, warn: 1, latency: {} },
    ],
  }, t)
  const inferredBy = Object.fromEntries(inferred.rows.map((row) => [row.channel, row]))
  assert.equal(inferredBy.flaky.level, 'bad')
  assert.equal(inferredBy.scope_check.level, 'retire')
  assert.equal(inferredBy.retry.level, 'warn')
})

test('the threshold table shows a fit that suggests nothing, and never paints it as an instruction', async () => {
  /*
   * Two ways this section lied. It gated on `suggested`, which is only the apply-ready
   * subset — so a healthy corpus whose every fit says "no change needed" read as "run a
   * benchmark first". And it printed the raw recommendation in the action colour, which
   * is how a table talks someone into retuning a channel the kit itself refuses to
   * retune (the label says 建议; the verdict says ⚪ / ⬛).
   */
  const { React, mount } = liveReact()
  const bodies = {
    '/dsh-jev-kit/api/status': { version: '0.15.1', enabled: true, channels: 23, key: { configured: true, source: 'credential:file' }, budget: {} },
    '/dsh-jev-kit/api/report?days=7': { ok: true, days: 7, report: { total: 1, window: { days: 7 }, channels: [{ channel: 'private_scan', group: 'P', n: 1, flagged: 1, warn: 0, latency: {} }] } },
    '/dsh-jev-kit/api/thresholds': {
      ok: true,
      // Nothing is apply-ready, and that is the point of the fixture.
      applied: { scope_check: 0.1 },
      suggested: {},
      details: [
        { channel: 'scope_check', current: 0.1, recommended: 0.1, accuracyNow: 0.95, accuracyFitted: 0.95, accuracyCrossVal: 0.95, n: 20, separation: 0.99, trustworthy: true, changes: false, level: 'optimal' },
        { channel: 'retry', current: 0.6, recommended: 0.33, accuracyNow: 0.95, accuracyFitted: 1, accuracyCrossVal: 0.95, n: 20, separation: 1, trustworthy: false, changes: true, level: 'optimal' },
        // No `level` on the wire (an older host): the fallback must still classify it.
        { channel: 'noisy_channel', current: 0.5, recommended: 0.2, accuracyNow: 0.6, accuracyFitted: 0.6, accuracyCrossVal: 0.6, n: 20, separation: 0.4, trustworthy: false, changes: true },
      ],
    },
  }
  globalThis.fetch = async (url) => ({ ok: true, json: async () => bodies[String(url)] })
  try {
    const { seats } = await boot({ react: React })
    const text = textOf(await mount(seats['jev-kit']))
    assert.doesNotMatch(text, /还没有拟合结果/, 'a fit that needs no change is still a fit')
    for (const channel of ['scope_check', 'retry', 'noisy_channel']) assert.match(text, new RegExp(channel))
    assert.match(text, /⚪ 无需改动/, 'the fit legend explains what each marker means')
    assert.match(text, /0\.33/, 'the recommendation is still shown for the record')
    assert.match(text, /⬛/, 'a fit whose separation is below the bar is marked as not fittable')
  } finally {
    delete globalThis.fetch
  }
})

test('the bundle is a ModuleLoader bundle, not an ES module', () => {
  const source = fs.readFileSync(bundlePath, 'utf8')
  assert.match(source, /__ModuleLoader__\.load\(/)
  assert.doesNotMatch(source, /^\s*(import|export)\s/m, 'no import/export: the loader would reject it')
})
