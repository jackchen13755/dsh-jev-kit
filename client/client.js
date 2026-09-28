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

    /**
     * The host's verdict (`lib/ledger.js` `verdictOf`) mapped onto this card's tones.
     *
     * The verdict is computed host-side so the card, the copied Markdown and the tool
     * cannot disagree; the local rule below stays only as the fallback for a payload
     * that does not carry one.
     */
    const HOST_LEVEL = { useful: 'bad', warn: 'warn', retire: 'retire', thin: 'unknown' }

    /**
     * Colour marker per tone.
     *
     * The card colours the whole row, but a row's colour does not survive being copied
     * into a commit message or a terminal — so every verdict also carries a symbol.
     */
    const MARK = { bad: '🔴', warn: '🟡', retire: '⬛', unknown: '⚪' }

    /** Separation below which a fitted cut is noise rather than calibration (mirrors `bench.js`). */
    const FITTABLE_SEPARATION = 0.75

    /** Colour marker per fit verdict (`bench.js` `FIT_VERDICT_MARK`). */
    const TRUST_MARK = { adjustable: '🟢', optimal: '⚪', noisy: '⬛' }

    /**
     * Which of the three states a fitted cut is in.
     *
     * Prefers the host's verdict (`bench.js` `fitVerdictOf`, which the thresholds route
     * sends on every row) and recomputes only for a payload that predates the field.
     * Showing a raw "建议" without this is how a table talks someone into retuning a
     * channel the kit itself refuses to retune.
     */
    const fitLevel = (fit) => {
      if (fit?.level) return fit.level
      if (Number(fit?.separation ?? 0) < FITTABLE_SEPARATION) return 'noisy'
      const gain = Number(fit?.accuracyFitted ?? 0) - Number(fit?.accuracyNow ?? 0)
      return fit?.trustworthy === true && fit?.changes !== false && gain > 0.02 ? 'adjustable' : 'optimal'
    }

    /**
     * Which suggested cuts would actually move the cut in force.
     *
     * `suggested` is the host's *apply-ready* table — trustworthy fits only — and it is
     * routinely **empty**: on this machine all eight recorded fits failed held-out
     * validation, so every cut in force is already the one the corpus supports. The card
     * rendered a live button for that state anyway, and `POST {thresholds:{}}` merges
     * nothing and answers `ok: true`, so the click changed nothing anywhere.
     *
     * A button whose only possible outcome is "nothing" must not look pressable. This is
     * also why the button sends the *difference* rather than the raw table: a key already
     * at its suggested value is not a change, and reporting it as one is the same lie in
     * a smaller place.
     *
     * @param {object} thresholds - the `GET /api/thresholds` body.
     * @returns {Array<{key: string, from: number|null, to: number}>} the real changes.
     */
    function thresholdChanges (thresholds) {
      const applied = thresholds?.applied ?? {}
      const changes = []
      for (const [key, cut] of Object.entries(thresholds?.suggested ?? {})) {
        const to = Number(cut)
        if (!Number.isFinite(to)) continue
        const from = Number(applied[key])
        if (Number.isFinite(from) && Math.abs(from - to) < 1e-9) continue
        changes.push({ key, from: Number.isFinite(from) ? from : null, to })
      }
      return changes
    }

    /**
     * Split an intended change into what the host's echo says landed and what did not.
     *
     * Checked against `settings.thresholds` rather than assumed from a 200: this endpoint
     * answers `ok: true` for a patch that merges to nothing, so "the request succeeded"
     * and "the cut moved" are two different facts and only the second one is news.
     *
     * @param {Array<{key: string, to: number}>} changes - what was sent.
     * @param {object} landed - `settings.thresholds` from the response.
     */
    function appliedNote (changes, landed) {
      const moved = []
      const missed = []
      for (const change of changes) {
        const now = Number(landed?.[change.key])
        if (Number.isFinite(now) && Math.abs(now - change.to) < 1e-9) moved.push(change)
        else missed.push(change)
      }
      return { moved, missed }
    }

    /** One change as `key 0.60 → 0.43`, with `—` for a key that had no cut before. */
    const changeLabel = (change) => `${change.key} ${change.from === null ? '—' : change.from.toFixed(2)} → ${change.to.toFixed(2)}`

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
        colVerdict: '判定',
        colChannel: '通道',
        colGroup: '组',
        colN: '次数',
        colFlag: '⛔',
        colWarn: '⚠️',
        colCached: '缓存',
        colActed: '采纳',
        colP50: 'p50',
        colP95: 'p95',
        legend: '🔴 有命中（去看它抓到了什么）· 🟡 只有 warn（观察）· ⬛ 样本够了却从未非中性（淘汰或改问句——本表唯一的行动项）· ⚪ 样本不足（不表态）· 缓存 = 同输入重复问时省下的调用 · 采纳 = 判定被真正用上的比例（**只有调用方回填才知道，没回填显示「未回填」而不是 0%**）',
        effect: '执行效果（这个插件到底干了什么）',
        effectTotals: (o) => `${o.total} 次判定 · 账本窗口 ${o.days} 天共 ${o.records} 行`,
        effectCost: (o) => `花费**估算** $${o.usd}（${o.inputTokens} 输入 token，按字符数 ÷ 4 估的，不是实测）· 缓存省下 ${o.savedCalls} 次调用`,
        effectHealthOk: '✅ 没有降级、没有出错',
        effectHealth: (o) => `⚠️ 降级 ${o.degraded} 次（= **没有判定就放行了**，fail-open；不等于"没问题"）· 出错 ${o.errors} 次`,
        byEntry: '谁在调用（入口分布）',
        byEntryNone: '还没有判定——所以这里也没有入口',
        unused: '从未触发的通道（与 ⬛ 是一对：零调用 vs 从不表态，都是退役候选）',
        unusedNone: '无（每个通道都被调用过）',
        actedNotReported: '未回填',
        prune: '剪枝试跑（贴一段工具输出，看它怎么剪）',
        pruneHelp: '逐段判相关性 + 确定性信封。**只给方案，不改任何东西**；是否采用由你决定。需要宿主已是新版本（`POST /api/prune`）。',
        pruneTask: '任务（相关性目标）：例如「为什么 CI 上的 install 失败」',
        pruneText: '要剪的工具输出（整段粘贴）',
        pruneBudget: '预算字符',
        pruneRun: '试剪',
        pruneStaleHost: '宿主还是旧版本——这条路由要重启 DSH 之后才存在（当前卡片是新的、宿主是旧的）。重启后再来。',
        pruneOverview: (o) => o.note ? o.note : `${o.totalChars} 字符 / ${o.units} 段 → 保留 ${o.keptSegments} 段 / ${o.keptChars} 字符`,
        pruneSaved: (o) => o.droppedChars
          ? `相对「完全不剪」省下 ${o.droppedChars} 字符（${Math.round((o.droppedChars / Math.max(1, o.totalChars)) * 100)}%）；基线保留 ${o.baselineKeptChars}`
          : '没有可省的字符（预算够用，或有地板托底）',
        pruneRules: (o) => {
          const s = o.summary ?? {}
          const base = `边界保留 ${s.edge ?? 0} · 地板内保留 ${s.floor ?? 0} · 按分数保留 ${s.budget ?? 0} · 剪掉 ${s.dropped ?? 0} · 未判定 ${s.unjudged ?? 0}`
          const over = o.floorDecided ? ' · ⚠️ 结果超出预算（头尾与地板恒定保留，预算是软的）' : ''
          const deg = o.degraded ? ` · ⚠️ 有 ${o.degraded} 段未能判定（按中性处理，没被优先剪掉）` : ''
          return base + over + deg
        },
        colPruneIndex: '#',
        colPrunePreview: '段（截前 90 字）',
        colPruneScore: 'needed',
        colPruneDecision: '决定',
        decisionLabel: { edge: '边界保留', floor: '地板内保留', budget: '按分数保留', dropped: '剪掉' },
        pruneDecisionLegend: '决定栏读法：**边界保留** = 头尾规则钉住（与分数无关）· **地板内保留** = 在达到地板之前收入，此时预算根本没被咨询（分数决定的是顺序，不是去留）· **按分数保留** = 地板达标后按分数装进预算 · **剪掉** = 未保留',
        pruneKept: '剪枝后的文本（可复制）',
        pruneNoSegments: '没有可判定的分段（内容太短或只有一段）。',
        pruneHonesty: 'needed 是**排序信号不是概率**（实测刻度压缩在 0.16–0.9，真错误 0.92、无关的 deprecated 警告 0.64–0.72）。所以规则永远优先于分数：头尾恒定保留、地板优先于预算、绝不剪空。',
        colFit: '调整',
        fitLegend: '🟢 可调整（分离度够 + 留出折上收益 > 2 点）· ⚪ 无需改动（现值已接近留出折最优）· ⬛ 不可拟合（分离度 < 0.75，照改就是过拟合）',
        axisNote: '按轴刀口（优先于通道级，且应用建议时会保留）',
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
        credentials: 'Jev 凭据（两个插件共用）',
        keyHelp: '粘贴 TypeSafe API key。写入 DSH 凭据库（~/.dsh/.credentials.yaml，0600），lens 与 kit 共用同一把；任何路由都不会回显它。',
        keySave: '保存 key',
        keyClear: '清除',
        keySaved: '已保存，指纹',
        keyCleared: '已清除',
        keyMissing: '未配置',
        scanStaged: '扫描暂存改动',
        scanning: '扫描中…',
        scanClean: '暂存改动未发现语义泄漏',
        thresholds: '阈值（语料拟合）',
        applyThresholds: '应用建议阈值',
        appliedThresholds: '已应用',
        applyNothing: (n) => `没有可应用的改动：${n} 项拟合都是 ⚪/⬛（现值已是留出折最优，或分离度不足）——照改就是过拟合`,
        applyWill: (list) => `将写入（合并，按轴刀口会保留）：${list}`,
        noThresholds: '还没有拟合结果。跑一次基准（POST /api/bench）后再来。',
        colCurrent: '现用',
        colSuggested: '建议',
        colCV: '交叉验证',
        colScale: '刻度',
        colN: 'n',
        scaleLegend: '刻度 = 分数当概率读有多准。**Brier** 越小越好，但必须跟该通道自己的**基线**比（基线 = 恒答本通道正例率的得分；平衡语料上正是 0.25）——' +
          '**技能 = 1 − Brier/基线**，0 表示不比"恒答基率"更强。单元格悬停可看 ECE / 最大偏差 / n。' +
          '**刻度差 ≠ 通道有错**：它说明这个通道的分数用来排序而不是当概率，所以刀口必须按它自己拟合——正是本表在做的事。' +
          '别因为刻度差就把刀口挪向 0.5，那是把排序信号当概率用。',
        scaleReading: (cal) => `Brier ${Number(cal.brier).toFixed(3)} · ECE ${Number(cal.ece).toFixed(3)} · 最大偏差 ${cal.maxGap === undefined || cal.maxGap === null ? '—（各段样本都不足，没算出可信的最差段）' : Number(cal.maxGap).toFixed(3)} · n=${cal.n}` +
          `${cal.skill === undefined || cal.skill === null ? '' : ` · 技能 ${Number(cal.skill).toFixed(2)}（基线 ${Number(cal.baseline).toFixed(3)}）`}` +
          `${cal.outOfRange ? ` · ⚠️ 越界 ${cal.outOfRange}` : ''}${cal.unusable ? ` · ⚠️ 不可用 ${cal.unusable}` : ''}`,
        scaleUnmeasured: '未测——这条拟合记录早于「刻度」功能（v0.17.3 之前写入的 bench.json）；重跑一次 bench 就会填上',
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
        colVerdict: 'verdict',
        colChannel: 'channel',
        colGroup: 'grp',
        colN: 'n',
        colFlag: '⛔',
        colWarn: '⚠️',
        colCached: 'cached',
        colActed: 'acted',
        colP50: 'p50',
        colP95: 'p95',
        legend: '🔴 found things (go read what it caught) · 🟡 warnings only (watch) · ⬛ enough samples, never non-neutral (retire or reword — the only action item) · ⚪ too few samples (no verdict) · cached = calls saved by answering the same input again · acted = share of verdicts actually used (**only known when the caller reports back, so an un-reported channel says "not reported", never 0%**)',
        effect: 'Effect (what this plugin actually did)',
        effectTotals: (o) => `${o.total} judgments · ledger window ${o.days}d, ${o.records} rows`,
        effectCost: (o) => `**estimated** cost $${o.usd} (${o.inputTokens} input tokens, chars ÷ 4 — an estimate, not a measurement) · cache saved ${o.savedCalls} calls`,
        effectHealthOk: '✅ no degradations, no errors',
        effectHealth: (o) => `⚠️ ${o.degraded} degradation(s) — **no judgment was made and the call went through** (fail-open, which is not the same as "nothing found") · ${o.errors} error(s)`,
        byEntry: 'Who is calling it (entry points)',
        byEntryNone: 'no judgments yet — so no entry points either',
        unused: 'Channels never triggered (the partner of ⬛: zero calls vs never spoke up — both are retirement candidates)',
        unusedNone: 'none (every channel has been called)',
        actedNotReported: 'not reported',
        prune: 'Prune try-out (paste a tool result and watch what it cuts)',
        pruneHelp: 'Per-segment relevance plus a deterministic envelope. **It returns a plan and changes nothing**; adopting it is your call. Needs a current host (`POST /api/prune`).',
        pruneTask: 'Task (the relevance target), e.g. "why did install fail on CI"',
        pruneText: 'The tool result to prune (paste it whole)',
        pruneBudget: 'budget chars',
        pruneRun: 'Try a prune',
        pruneStaleHost: 'The host is still the old build — this route only exists after a DSH restart (the card is new, the host is not). Come back after restarting.',
        pruneOverview: (o) => o.note ? o.note : `${o.totalChars} chars / ${o.units} segments → kept ${o.keptSegments} segments / ${o.keptChars} chars`,
        pruneSaved: (o) => o.droppedChars
          ? `saves ${o.droppedChars} chars vs pruning nothing (${Math.round((o.droppedChars / Math.max(1, o.totalChars)) * 100)}%); the baseline keeps ${o.baselineKeptChars}`
          : 'nothing to save (the budget was enough, or the floor covered it)',
        pruneRules: (o) => {
          const s = o.summary ?? {}
          const base = `edge-kept ${s.edge ?? 0} · within floor ${s.floor ?? 0} · kept on score ${s.budget ?? 0} · dropped ${s.dropped ?? 0} · unjudged ${s.unjudged ?? 0}`
          const over = o.floorDecided ? ' · ⚠️ over budget (head, tail and floor are pinned; the budget is soft)' : ''
          const deg = o.degraded ? ` · ⚠️ ${o.degraded} segment(s) unjudged (treated as neutral, not pruned first)` : ''
          return base + over + deg
        },
        colPruneIndex: '#',
        colPrunePreview: 'segment (first 90 chars)',
        colPruneScore: 'needed',
        colPruneDecision: 'decided',
        decisionLabel: { edge: 'edge-kept', floor: 'within floor', budget: 'kept on score', dropped: 'dropped' },
        pruneDecisionLegend: 'How to read the decision column: **edge-kept** = pinned by the head/tail rule, whatever the score · **within floor** = taken before the floor was reached, so the budget was never consulted (the score decided its *order*, not whether it stayed) · **kept on score** = taken on its own score once the floor was met · **dropped** = not kept',
        pruneKept: 'The pruned text (copyable)',
        pruneNoSegments: 'no judgeable segments (the content is too short, or it is one block).',
        pruneHonesty: '`needed` is a **ranking signal, not a probability** (measured: the scale compresses into 0.16–0.9 — the real error scored 0.92 while irrelevant `warn deprecated` lines scored 0.64–0.72). So the rules always outrank the scores: head and tail pinned, floor before budget, never empty.',
        colFit: 'adjust',
        fitLegend: '🟢 adjustable (separated + > 2 points gained on the held-out folds) · ⚪ no change needed (already near the held-out optimum) · ⬛ not fittable (separation < 0.75: following it is overfitting)',
        axisNote: 'per-axis cut (wins over the channel-level one, and an apply preserves it)',
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
        credentials: 'Jev credential (shared by both plugins)',
        keyHelp: 'Paste the TypeSafe API key. It is written to the DSH credential store (~/.dsh/.credentials.yaml, 0600) and shared by lens and kit; no route ever returns it.',
        keySave: 'Save key',
        keyClear: 'Clear',
        keySaved: 'saved, fingerprint',
        keyCleared: 'cleared',
        keyMissing: 'not configured',
        scanStaged: 'Scan staged changes',
        scanning: 'scanning…',
        scanClean: 'no semantic leak found in staged changes',
        thresholds: 'Thresholds (fitted from corpus)',
        applyThresholds: 'Apply suggested',
        appliedThresholds: 'applied',
        applyNothing: (n) => `nothing to apply: all ${n} fits are ⚪/⬛ (already at the held-out optimum, or separation too low to trust)`,
        applyWill: (list) => `will write (merged; per-axis cuts are kept): ${list}`,
        noThresholds: 'No fit recorded yet — run the benchmark (POST /api/bench) first.',
        colCurrent: 'current',
        colSuggested: 'suggested',
        colCV: 'cross-val',
        colScale: 'scale',
        colN: 'n',
        scaleLegend: 'Scale = how well the score reads as a probability. Lower **Brier** is better, but it must be read against this channel own **baseline** ' +
          '(the score of always answering the channel base rate; 0.25 exactly on a balanced corpus) — **skill = 1 − Brier/baseline**, where 0 means no better than the base rate. ' +
          'Hover a cell for ECE / max gap / n. **A bad scale is not a broken channel**: it means this score ranks rather than states a probability, so the cut has to be fitted per channel — ' +
          'which is what this table does. Never answer it by moving the cut toward 0.5; that reads a ranking signal as a probability.',
        scaleReading: (cal) => `Brier ${Number(cal.brier).toFixed(3)} · ECE ${Number(cal.ece).toFixed(3)} · max gap ${cal.maxGap === undefined || cal.maxGap === null ? '—' : Number(cal.maxGap).toFixed(3)} · n=${cal.n}` +
          `${cal.skill === undefined || cal.skill === null ? '' : ` · skill ${Number(cal.skill).toFixed(2)} (baseline ${Number(cal.baseline).toFixed(3)})`}` +
          `${cal.outOfRange ? ` · ⚠️ out of range ${cal.outOfRange}` : ''}${cal.unusable ? ` · ⚠️ unusable ${cal.unusable}` : ''}`,
        scaleUnmeasured: 'not measured — this fit record predates the scale feature (bench.json written before v0.17.3); one bench run fills it in',
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
        // Prefer the host's verdict; recompute only when the payload has none.
        const level = HOST_LEVEL[row.level] ?? (flagged > 0 ? 'bad' : warn > 0 ? 'warn' : n >= MIN_SAMPLE ? 'retire' : 'unknown')
        const label = level === 'bad' ? t.verdictUseful : level === 'warn' ? t.verdictWarn : level === 'retire' ? t.verdictRetire : t.verdictThin
        /*
         * `cached` and `acted` are what separate "it ran" from "it mattered": a judgment
         * served from cache cost nothing, and one nobody acted on is a verdict with no
         * effect. `acted` is only known when the caller reports back, so 0 means "not
         * reported" — which is a different, much milder claim than "0% adopted", and the
         * card must not print the strong one.
         */
        return {
          channel: row.channel,
          group: row.group ?? '?',
          n,
          flagged,
          warn,
          cached: Number(row.cached ?? 0),
          acted: Number(row.acted ?? 0),
          actedYes: Number(row.actedYes ?? 0),
          p50: row.latency?.p50 ?? 0,
          p95: row.latency?.p95 ?? 0,
          level,
          mark: MARK[level],
          label,
        }
      })
      const retire = rows.filter((row) => row.level === 'retire').length
      const total = Number(report?.total ?? 0)
      /*
       * The window's headline numbers, read straight off `summarize()` (`ledger.ts`).
       * They were always in the payload — the card simply never showed them, so "is this
       * plugin doing anything at all" could only be answered by opening the ledger by hand.
       */
      const overview = {
        total,
        records: Number(report?.window?.records ?? 0),
        days: Number(report?.window?.days ?? 0),
        usd: Number(report?.cost?.usd ?? 0),
        inputTokens: Number(report?.cost?.inputTokens ?? 0),
        savedCalls: Number(report?.cost?.savedCalls ?? 0),
        degraded: Number(report?.health?.degraded ?? 0),
        errors: Number(report?.health?.errors ?? 0),
        entries: Array.isArray(report?.byEntry)
          ? report.byEntry.map((entry) => ({ entry: String(entry?.entry ?? '?'), n: Number(entry?.n ?? 0), flag: Number(entry?.flag ?? 0) }))
          : [],
        unused: Array.isArray(report?.unusedChannels) ? report.unusedChannels.map(String) : [],
      }
      if (!total) return { level: 'unknown', text: t.noRecords, rows, retire: 0, overview }
      if (retire) return { level: 'warn', text: t.retireHead(retire), rows, retire, overview }
      return { level: 'ok', text: t.healthy, rows, retire: 0, overview }
    }

    /**
     * `GET /api/report` answers with an envelope — `{ok, days, report, markdown}` — while
     * `classify` and `toMarkdown` take the report itself.
     *
     * Reading the envelope as if it were the report fails *silently*: every field it
     * looks for is undefined, so a ledger with thousands of entries renders as "0
     * records · window 0d" and the copy button emits the same empty table. A false
     * all-clear on the one table whose only job is to retire channels, which is why this
     * is unwrapped explicitly instead of defaulting to `{}`.
     *
     * Only the report is enveloped: `/api/status` is flat, and `/api/thresholds` keeps
     * `applied`/`suggested`/`details` at the top level. Both shapes are tolerated here so
     * a route that stops wrapping does not break the card.
     *
     * @param {object} body - whatever `GET /api/report` returned.
     * @returns {object} the report.
     */
    function unwrapReport (body) {
      if (body !== null && typeof body === 'object' && body.report !== null && typeof body.report === 'object') return body.report
      return body
    }

    /** The Markdown a person pastes into a commit message or an issue. */
    function toMarkdown (report, status, rows, t) {
      const lines = [
        `### ${t.title}${status?.version ? ` v${status.version}` : ''}`,
        '',
        `| ${t.colVerdict} | ${t.colChannel} | ${t.colGroup} | ${t.colN} | ${t.colFlag} | ${t.colWarn} | ${t.colP50} | ${t.colP95} |`,
        '|---|---|---|---|---|---|---|---|',
      ]
      for (const row of rows) lines.push(`| ${row.mark} | ${row.channel} | ${row.group} | ${row.n} | ${row.flagged} | ${row.warn} | ${row.p50}ms | ${row.p95}ms |`)
      if (!rows.length) lines.push('| (none) | | | | | | | |')
      lines.push('', t.legend, `total ${report?.total ?? 0} · ${t.days} ${report?.window?.days ?? 0}d`)
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
        // Starts blank on every load: a credential box that prefills is one that leaks
        // to whoever is looking over the shoulder.
        const [keyDraft, setKeyDraft] = React.useState('')
        const [days, setDays] = React.useState(7)
        const [note, setNote] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        /* The prune try-out keeps its own state: it is the one action here that reads no
         * ledger and writes nothing, so a failure in it must not disturb the card's. */
        const [pruneTask, setPruneTask] = React.useState('')
        const [pruneText, setPruneText] = React.useState('')
        const [pruneBudget, setPruneBudget] = React.useState(4000)
        const [pruneOut, setPruneOut] = React.useState(null)
        const [pruneError, setPruneError] = React.useState('')
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
            if (reportResponse.ok) setReport(unwrapReport(await reportResponse.json()))
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

        /**
         * Write one settings patch and report honestly whether it landed.
         *
         * The reload runs **before** the note is set, and that order is the fix for a
         * dead-looking button: `load()` clears the note when it succeeds, so a note set
         * beforehand survived only as long as three localhost round trips and then
         * vanished — a save that worked and a click that did nothing looked identical.
         *
         * @param {object} patch - the settings patch.
         * @param {(body: object) => string} [report] - builds the note from the response.
         */
        const write = async (patch, report) => {
          try {
            const response = await fetch('/dsh-jev-kit/api/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch),
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok || body.ok !== true) { setNote(`${t.saveFailed}: ${body.error ?? response.status}`); return }
            await load(days)
            setNote(report ? report(body) : t.saved)
          } catch (error) {
            setNote(`${t.saveFailed}: ${error && error.message ? error.message : error}`)
          }
        }

        /**
         * Run one prune and show the whole execution: the per-segment scores, which rule
         * decided each one, and the accounting against "prune nothing".
         *
         * A 404 gets its own message rather than the generic failure, because it is the one
         * error here with an obvious cause and an obvious fix: the route lives in the *host*
         * half, which only changes on a DSH restart. Reporting "读不到接口" would send the
         * reader looking for a bug that is really a restart.
         */
        const runPrune = async () => {
          setBusy(true)
          setPruneError('')
          setPruneOut(null)
          try {
            const response = await fetch('/dsh-jev-kit/api/prune', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                task: pruneTask.trim(),
                text: pruneText,
                budgetChars: Number(pruneBudget) || 4000,
              }),
            })
            if (response.status === 404) { setPruneError(t.pruneStaleHost); return }
            const body = await response.json().catch(() => ({}))
            if (body.ok !== true) { setPruneError(String(body.error ?? response.status)); return }
            setPruneOut(body)
          } catch (error) {
            setPruneError(String(error && error.message ? error.message : error))
          } finally {
            setBusy(false)
          }
        }

        const verdict = classify(report, t)
        const overview = verdict.overview
        const keyConfigured = status?.key?.configured === true
        const rows = verdict.rows
        /** The apply-ready cuts that would really move something (often none — see `thresholdChanges`). */
        const changes = thresholdChanges(thresholds)

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

        /*
         * 「执行效果」— the answer to "is this plugin doing anything", before any of the
         * detail. Every number comes from `GET /api/report` (`summarize()`), which the card
         * had been receiving and discarding: without this, the only way to tell a working
         * plugin from an idle one was to read the ledger by hand.
         *
         * Two of them are deliberately loud rather than tidy:
         *   · `degraded` is printed in the warning tone because a degradation means **no
         *     judgment happened** — reading fail-open as "nothing found" is the exact
         *     mistake this instrument exists to prevent;
         *   · the cost is labelled an estimate, because tokens are not recorded per row
         *     (the host derives them from character counts) and a fabricated-precision
         *     dollar figure is worse than an honest approximation.
         */
        children.push(h('div', { key: 'effect', style: divider },
          h('div', { style: label }, t.effect),
          h('div', null, t.effectTotals(overview)),
          h('div', { style: muted }, t.effectCost(overview)),
          h('div', { style: overview.degraded || overview.errors ? { fontSize: '12px', color: TONE.warn } : muted },
            overview.degraded || overview.errors ? t.effectHealth(overview) : t.effectHealthOk),
          h('div', { style: label }, t.byEntry),
          h('div', { style: muted }, overview.entries.length
            ? overview.entries.map((entry) => `${entry.entry} ${entry.n}${entry.flag ? `（⛔${entry.flag}）` : ''}`).join(' · ')
            : t.byEntryNone),
          h('div', { style: label }, t.unused),
          h('div', { style: muted }, overview.unused.length ? overview.unused.join(' · ') : t.unusedNone)))

        /*
         * 「剪枝试跑」— one execution, end to end.
         *
         * The point is the third column of the result table: `decidedBy`. A prune that
         * shows only which segments survived leaves the reader guessing whether the safety
         * rules did anything or the scores decided everything — and on this corpus that is
         * exactly the question, since the relevance channel is a ranker whose margins are
         * thin. Naming the rule per segment turns the envelope from a promise into a
         * reading. It calls a route that returns a plan and writes nothing.
         */
        children.push(h('div', { key: 'prune', style: divider },
          h('div', { style: label }, t.prune),
          h('div', { style: muted }, t.pruneHelp),
          h('input', {
            type: 'text',
            value: pruneTask,
            placeholder: t.pruneTask,
            onChange: (event) => setPruneTask(event.target.value),
            style: { width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit' },
          }),
          h('textarea', {
            value: pruneText,
            placeholder: t.pruneText,
            rows: 4,
            onChange: (event) => setPruneText(event.target.value),
            style: { width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', fontFamily: 'inherit', resize: 'vertical' },
          }),
          h('div', { style: row },
            h('span', { style: label }, t.pruneBudget),
            h('input', {
              type: 'number',
              value: pruneBudget,
              onChange: (event) => setPruneBudget(event.target.value),
              style: { width: '96px', fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit' },
            }),
            button(t.pruneRun, busy || pruneTask.trim() === '' || pruneText.trim() === '', () => { void runPrune() })),
          pruneError ? h('div', { style: { fontSize: '12px', color: TONE.warn } }, pruneError) : null,
          pruneOut
            ? h('div', { key: 'prune-out', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('div', null, t.pruneOverview(pruneOut)),
              h('div', { style: muted }, t.pruneSaved(pruneOut)),
              h('div', { style: pruneOut.floorDecided || pruneOut.degraded ? { fontSize: '12px', color: TONE.warn } : muted }, t.pruneRules(pruneOut)),
              (pruneOut.segments ?? []).length
                ? h('table', { style: table },
                  h('thead', null, h('tr', null,
                    h('th', { style: cellNum }, t.colPruneIndex),
                    h('th', { style: headCell }, t.colPrunePreview),
                    h('th', { style: cellNum }, t.colPruneScore),
                    h('th', { style: headCell }, t.colPruneDecision))),
                  h('tbody', null, ...(pruneOut.segments ?? []).map((segment, index) => h('tr', { key: `${segment.where}-${index}` },
                    h('td', { style: cellNum }, index + 1),
                    h('td', { style: cell, title: segment.where }, segment.preview),
                    // An unjudged segment prints "—", not 0.00: the planner kept it as a
                    // neutral 0.5, and a printed zero would contradict what actually happened.
                    h('td', { style: cellNum }, segment.needed === null || segment.needed === undefined ? '—' : Number(segment.needed).toFixed(2)),
                    h('td', { style: segment.keep ? cell : { ...cell, opacity: 0.6 } }, (t.decisionLabel ?? {})[segment.decidedBy] ?? segment.decidedBy)))))
                : h('div', { style: muted }, t.pruneNoSegments),
              (pruneOut.segments ?? []).length ? h('div', { style: muted }, t.pruneDecisionLegend) : null,
              h('div', { style: label }, t.pruneKept),
              h('textarea', { readOnly: true, value: pruneOut.keptText ?? '', rows: 6, style: { width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', fontFamily: 'inherit' } }),
              h('div', { style: muted }, t.pruneHonesty))
            : null))

        children.push(h('div', { key: 'credential', style: divider },
          h('div', { style: label }, t.credentials),
          h('div', { style: muted }, t.keyHelp),
          h('div', { style: row },
            h('input', {
              type: 'password',
              value: keyDraft,
              autoComplete: 'off',
              'data-1p-ignore': 'true',
              placeholder: status?.key?.configured ? `${status.key.source} · ${status.key.fingerprint ?? ''}` : t.keyMissing,
              onChange: (event) => setKeyDraft(event.target.value),
              style: { flex: '1 1 320px', fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit' },
            }),
            button(t.keySave, keyDraft.trim() === '', async () => {
              const response = await fetch('/dsh-jev-kit/api/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: keyDraft.trim() }) })
              const body = await response.json().catch(() => ({}))
              // Reload first, then speak: `load()` clears the note when it succeeds, so a
              // note set before it was gone before anyone could read it — the same race
              // that made the apply button look dead.
              if (body.ok !== true) { setNote(String(body.error ?? response.status)); await load(days); return }
              await load(days)
              setNote(`${t.keySaved} ${body.key?.fingerprint ?? ''}`)
              setKeyDraft('')
            }),
            button(t.keyClear, status?.key?.configured !== true, async () => {
              const response = await fetch('/dsh-jev-kit/api/key/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
              const body = await response.json().catch(() => ({}))
              await load(days)
              setNote(body.ok === true ? t.keyCleared : String(body.error ?? response.status))
            }))))

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
              h('th', { style: headCell }, t.colVerdict),
              h('th', { style: headCell }, t.colChannel),
              h('th', { style: headCell }, t.colGroup),
              h('th', { style: cellNum }, t.colN),
              h('th', { style: cellNum }, t.colFlag),
              h('th', { style: cellNum }, t.colWarn),
              h('th', { style: cellNum }, t.colCached),
              h('th', { style: cellNum }, t.colActed),
              h('th', { style: cellNum }, t.colP50),
              h('th', { style: cellNum }, t.colP95))),
            h('tbody', null, ...(rows.length
              ? rows.map((entry) => h('tr', { key: entry.channel, style: toneStyle(entry.level), title: entry.label },
                h('td', { style: cell }, entry.mark),
                h('td', { style: cell }, entry.channel),
                h('td', { style: cell }, entry.group),
                h('td', { style: cellNum }, entry.n),
                h('td', { style: cellNum }, entry.flagged),
                h('td', { style: cellNum }, entry.warn),
                h('td', { style: cellNum }, entry.cached),
                /*
                 * `0` is not "0% adopted" — it is "nobody reported back", which is the
                 * normal state for an advisory tool nobody wired a feedback loop into.
                 * Printing 0% there would accuse every channel of being ignored.
                 */
                h('td', { style: cellNum }, entry.acted === 0 ? t.actedNotReported : `${entry.actedYes}/${entry.acted}`),
                h('td', { style: cellNum }, `${entry.p50}ms`),
                h('td', { style: cellNum }, `${entry.p95}ms`)))
              : [h('tr', { key: 'empty' }, h('td', { style: { ...cell, opacity: 0.7 }, colSpan: 10 }, t.empty))]))),
          h('div', { style: muted }, t.legend)))

        children.push(h('div', { key: 'skips', style: divider },
          h('div', { style: label }, t.skipped),
          h('div', { style: muted }, (status?.reasons ?? []).length
            ? (status.reasons ?? []).map(([why, n]) => `${n} × ${why}`).join(' · ')
            : t.noSkips)))

        children.push(h('div', { key: 'thresholds', style: divider },
          h('div', { style: label }, t.thresholds),
          /*
           * A fit exists when there are rows — NOT when there is something to apply.
           * `suggested` holds only the apply-ready subset, so gating the whole section
           * on it told the reader "run a benchmark" while a perfectly good fit sat in
           * `details` saying nothing needed changing.
           */
          !(thresholds?.details ?? []).length
            ? h('div', { style: muted }, t.noThresholds)
            : h('div', null,
              (thresholds.wordingDrift ?? []).length ? h('div', { style: { fontSize: '12px', color: TONE.warn } }, t.drift((thresholds.wordingDrift ?? []).join(', '))) : null,
              h('table', { style: table },
                h('thead', null, h('tr', null,
                  h('th', { style: headCell }, t.colFit),
                  h('th', { style: headCell }, t.colChannel),
                  h('th', { style: cellNum }, t.colCurrent),
                  h('th', { style: cellNum }, t.colSuggested),
                  h('th', { style: cellNum }, t.colCV),
                  h('th', { style: cellNum }, t.colScale),
                  h('th', { style: cellNum }, t.colN))),
                h('tbody', null, ...(thresholds.details ?? []).map((fit) => {
                  const level = fitLevel(fit)
                  // Only an actionable fit is painted as an instruction; the rest are
                  // here for the record and must not read as "change this".
                  const suggestedStyle = level === 'adjustable' ? { ...cellNum, color: TONE.retire } : { ...cellNum, opacity: 0.6 }
                  /*
                   * `Brier` is shown plainly, not colour-coded, and that is deliberate:
                   * a bad scale does not mean a broken channel — it means the score
                   * orders cases rather than stating a probability, which is already
                   * handled (the cut is fitted per channel). Painting it red would
                   * invite exactly the wrong repair: moving the cut toward the score's
                   * nominal 0.5, which is what caused the 2026-09-23 false-positive
                   * storm this table's ⚪/⬛ column exists to prevent.
                   */
                  const cal = fit.calibration
                  const reading = cal ? t.scaleReading(cal) : t.scaleUnmeasured
                  return h('tr', { key: fit.channel },
                    h('td', { style: cell }, TRUST_MARK[level]),
                    h('td', { style: cell }, fit.channel),
                    h('td', { style: cellNum }, Number(fit.current).toFixed(2)),
                    h('td', { style: suggestedStyle }, Number(fit.recommended).toFixed(2)),
                    h('td', { style: cellNum }, `${Math.round(Number(fit.accuracyCrossVal) * 100)}%`),
                    h('td', { style: cellNum, title: reading }, cal ? Number(cal.brier).toFixed(2) : '—'),
                    h('td', { style: cellNum }, fit.n))
                }))),
              h('div', { style: muted }, t.fitLegend),
              h('div', { style: muted }, t.scaleLegend),
              /*
               * Per-axis cuts are invisible in a per-channel table, and one of them is
               * exactly what keeps this gate from flagging plain code: private_scan's
               * axes carry different cuts (a hand-cut internal axis over an all-axes
               * fit). Saying them out loud is cheaper than the alternative — someone
               * "correcting" the channel-level number and silently overriding the axis
               * that was measured by hand.
               */
              ...(Object.entries(thresholds.applied ?? {}).filter(([key]) => key.includes('.'))
                .map(([key, cut]) => h('div', { style: muted }, `${t.axisNote}：${key} ${Number(cut).toFixed(2)}`))),
              h('div', { key: 'apply', style: row },
                button(t.applyThresholds, busy || changes.length === 0, () => {
                  void write({ thresholds: Object.fromEntries(changes.map((change) => [change.key, change.to])) }, (body) => {
                    const { moved, missed } = appliedNote(changes, body?.settings?.thresholds)
                    const parts = []
                    if (moved.length) parts.push(`${t.appliedThresholds}：${moved.map(changeLabel).join(' · ')}`)
                    if (missed.length) parts.push(`${t.saveFailed}（未落地：${missed.map((change) => change.key).join(', ')}）`)
                    return parts.join(' · ') || t.saved
                  })
                }),
                changes.length === 0
                  ? h('span', { style: muted }, t.applyNothing((thresholds.details ?? []).length))
                  : h('span', { style: muted }, t.applyWill(changes.map(changeLabel).join(' · ')))))))

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
      __internals: { classify, toMarkdown, unwrapReport, S, MIN_SAMPLE, thresholdChanges, appliedNote, changeLabel },
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
