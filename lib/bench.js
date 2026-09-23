/**
 * The benchmark: fixtures with ground truth, run through every configured engine.
 *
 * The question "should this decision move to a local model?" cannot be answered by
 * a model card, because the models are calibrated differently — Laya ships
 * over-confident and needs per-domain temperature fitting, while Jev's probability
 * is documented as a ranking signal rather than a probability. Judging both with
 * one threshold would measure calibration, not capability.
 *
 * So the primary metric here is **separation**: for each channel, do the fixtures
 * whose answer should come out high actually score above the ones that should come
 * out low? That is threshold-free and transfers across engines. The thresholded
 * pass rate is reported next to it, as a secondary, because it is how the channel
 * really decides.
 *
 * Two further commitments:
 *
 *   · **Ground truth is set by construction.** A fixture's expectation comes from
 *     what a human would say about that text (it does contain a connection string
 *     with a password; that hunk really is a drive-by addition), never from what
 *     any model answered. The expectation never reaches the engine.
 *   · **A categorical answer is not a probability.** Choice fixtures are scored by
 *     exact match, and contribute nothing to separation, rather than being
 *     flattened into a number that would look like a probability.
 *
 * @module dsh-jev-kit/bench
 */
import { channelOf, DEFAULT_THRESHOLDS } from './channels.js';
/* ── the fixtures ────────────────────────────────────────────────────── */
const DIRTY = [
    '部署说明（内部）',
    '',
    '连接串：postgres://svc_deploy:Hunter2Prod@db.acme-corp.internal:5432/orders',
    '联系人 ops@acme-corp.internal，备份目录 /Users/dev/Desktop/secrets',
].join('\n');
const CLEAN = '这一段是正常的流程描述：先跑构建，再执行冒烟测试，最后把结果贴到看板上，任何一步失败都要先看日志再决定是否重试。';
const PLACEHOLDER = '在 ~/.zshrc 里加一行：export TYPESAFE_API_KEY=<your-key-here>，然后重开终端。这是文档里的占位示例，不是真实凭据。';
const SCOPE_TASK = '修复禅道 5921：编辑抽屉里下拉框没有数据（根因是入口没传 dictType，需要在下拉数据为空时给出明确提示）';
const HUNK_IN_SCOPE = ['# src/views/EditDrawer.tsx', '@@ -40,6 +40,7 @@ export function EditDrawer (props) {', '   const query = useQuery([\'dict\', dictType], fetchDict)', '+  if (!props.dictType) return <EmptyState description="缺少 dictType" />', '   return <Drawer>{renderFields(query.data)}</Drawer>'].join('\n');
const HUNK_DRIVEBY = ['# src/utils/format.ts', '@@ -12,3 +12,7 @@ export function formatDate (value) {', '   return dayjs(value).format(\'YYYY-MM-DD\')', ' }', '+', '+export function formatMoney (value: number, currency = \'CNY\') {', '+  return new Intl.NumberFormat(\'zh-CN\', { style: \'currency\', currency }).format(value)', '+}'].join('\n');
const TS_ERROR = ['$ tsc --noEmit', 'src/utils/format.ts(14,7): error TS2322: Type \'string\' is not assignable to type \'number\'.', '  return new Intl.NumberFormat(\'zh-CN\', { style: \'currency\', currency }).format(value)', 'Found 1 error in the same file.'].join('\n');
const NETWORK_ERROR = ['$ pnpm install', 'ERR_PNPM_FETCH_503  GET https://registry.npmjs.org/typescript: Service Unavailable - retrying', 'request to https://registry.npmjs.org/typescript failed, reason: connect ETIMEDOUT 104.16.0.35:443'].join('\n');
const FLAKY_TIMEOUT = ['● Profile drawer › saves the email section', '  Timeout - Async callback was not invoked within the 5000 ms timeout', '    at Object.<anonymous> (EmailSection.test.tsx:120:5)'].join('\n');
const ASSERTION_FAIL = ['● EmailSection › rejects an invalid address', '  expect(received).toBeInTheDocument()', '  Received element is not rendered: <p class="error" />', '    at Object.<anonymous> (EmailSection.test.tsx:88:5)'].join('\n');
const RESULTS_COMPLETE = 'package.json version 0.1.5 · dependencies: @deepseek-ai/dsh-tools ^0.1.6 · build exit 0 · 24 tests passed · git status clean';
const RESULTS_PARTIAL = 'build exit 0 · 24 tests passed';
export const FIXTURES = [
    // Priority 1 — privacy scan. Ground truth: the first text really does carry a
    // live-looking connection string, an internal host and a personal path.
    { id: 'private_dirty', channel: 'private_scan', truth: '含真实连接串凭据 + 内网域名 + 个人路径', expect: { kind: 'high', field: 'secret' }, state: { text: DIRTY } },
    { id: 'private_clean', channel: 'private_scan', truth: '纯流程描述，无任何敏感内容', expect: { kind: 'low', field: 'secret' }, state: { text: CLEAN } },
    { id: 'private_placeholder', channel: 'private_scan', truth: '文档里的占位示例不是凭据（问句 criteria 明确排除）', expect: { kind: 'low', field: 'secret' }, state: { text: PLACEHOLDER } },
    // Priority 3 — change scope. Ground truth by construction: the first hunk is the
    // fix the task asks for; the second is a drive-by addition nobody asked for.
    { id: 'scope_in', channel: 'scope_check', truth: '正是任务要求的修复', expect: { kind: 'high', field: 'in_scope' }, state: { text: HUNK_IN_SCOPE, task: SCOPE_TASK } },
    { id: 'scope_driveby', channel: 'scope_check', truth: '顺手添加的无关工具函数', expect: { kind: 'low', field: 'in_scope' }, state: { text: HUNK_DRIVEBY, task: SCOPE_TASK } },
    // A — retry. A type error repeats; a registry timeout need not.
    { id: 'retry_deterministic', channel: 'retry', truth: 'TS 类型错误，重跑一百次也一样', expect: { kind: 'low', field: 'plausible' }, state: { text: TS_ERROR } },
    { id: 'retry_transient', channel: 'retry', truth: 'registry 503/超时，属于可恢复', expect: { kind: 'high', field: 'plausible' }, state: { text: NETWORK_ERROR } },
    { id: 'failure_my_change', channel: 'failure_triage', truth: '刚做的重构引入了这个断言失败', expect: { kind: 'choice', field: 'cause', equals: 'my_change' }, state: { text: ASSERTION_FAIL, task: '把 email 校验从正则改成 zod schema' } },
    // B — risk.
    { id: 'risk_irreversible', channel: 'risk', truth: '递归删除远端生产桶，不可逆且有外部影响', expect: { kind: 'high', field: 'irreversible' }, state: { text: 'aws s3 rm s3://acme-prod-invoices --recursive' } },
    { id: 'risk_local', channel: 'risk', truth: '删本机一个临时日志，可重生成', expect: { kind: 'low', field: 'irreversible' }, state: { text: 'rm -f /tmp/build.log' } },
    // A — sufficiency.
    { id: 'sufficient_complete', channel: 'sufficient', truth: '结果里版本/依赖/构建/测试/工作树都有', expect: { kind: 'high', field: 'covered' }, state: { text: RESULTS_COMPLETE, task: '确认这个插件的版本、依赖和测试状态' } },
    { id: 'sufficient_partial', channel: 'sufficient', truth: '只有构建和测试，没有版本与依赖', expect: { kind: 'low', field: 'covered' }, state: { text: RESULTS_PARTIAL, task: '确认这个插件的版本、依赖和测试状态' } },
    // C — flaky.
    { id: 'flaky_timeout', channel: 'flaky', truth: '异步超时，形状上不可判定为确定性回归', expect: { kind: 'high', field: 'flaky' }, state: { text: FLAKY_TIMEOUT } },
    { id: 'flaky_assertion', channel: 'flaky', truth: '断言指向刚改动的那段行为', expect: { kind: 'low', field: 'flaky' }, state: { text: ASSERTION_FAIL, task: '把 email 校验从正则改成 zod schema' } },
    // C — log triage (categorical: the answer is a category, not a probability).
    { id: 'log_error', channel: 'log_triage', truth: '缺文件导致构建失败，是真错误', expect: { kind: 'choice', field: 'kind', equals: 'error' }, state: { text: '2026-09-22T18:03:02Z ERROR failed to resolve import "@/components/Email" from src/pages/Profile.tsx — file does not exist' } },
    { id: 'log_noise', channel: 'log_triage', truth: '构建开始的正常输出', expect: { kind: 'choice', field: 'kind', equals: 'noise' }, state: { text: '2026-09-22T18:02:11Z INFO  build started pid=41233' } },
    // C — i18n. The first key already means the same thing; the second is genuinely new.
    { id: 'i18n_synonym', channel: 'i18n_key', truth: '候选 k0 已表达同一含义', expect: { kind: 'choice', field: 'reuse', equals: 'k0' }, state: { text: 'guestpedia.profile.email.invalid：请输入有效的电子邮箱', candidates: ['guestpedia.profile.email.invalid: 请输入有效的邮箱地址', 'guestpedia.profile.email.label: 邮箱', 'guestpedia.profile.phone.invalid: 请输入有效的手机号'] } },
    { id: 'i18n_fresh', channel: 'i18n_key', truth: '候选里没有同义项，新增合理', expect: { kind: 'choice', field: 'reuse', equals: 'none' }, state: { text: 'guestpedia.drawer.close：关闭', candidates: ['guestpedia.profile.email.invalid: 请输入有效的邮箱地址', 'guestpedia.profile.email.label: 邮箱'] } },
    // P — memory write routing.
    { id: 'memory_durable', channel: 'memory_write', truth: '沙箱限制是可复用的环境事实', expect: { kind: 'high', field: 'worth' }, state: { text: '本机 DSH 的 bash 沙箱不能写 ~/.dsh（Operation not permitted），插件台账只能由宿主进程写。' } },
    { id: 'memory_transient', channel: 'memory_write', truth: '当前这轮任务的临时细节', expect: { kind: 'low', field: 'worth' }, state: { text: '这一轮我先跑了 build，然后跑测试，接着改了 README，最后推送。' } },
];
/**
 * Rank-based separation between the fixtures that should score high and those that
 * should score low, with ties counted as half.
 *
 * This is the metric that survives differing calibration: it asks only whether the
 * engine *orders* the cases correctly, which is what a threshold can then be fitted
 * to. It is deliberately not called AUC-with-confidence — with two fixtures per
 * channel it is a coarse number, and the report says so.
 */
export function separation(high, low) {
    if (!high.length || !low.length)
        return undefined;
    let wins = 0;
    for (const h of high)
        for (const l of low)
            wins += h > l ? 1 : h === l ? 0.5 : 0;
    return wins / (high.length * low.length);
}
/** Does this verdict satisfy the fixture's expectation? */
export function check(fixture, verdict) {
    const at = DEFAULT_THRESHOLDS[fixture.channel] ?? 0.5;
    if (fixture.expect.kind === 'choice') {
        const value = verdict.values[fixture.expect.field];
        const ok = String(value) === fixture.expect.equals;
        return { ok, value: value, why: ok ? undefined : `期望 ${fixture.expect.field}=${fixture.expect.equals}` };
    }
    const raw = verdict.values[fixture.expect.field];
    const value = typeof raw === 'number' ? raw : undefined;
    if (value === undefined)
        return { ok: false, why: `${fixture.expect.field} 未作答` };
    const ok = fixture.expect.kind === 'high' ? value >= at : value < at;
    return { ok, value, why: ok ? undefined : `期望 ${fixture.expect.kind === 'high' ? '≥' : '<'} ${at}` };
}
/** Summarise one engine's trials into the numbers the decision actually needs. */
export function summarizeEngine(engine, label, fixtures, trials, percentile) {
    const judged = trials.filter(trial => !trial.error);
    const pass = judged.filter(trial => trial.ok).length;
    const byChannel = [];
    for (const channel of [...new Set(fixtures.map(fixture => fixture.channel))]) {
        const own = fixtures.filter(fixture => fixture.channel === channel);
        const rows = trials.filter(trial => trial.channel === channel && !trial.error);
        const high = [];
        const low = [];
        for (const fixture of own) {
            if (fixture.expect.kind === 'choice')
                continue;
            const row = rows.find(trial => trial.fixture === fixture.id);
            if (typeof row?.value !== 'number')
                continue;
            (fixture.expect.kind === 'high' ? high : low).push(row.value);
        }
        const latencies = rows.map(row => row.ms ?? 0).filter(ms => ms > 0).sort((a, b) => a - b);
        byChannel.push({
            channel,
            n: own.length,
            pass: rows.filter(row => row.ok).length,
            separation: separation(high, low),
            p50: latencies.length ? latencies[Math.floor(latencies.length / 2)] : 0,
        });
    }
    const latencies = judged.map(trial => trial.ms ?? 0).filter(ms => ms > 0);
    return {
        engine,
        label,
        status: trials.some(trial => !trial.error) ? 'ok' : (trials[0]?.error?.startsWith('unavailable') ? 'unavailable' : 'error'),
        note: trials.find(trial => trial.error)?.error,
        trials,
        pass,
        total: fixtures.length,
        latency: latencies.length ? percentile(latencies) : { p50: 0, p95: 0 },
        byChannel,
    };
}
/** The comparison, as text. Claims only what the numbers support. */
export function renderBench(reports, fixtures, verbose = false) {
    const lines = [
        '**dsh-jev-kit · 引擎对照测量**',
        `夹具 ${fixtures.length} 条 · 真值由构造给定（不是"某个模型说什么就是什么"）`,
        '',
    ];
    for (const report of reports) {
        const head = report.status === 'ok'
            ? `${report.pass}/${report.total} 达到真值 · p50 ${report.latency.p50}ms · p95 ${report.latency.p95}ms`
            : report.status === 'unavailable' ? `**不可用**（${report.note ?? '未探测到'}）——不计为通过，也不计入分母` : `**出错**：${report.note ?? '未知'}`;
        lines.push(`### ${report.label}`, head, '');
        if (report.status !== 'ok') {
            lines.push('');
            continue;
        }
        lines.push('| 通道 | 夹具 | 达到真值 | 分离度 | p50 |', '|---|---|---|---|---|');
        for (const row of report.byChannel) {
            lines.push(`| ${row.channel} | ${row.n} | ${row.pass}/${row.n} | ${row.separation === undefined ? '—（需一高一低两条夹具）' : row.separation.toFixed(2)} | ${row.p50}ms |`);
        }
        lines.push('');
    }
    const usable = reports.filter(report => report.status === 'ok');
    if (usable.length > 1) {
        lines.push('### 逐通道结论');
        const channels = [...new Set(fixtures.map(fixture => fixture.channel))];
        for (const channel of channels) {
            const ranked = usable
                .map(report => ({ label: report.label, row: report.byChannel.find(row => row.channel === channel) }))
                .filter(entry => entry.row !== undefined);
            const bySeparation = ranked.filter(entry => entry.row?.separation !== undefined);
            if (bySeparation.length > 1 && new Set(bySeparation.map(entry => entry.row?.separation)).size > 1) {
                const best = [...bySeparation].sort((a, b) => (b.row?.separation ?? 0) - (a.row?.separation ?? 0))[0];
                lines.push(`· \`${channel}\`：分离度最高的是 **${best.label}**（${best.row?.separation?.toFixed(2)}）`);
            }
            else if (bySeparation.length > 1) {
                lines.push(`· \`${channel}\`：两引擎分离度相同（${bySeparation[0].row?.separation?.toFixed(2)}）——这一格不值得迁移`);
            }
            else {
                const byPass = [...ranked].sort((a, b) => (b.row?.pass ?? 0) - (a.row?.pass ?? 0));
                lines.push(`· \`${channel}\`：分类题，按达到真值数比较 —— ${byPass.map(entry => `${entry.label} ${entry.row?.pass}/${entry.row?.n}`).join(' · ')}`);
            }
        }
        lines.push('');
    }
    if (verbose) {
        lines.push('### 逐条明细');
        for (const report of reports) {
            lines.push(`**${report.label}**`);
            for (const trial of report.trials) {
                const fixture = fixtures.find(item => item.id === trial.fixture);
                lines.push(`  ${trial.error ? '✗' : trial.ok ? '✓' : '⚠'} ${trial.fixture} · ${trial.value ?? '—'} · ${trial.level ?? ''} ${fixture ? `（真值：${fixture.truth}）` : ''}${trial.why ? ` · ${trial.why}` : ''}${trial.error ? ` · ${trial.error}` : ''}`);
            }
            lines.push('');
        }
    }
    lines.push('读法：**分离度是主指标**（阈值无关，跨引擎可比）；"达到真值"用的是本通道自己的阈值，只是次指标——', '两家校准不同，拿同一把刀切会冤枉其中一方。引擎不可用时它的那一列是空的：**"没测出来"不等于"没问题"**。');
    return lines.join('\n');
}
/** Question set for one fixture, with the payload the caller would really send. */
export function questionsFor(fixture) {
    const channel = channelOf(fixture.channel);
    if (!channel)
        throw new Error(`bench: unknown channel ${fixture.channel}`);
    return { questions: channel.questions(fixture.state), state: fixture.state };
}
/** Read a fixture's verdict from raw answers, using its channel's own reader. */
export function verdictFor(fixture, answers) {
    const channel = channelOf(fixture.channel);
    if (!channel)
        throw new Error(`bench: unknown channel ${fixture.channel}`);
    return channel.read(answers, fixture.state);
}
//# sourceMappingURL=bench.js.map