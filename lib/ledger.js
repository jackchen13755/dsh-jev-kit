/**
 * The kit's ledger: one row per judgment, metadata only.
 *
 * It exists for the reason the whole toolkit exists measured rather than
 * asserted: without a record of what was asked, what answered, how long it took
 * and whether the caller acted on it, "Jev is useful here" is a feeling. No
 * bodies: a redacted, capped excerpt at most, never the full text under judgment.
 *
 * @module dsh-jev-kit/ledger
 */
import fs from 'node:fs';
import path from 'node:path';
import { percentiles } from '@dsh-external/dsh-jev-core';
import { CHANNEL_LIST } from './channels.js';
/** The full catalogue, so the report can name what was never used. */
const ALL_CHANNELS = CHANNEL_LIST.map(channel => channel.id);
export const ledgerFile = (dir, when = new Date()) => path.join(dir, `ledger-${when.toISOString().slice(0, 10)}.jsonl`);
/** Append one row. Best-effort by design: measurement never breaks a task. */
export function append(dir, record) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(ledgerFile(dir), JSON.stringify(record) + '\n');
    }
    catch { /* a ledger write must never be the reason a task fails */ }
}
/** Load the last `days` daily files, oldest first. */
export function load(dir, days, now = new Date()) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const file = ledgerFile(dir, new Date(now.getTime() - i * 86400000));
        if (!fs.existsSync(file))
            continue;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim())
                continue;
            try {
                out.push(JSON.parse(line));
            }
            catch { /* torn line */ }
        }
    }
    return out.sort((a, b) => a.t - b.t);
}
/** Sample size below which a channel's silence means nothing. */
export const MIN_SAMPLE = 20;
/**
 * Judged from the counts, in one place.
 *
 * The card, the copied Markdown and `/jev-kit report` all render this table, so "when
 * do I retire a channel" is decided once here — two implementations of it drift the
 * moment one of them is edited, which is the same failure mode as a route and its
 * client disagreeing about a payload.
 *
 * @param row - the counts that decide it.
 * @returns the verdict.
 */
export const verdictOf = (row) => row.flagged > 0 ? 'useful' : row.warn > 0 ? 'warn' : row.n >= MIN_SAMPLE ? 'retire' : 'thin';
/**
 * Colour marker per verdict.
 *
 * The report is read in Markdown and in a terminal, where a row cannot be coloured, so
 * the marker has to survive copy-paste — which is why the levels get a symbol rather
 * than staying implicit in the numbers.
 */
export const VERDICT_MARK = { useful: '🔴', warn: '🟡', retire: '⬛', thin: '⚪' };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** Aggregate the ledger by channel — the only honest way to rank this catalogue. */
export function summarize(records, days, usdPerMTok = 0.042) {
    const decisions = records.filter((r) => r.kind === 'decision');
    const byChannel = new Map();
    for (const row of decisions) {
        const list = byChannel.get(row.channel) ?? [];
        list.push(row);
        byChannel.set(row.channel, list);
    }
    const channels = [...byChannel.entries()].map(([channel, rows]) => {
        const n = rows.length;
        const flagged = rows.filter(r => r.level === 'flag').length;
        const warn = rows.filter(r => r.level === 'warn').length;
        return {
            channel,
            group: rows[0]?.group ?? '?',
            n,
            flagged,
            warn,
            level: verdictOf({ n, flagged, warn }),
            cached: rows.filter(r => r.via === 'cache').length,
            latency: percentiles(rows.map(r => r.ms ?? 0).filter(ms => ms > 0)),
            acted: rows.filter(r => r.acted !== undefined).length,
            actedYes: rows.filter(r => r.acted === true).length,
        };
    }).sort((a, b) => b.n - a.n);
    // Tokens are not recorded per row (the state size is), so the cost shown is an
    // estimate at the documented rate rather than a measurement pretending to be one.
    const chars = decisions.reduce((sum, r) => sum + r.chars, 0);
    const inputTokens = Math.round(chars / 4);
    return {
        window: { days, records: records.length },
        total: decisions.length,
        cost: { inputTokens, usd: Number(((inputTokens * usdPerMTok) / 1e6).toFixed(6)), savedCalls: decisions.filter(r => r.via === 'cache').length },
        channels,
        health: {
            degraded: records.filter(r => r.kind === 'degraded').length,
            errors: records.filter(r => r.kind === 'error').length,
        },
        byEntry: (() => {
            const counts = new Map();
            for (const row of decisions) {
                const entry = row.session ?? '(未记录)';
                const own = counts.get(entry) ?? { n: 0, flag: 0 };
                own.n++;
                if (row.level === 'flag')
                    own.flag++;
                counts.set(entry, own);
            }
            return [...counts.entries()].map(([entry, own]) => ({ entry, ...own })).sort((a, b) => b.n - a.n);
        })(),
        unusedChannels: (() => {
            const used = new Set(decisions.map(row => row.channel));
            return ALL_CHANNELS.filter(channel => !used.has(channel));
        })(),
        bench: (() => {
            const trials = records.filter((r) => r.kind === 'trial');
            const byEngine = {};
            for (const trial of trials) {
                const own = byEngine[trial.engine] ?? { n: 0, pass: 0 };
                own.n++;
                if (trial.ok)
                    own.pass++;
                byEngine[trial.engine] = own;
            }
            return { trials: trials.length, byEngine };
        })(),
    };
}
/** Human-readable report. */
export function render(report) {
    const lines = [
        '**dsh-jev-kit · Jev 决策工具箱**',
        `窗口：最近 ${report.window.days} 天 · ${report.total} 次判断 · 估算成本 $${report.cost.usd}（≈${report.cost.inputTokens} input tok）· 命中缓存 ${report.cost.savedCalls}`,
        '',
        '| 判定 | 通道 | 组 | 次数 | ⚠️flag | △warn | 缓存 | p50 | p95 |',
        '|---|---|---|---|---|---|---|---|---|',
    ];
    for (const channel of report.channels) {
        lines.push(`| ${VERDICT_MARK[channel.level]} | ${channel.channel} | ${channel.group} | ${channel.n} | ${channel.flagged} | ${channel.warn} | ${channel.cached} | ${channel.latency.p50}ms | ${channel.latency.p95}ms |`);
    }
    if (!report.channels.length)
        lines.push('| （还没有判断记录） | | | | | | | | |');
    lines.push('', `判定：🔴 有命中（去看它抓到了什么）· 🟡 只有 warn（观察）· ⬛ 样本够了却从未非中性（淘汰或改问句——本表唯一的行动项）· ⚪ 样本不足（不表态，样本 < ${MIN_SAMPLE}）`, '', report.health.degraded || report.health.errors
        ? `⚠️ 降级 ${report.health.degraded} · 失败 ${report.health.errors}（失败永远不记成"没问题"）`
        : '无降级、无失败', '', report.byEntry.length
        ? `按入口：${report.byEntry.map(row => `\`${row.entry}\`×${row.n}${row.flag ? `(⛔${row.flag})` : ''}`).join(' · ')} —— **没有入口的通道永远是 0，无论问句写得多好**`
        : '', report.unusedChannels.length
        ? `从未被真实调用过的通道（${report.unusedChannels.length}）：${report.unusedChannels.map(c => `\`${c}\``).join(' · ')} —— 评测能证明"它能判"，只有用法能证明"有人要"。停用它们：设置里的 disabledChannels。`
        : '每个通道都被真实调用过。', '', '读法：**这个表是用来淘汰通道的**。某个通道次数不少但 flag/warn 长期为 0，说明它在你的语料上不产生信息——那就别用了，别留着自我安慰。');
    return lines.join('\n');
}
//# sourceMappingURL=ledger.js.map