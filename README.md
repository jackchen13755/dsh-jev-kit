# dsh-jev-kit

**Jev 决策工具箱** —— 把 TypeSafe Jev（不生成文本、只做类型化判断的 System One 模型）变成 **23 个可以随时调用的具名判断**，挂在 DeepSeek Harness 上。

一句话定位：**它是"结构化的 if 语句"**。输入一段状态，输出「有没有 / 属于哪类 / 严重到几分」+ 概率，约 300–500ms。

```bash
dsh plugin --profile web add github:jackchen13755/dsh-jev-kit
```

装完重启 `dsh web`。key 与 `dsh-jev-lens` **共用同一个凭据引用**（`TYPESAFE_API_KEY`），配过一次即可。

## 它不做什么（比它做什么更重要）

- **不生成文本**：它给概率和分类，不给理由、不写代码。
- **不拦截、不改写、不问你**：纯建议。所以它不受审批策略影响——不会出现"approval=never 时 ask 悄悄变成拒绝、还谎称用户拒绝"那种事。
- **不注册任何 hook**：只注册工具。这意味着热重载它**不会**触发"工具调用内 dispose 自己"的自噬死锁。

## 通道目录

`jev_kit_channels` 列出全部；`jev_kit_decide` 是通用入口（任何通道都能从它调用）。

| 组 | 通道 | 判断 | 替掉什么 |
|---|---|---|---|
| **P** | `private_scan` | 凭据 / 个人信息 / 内网信息 | 正则扫不到的**语义**泄漏；`jev_kit_scan_private` 只扫 diff 的新增行 |
| **P** | `scope_check` | 这个 hunk 属于本任务吗 | 「只改要求改的地方」的人工复核；`jev_kit_scope_check` 逐 hunk |
| **P** | `memory_write` | 值得记吗 / 哪一轨 | 记忆插件里那次"整段对话喂给 LLM"的往返（三问一次请求） |
| **P** | `memory_conflict` | 两条记忆矛盾吗 / 重复吗 | 知识库清理 |
| **A** | `sufficient` | 工具结果够答了吗 | 一整轮"再确认一下"（**只建议，不强制收束**） |
| **A** | `retry` | 重试还是停 | 确定性失败上的重试循环 |
| **A** | `route` | 这轮该用哪档模型 | 简单轮次占用强模型 |
| **A** | `duplicate_call` | 与已有调用等价吗 | 重复 read/grep |
| **A** | `failure_triage` | 归因：我的改动/环境/flaky/数据 | 一次"分析报错"的往返 |
| **A** | `evidence_check` | 报告含所需证据吗（按条批量） | 一次复核子 agent 报告的 LLM 往返 |
| **B** | `risk` | 有不可逆的外部副作用吗 | 执行前的人工风险判断 |
| **B** | `review_triage` | 评审意见：阻塞/小问题/提问 | 人工分级 |
| **B** | `commit_message` | 提交信息与 diff 相符吗 / 夹带改动吗 | 提交前检查 |
| **B** | `plan_risk` | 这一步要用户拍板吗 | 执行到一半才停下来问 |
| **C** | `log_triage` | 日志：错误/值得处理/噪声 | 人读几千行日志 |
| **C** | `alert_dedup` | 与未闭环告警同一件事吗 | 告警折叠 |
| **C** | `bug_triage` | 类型 + 可复现吗 | 进仓库前的人工读单 |
| **C** | `flaky` | flaky 还是真回归 | 一次误判往返 |
| **C** | `pick` | 在候选里选一个（**带 no-match 出口**） | 组件/测试/技能选择 |
| **C** | `i18n_key` | 新 key 是否多余 / 术语是否一致 | 配合"只允许新增词条、不得改写现有文案"的纪律 |
| **C** | `rank` | 相关度排序（**不设阈值**） | 粗排 |
| **D** | `recall_rerank` | 这条记忆能回答这个 query 吗 | 召回重排（只排序） |
| **D** | `tag_session` | 领域标签 + 是否有可复用教训 | LLM 起标题那一轮 |

## 工具

| 工具 | 用途 |
|---|---|
| `jev_kit_channels [group]` | 列出目录（先看这个） |
| `jev_kit_decide { channel, text, task, candidates, requirements }` | 通用入口：跑任意通道 |
| `jev_kit_scan_private { diff \| text }` | **优先事项 1**：推送前语义隐私扫描（diff 只扫新增行） |
| `jev_kit_scope_check { task, diff }` | **优先事项 3**：逐 hunk 范围门禁 |
| `jev_kit_memory { mode: write\|conflict\|rerank }` | **优先事项 2** + 组 D |
| `jev_kit_triage { kind: log\|alert\|bug\|flaky, items, context }` | 组 C：批量分诊 + 汇总 |
| `jev_kit_pick { task, candidates, noun }` | 组 C：带 no-match 的选择 |
| `jev_kit_bench { engines?, verbose? }` | **引擎对照测量**：32 条夹具（含 lens 命令措辞 12 条）跑遍每个引擎，出分离度/达到真值/延迟 |
| `jev_kit_status` / `jev_kit_report [days]` | 运行态 / 按通道的账本报告 |
| `/jev-kit channels\|report\|status` | 同上，命令行 |

HTTP（给卡片或 curl 用）：`GET /dsh-jev-kit/api/{status,report?days=7,channels}`

## 用法示例

```
# 推送前的语义扫描（配合你的正则扫描，两者互补）
jev_kit_scan_private { diff: <git diff 输出> }

# 提交前：这段改动是否超出了任务范围
jev_kit_scope_check { task: "修 5921 下拉没数据", diff: <git diff> }

# 记忆写入路由：值得记吗 / 哪一轨
jev_kit_memory { mode: "write", text: "本机 bash 沙箱不能写 ~/.dsh，插件台账只能由宿主写" }

# 1000 行日志分诊
jev_kit_triage { kind: "log", items: [...], maxItems: 200 }

# 组件选择（带 no-match）
jev_kit_pick { task: "个人资料编辑抽屉的邮箱段", candidates: [...], noun: "component" }
```

## UI 卡片

设置页 → **Jev 决策工具箱**（`settings.section`，order 45），同时也挂在该插件自己的页面（`plugins.bundle.config`）。卡片显示的就一件事——**按通道的证据**：

- 状态行：版本 / 通道数 / key 来源 / 今日用量；key 没解析到时显式警告（fail-open，不会卡住任何一轮）
- 开关：启用（关闭后一个请求都不发）
- 账本表（1/7/30 天窗口）：每个通道的次数、⛔、⚠️、p50、p95，**按颜色标注**：
  - 红 = 抓到过东西（它的价值，值得人看一眼）
  - 琥珀 = 只有警告
  - 灰 = **样本够了却从未产生非中性判定 → 建议淘汰或改问句**（本表唯一的行动项）
  - 无色 = 样本不足（**未测量过的东西不允许看起来像测量过**）
- 跳过原因、通道目录（折叠）、账本目录、复制 Markdown

卡片只读 `GET /api/{status,report}` + 写 `POST /api/config`；**不碰 key**——kit 与 lens 共用 `TYPESAFE_API_KEY`，密钥输入框只在 lens 卡片里有一处。

### 一个值得记住的坑：client-modules 会缓存"否定答案"

`clientModules.resolveMeta()` 对没有 `dsh.client` 的包会缓存 `null`：

```js
const cached = this.pkgMeta.get(sourceKey)
if (cached !== undefined) return cached   // null 也被缓存，并永久返回
```

于是**先装 host 半边、后加浏览器半边的包，UI 永远不出现，且没有任何报错**（注入器只清自己那一条 pkgMeta，不管别人的）。kit 现在在 `apply()` 里清掉自己那条缓存（在引导图组合之前），并暴露 `POST /dsh-jev-kit/api/heal-client` 供随时修复。

## 引擎对照测量（Jev vs 本地 Laya）

"这条判断该不该搬到本地小模型"不能用模型卡来回答——两家**校准不同**（Laya 出厂过度自信、需按域拟合温度；Jev 的 p 是排序信号）。所以这里的**主指标是分离度**（阈值无关、跨引擎可比）：该判高的夹具是否真的排在该判低的之上；**阈值通过率只是次指标**。

```bash
# 只测 Jev（本机现状）
jev_kit_bench { engines: ["jev"] }

# 装上 Laya 后双跑（参考服务端已附）
python3 -m venv .venv && . .venv/bin/activate && pip install laya
python3 scripts/laya-server.py --port 8791
jev_kit_bench { engines: ["jev", "laya"], verbose: true }
```

夹具 20 条，**真值由构造给定**（那段文本里确实有连接串凭据、那个 hunk 确实是顺手加的），真值**不会发给引擎**；引擎不可用时它的那一列是空的，**"没测出来"绝不等于"没问题"**，也不计入分母。

### 全量实测（2026-09-23，Apple M2 16GB，**281 条夹具**，ONNX Runtime CPU）

夹具来源：`src/corpus.ts`，**每通道几十条、真值由构造给定**（private_scan 48 · lens:destructive 72 · log_triage 47 · risk 22 · scope_check 20 · retry 20 · flaky 20 · memory_write 17 · sufficient 12 · i18n_key 2 · failure_triage 1）。

| 通道 | n | Jev 通过 / 分离度 | Laya 通过 / 分离度 |
|---|---|---|---|
| private_scan | 48 | 40/48 · **1.00** | 18/48 · **0.41** |
| lens:destructive | 72 | 68/72 · **0.97** | 19/72 · **0.48** |
| flaky | 20 | 19/20 · **1.00** | 6/20 · **0.23** |
| retry | 20 | 19/20 · 1.00 | 10/20 · 0.45 |
| scope_check | 20 | 16/20 · 0.99 | 12/20 · 0.75 |
| risk | 22 | 20/22 · 0.95 | 12/22 · 0.66 |
| memory_write | 17 | 16/17 · 1.00 | 9/17 · 0.86 |
| log_triage | 47 | 46/47 | 42/47 ← Laya 唯一像样的通道 |
| sufficient | 12 | 8/12 · 1.00 | 6/12 · 0.78 |
| **合计** | **281** | **255（91%）· p50 476ms** | **136（48%）· p50 1502ms** |

**结论（n=281，不再是噪声）**：Jev 在每个判断通道上分离度 **0.95–1.00**；Laya 在 5 个通道上**接近或低于随机**（0.23–0.66），只有 `log_triage` 这种"短输入 + 分类"形态达到 89%。这与它自己的定位一致（路由/分类），与"带长 criteria 的细粒度存在性判断"不一致。延迟上 Laya 也全面更慢（p50 1502ms / p95 3878ms）。

**注意 n=32 会骗人**：同一套件在 32 条时 Jev 是 32/32、看起来完美；扩到 281 条才露出真实的 91%。**样本量不够时，"满分"是噪声**。

### 阈值拟合：分离度好而通过率低 ≠ 判错

分离度高（排序对）而阈值通过率低，意味着**概率刻度与手选的刀口不匹配**（Jev 官方口径：p 是排序信号不是概率）。所以测量台现在**从语料拟合每个通道的刀口**（取所有观测值中点中使准确率最大的那个）：

| 通道 | 现值 | 语料拟合值 | 通过率 | 拟合后 | n |
|---|---|---|---|---|---|
| sufficient | 0.80 | 0.07 | 67% | 92% | 12 |
| private_scan | 0.50 | 0.11 | 83% | 100% | 48 |
| scope_check | 0.50 | 0.10 | 80% | 95% | 20 |
| risk | 0.60 | 0.41 | 86% | 96% | 22 |
| memory_write | 0.50 | 0.81 | 94% | 100% | 17 |
| retry / flaky | 0.60 | 0.37 / 0.35 | 95% | 100% | 20 |

**但先别照着改**——见下一节。**拟合值是对"我的标签"的拟合，标签有噪声时它会去学噪声。**

### 测量台抓到过作者自己的两个错（这就是它存在的理由）

1. **名字命名空间错**：fixture 打了**问句键** `answers`，而通道发布到 values 的字段叫 `covered` → 分数读到"未作答"，看起来像模型失败。已加断言：夹具声明的字段必须存在于该通道 reader 真正发布的值里。
2. **标签错（281 条时才暴露）**：8 条 private_scan 未达标里，6 条用的个人路径是 **`/Users/dev`** ——正是问句 criteria 里**明确排除的通用占位**；另有一条用的是 **AWS 文档里的示例 key**。**Jev 按自己的口径判低分是对的，我的标签错了**。修正语料后重跑（`corpus.ts` 里只留虚构人名）。

所以 `private_scan` 那个"拟合到 0.11、通过率 100%"在修标签前是**在学我的噪声**。口径：**先查标签，再动阈值**。

### 本地引擎的成本模型（实测拆解）

同一台 M2、4 线程，逐项拆开：

| 输入 | 状态+问句字符 | p50 |
|---|---|---|
| 短状态 + 1 个短问 | 140 | **145ms** |
| 短状态 + 3 个**真**问（长 criteria） | 1157 | **863ms** |
| 长状态(743) + 1 个短问 | 861 | **1754ms** |
| 长状态(743) + 3 个真问 | 1878 | **5496ms** |
| 长状态截到 200 + 3 个真问 | 1348 | **4539ms**（只省 17%） |

三条结论，每条都推翻了直觉：

1. **问句文本本身是一等成本**：同一个短状态，1 个短问 145ms → 3 个真问 863ms（6×）。我们那些**为了可审计而写长的 criteria**，在托管引擎上免费，在本地 CPU 上按 token 收费。
2. **截 state 只省 17%**：因为长 criteria 那侧已经占了大头。想靠截断救本地引擎，方向就错了。
3. **成本 ≈ 问题数 × 最长序列长度**（ONNX 图按 `[n, L]` 成批并右填充）；双向编码器每次都要重读全序列，**没有 KV cache 可预热**——所以"开缓存/Flash Attention"那类 LLM 调优建议在这个模型类别上不适用。

**于是"攒一批问题一次问"这条设计在本地引擎上是错的**：Jev 上几乎免费，本地 CPU 上按 n 线性收费。真要迁本地，得**重写更短的问句 + 一次只问一个 + 跨调用并发**——而那等于**重新标定每个通道**（又一次印证"问句不能移植"）。

### 怎么跑到这个规模

几百条 × 两条引擎要几分钟，**不要用工具调用等**：

```bash
curl -s -m 3600 -X POST http://127.0.0.1:3080/dsh-jev-kit/api/bench \
  -H 'content-type: application/json' -d '{"engines":["jev","laya"]}' -o /tmp/bench.json &
# 完成后取 .markdown
```

Jev 全量 281 条约 **40 秒**（并发 4）；Laya 约 **5 分钟**（服务端单线程，并发只会排队）。

### Jev 基线（同一夹具集，2026-09-22/23）

```
20/20 达到真值 · p50 507ms · p95 973ms

private_scan 3/3 分离度 1.00 · scope_check 2/2 1.00 · retry 2/2 1.00 · risk 2/2 1.00
sufficient   2/2 1.00 · flaky 2/2 1.00 · memory_write 2/2 1.00
failure_triage 1/1 · log_triage 2/2 · i18n_key 2/2   （分类题，按达到真值数比较）
```

本机 Laya 的部署方式（已归档进仓库）：

```bash
# 1) 装 ONNX 运行时（Node 20+，不需要 Python）
mkdir laya-runtime && cd laya-runtime && npm i @receptron/laya
npm install-scripts approve onnxruntime-node && npm rebuild onnxruntime-node   # npm 11 默认拦 postinstall
# 2) 权重 1.69GB：huggingface.co 直连不通时用镜像灌缓存（比走代理快 20 倍）
#    ~/.cache/receptron-laya/receptron--laya-onnx/main/{laya.onnx,laya.onnx.data,laya_config.json,tokenizer/*}
# 3) 起服务
node scripts/laya-server.mjs --port 8791        # 或用 --subfolder multilingual（需自备 bundle）
```

`scripts/laya-server.mjs` 是**本机实测跑通的那个**（`scripts/laya-server.py` 是 PyTorch/多语种路线的参考实现）。它把 `noul` 的 true/false 措辞折进 instructions——**丢掉这一对，极性就没人审计了**，答反了会看起来像模型失败而不是接线错误。

### 测量台第一次运行就抓到了一个真问题

首轮 18/20：`sufficient` 两条报"未作答"。根因不是模型，而是**我的夹具用错了命名空间**——那条通道的问句键叫 `answers`，但它公开发布的判定字段叫 `covered`。于是分数读到一个"通道其实答得很好"的未作答。已修，并加了断言：**夹具声明的字段必须存在于该通道 `read()` 真正发布出来的 values 里**（用合成答案跑一遍 reader 来验证，不需要网络）。

教训与问句那条同源：**名字必须指真实存在的东西**——问句要点真实字段，夹具要打真实发布字段。

## 预算与失败行为（与 lens 同一套纪律）

| 轴 | 默认 |
|---|---|
| 单次请求硬上限 | 8000ms（401/403 不重试；429/5xx 退避重试 1 次） |
| 单次**工具调用**总预算 | 90s（超时提前结束并说明） |
| 单次调用判定条数 | ≤ 40（diff 会被切成"新增行分组"，不会一行一个请求） |
| 并发 | 4 |
| 熔断 | 连续 3 次失败 → 冷却 120s |
| 缓存 | 15 分钟（同样的 state 同样的答案；命中不花钱） |
| 预算 | 单会话 2000 / 每日 20000 次 |
| 失败 | **一律 fail-open**：判定不了就返回"未能判定"，绝不冒充"没问题" |

判定失败会写成 `error` 行、跳过会写成 `degraded` 行——所以报告里的比例不会因为接口挂了而虚高，但样本会变少（`jev_kit_status` 的"跳过原因"表就是看这个的）。

## 账本：用它淘汰通道

`$DSH_HOME/storages/dsh_jev_kit/ledger-YYYY-MM-DD.jsonl`，只记元数据（通道、判定档位、概率/选择、耗时、是否命中缓存），**不含正文**。

`jev_kit_report` 会把每个通道的次数、flag/warn 数、延迟 p50/p95 列出来。读法就一句：

> **某个通道跑了很多次却长期没有非中性判定，说明它在你的语料上不产生信息 —— 那就别用它。**

通道是可以删的，留着不产生信息的通道只是在自我安慰。这也是这个仓库存在的意义：**先量，再留**。

## 实测校准记录（每个通道的"哪个子问题可信"）

标定不是一次性的事。以下是本机实测后对通道做的修正，写在代码注释里也写在这里：

| 通道 | 实测发现 | 处理 |
|---|---|---|
| `private_scan` | 脏段落 secret 0.68 / personal 0.52 / internal 0.70，干净段落 0.01–0.03 | 三问全部保留，≥0.5 即命中 |
| `scope_check` | `in_scope` 分离干净（被要求的修复 0.83 vs 顺手改的 0.03）；但 `necessary` 在**被明确要求**的改动上只给 0.20 | **只有 `in_scope` 参与判定**，`necessary` 降级为参考数字（否则正确结论会被染成黄色） |
| `failure_triage` | 引入性测试失败 → `cause=my_change`、`retry_plausible=0.20` | 保持 |
| `log_triage` | 4 行混合日志 → noise / warn_act / error / noise，全对 | 保持 |
| `memory_write` | 耐久事实 → worth 0.93、track=fact | 保持 |

结论性口径：**第二个问题只有在证明能分离之后，才有资格参与判定。** 否则它只是把噪声引进结论。

还有一条被断言钉住的规则：**问句里反引号点名的字段，必须是调用方真的会发的字段**（`text` / `task` / `other` / `candidates` / `requirements`）。
写这条断言之前，有 8 个通道的问句点了 `failure`、`results`、`log line` 这类 payload 里不存在的名字——
线上照样判对了，靠的是模型自己猜"它大概指那段唯一的文本"。**侥幸答对不算设计正确**，所以现在它是测试。

## 问句即标定

所有问句都写成**"有没有 / 属于哪类"**（presence），不是"有多相关"（relevance）。原因是本机实测：36 段真实代码喂进去判"相关吗"，p 全挤在 0.02–0.66、没有分离度，按 0.5 切会丢掉 75%——而"干净页面有没有注入指令"这类**存在性**判断是 0/20 误报、10/10 命中。

词句改动等于重新标定：`jev_kit_decide` 的缓存键包含插件版本，所以升级后旧缓存不会串味。

## 构建 / 测试

```bash
npm install          # 或 bash scripts/link-deps.sh（借用本机已有的 harness，不联网）
npm run build        # tsc → lib/
npm test             # 31 项离线测试：无网络、无 key、无宿主（含浏览器半边桩渲染与夹具完整性）
```

仓库提交了 `lib/`，所以 git 安装即使跳过构建也能直接用。

## License

BSD-3-Clause
