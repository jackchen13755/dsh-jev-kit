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
  /**
   * Re-render the settled component *without* re-running its effects, which is what a
   * state change does in the browser.
   *
   * `mount()` cannot stand in for this: it re-runs the mount effects, and the card's
   * mount effect reloads — which clears the note. Using it to look at a note would have
   * reproduced the bug instead of catching it.
   */
  const render = async (Component) => {
    slot.cursor = 0
    let tree = Component()
    for (let i = 0; i < 20; i++) {
      await settle()
      if (!slot.dirty) continue
      slot.dirty = false
      slot.cursor = 0
      tree = Component()
    }
    return tree
  }
  /** Render once, run the mount effects, then keep re-rendering while state moves. */
  const mount = async (Component) => {
    slot.effects = []
    slot.cursor = 0
    Component()
    for (const effect of slot.effects) await effect()
    return await render(Component)
  }
  return { React, mount, render }
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
    const tree = await mount(seats['jev-kit'])
    const text = textOf(tree)
    assert.doesNotMatch(text, /还没有拟合结果/, 'a fit that needs no change is still a fit')
    for (const channel of ['scope_check', 'retry', 'noisy_channel']) assert.match(text, new RegExp(channel))
    assert.match(text, /⚪ 无需改动/, 'the fit legend explains what each marker means')
    assert.match(text, /0\.33/, 'the recommendation is still shown for the record')
    assert.match(text, /⬛/, 'a fit whose separation is below the bar is marked as not fittable')
    /*
     * The button must be dead here, and it must say why.
     *
     * `suggested` is the host's apply-ready subset and this fixture is the real live
     * state of the machine: every fit failed held-out validation, so it is `{}`. The
     * button used to render enabled anyway, POST `{thresholds:{}}`, receive `ok:true`
     * (a merge with nothing to merge) and leave the table byte-identical — a click that
     * provably could not do anything, presented as the one action on the card.
     */
    const apply = find(tree, (node) => node.type === 'button' && textOf(node) === '应用建议阈值')
    assert.equal(apply.length, 1, 'the apply button is on the card')
    assert.equal(apply[0].props.disabled, true, 'nothing to apply must not look pressable')
    assert.match(text, /没有可应用的改动/, 'and the card says so instead of staying silent')
    assert.match(text, /3 项拟合/, 'naming how many fits it looked at')
  } finally {
    delete globalThis.fetch
  }
})

test('thresholdChanges keeps only the cuts that would really move', async () => {
  /*
   * The apply button's payload, as a pure function, because "what counts as a change"
   * is where the silent no-op lived: the card used to send the whole `suggested` map,
   * so a key already at its suggested value travelled as if it were work.
   */
  const { plugin } = await boot()
  const { thresholdChanges } = plugin.__internals
  assert.deepEqual(thresholdChanges(null), [], 'no payload yet is no changes')
  assert.deepEqual(thresholdChanges({ applied: {}, suggested: {} }), [], 'an empty fit is empty')
  assert.deepEqual(thresholdChanges({ applied: { risk: 0.43 }, suggested: { risk: 0.43 } }), [], 'already in force is not a change')
  assert.deepEqual(
    thresholdChanges({
      // The per-axis keys are the ones a hand-cut lives on; they must be treated like
      // any other key rather than filtered by their dots.
      applied: { risk: 0.6, 'private_scan.internal': 0.75 },
      suggested: { risk: 0.43, 'private_scan.internal': 0.75, log_triage: 0.3, junk: 'nope', nan: Number.NaN },
    }),
    [{ key: 'risk', from: 0.6, to: 0.43 }, { key: 'log_triage', from: null, to: 0.3 }],
    'a real move, a brand-new key, and nothing else'
  )
})

test('an apply is judged by the host echo, not by a 200', async () => {
  /*
   * The route answers `ok: true` for a patch that merges to nothing, so a status code
   * cannot tell "the cut moved" from "the request was accepted and ignored". The note
   * is built from `settings.thresholds`, and a missing echo is reported as not landing
   * rather than assumed good.
   */
  const { plugin } = await boot()
  const { appliedNote } = plugin.__internals
  const changes = [{ key: 'risk', from: 0.6, to: 0.43 }, { key: 'sufficient', from: 0.8, to: 0.08 }]
  const { moved, missed } = appliedNote(changes, { risk: 0.43 })
  assert.deepEqual(moved, [changes[0]])
  assert.deepEqual(missed, [changes[1]], 'a key the host did not echo did not land')
  assert.deepEqual(appliedNote(changes, undefined).missed, changes, 'no echo is not evidence')
  assert.deepEqual(appliedNote(changes, {}).moved, [])
})

test('a real apply posts the difference, and the note survives the reload', async () => {
  /*
   * Two failures met in this one path and both made the button read as dead:
   *
   *   · the note was set *before* `load()`, and `load()` clears the note when it
   *     succeeds — so a save that worked and a click that did nothing looked identical;
   *   · nothing said what had been written, so even a landing save left the reader
   *     comparing threshold tables by eye.
   *
   * This walks the path the browser walks: render → click → POST → reload → re-render,
   * and asserts the posted body, the note, and that the button goes quiet afterwards.
   */
  const { React, mount, render } = liveReact()
  const thresholds = {
    ok: true,
    applied: { risk: 0.6, sufficient: 0.8 },
    suggested: { risk: 0.43, sufficient: 0.8 },
    details: [
      { channel: 'risk', current: 0.6, recommended: 0.43, accuracyNow: 0.909, accuracyFitted: 0.955, accuracyCrossVal: 0.909, n: 22, separation: 0.95, trustworthy: true, changes: true, level: 'adjustable' },
      { channel: 'sufficient', current: 0.8, recommended: 0.8, accuracyNow: 0.92, accuracyFitted: 0.92, accuracyCrossVal: 0.92, n: 12, separation: 0.9, trustworthy: true, changes: false, level: 'optimal' },
    ],
  }
  const bodies = {
    '/dsh-jev-kit/api/status': { version: '0.17.1', enabled: true, channels: 23, key: { configured: true, source: 'credential:file' }, budget: {} },
    '/dsh-jev-kit/api/report?days=7': { ok: true, days: 7, report: { total: 2, window: { days: 7 }, channels: [{ channel: 'risk', group: 'B', n: 2, flagged: 1, warn: 0, latency: {} }] } },
    '/dsh-jev-kit/api/thresholds': thresholds,
  }
  const posts = []
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      const patch = JSON.parse(init.body)
      posts.push(patch)
      // Mirror the host: merge the patch into what is in force, then echo every key.
      for (const [key, cut] of Object.entries(patch.thresholds ?? {})) thresholds.applied[key] = cut
      thresholds.suggested = {}
      return { ok: true, json: async () => ({ ok: true, settings: { thresholds: thresholds.applied } }) }
    }
    return { ok: true, json: async () => bodies[String(url)] }
  }
  try {
    const { seats } = await boot({ react: React })
    const component = seats['jev-kit']
    const tree = await mount(component)
    const apply = find(tree, (node) => node.type === 'button' && textOf(node) === '应用建议阈值')
    assert.equal(apply.length, 1)
    assert.equal(apply[0].props.disabled, false, 'a fit with a real change must be pressable')
    assert.match(textOf(tree), /risk 0\.60 → 0\.43/, 'and it says what it is about to write')
    assert.doesNotMatch(textOf(tree), /sufficient 0\.80 →/, 'a cut already in force is not a change')

    apply[0].props.onClick()
    for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(posts, [{ thresholds: { risk: 0.43 } }], 'only the difference is sent')
    const after = await render(component)
    const afterText = textOf(after)
    assert.match(afterText, /已应用：risk 0\.60 → 0\.43/, 'the note names what moved, from the host echo')
    assert.match(afterText, /已应用：risk 0\.60 → 0\.43/, 'and the reload did not erase it')
    const applyAfter = find(after, (node) => node.type === 'button' && textOf(node) === '应用建议阈值')
    assert.equal(applyAfter[0].props.disabled, true, 'with nothing left to apply it goes quiet')
    assert.match(afterText, /没有可应用的改动/, 'saying why instead of looking pressable')
  } finally {
    delete globalThis.fetch
  }
})

test('an apply whose key did not land says so instead of claiming a save', async () => {
  /*
   * The failure this guards against is the family's oldest one: a write reported as
   * done that did not happen. The host is stubbed to accept the POST and echo a
   * thresholds map *without* the key — the shape a rejected or dropped key produces.
   */
  const { React, mount, render } = liveReact()
  const bodies = {
    '/dsh-jev-kit/api/status': { version: '0.17.1', enabled: true, channels: 23, key: { configured: true, source: 'credential:file' }, budget: {} },
    '/dsh-jev-kit/api/report?days=7': { ok: true, days: 7, report: { total: 1, window: { days: 7 }, channels: [] } },
    '/dsh-jev-kit/api/thresholds': {
      ok: true,
      applied: { risk: 0.6 },
      suggested: { risk: 0.43 },
      details: [{ channel: 'risk', current: 0.6, recommended: 0.43, accuracyNow: 0.9, accuracyFitted: 0.96, accuracyCrossVal: 0.92, n: 22, separation: 0.95, trustworthy: true, changes: true, level: 'adjustable' }],
    },
  }
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true, settings: { thresholds: {} } }) }
    return { ok: true, json: async () => bodies[String(url)] }
  }
  try {
    const { seats } = await boot({ react: React })
    const component = seats['jev-kit']
    const tree = await mount(component)
    find(tree, (node) => node.type === 'button' && textOf(node) === '应用建议阈值')[0].props.onClick()
    for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve))
    const text = textOf(await render(component))
    assert.match(text, /未落地：risk/, 'a key the host did not echo is reported, not glossed over')
    assert.doesNotMatch(text, /已应用：risk/, 'and must not be announced as applied')
  } finally {
    delete globalThis.fetch
  }
})

test('the card shows how well a score reads as a probability, and never invents one', async () => {
  /*
   * The bench now measures the scale (`Brier` / skill against the corpus own base rate),
   * and a measurement nobody can see is a measurement nobody uses. Two rules are worth
   * a test of their own:
   *
   *   · a record written before the metric existed has **no** `calibration`, and the cell
   *     must say "not measured" — rendering `0.00` there would read as a perfect score;
   *   · a bad scale must not be painted as a broken channel, because the repair that
   *     suggests (move the cut toward 0.5) is the false-positive storm.
   */
  const { React, mount } = liveReact()
  const bodies = {
    '/dsh-jev-kit/api/status': { version: '0.17.3', enabled: true, channels: 24, key: { configured: true, source: 'credential:file' }, budget: {} },
    '/dsh-jev-kit/api/report?days=7': { ok: true, days: 7, report: { total: 1, window: { days: 7 }, channels: [] } },
    '/dsh-jev-kit/api/thresholds': {
      ok: true,
      applied: {},
      suggested: {},
      details: [
        {
          channel: 'private_scan', current: 0.06, recommended: 0.06, accuracyNow: 1, accuracyFitted: 1, accuracyCrossVal: 0.983, n: 58, separation: 1, trustworthy: false, changes: false, level: 'optimal',
          calibration: { n: 58, baseRate: 0.5, brier: 0.0299, baseline: 0.25, skill: 0.8804, ece: 0.0565, maxGap: 0.505, qualified: 4, thin: 0, bins: [], outOfRange: 0, unusable: 0 },
        },
        {
          channel: 'sufficient', current: 0.8, recommended: 0.8, accuracyNow: 0.667, accuracyFitted: 0.667, accuracyCrossVal: 0.667, n: 12, separation: 0.99, trustworthy: false, changes: false, level: 'optimal',
          // Brier 0.247 against its own baseline 0.25: the scale carries no information.
          calibration: { n: 12, baseRate: 0.5, brier: 0.247, baseline: 0.25, skill: 0.012, ece: 0.2688, maxGap: undefined, qualified: 1, thin: 2, bins: [], outOfRange: 0, unusable: 0 },
        },
        // A record from before this metric existed: no calibration field at all.
        { channel: 'risk', current: 0.6, recommended: 0.6, accuracyNow: 0.9, accuracyFitted: 0.9, accuracyCrossVal: 0.9, n: 22, separation: 0.95, trustworthy: false, changes: false, level: 'optimal' },
      ],
    },
  }
  globalThis.fetch = async (url) => ({ ok: true, json: async () => bodies[String(url)] })
  try {
    const { seats } = await boot({ react: React })
    const tree = await mount(seats['jev-kit'])
    const text = textOf(tree)
    assert.match(text, /刻度/, 'the column is there')
    assert.match(text, /刻度 = 分数当概率读有多准/, 'and explains itself')
    assert.match(text, /别因为刻度差就把刀口挪向 0\.5/, 'including the repair it must not suggest')
    const scaleCells = find(tree, (node) => node.type === 'td' && typeof node.props.title === 'string' && node.props.title.length > 0)
    const titles = scaleCells.map((node) => node.props.title)
    assert.equal(titles.some((title) => /Brier 0\.030/.test(title)), true, 'the measured channel carries its number')
    assert.equal(titles.some((title) => /技能 0\.01/.test(title)), true, 'and the skill against its own baseline')
    const unmeasured = scaleCells.find((node) => /未测/.test(node.props.title))
    assert.ok(unmeasured, 'an older record is reported as not measured')
    assert.equal(textOf(unmeasured), '—', 'and never as 0.00, which would read as perfect')
    /*
     * A row in `details` can never lack `calibration` for lack of samples: `fitThresholds`
     * skips those channels *before* pushing a row. So the only cause is a record written by
     * code that predates the metric, and blaming the sample size sent the reader off to
     * collect fixtures for a channel that was never the problem.
     */
    assert.doesNotMatch(unmeasured.props.title, /样本|正负例/, 'do not blame a cause that cannot produce this row')
    assert.match(unmeasured.props.title, /早于「刻度」功能/, 'name the actual cause and the fix')
    /*
     * `maxGap` is absent when no band had enough samples (MIN_BIN_N). Interpolating it
     * unguarded printed "最大偏差 NaN" — the one cell whose whole job is to say "not
     * measured" instead said a number.
     */
    const thinBins = find(tree, (node) => node.type === 'td' && /Brier/.test(node.props.title ?? '')).map((node) => node.props.title)
    assert.equal(thinBins.some((title) => /NaN|undefined/.test(title)), false, 'no NaN in a tooltip')
    assert.equal(thinBins.some((title) => /最大偏差 —/.test(title)), true, 'the unmeasurable gap says so in words')
  } finally {
    delete globalThis.fetch
  }
})

test('the card shows what the plugin actually did, not just per-channel counts', async () => {
  /*
   * Every number here was already arriving in `GET /api/report` and being discarded, so
   * "is this plugin doing anything" could only be answered by reading the ledger by hand.
   * Two of them are honesty rules rather than decoration, and both are asserted:
   *
   *   · a **degradation** means no judgment was made (fail-open) — printing it as a bare
   *     count, or worse letting it read as "nothing found", is the mistake this family
   *     exists to prevent;
   *   · a **cost** derived from characters ÷ 4 must say it is an estimate; a precise
   *     dollar figure with no such label is fabricated precision.
   */
  const { React, mount } = liveReact()
  const bodies = {
    '/dsh-jev-kit/api/status': { version: '0.17.6', enabled: true, channels: 25, key: { configured: true, source: 'credential:file' }, budget: { dayCalls: 12, dailyCallLimit: 20000 } },
    '/dsh-jev-kit/api/report?days=7': {
      ok: true,
      days: 7,
      report: {
        total: 143,
        window: { days: 7, records: 4310 },
        cost: { inputTokens: 120000, usd: 0.00504, savedCalls: 37 },
        health: { degraded: 2, errors: 0 },
        byEntry: [{ entry: 'auto', n: 78, flag: 3 }, { entry: 'hook', n: 40, flag: 1 }, { entry: 'abc-session', n: 25, flag: 0 }],
        unusedChannels: ['route', 'evidence_check', 'bug_triage'],
        channels: [
          { channel: 'private_scan', group: 'P', n: 100, flagged: 4, warn: 0, level: 'useful', cached: 37, acted: 6, actedYes: 5, latency: { p50: 700, p95: 900 } },
          { channel: 'retry', group: 'A', n: 43, flagged: 0, warn: 1, level: 'warn', cached: 0, acted: 0, actedYes: 0, latency: { p50: 600, p95: 800 } },
        ],
      },
    },
    '/dsh-jev-kit/api/thresholds': { ok: true, applied: {}, suggested: {}, details: [] },
  }
  globalThis.fetch = async (url) => ({ ok: true, json: async () => bodies[String(url)] })
  try {
    const { seats } = await boot({ react: React })
    const tree = await mount(seats['jev-kit'])
    const text = textOf(tree)
    assert.match(text, /执行效果/)
    assert.match(text, /143 次判定/)
    assert.match(text, /4310 行/)
    assert.match(text, /估算/, 'the dollar figure must be labelled an estimate')
    assert.match(text, /37/, 'calls saved by the cache are worth showing')
    assert.match(text, /降级 2 次/)
    assert.match(text, /没有判定就放行了/, 'fail-open must not read as "nothing found"')
    assert.match(text, /auto 78/, 'the automatic lane is visible as an entry point')
    assert.match(text, /hook 40/)
    assert.match(text, /abc-session 25/)
    assert.match(text, /route · evidence_check · bug_triage/, 'zero-call channels are named, not counted')

    const cellsOf = (row) => (row.children ?? []).filter((child) => child && child.type === 'td').map(textOf)
    const table = find(tree, (node) => node.type === 'tr').map(cellsOf).filter((cells) => cells.length > 1)
    const privateRow = table.find((cells) => cells[1] === 'private_scan')
    assert.ok(privateRow, 'the channel row renders')
    assert.equal(privateRow[6], '37', 'cached column')
    assert.equal(privateRow[7], '5/6', 'acted column: adopted out of reported')
    const retryRow = table.find((cells) => cells[1] === 'retry')
    assert.equal(retryRow[6], '0', 'no cache hits is a real zero and may be printed as one')
    assert.equal(retryRow[7], '未回填', 'no report is not 0% — that would accuse the channel of being ignored')
  } finally {
    delete globalThis.fetch
  }
})

test('a report with nothing in it still answers "is it working" with a reason', async () => {
  /*
   * The empty window is its own answer, not a blank panel: a card that shows nothing at
   * all cannot be told apart from a card that failed to load.
   */
  const { React, mount } = liveReact()
  const bodies = {
    '/dsh-jev-kit/api/status': { version: '0.17.6', enabled: true, channels: 25, key: { configured: true, source: 'credential:file' }, budget: {} },
    '/dsh-jev-kit/api/report?days=7': { ok: true, days: 7, report: { total: 0, window: { days: 7, records: 0 }, cost: { usd: 0, inputTokens: 0, savedCalls: 0 }, health: { degraded: 0, errors: 0 }, byEntry: [], unusedChannels: [] } },
    '/dsh-jev-kit/api/thresholds': { ok: true, applied: {}, suggested: {}, details: [] },
  }
  globalThis.fetch = async (url) => ({ ok: true, json: async () => bodies[String(url)] })
  try {
    const { seats } = await boot({ react: React })
    const text = textOf(await mount(seats['jev-kit']))
    assert.match(text, /还没有判定记录/, 'an empty window says so')
    assert.match(text, /还没有判定——所以这里也没有入口/, 'and the entry-point block explains itself instead of being blank')
    assert.match(text, /无（每个通道都被调用过）/, 'an empty unused-list is not an empty string')
    assert.match(text, /没有降级、没有出错/, 'and zero problems is stated, not implied')
  } finally {
    delete globalThis.fetch
  }
})

test('the bundle is a ModuleLoader bundle, not an ES module', () => {
  const source = fs.readFileSync(bundlePath, 'utf8')
  assert.match(source, /__ModuleLoader__\.load\(/)
  assert.doesNotMatch(source, /^\s*(import|export)\s/m, 'no import/export: the loader would reject it')
})
