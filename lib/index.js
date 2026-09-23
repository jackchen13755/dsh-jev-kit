/**
 * `dsh-jev-kit` — Jev as a set of named decisions a caller can reach for.
 *
 * The design commitments, each of which is a reaction to a measured failure:
 *
 *   · **Tools, not hooks.** Nothing here intercepts a tool call, blocks it, or
 *     asks a human. A toolkit that could gate would inherit every failure mode of
 *     a gate — including the `approval: never` trap, where an ask quietly becomes
 *     a refusal whose reason claims the user declined something they never saw.
 *     It also means this plugin registers no `pre/post-execute` middleware, so
 *     hot-reloading it cannot deadlock the call that triggers the reload.
 *   · **One request per unit, all its questions at once.** Independent questions
 *     over the same state run in parallel for the price of one; asking them
 *     separately would triple the latency for nothing.
 *   · **Bounded on every axis.** Per request, per call, per item count, per
 *     session, per day. A 5000-line diff must cost a bounded amount, not an
 *     accidental invoice.
 *   · **The ledger decides what survives.** A channel that never produces a
 *     non-neutral verdict on real input is dead weight, and the report says so.
 *
 * @module dsh-jev-kit
 */
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createJev, compileExtraPatterns, redact, JevError, createBreaker, createLimiter, percentiles, createCache, keyOf, serviceOf, } from '@dsh-external/dsh-jev-core';
import { CHANNEL_LIST, channelOf, setReaderThresholds } from './channels.js';
import { hunksOf, unitsOf } from './segments.js';
import { jevEngine, layaEngine, selectEngines, trimState } from './engines.js';
import { FIXTURES, check, questionsFor, renderBench, summarizeEngine, verdictFor, fittedTable, setThresholdOverrides, thresholdOverrides, questionHash, questionHashes, wordingDrift } from './bench.js';
import { append, load, render, summarize } from './ledger.js';
import { KIT_DEFAULTS, loadStored, merge, saveStored, validate } from './settings.js';
export const name = '@dsh-external/dsh-jev-kit';
export const inject = ['tools'];
const API_PREFIX = '/dsh-jev-kit/api';
/** The version comes from the manifest, so a bug report cannot quote a stale one. */
const VERSION = (() => {
    try {
        const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
})();
const DEFAULTS = {
    ...KIT_DEFAULTS,
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    // Pinned, never an alias: a moving model would move every threshold with it.
    model: 'jev-1.13.0',
    apiKey: '',
    apiKeyFile: '',
    ledgerDir: '',
    redact: true,
    engines: ['jev'],
    layaEndpoint: 'http://127.0.0.1:8791',
};
/** Resolve the key from the credential store, then the environment, then a file. */
export function resolveKey(config, env = process.env) {
    if (config.apiKey.trim())
        return { key: config.apiKey.trim(), source: 'config.apiKey' };
    if (env.TYPESAFE_API_KEY?.trim())
        return { key: env.TYPESAFE_API_KEY.trim(), source: 'env:TYPESAFE_API_KEY' };
    const file = config.apiKeyFile.trim();
    if (file) {
        try {
            const value = fs.readFileSync(file, 'utf8').trim();
            if (value)
                return { key: value, source: `file:${file}` };
        }
        catch { /* fall through */ }
    }
    return { key: '', source: 'missing' };
}
export function apply(ctx, input = {}) {
    const base = { ...DEFAULTS, ...input };
    let config = base;
    const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
    const ledgerDir = base.ledgerDir.trim() || path.join(dshHome, 'storages', 'dsh_jev_kit');
    const logger = serviceOf(ctx, 'logger');
    const services = {};
    try {
        ctx.inject?.(['credentials'], (scope) => {
            services.credentials = serviceOf(scope, 'credentials');
        });
    }
    catch { /* no credentials seam: the key comes from config, env or a file */ }
    /** Drop this package's cached client metadata, if the service is reachable. */
    function healClientMeta(scope) {
        try {
            const clientModules = serviceOf(scope, 'clientModules');
            const meta = clientModules?.pkgMeta;
            if (!meta || typeof meta.delete !== 'function' || typeof meta.keys !== 'function')
                return 0;
            let cleared = 0;
            for (const key of [...meta.keys()]) {
                if (String(key).includes(name)) {
                    meta.delete(key);
                    cleared++;
                }
            }
            return cleared;
        }
        catch {
            return 0;
        }
    }
    const state = {
        startedAt: Date.now(),
        sessionCalls: new Map(),
        day: new Date().toISOString().slice(0, 10),
        dayCalls: 0,
        reasons: new Map(),
    };
    const reason = (why) => { state.reasons.set(why, (state.reasons.get(why) ?? 0) + 1); };
    const keyState = { value: '', source: 'missing' };
    /** Short, stable, non-reversible id for the configured key. */
    const keyFingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
    let jev = null;
    const auth = { fingerprint: '', at: 0, status: 0, message: '' };
    let breaker = createBreaker({ failures: config.breakerFailures, cooldownMs: config.breakerCooldownMs });
    const limiter = createLimiter(config.concurrency);
    let cache = createCache(config.cacheMaxEntries, config.cacheTtlMs);
    let extraKey = '\u0000unset';
    let extraCompiled = [];
    const extraPatterns = () => {
        const current = config.redactExtra.join('\u0000');
        if (current !== extraKey) {
            extraKey = current;
            extraCompiled = compileExtraPatterns(config.redactExtra);
        }
        return extraCompiled;
    };
    const prep = (text) => (config.redact ? redact(text, extraPatterns()) : text);
    async function ensureJev() {
        let found = resolveKey(config);
        const service = services.credentials;
        if (service && typeof service.resolve === 'function') {
            try {
                const resolved = await service.resolve(config.apiKeyRef.trim() || DEFAULTS.apiKeyRef);
                if (resolved?.value)
                    found = { key: resolved.value, source: `credential:${resolved.source ?? config.apiKeyRef}` };
            }
            catch { /* fall through to the static sources */ }
        }
        if (found.key !== keyState.value) {
            keyState.value = found.key;
            keyState.source = found.source;
            auth.fingerprint = '';
            breaker.ok();
            jev = found.key
                ? createJev({ endpoint: config.endpoint, model: config.model, apiKey: found.key, timeoutMs: config.requestTimeoutMs, maxRetries: 1 })
                : null;
        }
        return jev;
    }
    /** All engines this build knows, in the order settings may name them. */
    function knownEngines() {
        return [
            jevEngine(async () => await ensureJev()),
            layaEngine({ endpoint: config.layaEndpoint }),
        ];
    }
    /** The engine that serves interactive judgments: the first one configured. */
    function primaryEngine() {
        const { engines, unknown } = selectEngines(config.engines.length ? config.engines : ['jev'], knownEngines());
        return { engine: engines[0] ?? knownEngines()[0], unknown };
    }
    function authBlocked() {
        if (!auth.fingerprint)
            return false;
        if (Date.now() - auth.at >= config.breakerCooldownMs) {
            auth.fingerprint = '';
            return false;
        }
        reason(`auth:rejected-${auth.status}`);
        return true;
    }
    function noteAuthFailure(error) {
        if (!(error instanceof JevError) || (error.status !== 401 && error.status !== 403))
            return;
        auth.fingerprint = keyState.source;
        auth.at = Date.now();
        auth.status = error.status;
        auth.message = error.message.slice(0, 200);
    }
    function budgetOk(session) {
        if (!config.enabled)
            return false;
        const today = new Date().toISOString().slice(0, 10);
        if (today !== state.day) {
            state.day = today;
            state.dayCalls = 0;
        }
        if (state.dayCalls >= config.dailyCallLimit) {
            reason('budget:daily');
            return false;
        }
        const used = state.sessionCalls.get(session) ?? 0;
        if (used >= config.sessionCallLimit) {
            reason('budget:session');
            return false;
        }
        state.dayCalls++;
        state.sessionCalls.set(session, used + 1);
        return true;
    }
    /* ── the runner ─────────────────────────────────────────────────────── */
    /** Judge one unit with one channel. Cache first, then one batched request. */
    async function judge(channel, channelState, session) {
        const questions = channel.questions(channelState);
        if (!Object.keys(questions).length)
            return null;
        const chars = JSON.stringify(channelState).length;
        const cacheKey = keyOf([channel.id, VERSION, prep(JSON.stringify(channelState))]);
        const cached = cache.get(cacheKey);
        if (cached) {
            append(ledgerDir, { t: Date.now(), kind: 'decision', channel: channel.id, group: channel.group, level: cached.verdict.level, values: cached.verdict.values, via: 'cache', chars, ms: cached.ms, session });
            return { where: '', verdict: cached.verdict, via: 'cache', chars };
        }
        const { engine } = primaryEngine();
        if (engine.id === 'jev') {
            if (authBlocked()) {
                append(ledgerDir, { t: Date.now(), kind: 'degraded', channel: channel.id, reason: `auth:rejected-${auth.status}` });
                return null;
            }
            if (!(await ensureJev())) {
                reason('no-key');
                append(ledgerDir, { t: Date.now(), kind: 'degraded', channel: channel.id, reason: 'no-key' });
                return null;
            }
            if (breaker.isOpen()) {
                reason('degraded:breaker-open');
                append(ledgerDir, { t: Date.now(), kind: 'degraded', channel: channel.id, reason: 'degraded:breaker-open' });
                return null;
            }
        }
        if (!budgetOk(session)) {
            append(ledgerDir, { t: Date.now(), kind: 'degraded', channel: channel.id, reason: 'budget' });
            return null;
        }
        /*
         * The state is redacted as a whole and handed over as an object: the question
         * wording names its fields, so the field names must survive redaction.
         */
        const redacted = {};
        for (const [field, value] of Object.entries(channelState)) {
            if (typeof value === 'string')
                redacted[field] = prep(value);
            else if (Array.isArray(value))
                redacted[field] = value.map(item => (typeof item === 'string' ? prep(item) : item));
            else if (value && typeof value === 'object')
                redacted[field] = prep(JSON.stringify(value));
            else if (value !== undefined)
                redacted[field] = value;
        }
        if (channelState.candidates)
            redacted.candidates = channelState.candidates.map(candidate => prep(candidate));
        if (channelState.requirements)
            redacted.requirements = channelState.requirements.map(requirement => prep(requirement));
        /*
         * A local engine pays per token (measured: 22 chars ≈ 100 ms, 743 chars ≈ 1.6 s),
         * so its state is capped. The hosted engine keeps everything: truncating there
         * would trade information for a cost it does not have.
         */
        const payload = engine.id === 'jev'
            ? redacted
            : trimState(redacted, { maxChars: config.localStateChars, maxItems: config.localMaxItems }).state;
        let answer;
        try {
            answer = await limiter.run(() => engine.ask(payload, questions, { timeoutMs: config.requestTimeoutMs }));
        }
        catch (error) {
            noteAuthFailure(error);
            breaker.fail();
            reason(error instanceof JevError && error.status === 401 ? 'error:auth' : 'error:request');
            append(ledgerDir, { t: Date.now(), kind: 'error', channel: channel.id, message: error instanceof Error ? error.message : String(error) });
            return null;
        }
        breaker.ok();
        auth.fingerprint = '';
        const verdict = channel.read(answer.answers, channelState);
        cache.set(cacheKey, { verdict, ms: answer.ms });
        append(ledgerDir, { t: Date.now(), kind: 'decision', channel: channel.id, group: channel.group, level: verdict.level, values: verdict.values, via: 'jev', ms: answer.ms, chars, session, qh: questionHash(channel.id) });
        return { where: '', verdict, ms: answer.ms, via: 'jev', chars };
    }
    /** Judge every unit, bounded by item count and by the call's own budget. */
    async function runUnits(channelId, units, session, extra = {}) {
        const channel = channelOf(channelId);
        if (!channel)
            throw new Error(`unknown channel: ${channelId}`);
        if (config.disabledChannels.includes(channel.id)) {
            return { channel: channel.id, title: channel.title, items: [], skipped: units.length, degraded: 0, errors: [], stopReason: `通道已停用（settings.disabledChannels）：${channel.id}` };
        }
        const started = Date.now();
        const capped = units.slice(0, config.maxItems);
        const items = [];
        let degraded = 0;
        const errors = [];
        let stopReason;
        let cursor = 0;
        const workers = Array.from({ length: Math.min(config.concurrency, capped.length) }, async () => {
            while (cursor < capped.length) {
                if (Date.now() - started > config.callBudgetMs) {
                    stopReason = `超出单次调用预算 ${config.callBudgetMs}ms，提前结束`;
                    return;
                }
                const index = cursor++;
                const unit = capped[index];
                const channelState = { text: unit.text, ...extra };
                const result = await judge(channel, channelState, session);
                if (result)
                    items.push({ ...result, where: unit.where });
                else
                    degraded++;
            }
        });
        await Promise.all(workers);
        items.sort((a, b) => units.findIndex(u => u.where === a.where) - units.findIndex(u => u.where === b.where));
        return {
            channel: channel.id,
            title: channel.title,
            items,
            skipped: Math.max(0, units.length - capped.length),
            stopReason,
            degraded,
            errors,
        };
    }
    /** Run an `per: input` channel once. */
    async function runInput(channelId, channelState, session) {
        const channel = channelOf(channelId);
        if (!channel)
            throw new Error(`unknown channel: ${channelId}`);
        if (config.disabledChannels.includes(channel.id)) {
            return { channel: channel.id, title: channel.title, items: [], skipped: 0, degraded: 0, errors: [], stopReason: `通道已停用（settings.disabledChannels）：${channel.id}` };
        }
        const result = await judge(channel, channelState, session);
        return {
            channel: channel.id,
            title: channel.title,
            items: result ? [result] : [],
            skipped: 0,
            degraded: result ? 0 : 1,
            errors: [],
        };
    }
    /* ── rendering ──────────────────────────────────────────────────────── */
    /**
     * The budget key: a session id, or the name of a non-session entry.
     *
     * Budgets are per-session so one long session cannot spend the day's allowance; the
     * ledger reuses the same string as the *entry* label, which is how `hook` and
     * `command` show up in the report as first-class callers.
     */
    const sessionOf = (exec) => exec?.agent?.session?.id ?? 'unknown';
    function renderCall(result, note) {
        const head = [`**${result.channel}** · ${result.title}`, note ?? ''].filter(Boolean);
        const body = [];
        for (const item of result.items) {
            const icon = item.verdict.level === 'flag' ? '⛔' : item.verdict.level === 'warn' ? '⚠️' : item.verdict.level === 'ok' ? '✓' : '·';
            const where = item.where ? `${item.where} — ` : '';
            body.push(`${icon} ${where}${item.verdict.headline}${item.via === 'cache' ? '（缓存）' : ''}`);
            for (const detail of item.verdict.details ?? [])
                body.push(`    ${detail}`);
        }
        const neutral = result.items.filter(item => item.verdict.level === 'info').length;
        const summary = result.items.length
            ? `${result.items.length} 条判定：⛔${result.items.filter(i => i.verdict.level === 'flag').length} ⚠️${result.items.filter(i => i.verdict.level === 'warn').length} ✓${result.items.filter(i => i.verdict.level === 'ok').length} ·中性 ${neutral}`
            : '没有可判定的内容';
        const warns = [
            result.skipped ? `（超过单次上限，跳过了 ${result.skipped} 条——分批再跑）` : '',
            result.degraded ? `（${result.degraded} 条未能判定：key/熔断/预算，已 fail-open）` : '',
            result.stopReason ?? '',
        ].filter(Boolean);
        return [...head, '', summary, ...warns, '', ...body].join('\n');
    }
    function statusPayload() {
        return {
            version: VERSION,
            uptimeMs: Date.now() - state.startedAt,
            enabled: config.enabled,
            model: config.model,
            key: {
                ref: config.apiKeyRef,
                configured: keyState.value !== '',
                source: keyState.source,
                /*
                 * A fingerprint, never the value. The card needs to answer "is this the key I
                 * think it is" (and "did my paste land") without any route ever being able to
                 * hand the secret back out — the same rule the lens's card follows, and the
                 * reason this box can exist here at all.
                 */
                fingerprint: keyState.value ? keyFingerprint(keyState.value) : '',
            },
            auth: auth.fingerprint ? { rejected: true, status: auth.status, at: auth.at, message: auth.message } : { rejected: false },
            settings: {
                requestTimeoutMs: config.requestTimeoutMs,
                callBudgetMs: config.callBudgetMs,
                maxItems: config.maxItems,
                concurrency: config.concurrency,
                cacheTtlMs: config.cacheTtlMs,
            },
            channels: CHANNEL_LIST.length,
            disabledChannels: config.disabledChannels,
            defaultRepo: config.defaultRepo,
            engines: config.engines,
            layaEndpoint: config.layaEndpoint,
            thresholds: thresholdOverrides(),
            /** Compact `GROUP:id` list, for the card's catalogue section. */
            catalogue: CHANNEL_LIST.map(channel => `${channel.group}:${channel.id}`),
            health: {
                breakerOpen: breaker.state.open,
                failures: breaker.state.failures,
                inFlight: limiter.active,
                queued: limiter.queued,
                cache: { hits: cache.stats.hits, misses: cache.stats.misses, size: cache.stats.size },
                requests: jev?.stats.calls ?? 0,
                inputTokens: jev?.stats.inputTokens ?? 0,
            },
            budget: { dayCalls: state.dayCalls, dailyCallLimit: config.dailyCallLimit, sessionCallLimit: config.sessionCallLimit },
            reasons: [...state.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
            ledger: ledgerDir,
        };
    }
    const reasonTable = () => {
        const entries = [...state.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        return entries.length ? entries.map(([why, n]) => `${String(n).padStart(4)} × ${why}`).join('\n') : '无（每次调用都走到了判定）';
    };
    /* ── reading the working tree ───────────────────────────────────────── */
    /**
     * Read a git diff without a shell.
     *
     * `execFile` with an argument array (no shell interpolation) and a bounded timeout:
     * this asks git for one diff in one repository and nothing else. The path comes from
     * the caller's own command line, never from fetched content.
     */
    async function gitDiff(repo, staged, timeoutMs = 15000) {
        const { execFile } = await import('node:child_process');
        const run = (args) => new Promise((resolve) => {
            execFile('git', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ out: '', error: `${error.message.split('\n')[0]}${stderr ? ` · ${String(stderr).trim().slice(0, 160)}` : ''}` });
                    return;
                }
                resolve({ out: stdout });
            });
        });
        // Ask git whether this is a repository *first*. Without this, a non-repository
        // path makes git fall back to --no-index and answer "unknown option `cached`",
        // which names the wrong problem.
        const probe = await run(['-C', repo, 'rev-parse', '--show-toplevel']);
        if (probe.error)
            return { diff: '', error: `${repo} 不是 git 仓库（或 git 不可用）：${probe.error}` };
        const root = probe.out.trim();
        const args = ['-C', root, 'diff', '--no-color', '-U0', ...(staged ? ['--cached'] : [])];
        return await new Promise((resolve) => {
            execFile('git', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ diff: '', error: `${error.message.split('\n')[0]}${stderr ? ` · ${String(stderr).trim().slice(0, 160)}` : ''}` });
                    return;
                }
                resolve({ diff: stdout });
            });
        });
    }
    /* ── tools ──────────────────────────────────────────────────────────── */
    const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
    const list = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === 'string') : []);
    const tool = (definition, label) => { ctx.effect(() => ctx.tools.register(definition), label); };
    // `as const` on the discriminant: hoisting this descriptor out of the tool
    // literal widens `type` to `string`, which the output contract rejects.
    const textOut = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] };
    tool(defineTool({
        name: 'jev_kit_channels',
        description: 'List every decision channel this toolkit can make (id, group, what it replaces). Use it before jev_kit_decide.',
        parameters: { group: { type: 'string', description: 'Filter: P (priorities) | A (agent loop) | B (guards) | C (batch triage) | D (memory)' } },
        output: textOut,
        async execute(args) {
            const wanted = str(args?.group).trim().toUpperCase();
            const rows = CHANNEL_LIST.filter(channel => !wanted || channel.group === wanted);
            const groupName = {
                P: 'P · 三件优先事项', A: 'A · 替掉一次 frontier 往返', B: 'B · 守卫与门禁（只给建议）', C: 'C · 批量分诊', D: 'D · 记忆与检索',
            };
            const lines = [];
            for (const group of ['P', 'A', 'B', 'C', 'D']) {
                const own = rows.filter(channel => channel.group === group);
                if (!own.length)
                    continue;
                lines.push(`**${groupName[group]}**`);
                for (const channel of own) {
                    const off = config.disabledChannels.includes(channel.id) ? ' **[已停用]**' : '';
                    lines.push(`  · \`${channel.id}\`（${channel.per === 'item' ? '逐条' : '整体'}）— ${channel.title}：${channel.intent}${off}`);
                }
                lines.push('');
            }
            lines.push('用法：`jev_kit_decide { channel, text, task, candidates, requirements }`；隐私/范围/记忆/分诊/选择有专用工具，见各自描述。');
            return lines.join('\n');
        },
    }), 'jev-kit channels tool');
    tool(defineTool({
        name: 'jev_kit_decide',
        description: 'Run one named Jev decision channel over the state you pass (see jev_kit_channels). Advisory only: it returns a typed verdict and never blocks anything.',
        parameters: {
            channel: { type: 'string', description: 'Channel id, e.g. sufficient / route / failure_triage / risk / review_triage' },
            text: { type: 'string', description: 'The text under judgment (segment, hunk, tool result, comment…)' },
            task: { type: 'string', description: 'The user request or task the judgment is relative to, when the channel needs one' },
            other: { type: 'string', description: 'Second text for pair judgments (memory_conflict)' },
            candidates: { type: 'array', items: { type: 'string' }, description: 'Shortlist for choice channels (pick, tag_session)' },
            requirements: { type: 'array', items: { type: 'string' }, description: 'Checklist for evidence_check' },
            candidateNoun: { type: 'string', description: 'What the candidates are (component, test, skill…)' },
        },
        output: textOut,
        async execute(args, exec) {
            const channelId = str(args?.channel);
            const channel = channelOf(channelId);
            if (!channel)
                return `未知通道 "${channelId}"。先用 jev_kit_channels 看目录。`;
            const channelState = {
                text: str(args?.text), task: str(args?.task) || undefined, other: str(args?.other) || undefined,
                candidates: list(args?.candidates), requirements: list(args?.requirements),
                candidateNoun: str(args?.candidateNoun) || undefined,
            };
            if (channel.per === 'item') {
                const units = channelState.text ? [{ text: channelState.text, where: '' }] : [];
                if (!units.length)
                    return '该通道需要 `text`。';
                return renderCall(await runUnits(channel.id, units, sessionOf(exec), { task: channelState.task, other: channelState.other, candidates: channelState.candidates, requirements: channelState.requirements, candidateNoun: channelState.candidateNoun }));
            }
            return renderCall(await runInput(channel.id, channelState, sessionOf(exec)));
        },
    }), 'jev-kit decide tool');
    tool(defineTool({
        name: 'jev_kit_scan_private',
        description: 'Priority 1 — semantic privacy scan for a pre-push check: finds credentials, personal data and internal details that a regex pass misses. Pass a `diff` (only added lines are scanned) or a `text`. Advisory: it reports findings, it does not edit anything.',
        parameters: {
            diff: { type: 'string', description: 'Unified diff to scan (added lines only)' },
            text: { type: 'string', description: 'Or free text to scan instead' },
            maxItems: { type: 'number', description: 'Cap on units judged (default from settings)' },
        },
        output: textOut,
        async execute(args, exec) {
            const artifact = str(args?.diff) || str(args?.text);
            if (!artifact)
                return '需要 `diff` 或 `text`。';
            const cap = typeof args?.maxItems === 'number' ? Math.max(1, Math.min(200, args.maxItems)) : config.maxItems;
            const units = unitsOf(artifact, cap);
            if (!units.length)
                return '没有可扫描的内容（diff 里没有新增行，或文本太短）。';
            const result = await runUnits('private_scan', units, sessionOf(exec));
            const findings = result.items.filter(item => item.verdict.level === 'flag');
            return renderCall(result, findings.length
                ? `⚠️ ${findings.length} 处疑似泄漏 —— 逐条确认后再推送（正则扫描仍要照跑，两者互补）`
                : '未发现语义层面的泄漏（正则扫描仍要照跑：token 形态、手机号这类由正则负责）');
        },
    }), 'jev-kit private scan tool');
    tool(defineTool({
        name: 'jev_kit_scope_check',
        description: 'Priority 3 — change-scope gate: judges each diff hunk against the task and reports hunks the task did not ask for. Advisory; it never reverts or edits.',
        parameters: {
            task: { type: 'string', description: 'What the user asked for' },
            diff: { type: 'string', description: 'Unified diff of the change' },
            maxItems: { type: 'number', description: 'Cap on hunks judged' },
        },
        output: textOut,
        async execute(args, exec) {
            const task = str(args?.task);
            const diff = str(args?.diff);
            if (!task || !diff)
                return '需要 `task` 和 `diff`。';
            const cap = typeof args?.maxItems === 'number' ? Math.max(1, Math.min(200, args.maxItems)) : config.maxItems;
            const units = hunksOf(diff, cap);
            if (!units.length)
                return 'diff 里没有可判定的 hunk。';
            return renderCall(await runUnits('scope_check', units, sessionOf(exec), { task }), '按你自己的纪律「只改要求改的地方」逐 hunk 对照');
        },
    }), 'jev-kit scope tool');
    tool(defineTool({
        name: 'jev_kit_memory',
        description: 'Priority 2 + group D — memory judgments: mode=write (worth remembering? which track?), mode=conflict (do two memories contradict or duplicate?), mode=rerank (score each candidate memory against a query, best first).',
        parameters: {
            mode: { type: 'string', enum: ['write', 'conflict', 'rerank'], description: 'Which memory judgment' },
            text: { type: 'string', description: 'The turn/lesson text (write) or the first memory (conflict)' },
            other: { type: 'string', description: 'The second memory (conflict)' },
            query: { type: 'string', description: 'What you are trying to answer (rerank)' },
            candidates: { type: 'array', items: { type: 'string' }, description: 'Candidate memories (rerank)' },
        },
        output: textOut,
        async execute(args, exec) {
            const mode = str(args?.mode) || 'write';
            const text = str(args?.text);
            if (mode === 'write') {
                if (!text)
                    return 'mode=write 需要 `text`。';
                return renderCall(await runUnits('memory_write', [{ text, where: '' }], sessionOf(exec)));
            }
            if (mode === 'conflict') {
                const other = str(args?.other);
                if (!text || !other)
                    return 'mode=conflict 需要 `text` 与 `other` 两条记忆。';
                return renderCall(await runUnits('memory_conflict', [{ text, where: '' }], sessionOf(exec), { other }));
            }
            const query = str(args?.query);
            const candidates = list(args?.candidates);
            if (!query || !candidates.length)
                return 'mode=rerank 需要 `query` 与 `candidates`。';
            const units = candidates.slice(0, config.maxItems).map((candidate, index) => ({ text: candidate, where: `#${index + 1}` }));
            const result = await runUnits('recall_rerank', units, sessionOf(exec), { task: query });
            const ordered = [...result.items].sort((a, b) => Number(b.verdict.values.answers_query ?? 0) - Number(a.verdict.values.answers_query ?? 0));
            const table = ordered.map((item, index) => `${index + 1}. ${item.where} score=${item.verdict.values.answers_query ?? '—'} ${item.where ? '' : ''}`).join('\n');
            return `${renderCall(result, '只排序，不设阈值：分数是排序信号，不是概率')}\n\n**按分数排序**\n${table}`;
        },
    }), 'jev-kit memory tool');
    tool(defineTool({
        name: 'jev_kit_triage',
        description: 'Group C — batch triage over many items: kind=log (error / warning worth acting on / noise), kind=alert (same incident as an open one?), kind=bug (code/config/data/perf/ux + reproducible?), kind=flaky (flaky or a real regression?).',
        parameters: {
            kind: { type: 'string', enum: ['log', 'alert', 'bug', 'flaky'], description: 'Which triage channel' },
            items: { type: 'array', items: { type: 'string' }, description: 'The lines / alerts / reports / failures to triage' },
            context: { type: 'string', description: 'Context for pair/relative judgments: the open alert (alert), the change or test (flaky)' },
            maxItems: { type: 'number', description: 'Cap on items judged' },
        },
        output: textOut,
        async execute(args, exec) {
            const kind = str(args?.kind) || 'log';
            const channelId = kind === 'log' ? 'log_triage' : kind === 'alert' ? 'alert_dedup' : kind === 'bug' ? 'bug_triage' : 'flaky';
            const items = list(args?.items);
            if (!items.length)
                return '需要 `items`。';
            const cap = typeof args?.maxItems === 'number' ? Math.max(1, Math.min(500, args.maxItems)) : Math.min(config.maxItems, 200);
            const context = str(args?.context);
            const units = items.slice(0, cap).map((item, index) => ({ text: item, where: `#${index + 1}` }));
            const result = await runUnits(channelId, units, sessionOf(exec), context ? { other: context, task: context } : {});
            const groups = new Map();
            for (const item of result.items) {
                const label = String(item.verdict.headline);
                groups.set(label, (groups.get(label) ?? 0) + 1);
            }
            const tally = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${label} × ${n}`).join(' · ');
            return `${renderCall(result)}\n\n**汇总**：${tally || '—'}`;
        },
    }), 'jev-kit triage tool');
    tool(defineTool({
        name: 'jev_kit_pick',
        description: 'Group C — choose one candidate (component, test file, skill, doc) that best matches a task, with an explicit "none of these" escape so a wrong list cannot force a bad answer.',
        parameters: {
            task: { type: 'string', description: 'What you are trying to do' },
            candidates: { type: 'array', items: { type: 'string' }, description: 'The shortlist (≤60)' },
            noun: { type: 'string', description: 'What the candidates are, e.g. component / test / skill' },
        },
        output: textOut,
        async execute(args, exec) {
            const task = str(args?.task);
            const candidates = list(args?.candidates);
            if (!task || !candidates.length)
                return '需要 `task` 与 `candidates`。';
            return renderCall(await runInput('pick', { task, candidates: candidates.slice(0, 60), candidateNoun: str(args?.noun) || 'option' }, sessionOf(exec)));
        },
    }), 'jev-kit pick tool');
    /**
     * Run the whole fixture suite through one engine.
     *
     * Shared by the tool and the HTTP route so both measure the same thing; bounded
     * concurrency because a few hundred fixtures at ~1s each would otherwise take
     * minutes per engine, and the limiter is the same ceiling the interactive path
     * respects.
     *
     * @param engine - the engine under test.
     * @param stateChars - per-string cap for this run (0 = full state).
     * @returns one trial per fixture, in suite order.
     */
    async function runSuite(engine, stateChars) {
        let reachable = true;
        try {
            reachable = await engine.available();
        }
        catch {
            reachable = false;
        }
        if (!reachable) {
            append(ledgerDir, { t: Date.now(), kind: 'trial', engine: engine.id, channel: '-', fixture: '(probe)', ok: false, error: 'unavailable' });
            return [{ fixture: '(probe)', channel: '-', engine: engine.id, ok: false, error: `unavailable: ${engine.label}` }];
        }
        const judged = new Array(FIXTURES.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.max(1, Math.min(config.concurrency, FIXTURES.length)) }, async () => {
            while (cursor < FIXTURES.length) {
                const index = cursor++;
                const fixture = FIXTURES[index];
                let trial = { fixture: fixture.id, channel: fixture.channel, engine: engine.id, ok: false };
                try {
                    const { questions, state } = questionsFor(fixture);
                    const payload = stateChars > 0
                        ? trimState(state, { maxChars: stateChars, maxItems: config.localMaxItems }).state
                        : state;
                    const answer = await engine.ask(payload, questions, { timeoutMs: config.requestTimeoutMs });
                    const verdict = verdictFor(fixture, answer.answers);
                    const result = check(fixture, verdict);
                    trial = { ...trial, ok: result.ok, value: result.value, why: result.why, thresholdFree: result.thresholdFree, level: verdict.level, ms: answer.ms };
                }
                catch (error) {
                    trial = { ...trial, error: error instanceof Error ? error.message : String(error) };
                }
                judged[index] = trial;
                append(ledgerDir, { t: Date.now(), kind: 'trial', engine: engine.id, channel: fixture.channel, fixture: fixture.id, ok: trial.ok, value: trial.value, level: trial.level, ms: trial.ms, error: trial.error });
            }
        });
        await Promise.all(workers);
        return judged.filter(Boolean);
    }
    tool(defineTool({
        name: 'jev_kit_bench',
        description: `Run the ${FIXTURES.length}-fixture suite (dozens per channel, truth by construction) through every configured engine. Primary metric is separation (threshold-free, comparable across engines); the thresholded pass rate is secondary. An unreachable engine reports unavailable — never counted as passing. For the full corpus prefer POST /dsh-jev-kit/api/bench in a background shell: it takes minutes.`,
        parameters: {
            engines: { type: 'array', items: { type: 'string' }, description: 'Engine ids to compare (default: the ones in settings)' },
            verbose: { type: 'boolean', description: 'Also list every fixture with its ground truth' },
            stateChars: { type: 'number', description: 'Cap each state string at N chars for this run (0 = full state). Use it to measure the local-engine tradeoff.' },
        },
        output: textOut,
        async execute(args) {
            const wanted = list(args?.engines);
            const known = knownEngines();
            const { engines, unknown } = selectEngines(wanted.length ? wanted : config.engines, known);
            if (!engines.length)
                return `没有可用引擎。已知：${known.map(engine => engine.id).join(', ')}${unknown.length ? ` · 未知：${unknown.join(', ')}` : ''}`;
            const reports = [];
            for (const engine of engines) {
                const trials = await runSuite(engine, typeof args?.stateChars === 'number' ? Math.max(0, args.stateChars) : 0);
                reports.push(summarizeEngine(engine.id, engine.label, FIXTURES, trials, percentiles));
            }
            append(ledgerDir, { t: Date.now(), kind: 'bench', engines: engines.map(engine => engine.id), fixtures: FIXTURES.length });
            const capNote = typeof args?.stateChars === 'number' && args.stateChars > 0
                ? `\n\n> 本轮把每个 state 截到 **${args.stateChars} 字符**（本地引擎的成本随 token 走，截断即为部署配置）。两列都被同样截断，所以可比，但都不同于"全长 state"的结论。`
                : '';
            return renderBench(reports, FIXTURES, args?.verbose === true) + capNote + (unknown.length ? `\n\n⚠️ 设置里有未知引擎 id：${unknown.join(', ')}（已忽略，没有静默当成可用）` : '');
        },
    }), 'jev-kit bench tool');
    tool(defineTool({
        name: 'jev_kit_status',
        description: 'Kit status: key source, budget, breaker, cache, and why calls were skipped.',
        parameters: {},
        output: textOut,
        async execute() {
            // Resolve the credential first: a status that reports "missing" merely
            // because nothing has asked yet is a status that lies about its own state.
            await ensureJev();
            const payload = statusPayload();
            const policy = `enabled=${config.enabled} · model=${config.model} · 通道 ${CHANNEL_LIST.length} 个`;
            return [
                `**dsh-jev-kit** v${VERSION}`,
                policy,
                `key=${keyState.source}${keyState.value ? '' : '  ⚠️ 未解析到 key：所有判断都会被跳过（fail-open）'}`,
                `引擎 ${config.engines.join(' → ')} · 本地端点 ${config.layaEndpoint || '（未配置）'}`,
                `本地引擎限流 state ${config.localStateChars} 字符 / 数组 ${config.localMaxItems} 项`,
                `超时 单次 ${config.requestTimeoutMs}ms · 单次调用预算 ${config.callBudgetMs}ms · 每次最多 ${config.maxItems} 条 · 并发 ${config.concurrency}`,
                `预算 今日 ${state.dayCalls}/${config.dailyCallLimit} · 本会话 ${config.sessionCallLimit}`,
                `运行态 熔断 ${breaker.state.open ? 'OPEN' : 'closed'} · 在飞 ${limiter.active}/排队 ${limiter.queued} · 缓存 ${cache.stats.hits}/${cache.stats.hits + cache.stats.misses} 命中（${cache.stats.size} 条）· 累计请求 ${jev?.stats.calls ?? 0}`,
                `ledger ${ledgerDir}`,
                '',
                '跳过原因：',
                reasonTable(),
                '',
                `目录：jev_kit_channels${payload.auth && payload.auth.rejected ? '（⚠️ key 被拒，10 分钟内静默）' : ''}`,
            ].join('\n');
        },
    }), 'jev-kit status tool');
    tool(defineTool({
        name: 'jev_kit_report',
        description: 'Aggregate the kit ledger by channel. Read it to retire channels that never fire: a channel with many calls and no non-neutral verdict is not earning its keep.',
        parameters: { days: { type: 'number', description: 'Days of ledger to include (default 7)' } },
        output: textOut,
        async execute(args) {
            const days = Math.max(1, Math.min(90, Math.round(args?.days ?? 7)));
            return render(summarize(load(ledgerDir, days), days));
        },
    }), 'jev-kit report tool');
    /* ── the last benchmark, on disk ────────────────────────────────────── */
    const benchFile = path.join(ledgerDir, 'bench.json');
    /** Remember what the last run measured, so the card can offer it without re-running. */
    function saveBenchRecord(engines, fixtures, details, table) {
        try {
            fs.mkdirSync(ledgerDir, { recursive: true });
            const record = { at: Date.now(), fixtures, engines, thresholds: table, details, hashes: questionHashes() };
            fs.writeFileSync(benchFile, JSON.stringify(record, null, 2), { mode: 0o600 });
        }
        catch { /* a missing record only costs the card one table */ }
    }
    function loadBenchRecord() {
        try {
            const parsed = JSON.parse(fs.readFileSync(benchFile, 'utf8'));
            return parsed && typeof parsed === 'object' ? parsed : undefined;
        }
        catch {
            return undefined;
        }
    }
    /* ── settings + status over HTTP (for a card, and for curl) ─────────── */
    function installApi(host) {
        if (typeof host.inject !== 'function')
            return;
        try {
            host.inject(['webServer'], (scope) => {
                const server = serviceOf(scope, 'webServer') ?? scope.webServer;
                if (!server || typeof server.register !== 'function')
                    return;
                /** Read a small JSON body, bounded: a settings POST is never large. */
                const readBody = async (req) => {
                    const chunks = [];
                    let size = 0;
                    // The structural request view carries no iterator type, so the cast goes
                    // through `unknown`: the host hands us a real IncomingMessage here.
                    for await (const chunk of req) {
                        size += chunk.length;
                        /*
                         * 2 MB, not 64 KB: a single ordinary commit's diff is easily 100–400 KB
                         * (this repository's own corpus commit is 194 KB), and a cap below that
                         * turns every real push into "body too large" — which the hook then read
                         * as "no findings". The item cap is what bounds the *cost*; this only
                         * bounds the memory.
                         */
                        if (size > 2 * 1024 * 1024)
                            throw new Error(`body too large (${size} bytes, limit 2 MB)`);
                        chunks.push(chunk);
                    }
                    const raw = Buffer.concat(chunks).toString('utf8').trim();
                    return raw ? JSON.parse(raw) : {};
                };
                const send = (res, status, body) => {
                    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify(body));
                };
                scope.effect(() => server.register({
                    kind: 'prefix',
                    path: API_PREFIX,
                    handler: async (req, res) => {
                        const route = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.slice(API_PREFIX.length).replace(/^\/+/, '');
                        try {
                            if (req.method === 'GET' && (route === 'status' || route === '')) {
                                await ensureJev(); // same reason as the tool: never report "missing" before looking
                                send(res, 200, statusPayload());
                                return;
                            }
                            if (req.method === 'GET' && route === 'report') {
                                const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                                const days = Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get('days') ?? 7)) || 7));
                                send(res, 200, { ok: true, days, report: summarize(load(ledgerDir, days), days), markdown: render(summarize(load(ledgerDir, days), days)) });
                                return;
                            }
                            if (req.method === 'POST' && route === 'config') {
                                /*
                                 * The card's writes land here. Validated before anything is
                                 * applied: a settings POST that half-lands is worse than one that
                                 * is refused with the field name in the message.
                                 */
                                const patch = await readBody(req);
                                const merged = merge(config, patch);
                                const problem = validate(merged);
                                if (problem) {
                                    send(res, 400, { ok: false, error: problem });
                                    return;
                                }
                                if (!saveStored(ledgerDir, merged)) {
                                    send(res, 500, { ok: false, error: `无法写入 ${ledgerDir}/config.json` });
                                    return;
                                }
                                config = { ...config, ...merged };
                                /*
                                 * Rebuild rather than reconfigure: the copied breaker and cache are
                                 * immutable by design, and "the knobs just changed" is exactly when
                                 * stale failure counts and stale TTLs should not survive.
                                 */
                                breaker = createBreaker({ failures: config.breakerFailures, cooldownMs: config.breakerCooldownMs });
                                cache = createCache(config.cacheMaxEntries, config.cacheTtlMs);
                                setThresholdOverrides(config.thresholds);
                                setReaderThresholds(config.thresholds);
                                send(res, 200, { ok: true, settings: { enabled: config.enabled, maxItems: config.maxItems, requestTimeoutMs: config.requestTimeoutMs, callBudgetMs: config.callBudgetMs, concurrency: config.concurrency, cacheTtlMs: config.cacheTtlMs, thresholds: thresholdOverrides() } });
                                return;
                            }
                            if (req.method === 'POST' && route === 'i18n-check') {
                                /*
                                 * The user's standing rule — "only add keys, never rewrite existing
                                 * copy" — has been enforced by memory and discipline. This makes it a
                                 * check: each new entry is judged against the existing catalogue for a
                                 * synonym (do not add) and for terminology drift (do not invent a
                                 * second word for the same thing). Measured on the fixture: it caught
                                 * both at once ("电子邮箱" vs the established "邮箱").
                                 */
                                const body = await readBody(req);
                                const existing = (Array.isArray(body?.existing) ? body.existing : []).slice(0, 60)
                                    .map(entry => `${entry.key}: ${entry.text}`);
                                const incoming = (Array.isArray(body?.newKeys) ? body.newKeys : []).slice(0, config.maxItems);
                                if (!incoming.length) {
                                    send(res, 200, { ok: true, checked: 0, flagged: 0, findings: [], markdown: '没有新增词条。' });
                                    return;
                                }
                                const units = incoming.map(entry => ({ text: `${entry.key}：${entry.text}`, where: entry.key }));
                                const result = await runUnits('i18n_key', units, 'i18n-gate', { candidates: existing, candidateNoun: 'i18n key' });
                                const findings = result.items.filter(item => item.verdict.level === 'warn' || item.verdict.level === 'flag')
                                    .map(item => ({ where: item.where, headline: item.verdict.headline, values: item.verdict.values }));
                                send(res, 200, {
                                    ok: true,
                                    checked: result.items.length,
                                    flagged: findings.length,
                                    findings,
                                    markdown: renderCall(result, findings.length
                                        ? `⚠️ ${findings.length}/${result.items.length} 条新增词条需要确认（同义 key 应复用；术语需与既有说法一致）`
                                        : `✅ ${result.items.length} 条新增词条都没有同义项，术语与既有说法一致`),
                                });
                                return;
                            }
                            if (req.method === 'POST' && route === 'scope-check') {
                                /*
                                 * "Only change what was asked" — the user's own standing rule, turned
                                 * into a check for the pre-commit hook. One judgment per hunks, so the
                                 * drift is named by file and hunk rather than as a general feeling.
                                 */
                                const body = await readBody(req);
                                const task = typeof body?.task === 'string' ? body.task.trim() : '';
                                const diff = typeof body?.diff === 'string' ? body.diff : '';
                                if (!task || !diff) {
                                    send(res, 400, { ok: false, error: '需要 task 与 diff' });
                                    return;
                                }
                                const units = hunksOf(diff, config.maxItems);
                                if (!units.length) {
                                    send(res, 200, { ok: true, units: 0, flagged: 0, findings: [], markdown: 'diff 里没有可判定的 hunk。' });
                                    return;
                                }
                                const result = await runUnits('scope_check', units, 'scope-gate', { task });
                                const findings = result.items.filter(item => item.verdict.level === 'flag').map(item => ({ where: item.where, headline: item.verdict.headline, values: item.verdict.values }));
                                send(res, 200, { ok: true, units: result.items.length, flagged: findings.length, findings, markdown: renderCall(result) });
                                return;
                            }
                            if (req.method === 'POST' && route === 'check-commit') {
                                /*
                                 * `commit-msg` hook: does the message describe this diff, and does the
                                 * diff contain changes the message does not account for? Both are
                                 * habits the user already keeps by hand; a hook keeps them on the days
                                 * when nobody is paying attention.
                                 */
                                const body = await readBody(req);
                                const message = typeof body?.message === 'string' ? body.message.trim() : '';
                                const diff = typeof body?.diff === 'string' ? body.diff : '';
                                if (!message || !diff) {
                                    send(res, 400, { ok: false, error: '需要 message 与 diff' });
                                    return;
                                }
                                const state = { text: message, other: diff.slice(0, 120000) };
                                const result = await runInput('commit_message', state, 'commit-msg');
                                const flagged = result.items.some(item => item.verdict.level === 'warn' || item.verdict.level === 'flag');
                                send(res, 200, { ok: true, flagged: flagged ? 1 : 0, findings: flagged ? result.items.map(item => ({ where: '', headline: item.verdict.headline, values: item.verdict.values })) : [], markdown: renderCall(result) });
                                return;
                            }
                            if (req.method === 'POST' && route === 'key') {
                                /*
                                 * Why the toolkit carries a credential box despite the lens having one:
                                 * the kit reads the same `TYPESAFE_API_KEY`, but *configuring* it lived
                                 * only in the lens's card — which made the lens impossible to uninstall
                                 * without losing the UI for the one secret this whole family needs.
                                 */
                                const body = await readBody(req);
                                const value = typeof body?.value === 'string' ? body.value.trim() : '';
                                if (!value) {
                                    send(res, 400, { ok: false, error: '空 key' });
                                    return;
                                }
                                const service = services.credentials;
                                if (service && typeof service.set === 'function') {
                                    await service.set(config.apiKeyRef, value);
                                }
                                else {
                                    send(res, 400, { ok: false, error: '本 profile 没有凭据服务，请用环境变量 TYPESAFE_API_KEY 或 config.apiKey' });
                                    return;
                                }
                                // Force a re-resolve and forgive the old key's sins immediately: the
                                // point of pasting a new one is that it takes effect now.
                                keyState.value = '';
                                breaker.ok();
                                await ensureJev();
                                send(res, 200, { ok: true, key: { configured: keyState.value !== '', source: keyState.source, fingerprint: keyState.value ? keyFingerprint(keyState.value) : '' } });
                                return;
                            }
                            if (req.method === 'POST' && route === 'key/clear') {
                                const service = services.credentials;
                                if (service && typeof service.unset === 'function')
                                    await service.unset(config.apiKeyRef);
                                keyState.value = '';
                                await ensureJev();
                                send(res, 200, { ok: true, key: { configured: keyState.value !== '', source: keyState.source, fingerprint: '' } });
                                return;
                            }
                            if (req.method === 'POST' && route === 'scan-staged') {
                                /*
                                 * "Scan my staged changes" for a caller that cannot run git (the
                                 * card, a browser). The slash command does the same thing in-process;
                                 * this exists so the button and the command share one behaviour.
                                 */
                                const body = await readBody(req);
                                const repo = typeof body?.repo === 'string' && body.repo ? body.repo : (config.defaultRepo || process.cwd());
                                const { diff, error } = await gitDiff(repo, true);
                                if (error) {
                                    send(res, 200, { ok: false, error: `读不到 ${repo} 的暂存改动：${error}` });
                                    return;
                                }
                                if (!diff.trim()) {
                                    send(res, 200, { ok: true, units: 0, flagged: 0, findings: [], markdown: `${repo} 的暂存区是空的。` });
                                    return;
                                }
                                const units = unitsOf(diff, config.maxItems);
                                const result = await runUnits('private_scan', units, 'card');
                                const findings = result.items.filter(item => item.verdict.level === 'flag').map(item => ({ where: item.where, headline: item.verdict.headline, values: item.verdict.values }));
                                send(res, 200, { ok: true, repo, units: result.items.length, flagged: findings.length, findings, markdown: renderCall(result) });
                                return;
                            }
                            if (req.method === 'POST' && route === 'scan-private') {
                                /*
                                 * The privacy channel reachable from a shell, because a pre-push
                                 * hook cannot call a tool. Without this route the most valuable
                                 * channel in the catalogue only fires when a model remembers to ask
                                 * — measured: 2 interactive calls in a whole session, against the
                                 * lens's 883 automatic command judgments.
                                 */
                                const body = await readBody(req);
                                const artifact = typeof body?.diff === 'string' && body.diff ? body.diff : (typeof body?.text === 'string' ? body.text : '');
                                if (!artifact) {
                                    send(res, 400, { ok: false, error: '需要 diff 或 text' });
                                    return;
                                }
                                const cap = typeof body?.maxItems === 'number' ? Math.max(1, Math.min(200, body.maxItems)) : config.maxItems;
                                const units = unitsOf(artifact, cap);
                                if (!units.length) {
                                    send(res, 200, { ok: true, units: 0, flagged: 0, findings: [], markdown: '没有可扫描的内容（diff 里没有新增行）。' });
                                    return;
                                }
                                const result = await runUnits('private_scan', units, 'hook');
                                const findings = result.items.filter(item => item.verdict.level === 'flag').map(item => ({
                                    where: item.where,
                                    headline: item.verdict.headline,
                                    values: item.verdict.values,
                                }));
                                send(res, 200, {
                                    ok: true,
                                    units: result.items.length,
                                    flagged: findings.length,
                                    findings,
                                    markdown: renderCall(result, findings.length
                                        ? `⚠️ ${findings.length} 处疑似泄漏 —— 逐条确认后再推送（正则扫描仍要照跑，两者互补）`
                                        : '未发现语义层面的泄漏（正则扫描仍要照跑：token 形态、手机号这类由正则负责）'),
                                });
                                return;
                            }
                            if (req.method === 'POST' && route === 'bench') {
                                /*
                                 * The suite takes minutes at corpus scale, so it is reachable as a
                                 * route a shell can call in the background — a long tool call would
                                 * block the very turn that is waiting for the answer.
                                 */
                                const body = await readBody(req);
                                const known = knownEngines();
                                const wanted = Array.isArray(body?.engines) ? body.engines.filter((x) => typeof x === 'string') : config.engines;
                                const { engines } = selectEngines(wanted, known);
                                const reports = [];
                                for (const engine of engines) {
                                    const trials = await runSuite(engine, typeof body?.stateChars === 'number' ? body.stateChars : 0);
                                    reports.push(summarizeEngine(engine.id, engine.label, FIXTURES, trials, percentiles));
                                }
                                append(ledgerDir, { t: Date.now(), kind: 'bench', engines: engines.map(engine => engine.id), fixtures: FIXTURES.length });
                                const details = reports.flatMap(report => report.thresholds);
                                const table = fittedTable(details);
                                saveBenchRecord(engines.map(engine => engine.id), FIXTURES.length, details, table);
                                /*
                                 * `check: true` turns the run into a gate for CI: every channel with
                                 * enough fixtures must clear a separation floor, and channels whose
                                 * wording moved since the recorded fit are named. Wording *is* the
                                 * calibration — this is the only thing that would have caught the
                                 * polarity inversion and the reworded channel automatically.
                                 */
                                const floor = typeof body?.floor === 'number' ? body.floor : 0.75;
                                const failures = reports.flatMap(report => report.byChannel
                                    .filter(row => row.n >= 10 && row.separation !== undefined && row.separation < floor)
                                    .map(row => ({ engine: report.engine, channel: row.channel, separation: row.separation, floor })));
                                const drift = wordingDrift(loadBenchRecord());
                                send(res, 200, {
                                    ok: failures.length === 0,
                                    check: body?.check === true ? { passed: failures.length === 0, failures, wordingDrift: drift, floor } : undefined,
                                    fixtures: FIXTURES.length,
                                    markdown: renderBench(reports, FIXTURES, body?.verbose === true),
                                    // Apply-ready: POST this back to /config under `thresholds`.
                                    thresholds: table,
                                });
                                return;
                            }
                            if (req.method === 'POST' && route === 'heal-client') {
                                const cleared = healClientMeta(ctx);
                                send(res, 200, { ok: true, cleared, note: cleared ? '已清理，下一次注入即可见' : '没有需要清理的条目' });
                                return;
                            }
                            if (req.method === 'GET' && route === 'thresholds') {
                                /*
                                 * What the card offers to apply, plus what is in force and whether the
                                 * wording moved since the fit: a threshold measured against different
                                 * questions is not a threshold for these questions.
                                 */
                                const record = loadBenchRecord();
                                send(res, 200, {
                                    ok: true,
                                    applied: thresholdOverrides(),
                                    suggested: record?.thresholds ?? {},
                                    details: record?.details ?? [],
                                    at: record?.at ?? null,
                                    fixtures: record?.fixtures ?? 0,
                                    wordingDrift: wordingDrift(record),
                                });
                                return;
                            }
                            if (req.method === 'GET' && route === 'channels') {
                                send(res, 200, { ok: true, channels: CHANNEL_LIST.map(c => ({ id: c.id, group: c.group, title: c.title, intent: c.intent, per: c.per })) });
                                return;
                            }
                            send(res, 404, { ok: false, error: `unknown route ${route}` });
                        }
                        catch (error) {
                            send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
                        }
                    },
                }), 'jev-kit api');
            });
        }
        catch { /* no webServer service: the tools still work */ }
    }
    /* ── slash command ──────────────────────────────────────────────────── */
    try {
        ctx.inject?.(['commands'], (scope) => {
            scope.effect(() => scope.commands?.register({
                name: 'jev-kit',
                description: 'Jev 决策工具箱：scan [路径] / scope <任务> / report [days] / channels / status',
                input: { hint: 'scan [repo] | scope <task> | report [days] | channels | status' },
                handler: async (invocation) => {
                    const raw = invocation.rawInput.trim();
                    const [sub = '', ...rest] = raw.split(/\s+/);
                    const repo = config.defaultRepo || invocation.cwd || process.cwd();
                    /*
                     * `scan` and `scope` exist because a tool only fires when a model remembers
                     * to call it — measured: the privacy channel ran twice in an entire session,
                     * and nobody remembers at push time. One command, no diff to paste.
                     */
                    if (sub === 'scan') {
                        const target = rest[0] && !rest[0].startsWith('-') ? rest[0] : repo;
                        const { diff, error } = await gitDiff(target, true);
                        if (error)
                            return { kind: 'error', text: `读不到 ${target} 的暂存改动：${error}` };
                        if (!diff.trim())
                            return { kind: 'success', text: `${target} 的暂存区是空的（先 git add；未暂存改动用 git diff 查看）。` };
                        const result = await runUnits('private_scan', unitsOf(diff, config.maxItems), 'command');
                        return { kind: 'success', text: `**暂存改动扫描**（${target}）\n\n${renderCall(result)}` };
                    }
                    if (sub === 'scope') {
                        const task = rest.join(' ').trim();
                        if (!task)
                            return { kind: 'error', text: '用法：/jev-kit scope <任务描述> —— 对暂存区每个 hunk 判断是否属于该任务' };
                        const { diff, error } = await gitDiff(repo, true);
                        if (error)
                            return { kind: 'error', text: `读不到暂存改动：${error}` };
                        if (!diff.trim())
                            return { kind: 'success', text: '暂存区是空的。' };
                        const result = await runUnits('scope_check', hunksOf(diff, config.maxItems), 'command', { task });
                        return { kind: 'success', text: `**改动范围核对**（任务：${task}）\n\n${renderCall(result)}` };
                    }
                    if (sub === 'report') {
                        const days = Math.max(1, Math.min(90, Number(rest[0]) || 7));
                        return { kind: 'success', text: render(summarize(load(ledgerDir, days), days)) };
                    }
                    if (sub === 'channels') {
                        const lines = ['**dsh-jev-kit 通道目录**'];
                        for (const channel of CHANNEL_LIST)
                            lines.push(`· ${channel.group} \`${channel.id}\` — ${channel.title}`);
                        return { kind: 'success', text: lines.join('\n') };
                    }
                    return {
                        kind: 'success',
                        text: [
                            `dsh-jev-kit v${VERSION} · enabled=${config.enabled} · key=${keyState.source} · 通道 ${CHANNEL_LIST.length}`,
                            `ledger ${ledgerDir}`,
                            '用法：/jev-kit scan [路径] · /jev-kit scope <任务> · /jev-kit report [days] · /jev-kit channels',
                        ].join('\n'),
                    };
                },
            }), 'jev-kit command');
        });
    }
    catch { /* commands service absent */ }
    /* ── stored settings, then the API ──────────────────────────────────── */
    const stored = loadStored(ledgerDir);
    if (stored) {
        const candidate = merge(KIT_DEFAULTS, stored);
        const problem = validate(candidate);
        if (problem)
            logger?.warn?.(`[dsh-jev-kit] 已存设置不可用（${problem}），改用默认值`);
        else
            config = { ...config, ...candidate };
    }
    /*
     * Run the repair during apply, before the boot graph is composed for this
     * entry — a plugin whose browser half was added after its first mount is
     * otherwise invisible in the UI with no error anywhere.
     */
    const healedAt = healClientMeta(ctx);
    if (healedAt)
        logger?.info?.(`[dsh-jev-kit] 已清理自身 client 元数据缓存 ${healedAt} 条`);
    try {
        ctx.inject?.(['clientModules'], (scope) => { healClientMeta(scope); });
    }
    catch { /* no client-modules service in this profile */ }
    /*
     * Apply the fitted threshold table **after** the stored settings are merged.
     * Applying it before was a real bug: the persisted table was read one line
     * later, so a restart silently reverted to the hand-picked cuts.
     */
    setThresholdOverrides(config.thresholds);
    // The readers get the same table: a fit that only changes the report is not a fix.
    setReaderThresholds(config.thresholds);
    if (Object.keys(config.thresholds).length) {
        logger?.info?.(`[dsh-jev-kit] 已应用 ${Object.keys(config.thresholds).length} 条拟合阈值：${JSON.stringify(config.thresholds)}`);
    }
    installApi(ctx);
}
/** Exported for the offline tests: the pieces that must not need a host to check. */
export { CHANNEL_LIST, channelOf } from './channels.js';
export { unitsOf, hunksOf, diffUnits, textUnits, isDiff } from './segments.js';
export { summarize as summarizeLedger } from './ledger.js';
//# sourceMappingURL=index.js.map