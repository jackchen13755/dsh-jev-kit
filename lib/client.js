/**
 * dsh-jev-kit browser half: the toolkit's own card.
 *
 * Hand-written lazy-CJS bundle (`window.__ModuleLoader__.load`), no build step,
 * no imports beyond React — the same reasoning as the lens card: the published
 * `@deepseek-ai/dsh-*` packages lag the running harness, and depending on one
 * would couple this card to a stale signature.
 *
 * It mounts in `settings.section` (where a person goes looking for the plugin)
 * and in `plugins.bundle.config` (the plugin's own page), each in its own try so
 * one absent seat cannot take the other down.
 *
 * What it shows is deliberately the *only* thing that decides whether this
 * toolkit earns its place: **per-channel evidence**. A channel that has run
 * enough times and never produced a non-neutral verdict is dead weight, and the
 * card says so in colour rather than leaving the reader to eyeball a table.
 *
 * Routes it talks to (all owned by the host half):
 *
 *   GET  /dsh-jev-kit/api/status        what the plugin is doing right now
 *   GET  /dsh-jev-kit/api/report?days=N the ledger, aggregated per channel
 *   POST /dsh-jev-kit/api/config        the on/off switch and the caps
 *
 * No key handling here on purpose: the kit shares `TYPESAFE_API_KEY` with
 * dsh-jev-lens, so the credential box lives in exactly one card.
 *
 * @module dsh-jev-kit/client
 */

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-jev-kit',
  factory: (require) => {
    'use strict'

    /** Sample size below which a channel's silence means nothing. */
    const MIN_SAMPLE = 20

    const S = {
      zh: {
        title: 'Jev 决策工具箱',
        intent: '21+ 个具名判断：隐私扫描 / 改动范围 / 记忆路由 / 批量分诊 / agent 循环检查。纯建议，不拦截。',
        loading: '读取中…',
        unreachable: '读不到插件状态',
        enabled: '启用（关闭后不再发出任何判定请求）',
        days: '账本窗口',
        refresh: '刷新',
        copy: '复制 Markdown',
        copied: '已复制',
        status: '状态',
        keyMissing: '⚠️ 未解析到 key：所有判定都会被跳过（fail-open，不会卡住任何一轮）',
        channels: '通道',
        report: '账本（按通道）',
        empty: '还没有判定记录。先用起来，再回来看这张表——这张表唯一的用途是淘汰通道。',
        colChannel: '通道',
        colGroup: '组',
        colN: '次数',
        colFlag: '⛔',
        colWarn: '⚠️',
        colP50: 'p50',
        colP95: 'p95',
        verdictUseful: '有命中',
        verdictWarn: '只有警告',
        verdictRetire: '样本够但从未产生非中性判定 → 建议淘汰或改问句',
        verdictThin: '样本不足',
        retireHead: (n) => `⚠️ ${n} 个通道样本已够却从未产生非中性判定——这是本表唯一的行动项`,
        healthy: '✅ 暂无需淘汰的通道（有命中的继续用，样本不足的再攒）',
        noRecords: '还没有判定记录（先用起来）',
        skipped: '跳过原因',
        noSkips: '无（每次调用都走到了判定）',
        catalogue: '通道目录',
        ledger: '账本目录',
        budget: '今日用量',
        saveFailed: '保存失败',
        saved: '已保存',
        scanStaged: '扫描暂存改动',
        scanning: '扫描中…',
        scanClean: '暂存改动未发现语义泄漏',
        thresholds: '阈值（语料拟合）',
        applyThresholds: '应用建议阈值',
        appliedThresholds: '已应用',
        noThresholds: '还没有拟合结果。跑一次基准（POST /api/bench）后再来。',
        colCurrent: '现用',
        colSuggested: '建议',
        colCV: '交叉验证',
        colN: 'n',
        drift: (list) => `⚠️ 这些通道的问句在拟合之后改过，旧阈值不再适用：${list}`,
      },
      en: {
        title: 'Jev decision toolkit',
        intent: 'Named typed judgments: privacy scan / change scope / memory routing / batch triage / agent-loop checks. Advisory only.',
        loading: 'loading…',
        unreachable: 'plugin status unavailable',
        enabled: 'Enabled (off means no judgment is ever requested)',
        days: 'Ledger window',
        refresh: 'Refresh',
        copy: 'Copy Markdown',
        copied: 'copied',
        status: 'Status',
        keyMissing: '⚠️ No key resolved: every judgment is skipped (fail-open, nothing hangs)',
        channels: 'channels',
        report: 'Ledger (by channel)',
        empty: 'No judgments recorded yet. Use it first, then read this table — its only job is to retire channels.',
        colChannel: 'channel',
        colGroup: 'grp',
        colN: 'n',
        colFlag: '⛔',
        colWarn: '⚠️',
        colP50: 'p50',
        colP95: 'p95',
        verdictUseful: 'found things',
        verdictWarn: 'warnings only',
        verdictRetire: 'enough samples, never non-neutral → retire or reword',
        verdictThin: 'too few samples',
        retireHead: (n) => `⚠️ ${n} channel(s) have run enough and never produced a non-neutral verdict — the only action item`,
        healthy: '✅ Nothing to retire yet',
        noRecords: 'no judgments recorded yet',
        skipped: 'Skip reasons',
        noSkips: 'none (every call reached a judgment)',
        catalogue: 'Catalogue',
        ledger: 'Ledger directory',
        budget: 'Today',
        saveFailed: 'save failed',
        saved: 'saved',
        scanStaged: 'Scan staged changes',
        scanning: 'scanning…',
        scanClean: 'no semantic leak found in staged changes',
        thresholds: 'Thresholds (fitted from corpus)',
        applyThresholds: 'Apply suggested',
        appliedThresholds: 'applied',
        noThresholds: 'No fit recorded yet — run the benchmark (POST /api/bench) first.',
        colCurrent: 'current',
        colSuggested: 'suggested',
        colCV: 'cross-val',
        colN: 'n',
        drift: (list) => `⚠️ wording changed after the fit, so those thresholds no longer apply: ${list}`,
      },
    }

    const langOf = (ctx) => {
      const raw = ctx?.locale?.current ?? ctx?.locale?.lang ?? ctx?.locale?.locale ?? ''
      return String(raw).toLowerCase().startsWith('en') ? 'en' : 'zh'
    }

    /**
     * The one judgement this card makes, as a pure function.
     *
     * Colour means something specific here, and it is not "good/bad":
     *
     *   · `flag`   — the channel has caught something. That is its value, and a
     *                human should look at what it caught.
     *   · `warn`   — its milder sibling.
     *   · `retire` — it has enough samples and has *never* been non-neutral. The
     *                work is to delete it or reword it, not to keep paying for it.
     *   · `unknown`— too few samples to say anything; deliberately not coloured,
     *                because an unmeasured thing must not look measured.
     *
     * @param {object} report - aggregate from `GET /api/report`.
     * @param {object} t - active strings.
     * @returns {{level: string, text: string, rows: Array<object>, retire: number}}
     */
    function classify (report, t) {
      const channels = Array.isArray(report?.channels) ? report.channels : []
      const rows = channels.map((row) => {
        const n = Number(row.n ?? 0)
        const flagged = Number(row.flagged ?? 0)
        const warn = Number(row.warn ?? 0)
        const level = flagged > 0 ? 'bad' : warn > 0 ? 'warn' : n >= MIN_SAMPLE ? 'retire' : 'unknown'
        const label = level === 'bad' ? t.verdictUseful : level === 'warn' ? t.verdictWarn : level === 'retire' ? t.verdictRetire : t.verdictThin
        return { channel: row.channel, group: row.group ?? '?', n, flagged, warn, p50: row.latency?.p50 ?? 0, p95: row.latency?.p95 ?? 0, level, label }
      })
      const retire = rows.filter((row) => row.level === 'retire').length
      const total = Number(report?.total ?? 0)
      if (!total) return { level: 'unknown', text: t.noRecords, rows, retire: 0 }
      if (retire) return { level: 'warn', text: t.retireHead(retire), rows, retire }
      return { level: 'ok', text: t.healthy, rows, retire: 0 }
    }

    /** The Markdown a person pastes into a commit message or an issue. */
    function toMarkdown (report, status, rows, t) {
      const lines = [
        `### ${t.title}${status?.version ? ` v${status.version}` : ''}`,
        '',
        `| ${t.colChannel} | ${t.colGroup} | ${t.colN} | ${t.colFlag} | ${t.colWarn} | ${t.colP50} | ${t.colP95} |`,
        '|---|---|---|---|---|---|---|',
      ]
      for (const row of rows) lines.push(`| ${row.channel} | ${row.group} | ${row.n} | ${row.flagged} | ${row.warn} | ${row.p50}ms | ${row.p95}ms |`)
      if (!rows.length) lines.push('| (none) | | | | | | |')
      lines.push('', `total ${report?.total ?? 0} · ${t.days} ${report?.window?.days ?? 0}d`)
      return lines.join('\n')
    }

    /** @param {object} React @param {object} ctx */
    function makeCard (React, ctx) {
      const h = React.createElement

      /* ── the card's visual vocabulary (shared with the lens card) ────── */
      const card = { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px', lineHeight: 1.55 }
      const label = { fontSize: '12px', fontWeight: 600, opacity: 0.75 }
      const muted = { fontSize: '12px', opacity: 0.65 }
      const divider = { borderTop: '1px solid rgba(127,127,127,0.25)', paddingTop: '10px', marginTop: '2px', display: 'flex', flexDirection: 'column', gap: '8px' }
      const row = { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }
      const cell = { padding: '3px 8px', textAlign: 'left', whiteSpace: 'nowrap' }
      const cellNum = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
      const table = { borderCollapse: 'collapse', width: '100%', fontSize: '12px' }
      const headCell = { ...cell, opacity: 0.7, fontWeight: 600, borderBottom: '1px solid rgba(127,127,127,0.3)' }
      const TONE = { ok: '#3fb950', warn: '#d29922', bad: '#f85149', retire: '#8b949e', unknown: 'inherit' }
      const toneStyle = (level) => (level === 'unknown' ? { color: 'inherit', opacity: 0.65 } : { color: TONE[level] ?? 'inherit' })

      const button = (text, disabled, onClick) => h('button', {
        type: 'button',
        disabled: disabled === true,
        onClick,
        style: { fontSize: '12px', padding: '4px 10px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', cursor: disabled === true ? 'default' : 'pointer', opacity: disabled === true ? 0.5 : 1 },
      }, text)

      const toggle = (text, on, disabled, onToggle) => h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', opacity: disabled === true ? 0.5 : 1 } },
        h('input', { type: 'checkbox', checked: on === true, disabled: disabled === true, onChange: (event) => onToggle(event.target.checked) }),
        h('span', null, text))

      const Card = () => {
        const [lang, setLang] = React.useState(() => langOf(ctx))
        const [status, setStatus] = React.useState(null)
        const [report, setReport] = React.useState(null)
        const [thresholds, setThresholds] = React.useState(null)
        const [days, setDays] = React.useState(7)
        const [note, setNote] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const t = S[lang] ?? S.zh

        const load = React.useCallback(async (window_) => {
          setBusy(true)
          try {
            const [statusResponse, reportResponse, thresholdResponse] = await Promise.all([
              fetch('/dsh-jev-kit/api/status', { headers: { accept: 'application/json' } }),
              fetch(`/dsh-jev-kit/api/report?days=${window_}`, { headers: { accept: 'application/json' } }),
              fetch('/dsh-jev-kit/api/thresholds', { headers: { accept: 'application/json' } }),
            ])
            if (statusResponse.ok) setStatus(await statusResponse.json())
            if (reportResponse.ok) setReport(await reportResponse.json())
            if (thresholdResponse.ok) setThresholds(await thresholdResponse.json())
            setNote('')
          } catch (error) {
            setNote(String(error && error.message ? error.message : error))
          } finally {
            setBusy(false)
          }
        }, [])

        React.useEffect(() => { void load(days) }, [load, days])
        React.useEffect(() => { setLang(langOf(ctx)) }, [ctx])

        /** Write one settings patch and report honestly whether it landed. */
        const write = async (patch) => {
          try {
            const response = await fetch('/dsh-jev-kit/api/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch),
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok || body.ok !== true) { setNote(`${t.saveFailed}: ${body.error ?? response.status}`); return }
            setNote(t.saved)
            await load(days)
          } catch (error) {
            setNote(`${t.saveFailed}: ${error && error.message ? error.message : error}`)
          }
        }

        const verdict = classify(report, t)
        const keyConfigured = status?.key?.configured === true
        const rows = verdict.rows

        const children = [
          h('div', { key: 'head', style: label }, t.title),
          h('div', { key: 'intent', style: muted }, t.intent),
        ]

        if (note) children.push(h('div', { key: 'note', style: { fontSize: '12px', opacity: 0.8 } }, note))

        children.push(h('div', { key: 'status', style: row },
          h('span', { style: label }, t.status),
          status === null
            ? h('span', { style: muted }, busy ? t.loading : t.unreachable)
            : h('span', null, `v${status.version} · ${status.channels} ${t.channels} · key=${status.key?.source ?? '?'}${status.enabled === false ? ' · OFF' : ''}`),
          h('span', { style: muted }, `${t.budget} ${status?.budget?.dayCalls ?? 0}/${status?.budget?.dailyCallLimit ?? '—'}`)))

        if (status !== null && !keyConfigured) children.push(h('div', { key: 'nokey', style: { fontSize: '12px', color: TONE.warn } }, t.keyMissing))

        children.push(h('div', { key: 'controls', style: divider },
          toggle(t.enabled, status?.enabled === true, status === null, (next) => { void write({ enabled: next }) }),
          h('div', { style: row },
            h('span', { style: label }, t.days),
            ...[1, 7, 30].map((window_) => button(`${window_}d`, busy, () => setDays(window_))),
            button(t.refresh, busy, () => { void load(days) }),
            button(t.scanStaged, busy, async () => {
              /*
               * The button exists for the same reason the hook does: the channel was
               * called twice in a session because it required someone to remember.
               * Here the work is one click, and the result lands in the note line.
               */
              setBusy(true)
              try {
                const response = await fetch('/dsh-jev-kit/api/scan-staged', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
                const body = await response.json().catch(() => ({}))
                if (body.ok !== true) setNote(String(body.error ?? response.status))
                else if (!body.flagged) setNote(t.scanClean)
                else setNote(`${body.flagged} 处疑似泄漏：${(body.findings ?? []).map((f) => `${f.where} ${f.headline}`).join(' · ')}`)
              } catch (error) {
                setNote(String(error && error.message ? error.message : error))
              } finally {
                setBusy(false)
              }
            }),
            button(t.copy, report === null, () => {
              const markdown = toMarkdown(report, status, rows, t)
              void (navigator.clipboard?.writeText(markdown) ?? Promise.resolve()).then(() => setNote(t.copied))
            }))))

        children.push(h('div', { key: 'report', style: divider },
          h('div', { style: label }, t.report),
          h('div', { style: toneStyle(verdict.level) }, verdict.text),
          h('table', { style: table },
            h('thead', null, h('tr', null,
              h('th', { style: headCell }, t.colChannel),
              h('th', { style: headCell }, t.colGroup),
              h('th', { style: cellNum }, t.colN),
              h('th', { style: cellNum }, t.colFlag),
              h('th', { style: cellNum }, t.colWarn),
              h('th', { style: cellNum }, t.colP50),
              h('th', { style: cellNum }, t.colP95))),
            h('tbody', null, ...(rows.length
              ? rows.map((entry) => h('tr', { key: entry.channel, style: toneStyle(entry.level), title: entry.label },
                h('td', { style: cell }, entry.channel),
                h('td', { style: cell }, entry.group),
                h('td', { style: cellNum }, entry.n),
                h('td', { style: cellNum }, entry.flagged),
                h('td', { style: cellNum }, entry.warn),
                h('td', { style: cellNum }, `${entry.p50}ms`),
                h('td', { style: cellNum }, `${entry.p95}ms`)))
              : [h('tr', { key: 'empty' }, h('td', { style: { ...cell, opacity: 0.7 }, colSpan: 7 }, t.empty))])))))

        children.push(h('div', { key: 'skips', style: divider },
          h('div', { style: label }, t.skipped),
          h('div', { style: muted }, (status?.reasons ?? []).length
            ? (status.reasons ?? []).map(([why, n]) => `${n} × ${why}`).join(' · ')
            : t.noSkips)))

        children.push(h('div', { key: 'thresholds', style: divider },
          h('div', { style: label }, t.thresholds),
          thresholds === null || !Object.keys(thresholds.suggested ?? {}).length
            ? h('div', { style: muted }, t.noThresholds)
            : h('div', null,
              (thresholds.wordingDrift ?? []).length ? h('div', { style: { fontSize: '12px', color: TONE.warn } }, t.drift((thresholds.wordingDrift ?? []).join(', '))) : null,
              h('table', { style: table },
                h('thead', null, h('tr', null,
                  h('th', { style: headCell }, t.colChannel),
                  h('th', { style: cellNum }, t.colCurrent),
                  h('th', { style: cellNum }, t.colSuggested),
                  h('th', { style: cellNum }, t.colCV),
                  h('th', { style: cellNum }, t.colN))),
                h('tbody', null, ...(thresholds.details ?? []).map((fit) => h('tr', { key: fit.channel },
                  h('td', { style: cell }, fit.channel),
                  h('td', { style: cellNum }, Number(fit.current).toFixed(2)),
                  h('td', { style: cellNum, color: TONE.retire }, Number(fit.recommended).toFixed(2)),
                  h('td', { style: cellNum }, `${Math.round(Number(fit.accuracyCrossVal) * 100)}%`),
                  h('td', { style: cellNum }, fit.n)))),
              h('div', { style: row }, button(t.applyThresholds, busy, () => { void write({ thresholds: thresholds.suggested }) }))))))

        children.push(h('details', { key: 'catalogue', style: divider },
          h('summary', { style: label }, `${t.catalogue}（${status?.channels ?? 0}）`),
          h('div', { style: muted }, (status?.catalogue ?? []).join(' · ') || '—')))

        children.push(h('div', { key: 'foot', style: muted }, `${t.ledger}: ${status?.ledger ?? '—'}`))

        return h('div', { style: card }, ...children)
      }

      return Card
    }

    return {
      // React plus `fetch` is the whole dependency surface.
      inject: ['slots', 'locale'],
      /** Exposed for the offline smoke test: the colour rules are what can be wrong without looking wrong. */
      __internals: { classify, toMarkdown, S, MIN_SAMPLE },
      apply (ctx) {
        const slots = ctx.slots
        if (slots === undefined || typeof slots.inject !== 'function') return
        const React = require('react')
        const Card = makeCard(React, ctx)
        try {
          slots.inject('settings.section', () => slots.register({
            name: 'settings.section',
            id: 'jev-kit',
            order: 45,
            label: () => 'Jev 决策工具箱',
          }, Card))
        } catch { /* section seat absent on this harness build: the plugin page still mounts */ }
        try {
          slots.inject('plugins.bundle.config', () => slots.register({
            name: 'plugins.bundle.config',
            key: '@dsh-external/dsh-jev-kit',
          }, Card))
        } catch { /* plugin page seat absent: the section above still mounts */ }
      },
    }
  },
})
