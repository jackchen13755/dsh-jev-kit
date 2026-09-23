/**
 * 浏览器驱动样例：真实 DOM → Jev 判定 → 动作（可复跑）。
 *
 *   node examples/browser-driver.mjs          # 需要 kit 在 3080、系统 Chrome 在位
 *
 * 页面默认取 /tmp/pick-demo/page.html；用 DEMO_PAGE=file:///... 换。
 *
 * 与"每步一次 LLM 回合"的关键区别：只有**两类岔口**问 Jev（页面状态、下一步点哪里），
 * 其余全部由代码与真实等待原语决定；且每个岔口只问一次。实测一遍约 3 次判定
 * （≈450ms/次），而不是几十次往返。
 *
 * 与"每步一次 LLM 回合"的关键区别：这里只有**两类岔口**问 Jev（页面状态、下一步点哪里），
 * 其余全部由代码与等待原语决定；且每个岔口只问一次。
 */
import { createRequire } from 'node:module'
const require = createRequire('/usr/local/lib/node_modules/@playwright/cli/')
const { chromium } = require('playwright-core')

const KIT = 'http://127.0.0.1:3080/dsh-jev-kit/api/triage'
const FILE = process.env.DEMO_PAGE ?? 'file:///tmp/pick-demo/page.html'

async function ask (channel, fields) {
  const res = await fetch(KIT, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, ...fields }),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(`${channel}: ${body.error ?? 'failed'}`)
  return body
}

/*
 * Launch rather than `connectOverCDP` into the hand-started Chrome on 9223: with
 * playwright-core 1.60 the CDP attach path issues `Browser.setDownloadBehavior`, which
 * that combination rejects ("Browser context management is not supported"). Launching
 * means Playwright owns the browser and the whole CDP surface is available — and the
 * connection is still a one-off: everything after it is in-process CDP, no per-step
 * process or LLM round trip.
 */
const browser = await chromium.launch({
  headless: true,
  /* The system Chrome, because Playwright's bundled build is not downloadable in this
   * sandbox (`npx playwright install` hits EPERM) and the point is to use the browser
   * that is already here. Launching also keeps the whole CDP surface available. */
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--disable-gpu', '--disable-crash-reporter'],
})
const page = await browser.newPage()
await page.goto(FILE, { waitUntil: 'domcontentloaded' })

const TASK = '给订单 A-1029 申请退款'

// ── 岔口 1：现在到底在哪个页面？（一次判定决定后面干什么）──────────────
const snapshot = await page.evaluate(() => document.body.innerText.slice(0, 1500))
const state = await ask('page_state', { task: TASK, text: snapshot })
console.log(`[1] page_state → ${state.values.state} / ${state.values.next}  (${state.headline})`)
if (state.values.next !== 'proceed') {
  console.log(`    页面状态不允许继续（next=${state.values.next}），驱动按 next 分支走，不硬点。`)
  process.exit(0)
}

// ── 候选抽取：代码负责，不问模型 ──────────────────────────────────────
const candidates = await page.evaluate(() => {
  const els = [...document.querySelectorAll('button, a, [role=button], input[type=submit]')]
  return els.map((el, i) => {
    const role = el.tagName === 'A' ? 'link' : 'button'
    const name = el.getAttribute('name') || el.textContent.trim()
    const near = (el.parentElement?.innerText || '').replace(/\s+/g, ' ').slice(0, 40)
    return `#${i} role=${role} name="${name}" 附近="${near}"`
  })
})
console.log(`[2] 抽出 ${candidates.length} 个候选（代码做的，不问模型）`)

// ── 岔口 2：点哪个？（闭集选择 + 强制 no-match 出口）──────────────────
const pick = await ask('pick', { task: TASK, candidates, candidateNoun: '可点击元素' })
console.log(`[3] pick → choice=${pick.values.choice} index=${pick.values.index}  (${pick.headline})`)

if (pick.values.choice === 'none_of_these') {
  console.log('    no-match：候选里没有合适的 → 按设计不硬点（滚动/展开/换页），本次退出。')
  process.exit(0)
}

const target = candidates[pick.values.index]
const name = /name="([^"]+)"/.exec(target)?.[1]
console.log(`[4] 选中：${target}`)

// ── 岔口 3：点下去不可逆吗？（★实测最强的一项，点之前问）───────────────
const risk = await ask('risk', { task: TASK, text: `点击 ${target}（页面 ${page.url()}）` })
console.log(`[5] risk → ${risk.level} irreversible=${risk.values.irreversible} external=${risk.values.external}  (${risk.headline})`)
if (risk.level === 'flag') {
  console.log('    判定为不可逆/对外 → 按设计在此停下交人（样例里直接执行以便验证链路）')
}

// ── 执行：用真实等待原语，不用固定 sleep ──────────────────────────────
await page.click(`text=${name}`, { timeout: 5000 })
await page.waitForFunction(() => (window.__clicked || []).length > 0, null, { timeout: 5000 })
const clicked = await page.evaluate(() => window.__clicked)
console.log(`[6] 实际点击生效：${JSON.stringify(clicked)}`)
console.log(`\n结果：${clicked.includes('申请退款') ? '✅ 正确点中「申请退款」' : '❌ 点错了：' + JSON.stringify(clicked)}`)
await browser.close()
