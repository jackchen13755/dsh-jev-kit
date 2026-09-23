/**
 * The channel catalogue: every judgment this toolkit can make.
 *
 * A channel is a *named decision* with four parts: the state it needs, the typed
 * questions it asks about that state, how the answers fold into a verdict, and
 * the advice that verdict produces. Keeping all four in one table is what makes
 * the toolkit auditable — the wording is the calibration, so it lives next to the
 * threshold that consumes it instead of scattered through call sites.
 *
 * Two rules shaped every entry:
 *
 *   · **Presence, not relevance.** Jev separates cleanly on "is X in this text?"
 *     and poorly on "how relevant is this?" (measured locally: 36 real code
 *     segments scored 0.02–0.66, so a 0.5 cut would have dropped 75% of them).
 *     Every question below is therefore phrased as a presence or category test.
 *   · **Advice, never enforcement.** Nothing here blocks, rewrites, or asks a
 *     human. A toolkit that could gate would inherit every failure mode of a
 *     gate — including the `approval: never` trap where an ask silently becomes
 *     a refusal with a false reason. This one only ever returns text.
 *
 * @module dsh-jev-kit/channels
 */
import type { JevAnswer, JevQuestion } from '@dsh-external/dsh-jev-core'

/**
 * Effective thresholds for the readers themselves.
 *
 * The override map started life in the benchmark (scoring fixtures), which meant a
 * fitted cut changed the *report* but not what the plugin actually did. The first
 * real pre-push run showed why that is not enough: ordinary TypeScript was flagged
 * as "internal information" at exactly the 0.50 boundary, and the only way to act on
 * that evidence was to edit source. Readers now consult the same map.
 */
let READER_THRESHOLDS: Record<string, number> = {}

/** Apply fitted cuts to the readers (called with the same table as the benchmark). */
export function setReaderThresholds (map: Record<string, number> | undefined): void {
  READER_THRESHOLDS = { ...(map ?? {}) }
}

/** The effective cut for a channel inside a reader: override, else the literal default. */
export function readerThreshold (channel: string, fallback: number): number {
  const cut = READER_THRESHOLDS[channel]
  return typeof cut === 'number' && Number.isFinite(cut) ? cut : fallback
}

/** Which part of the catalogue a channel belongs to. `P` is the priority set. */
export type ChannelGroup = 'P' | 'A' | 'B' | 'C' | 'D'

/** How one judgment is read. */
export type VerdictLevel = 'ok' | 'info' | 'warn' | 'flag'

export interface Verdict {
  level: VerdictLevel
  /** One line, safe to show the model or a human. */
  headline: string
  /** Supporting numbers, never prose. */
  details?: string[]
  /** Raw answers, for the ledger and for callers that want their own policy. */
  values: Record<string, number | string | undefined>
}

/** What a channel needs from its caller. Fields are referenced by name in the questions. */
export interface ChannelState {
  /** The thing under judgment: a segment, a hunk, a tool result, a diff. */
  text?: string
  /**
   * A shell command, for the fixtures that measure another plugin's wording
   * verbatim (`dsh-jev-lens` names this field `command`, not `text`).
   */
  command?: string
  /** The user's request or task, when the judgment is relative to one. */
  task?: string
  /** A shortlist to choose from (components, tests, skills, memories). */
  candidates?: string[]
  /** The candidate list's meaning, for the question wording. */
  candidateNoun?: string
  /** A requirement list to check an artifact against. */
  requirements?: string[]
  /** A second text, for pair judgments (dedup, contradiction). */
  other?: string
  /** Extra scalar context the questions may name (e.g. a file path, a command). */
  extra?: Record<string, string>
}

export interface ChannelSpec {
  id: string
  group: ChannelGroup
  /** Human title (zh-CN; the card and the report are read on this machine). */
  title: string
  /** What it replaces, in one line — the reason it exists at all. */
  intent: string
  /** One call per item, or one call for the whole input. */
  per: 'item' | 'input'
  /** The questions, as a function of the state so field names stay honest. */
  questions: (state: ChannelState) => Record<string, JevQuestion>
  /** Fold the typed answers into a verdict. */
  read: (answers: Record<string, JevAnswer>, state: ChannelState) => Verdict
  /** Probability above which a binary channel is called positive. */
  at?: number
}

/* ── question builders ───────────────────────────────────────────────── */

const noul = (instructions: string, yes: string, no: string): JevQuestion =>
  ({ type: 'noul', instructions, criteria: { true: yes, false: no } })

const choice = (instructions: string, criteria: Record<string, string>): JevQuestion =>
  ({ type: 'choice', instructions, criteria })

const score = (instructions: string, criteria: string[]): JevQuestion =>
  ({ type: 'score', instructions, criteria })

/** Read a noul answer, or `undefined` when the model did not answer it. */
const p = (answers: Record<string, JevAnswer>, key: string): number | undefined => {
  const value = answers[key]?.noul
  return typeof value === 'number' ? value : undefined
}

/** Read a choice answer. */
const pickOf = (answers: Record<string, JevAnswer>, key: string): string | undefined => {
  const value = answers[key]?.choice
  return typeof value === 'string' ? value : undefined
}

/** Read a score answer. */
const scoreOf = (answers: Record<string, JevAnswer>, key: string): number | undefined => {
  const value = answers[key]?.score
  return typeof value === 'number' ? value : undefined
}

/** Level for a binary question, using the channel's own threshold. */
const levelAt = (value: number | undefined, at: number): VerdictLevel =>
  value === undefined ? 'info' : value >= at ? 'flag' : 'info'

/** `0.62 (阈值 0.50)` — the shape every detail line uses. */
const show = (value: number | undefined, at?: number): string =>
  value === undefined ? '未作答' : `${value.toFixed(2)}${at === undefined ? '' : `（阈值 ${at.toFixed(2)}）`}`

/* ── the catalogue ───────────────────────────────────────────────────── */

export const CHANNELS: Record<string, ChannelSpec> = {
  /* ── P: the three priorities ──────────────────────────────────────── */

  private_scan: {
    id: 'private_scan',
    group: 'P',
    title: '推送前隐私/凭据语义扫描',
    intent: '在正则扫描之后补一层语义判断：正则抓不到的"注释里写了密码"这类泄漏',
    per: 'item',
    at: 0.5,
    questions: state => ({
      secret: noul('Does `text` contain an actual credential or secret value — a password, API key, token, private key, or connection string with embedded credentials?',
        'a real secret value is present and would be usable if published',
        'no secret value is present; at most a placeholder, an env-var name, or documentation about secrets'),
      personal: noul('Does `text` contain personal or identifying information about a real person — a home directory path belonging to a person, a personal email address, a phone number, a full name tied to an account, or an internal username?',
        'personal or identifying information about a real person is present',
        /*
         * The exclusion list is not decoration here either — it is the same lesson the
         * `internal` axis learned first, applied one axis over.
         *
         * Measured 2026-09-23, before this text existed: the question named "a home
         * directory path" as personal information, so a *tool's own* configuration path
         * (`~/.dsh/profiles/web/node_modules`, `~/.dsh/.credentials.yaml`) scored 0.29–0.47,
         * while the corpus's genuine personal positives score 0.52–0.97. The cut sat at
         * 0.06, and ordinary comments and documentation prose — measured at 0.06–0.10 —
         * were reported as personal data, blocking four pushes in a single day, each time
         * on the author's own writing. Adding near-miss negatives to the corpus did not
         * fix it (those score 0.00–0.47, still below the genuine positives), which is what
         * pointed here: the model was reading its instructions correctly, and the
         * instructions were wrong.
         */
        'no personal information; generic placeholders do not count, nor does identity a project publishes on purpose (its own author/maintainer name, GitHub handle or users.noreply.github.com address in a manifest) — and neither do paths, package names or identifiers belonging to the software being scanned itself (its own config, cache, profile and dependency directories, its own module or package names, and file paths inside the repository under review). Those name a program, not a person'),
      /*
       * The exclusion list is not decoration: the first real pre-push run flagged three
       * lines of ordinary TypeScript in this project as "internal information" because
       * they contain the project's own identifiers. A hook that cries wolf on plain
       * code gets switched off, so the criteria now say out loud what does not count.
       */
      internal: noul('Does `text` reveal an organisation-internal detail that should not be public — an intranet hostname, an internal repository or service name, or an internal project codename?',
        'an intranet hostname, an internal-only service or repository, or an internal codename is exposed',
        'nothing that identifies an internal system; ordinary source code, UI copy and configuration keys of the repository being scanned are not internal details, and neither are public package names, a public vendor\'s documented API endpoint, localhost addresses or open-source project names'),
    }),
    read: (answers, state) => {
      const secret = p(answers, 'secret')
      const personal = p(answers, 'personal')
      const internal = p(answers, 'internal')
      /*
       * Per-axis cuts, measured rather than assumed.
       *
       * A single cut for all three axes failed on the first real pre-push run twice
       * over: ordinary source and UI copy scored 0.62–0.66 on `internal` while the
       * genuine internal leaks in the corpus score 0.81–0.91 — one cut cannot serve
       * both, and lowering the whole channel's sensitivity to clear the noise would
       * have blinded the two axes that cost the most when missed.
       *
       * Keys are `private_scan` (all axes), or `private_scan.internal` for one.
       */
      const cutOf = (axis: 'secret' | 'personal' | 'internal'): number =>
        readerThreshold(`private_scan.${axis}`, readerThreshold('private_scan', 0.5))
      const findings: string[] = []
      if ((secret ?? 0) >= cutOf('secret')) findings.push('凭据/密钥')
      if ((personal ?? 0) >= cutOf('personal')) findings.push('个人信息')
      if ((internal ?? 0) >= cutOf('internal')) findings.push('内网信息')
      return {
        level: findings.length ? 'flag' : 'info',
        headline: findings.length ? `⚠️ 疑似 ${findings.join(' + ')}` : '未发现泄漏',
        details: [`secret=${show(secret, cutOf('secret'))} personal=${show(personal, cutOf('personal'))} internal=${show(internal, cutOf('internal'))}`, `片段：${(state.text ?? '').slice(0, 100)}`],
        values: { secret, personal, internal },
      }
    },
  },

  scope_check: {
    id: 'scope_check',
    group: 'P',
    title: '改动范围门禁',
    intent: '把"只改要求改的地方"变成提交前的机器检查（对每个 hunk 问一次）',
    per: 'item',
    at: 0.5,
    questions: () => ({
      in_scope: noul('Is the change in `text` (the diff hunk) required by `task` — either to satisfy it directly or to fix something it necessarily breaks?',
        'the change is required by the task',
        'the change is unrelated to the task, or is a drive-by improvement the task did not ask for'),
      necessary: noul('Would `task` still be satisfied if the hunk in `text` were reverted and nothing else changed?',
        'reverting this hunk would leave the task unsatisfied',
        'reverting this change would still leave the task satisfied, so it is optional'),
    }),
    read: (answers, state) => {
      /*
       * Only `in_scope` decides the level. Measured on the first real fixture:
       * in_scope separated cleanly (0.83 for a required fix vs 0.03 for a drive-by
       * addition) while `necessary` scored 0.20 on the change the task explicitly
       * asked for — so promoting it to a warning would have turned a correct
       * verdict amber. It stays as a reported number, not as a policy input: a
       * second question earns its place only after it separates.
       */
      const inScope = p(answers, 'in_scope')
      const necessary = p(answers, 'necessary')
      const out = inScope !== undefined && inScope < 0.5
      return {
        level: out ? 'flag' : 'info',
        headline: out ? '⚠️ 疑似超出范围' : '在范围内',
        details: [`in_scope=${show(inScope, 0.5)} necessary=${show(necessary)}（参考，不参与判定）`, `改动：${(state.text ?? '').slice(0, 100)}`],
        values: { in_scope: inScope, necessary },
      }
    },
  },

  memory_write: {
    id: 'memory_write',
    group: 'P',
    title: '记忆写入路由（值得记吗 / 哪一轨 / 重复吗）',
    intent: '替换记忆插件里那次"整段对话喂给 LLM 抽取"的往返；三问一次请求',
    per: 'item',
    at: 0.5,
    questions: () => ({
      worth: noul('Does `text` state something durable and reusable — a rule, preference, environment fact, decision, or pitfall — rather than a transient detail of the current task?',
        'durable and reusable beyond this task',
        'transient: it only matters for the task at hand'),
      reusable: noul('Would a future session in a different project act differently because of `text`?',
        'a different project or session would change behaviour',
        'it only applies to this specific task or repository'),
      track: choice('Which single track does `text` belong to?', {
        rule: 'a rule that must be followed, an instruction or constraint',
        preference: 'a stated preference about how work should be done',
        fact: 'a durable environment or system fact',
        decision: 'a decision taken, with its reason',
        pitfall: 'a trap or failure mode worth avoiding',
        project: 'progress or state of one specific project',
        none: 'none of these fit, or it is not worth storing',
      }),
    }),
    read: answers => {
      const worth = p(answers, 'worth')
      const track = pickOf(answers, 'track')
      const keep = (worth ?? 0) >= 0.5 && track !== undefined && track !== 'none'
      return {
        level: keep ? 'info' : 'ok',
        headline: keep ? `建议记住（${track}）` : '建议不记',
        details: [`worth=${show(worth)} reusable=${show(p(answers, 'reusable'))} track=${track ?? '—'}`],
        values: { worth, track, reusable: p(answers, 'reusable') },
      }
    },
  },

  memory_conflict: {
    id: 'memory_conflict',
    // Group P on purpose: this is the cleanup half of priority 2, and the report
    // reads groups as "which of the agreed workstreams is this paying for".
    group: 'P',
    title: '两条记忆是否矛盾 / 重复',
    intent: '知识库清理：一次请求同时判"矛盾"和"重复"',
    per: 'item',
    at: 0.6,
    questions: () => ({
      contradicts: noul('Do `text` and `other` make conflicting claims — following one would mean violating the other?',
        'they conflict: both cannot be followed at once',
        'they are compatible; they may overlap but do not conflict'),
      duplicate: noul('Do `text` and `other` state the same fact, such that one of them is redundant?',
        'the same fact stated twice',
        'different facts, even if they are about the same topic'),
    }),
    read: answers => {
      const contradicts = p(answers, 'contradicts')
      const duplicate = p(answers, 'duplicate')
      const worst = Math.max(contradicts ?? 0, duplicate ?? 0)
      return {
        level: worst >= 0.6 ? 'flag' : 'info',
        headline: (contradicts ?? 0) >= 0.6 ? '⚠️ 矛盾' : (duplicate ?? 0) >= 0.6 ? '△ 重复' : '无冲突',
        details: [`contradicts=${show(contradicts, 0.6)} duplicate=${show(duplicate, 0.6)}`],
        values: { contradicts, duplicate },
      }
    },
  },

  /* ── A: replace a frontier round-trip ────────────────────────────── */

  sufficient: {
    id: 'sufficient',
    group: 'A',
    title: '工具结果是否已经够答',
    intent: '省掉一整轮"再确认一下"；只做建议，绝不强制收束',
    per: 'input',
    at: 0.8,
    questions: () => ({
      answers: noul('Does `text` (the tool results) already contain everything `task` asks for, so that a final answer could be written right now without another tool call?',
        'every part of the request is already covered by the results',
        'at least one part of the request still needs another tool call'),
      missing: noul('Is there a specific piece of information that `task` requires and `text` clearly lacks?',
        'a required piece is missing',
        'nothing required is missing'),
    }),
    read: answers => {
      const answers_ = p(answers, 'answers')
      const missing = p(answers, 'missing')
      const ready = (answers_ ?? 0) >= 0.8 && (missing ?? 1) < 0.5
      return {
        level: ready ? 'ok' : 'info',
        headline: ready ? '✅ 可以收束（建议，非强制）' : '还需继续',
        details: [`covered=${show(answers_, 0.8)} missing=${show(missing)}`],
        values: { covered: answers_, missing },
      }
    },
  },

  route: {
    id: 'route',
    group: 'A',
    title: '这一轮该用哪档模型',
    intent: '简单轮次走快模型，把强模型留给真正需要推理的轮次',
    per: 'input',
    at: 0.5,
    questions: () => ({
      complexity: choice('How much reasoning does `task` require?', {
        trivial: 'a lookup, a rename, a formatting change, or running one known command',
        routine: 'a normal edit that follows existing patterns in the repository',
        architectural: 'design work, cross-cutting change, or debugging whose cause is not yet known',
      }),
      needs_reasoning: noul('Does `task` require multi-step reasoning about unfamiliar code or an unknown cause, rather than pattern-following?',
        'yes: the answer is not visible from the immediate context',
        'no: it can be answered from the local context and existing patterns'),
    }),
    read: answers => {
      const complexity = pickOf(answers, 'complexity')
      const reasoning = p(answers, 'needs_reasoning')
      const tier = complexity === 'trivial' && (reasoning ?? 1) < 0.5 ? 'fast' : complexity === 'architectural' || (reasoning ?? 0) >= 0.7 ? 'strong' : 'default'
      return {
        level: 'info',
        headline: `建议档位：${tier}`,
        details: [`complexity=${complexity ?? '—'} needs_reasoning=${show(reasoning)}`, '（路由是建议；执行方是否支持分档由调用者决定）'],
        values: { complexity, needs_reasoning: reasoning, tier },
      }
    },
  },

  duplicate_call: {
    id: 'duplicate_call',
    group: 'A',
    title: '这次调用是否与已有调用等价',
    intent: '短路重复的 read/grep/命令',
    per: 'input',
    at: 0.7,
    questions: () => ({
      equivalent: noul('Is the call in `text` equivalent to one of the earlier calls in `other` — same target and same intent, such that its result would already be known?',
        'yes: an earlier call already covers it',
        'no: it asks for something the earlier calls did not'),
    }),
    read: answers => {
      const equivalent = p(answers, 'equivalent')
      return {
        level: (equivalent ?? 0) >= 0.7 ? 'warn' : 'info',
        headline: (equivalent ?? 0) >= 0.7 ? '⚠️ 疑似重复调用（复用已有结果）' : '新调用',
        details: [`equivalent=${show(equivalent, 0.7)}`],
        values: { equivalent },
      }
    },
  },

  failure_triage: {
    id: 'failure_triage',
    group: 'A',
    title: '失败归因（我的改动 / 环境 / flaky / 数据）',
    intent: '省掉一次"分析这段报错"的往返，直接给出下一步',
    per: 'input',
    at: 0.5,
    questions: () => ({
      cause: choice('What most likely caused the failure described in `text`?', {
        my_change: 'the change just made broke it',
        environment: 'the machine, network, permissions, or a missing tool',
        flaky: 'a non-deterministic test or timing issue',
        data: 'the input data or fixtures are wrong or missing',
        unrelated: 'a pre-existing failure that this change did not touch',
      }),
      safe_to_retry: noul('Is a plain re-run plausible to change the outcome?',
        'yes: the failure looks non-deterministic or environmental',
        'no: the failure looks deterministic and will repeat'),
    }),
    read: answers => {
      const cause = pickOf(answers, 'cause')
      const retry = p(answers, 'safe_to_retry')
      const advice = cause === 'my_change' ? '先看自己刚改的那几行'
        : cause === 'environment' ? '先查环境/权限/依赖，不要改代码'
          : cause === 'flaky' ? '重跑一次确认，别急着改'
            : cause === 'data' ? '检查 fixture 与输入'
              : cause === 'unrelated' ? '与本改动无关，可先记录后继续' : '信息不足'
      return {
        level: cause === 'my_change' ? 'flag' : 'info',
        headline: `原因：${cause ?? '未知'} → ${advice}`,
        details: [`cause=${cause ?? '—'} retry_plausible=${show(retry)}`],
        values: { cause, safe_to_retry: retry },
      }
    },
  },

  retry: {
    id: 'retry',
    group: 'A',
    title: '重试还是停',
    intent: '杀掉"同样的命令再跑一遍"的重试循环：确定性失败重跑一百次也一样',
    per: 'input',
    at: 0.6,
    questions: () => ({
      plausible: noul('Is another attempt of `text`, unchanged, plausible to produce a different outcome?',
        'plausible: the failure looks timing, network or resource dependent',
        'implausible: the same attempt would fail in the same way'),
      deterministic: noul('Does `text` name a deterministic cause — a wrong value, a missing symbol, a type error, a failing assertion about the change — rather than a transient one?',
        'deterministic: the cause is visible in the output and will repeat',
        'transient: nothing in the output explains a stable cause'),
    }),
    read: answers => {
      const plausible = p(answers, 'plausible')
      const deterministic = p(answers, 'deterministic')
      const stop = (plausible ?? 0) < 0.5 || (deterministic ?? 0) >= 0.6
      return {
        level: stop ? 'warn' : 'info',
        headline: stop ? '⚠️ 别重试，先改东西' : '可以再试一次',
        details: [`retry_plausible=${show(plausible, 0.5)} deterministic=${show(deterministic, 0.6)}`],
        values: { plausible, deterministic },
      }
    },
  },

  evidence_check: {
    id: 'evidence_check',
    group: 'A',
    title: '报告是否包含所需证据（按条批量问）',
    intent: '替代一次"复核子 agent 报告"的 LLM 往返：每条要求一问，同一次请求',
    per: 'input',
    at: 0.6,
    questions: state => {
      const out: Record<string, JevQuestion> = {}
      const requirements = (state.requirements ?? []).slice(0, 6)
      requirements.forEach((requirement, index) => {
        out[`r${index}`] = noul(`Does \`text\` (the report) contain evidence that satisfies this specific requirement: "${requirement.slice(0, 200)}"?`,
          'the text shows concrete evidence for it',
          'the text does not show evidence for it, or only asserts it')
      })
      return out
    },
    read: (answers, state) => {
      const requirements = (state.requirements ?? []).slice(0, 6)
      const missing: string[] = []
      const details: string[] = []
      requirements.forEach((requirement, index) => {
        const value = p(answers, `r${index}`)
        details.push(`· ${show(value, 0.6)} ${requirement.slice(0, 60)}`)
        if (value !== undefined && value < 0.6) missing.push(requirement.slice(0, 60))
      })
      return {
        level: missing.length ? 'warn' : 'ok',
        headline: missing.length ? `⚠️ 缺 ${missing.length}/${requirements.length} 条证据` : `✅ ${requirements.length} 条要求都有证据`,
        details,
        values: { missing: missing.length, total: requirements.length },
      }
    },
  },

  /* ── B: guards and gates ─────────────────────────────────────────── */

  risk: {
    id: 'risk',
    group: 'B',
    title: '这一步有没有不可逆的外部副作用',
    intent: '在执行前给任意动作打一个风险标签（建议，不拦截）',
    per: 'input',
    at: 0.6,
    questions: () => ({
      irreversible: noul('Would the action in `text` cause an effect that cannot be undone — deleting data that is not reproducible, overwriting a remote, publishing, paying, or messaging a third party?',
        'the effect cannot be undone by re-running or restoring',
        'the effect is local and reversible, or touches only reproducible artifacts'),
      external: noul('Does the action in `text` affect anything outside this machine and this repository?',
        'it reaches a remote system, a shared service, or another person',
        'it stays on this machine and in this working tree'),
    }),
    read: answers => {
      const irreversible = p(answers, 'irreversible')
      const external = p(answers, 'external')
      const worst = Math.max(irreversible ?? 0, external ?? 0)
      return {
        level: (irreversible ?? 0) >= 0.6 ? 'flag' : (external ?? 0) >= 0.6 ? 'warn' : 'info',
        headline: (irreversible ?? 0) >= 0.6 ? '⚠️ 不可逆风险' : (external ?? 0) >= 0.6 ? '△ 有外部影响' : '低风险',
        details: [`irreversible=${show(irreversible, 0.6)} external=${show(external, 0.6)}`],
        values: { irreversible, external },
      }
    },
  },

  review_triage: {
    id: 'review_triage',
    group: 'B',
    title: '评审意见分级',
    intent: '决定哪条意见必须处理、哪条只是提问',
    per: 'item',
    at: 0.5,
    questions: () => ({
      kind: choice('What kind of a comment is `text`?', {
        blocking: 'it must be resolved before the change can land',
        nit: 'a stylistic preference that does not affect correctness',
        question: 'it asks for information rather than demanding a change',
        praise: 'purely positive, no action required',
      }),
    }),
    read: answers => {
      const kind = pickOf(answers, 'kind')
      return {
        level: kind === 'blocking' ? 'flag' : kind === 'nit' ? 'warn' : 'info',
        headline: `分类：${kind ?? '未知'}`,
        values: { kind },
      }
    },
  },

  commit_message: {
    id: 'commit_message',
    group: 'B',
    title: '提交信息与 diff 是否相符',
    intent: '提交前的两问：说得对不对、有没有夹带无关改动',
    per: 'input',
    at: 0.5,
    questions: () => ({
      matches: noul('Does `text` (the commit message) describe what `other` (the diff) actually changes?',
        'the message describes the change accurately',
        'the message describes something else, or omits the main change'),
      unrelated: noul('Does `other` (the diff) contain changes unrelated to what `text` describes?',
        'yes: there are changes the message does not account for',
        'no: every change in the diff is accounted for by the message'),
    }),
    read: answers => {
      const matches = p(answers, 'matches')
      const unrelated = p(answers, 'unrelated')
      const bad = (matches ?? 1) < 0.5 || (unrelated ?? 0) >= 0.5
      return {
        level: bad ? 'warn' : 'ok',
        headline: bad ? '⚠️ 提交信息与 diff 不一致或夹带改动' : '✅ 相符',
        details: [`matches=${show(matches)} unrelated_present=${show(unrelated)}`],
        values: { matches, unrelated },
      }
    },
  },

  plan_risk: {
    id: 'plan_risk',
    group: 'B',
    title: '这一步是否需要用户拍板',
    intent: '在计划阶段就找出"该问人"的步骤，而不是执行到一半停下',
    per: 'item',
    at: 0.6,
    questions: () => ({
      needs_decision: noul('Does the step in `text` require a human decision that the agent cannot make on its own — a product tradeoff, a destructive choice, or spending money?',
        'a human must choose before this can proceed',
        'the step follows from the request; no new decision is needed'),
      external: noul('Does the step in `text` publish, deploy, message someone, or otherwise leave this machine irreversibly?',
        'yes: it has an irreversible external effect',
        'no: it is local and reversible'),
    }),
    read: answers => {
      const needs = p(answers, 'needs_decision')
      const external = p(answers, 'external')
      const stop = (needs ?? 0) >= 0.6 || (external ?? 0) >= 0.6
      return {
        level: stop ? 'flag' : 'info',
        headline: stop ? '⚠️ 建议先问用户' : '可直接执行',
        details: [`needs_decision=${show(needs, 0.6)} external=${show(external, 0.6)}`],
        values: { needs_decision: needs, external },
      }
    },
  },

  /* ── C: batch triage over many items ─────────────────────────────── */

  log_triage: {
    id: 'log_triage',
    group: 'C',
    title: '日志/输出分诊',
    intent: '1000 行日志几美分分完；人读要半小时',
    per: 'item',
    at: 0.5,
    questions: () => ({
      kind: choice('What is the log line in `text`?', {
        error: 'an error or failure that matters',
        warn_act: 'a warning worth acting on',
        noise: 'normal output, progress, or noise',
      }),
      actionable: noul('Does `text` point at something the reader should fix or investigate?',
        'yes: it names a problem to act on',
        'no: it is informational'),
    }),
    read: answers => {
      const kind = pickOf(answers, 'kind')
      return {
        level: kind === 'error' ? 'flag' : kind === 'warn_act' ? 'warn' : 'info',
        headline: kind ?? '未知',
        values: { kind, actionable: p(answers, 'actionable') },
      }
    },
  },

  alert_dedup: {
    id: 'alert_dedup',
    group: 'C',
    title: '告警是否与已有事件同一件事',
    intent: '对每条候选问一次，把一堆告警折成几个事件',
    per: 'item',
    at: 0.6,
    questions: () => ({
      same: noul('Is the alert in `text` the same incident as `other` — the same underlying cause at the same place?',
        'the same incident, described again',
        'a different incident, even if the symptoms look similar'),
    }),
    read: answers => {
      const same = p(answers, 'same')
      return {
        level: (same ?? 0) >= 0.6 ? 'warn' : 'info',
        headline: (same ?? 0) >= 0.6 ? '同一事件（合并）' : '新事件',
        values: { same },
      }
    },
  },

  bug_triage: {
    id: 'bug_triage',
    group: 'C',
    title: '缺陷分诊（类型 / 可复现）',
    intent: '进仓库之前先分类，省掉一次人工读单',
    per: 'item',
    at: 0.5,
    questions: () => ({
      kind: choice('What kind of problem does `text` (the report) describe?', {
        code: 'a logic or implementation defect',
        config: 'configuration, environment, or deployment',
        data: 'bad input data or an inconsistent dataset',
        perf: 'slowness or resource exhaustion',
        ux: 'a presentation or interaction problem',
        unclear: 'the description is not specific enough to tell',
      }),
      reproducible: noul('Does `text` contain enough steps or evidence for someone to reproduce the problem?',
        'yes: the steps are specific enough to follow',
        'no: it describes a symptom without a way to reproduce it'),
    }),
    read: answers => {
      const kind = pickOf(answers, 'kind')
      const reproducible = p(answers, 'reproducible')
      return {
        level: kind === 'unclear' || (reproducible ?? 1) < 0.5 ? 'warn' : 'info',
        headline: `类型：${kind ?? '未知'} · 可复现：${(reproducible ?? 0) >= 0.5 ? '是' : '否/不足'}`,
        values: { kind, reproducible },
      }
    },
  },

  flaky: {
    id: 'flaky',
    group: 'C',
    title: '失败是 flaky 还是真回归',
    intent: '决定重跑还是查代码，省掉一轮误判',
    per: 'item',
    at: 0.6,
    questions: () => ({
      flaky: noul('Does `text` (the failure output) look non-deterministic — a timeout, a race, an ordering dependency, or a resource contention — rather than a deterministic assertion about the change?',
        'yes: the shape points at non-determinism',
        'no: it reads as a deterministic failure caused by the change'),
      assertion_related: noul('Does `text` name an assertion or behaviour that the recent change could plausibly have altered?',
        'yes: it is about something the change touched',
        'no: it is unrelated to what changed'),
    }),
    read: answers => {
      const flaky = p(answers, 'flaky')
      const related = p(answers, 'assertion_related')
      const suspect = (flaky ?? 0) < 0.6 && (related ?? 0) >= 0.5
      return {
        level: suspect ? 'flag' : 'info',
        headline: suspect ? '⚠️ 更像真回归' : '更像 flaky / 无关',
        details: [`flaky=${show(flaky, 0.6)} assertion_related=${show(related)}`],
        values: { flaky, assertion_related: related },
      }
    },
  },

  page_state: {
    id: 'page_state',
    group: 'C',
    title: '当前页面处于哪个状态（导航后先问这个）',
    intent: '浏览器自动化的高频岔口：登录页 / 空壳 SPA / 错误页 / 目标页 / 需要人工验证 —— 一次闭集判定决定"下一步该干什么"，避免对着错误页面瞎点',
    per: 'input',
    /*
     * 0.5 是声称"这是目标页"所需的把握。给低了会把登录页/错误页误认成目标页，而这一步
     * 之后的所有动作都建立在它上面；给高了会把慢渲染的目标页判成"未知"从而反复等待。
     */
    at: 0.5,
    questions: () => ({
      /*
       * 闭集选择，**不是打分**。同族实测：让模型对"相关性"打分时，36 段真实文本挤在
       * 0.02–0.66 毫无分离度；而给一组具名选项做 1-of-N 选择，判别是干净的。页面状态
       * 天然是有限集，所以这里用 `choice`，并且**必须**带一个出口，否则模型会在候选都
       * 不对时硬选一个 —— 一个被认错的页面比一个"我不知道"贵得多。
       */
      state: choice('Which single state is the page in `text` actually in right now? Judge only from what `text` shows; choose unknown if it does not clearly show one of them.', {
        login: 'a login / sign-in page (credential form, single sign-on redirect, "session expired"): the user is not authenticated',
        target: 'the page the `task` needs, with its real content rendered and its controls present',
        shell: 'an empty or skeletal shell: the application frame loaded but its data has not arrived (spinners, skeletons, "loading…", empty containers)',
        error: 'an error page or an error state (4xx/5xx, stack trace, "something went wrong", permission denied, not found)',
        blocked: 'a human-verification or consent interstitial: captcha, 2FA prompt, cookie/terms wall, "verify you are human"',
        unknown: 'none of the above is clear from `text` (e.g. the snapshot is too partial to judge)',
      }),
    }),
    read: answers => {
      const state = pickOf(answers, 'state') ?? 'unknown'
      /*
       * Each state maps to the *next move*, not just a label: the point of asking is to
       * decide what the driver does next, and a label alone leaves that decision to
       * guesswork at the call site.
       *
       * `level` follows the family's vocabulary — `flag` means a human should look at
       * this, which is true for every state that is not the target page (the run is
       * about to do something other than what it planned).
       */
      const move: Record<string, { level: 'ok' | 'warn' | 'flag', next: string }> = {
        target: { level: 'ok', next: 'proceed' },
        shell: { level: 'warn', next: 'wait' },
        login: { level: 'flag', next: 'reauthenticate' },
        error: { level: 'flag', next: 'inspect' },
        blocked: { level: 'flag', next: 'hand_to_human' },
        unknown: { level: 'warn', next: 'snapshot_more' },
      }
      const chosen = move[state] ?? move.unknown as { level: 'ok' | 'warn' | 'flag', next: string }
      const labels: Record<string, string> = {
        target: '目标页（内容与控制都在）',
        shell: '空壳（框架在、数据未到）',
        login: '登录页/会话过期',
        error: '错误页/错误态',
        blocked: '需要人工验证（验证码/2FA/条款墙）',
        unknown: '无法判断',
      }
      return {
        level: chosen.level,
        headline: `${labels[state] ?? state} → ${chosen.next}`,
        details: [`state=${state}`, `next=${chosen.next}`],
        values: { state, next: chosen.next },
      }
    },
  },

  pick: {
    id: 'pick',
    group: 'C',
    title: '在候选清单里选一个（含"都不合适"）',
    intent: '组件/测试/技能选择：一次调用给出唯一答案，官方建议 choice 必须带 no-match 出口',
    per: 'input',
    at: 0.5,
    questions: state => {
      const noun = state.candidateNoun ?? 'option'
      const criteria: Record<string, string> = {}
      ;(state.candidates ?? []).slice(0, 60).forEach((candidate, index) => {
        criteria[`c${index}`] = `${noun} ${index + 1}: ${candidate.slice(0, 160)}`
      })
      criteria.none_of_these = `none of the ${noun}s fit: the correct one is not in this list`
      return {
        best: choice(`Which single ${noun} best matches \`task\`? Choose none_of_these if none of them fit.`, criteria),
      }
    },
    read: (answers, state) => {
      const best = pickOf(answers, 'best')
      const index = best !== undefined && /^c\d+$/.test(best) ? Number(best.slice(1)) : -1
      const chosen = index >= 0 ? (state.candidates ?? [])[index] : undefined
      return {
        level: best === 'none_of_these' ? 'warn' : 'ok',
        headline: chosen === undefined ? '候选里没有合适的（no-match）' : `选中：${chosen.slice(0, 80)}`,
        values: { choice: best, index },
      }
    },
  },

  i18n_key: {
    id: 'i18n_key',
    group: 'C',
    title: 'i18n：新 key 是否多余 / 术语是否一致',
    intent: '配合"只允许新增词条、不得改写现有文案"的纪律：先确认没有同义 key，再确认新词条不引入第二套说法',
    per: 'input',
    at: 0.5,
    questions: state => {
      const criteria: Record<string, string> = {}
      ;(state.candidates ?? []).slice(0, 40).forEach((candidate, index) => { criteria[`k${index}`] = candidate.slice(0, 160) })
      criteria.none = 'no existing key carries this meaning; a new key is justified'
      return {
        reuse: choice('Which existing key, if any, already carries the same meaning as `text`? Answer none if a new key is justified.', criteria),
        consistent: noul('Does `text` use the same term for the same concept as `candidates` — the established wording in this locale?',
          'consistent: it reuses the established term',
          'inconsistent: it introduces a second way of saying something that already has a term'),
      }
    },
    read: (answers, state) => {
      const reuse = pickOf(answers, 'reuse')
      const index = reuse !== undefined && /^k\d+$/.test(reuse) ? Number(reuse.slice(1)) : -1
      const existing = index >= 0 ? (state.candidates ?? [])[index] : undefined
      const consistent = p(answers, 'consistent')
      if (existing !== undefined) {
        return {
          level: 'warn',
          headline: `△ 已有同义 key，别新增：${existing.slice(0, 80)}`,
          details: [`reuse=${reuse} consistent=${show(consistent)}`, '按纪律：只新增、不改写现有文案；同义时复用现有 key'],
          values: { reuse, consistent },
        }
      }
      const off = consistent !== undefined && consistent < 0.5
      return {
        level: off ? 'warn' : 'info',
        headline: off ? '△ 可新增，但术语与既有说法不一致' : '✅ 可新增（无同义 key，术语一致）',
        details: [`reuse=${reuse ?? '—'} consistent=${show(consistent, 0.5)}`],
        values: { reuse, consistent },
      }
    },
  },

  rank: {
    id: 'rank',
    group: 'C',
    title: '按相关度排序（只排序，不设阈值）',
    intent: '官方口径：p 是排序信号不是概率；所以这里只排序取前 N',
    per: 'item',
    at: 0,
    questions: () => ({
      relevance: score('How relevant is `text` to `task`?', [
        'no connection at all',
        'tangential: shares vocabulary only',
        'somewhat related: same area, different concern',
        'directly related: same concern, partial overlap',
        'exactly what the task is about',
      ]),
    }),
    read: answers => {
      const relevance = scoreOf(answers, 'relevance')
      return { level: 'info', headline: `相关度 ${relevance ?? '—'}`, values: { relevance } }
    },
  },

  /* ── D: memory and retrieval ─────────────────────────────────────── */

  recall_rerank: {
    id: 'recall_rerank',
    group: 'D',
    title: '召回重排（这条记忆能不能回答这个 query）',
    intent: '记忆标题短、像标签，属于"有没有"型判断；仍然只排序不设阈值',
    per: 'item',
    at: 0,
    questions: () => ({
      answers_query: score('Does `text` (the memory) contain information that answers the query in `task`?', [
        'unrelated to the query',
        'same topic area but does not answer it',
        'partially answers it',
        'answers it in substance',
        'answers it directly and completely',
      ]),
    }),
    read: answers => {
      const value = scoreOf(answers, 'answers_query')
      return { level: 'info', headline: `回答度 ${value ?? '—'}`, values: { answers_query: value } }
    },
  },

  tag_session: {
    id: 'tag_session',
    group: 'D',
    title: '会话打标（领域 / 是否可复用教训）',
    intent: '替掉 LLM 起标题那一轮，顺带产出可检索标签',
    per: 'input',
    at: 0.5,
    questions: state => {
      const criteria: Record<string, string> = {}
      ;(state.candidates ?? []).slice(0, 20).forEach((candidate, index) => { criteria[`t${index}`] = candidate.slice(0, 80) })
      criteria.other = 'a domain not in this list'
      return {
        domain: choice('Which domain is `text` about?', criteria),
        lesson: noul('Does `text` contain a reusable lesson — something that should change how the same work is done next time?',
          'yes: a reusable lesson or rule is present',
          'no: it is ordinary task work'),
      }
    },
    read: (answers, state) => {
      const domain = pickOf(answers, 'domain')
      const index = domain !== undefined && /^t\d+$/.test(domain) ? Number(domain.slice(1)) : -1
      const label = index >= 0 ? (state.candidates ?? [])[index] : domain === 'other' ? '其他' : undefined
      return {
        level: 'info',
        headline: `领域：${label ?? '—'} · 可复用教训：${(p(answers, 'lesson') ?? 0) >= 0.5 ? '有' : '无'}`,
        values: { domain: label, lesson: p(answers, 'lesson') },
      }
    },
  },
}

/** The catalogue as data, for the listing tool and the tests. */
export const CHANNEL_LIST = Object.values(CHANNELS)

/** Suggested default thresholds, keyed by channel (overridable per call). */
export const DEFAULT_THRESHOLDS: Record<string, number> = Object.fromEntries(
  CHANNEL_LIST.filter(channel => channel.at !== undefined).map(channel => [channel.id, channel.at as number]),
)

/** Resolve one channel by id, tolerating `-`/`_` spelling drift. */
export function channelOf (id: string): ChannelSpec | undefined {
  const key = id.trim().toLowerCase().replace(/-/g, '_')
  return CHANNELS[key]
}
