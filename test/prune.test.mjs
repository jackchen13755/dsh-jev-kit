/**
 * The pruning envelope, tested by construction.
 *
 * Every guarantee in `prune.ts` is a claim that can be broken by a one-line change, and
 * each one protects against a failure that is invisible in a screenshot: a dropped last
 * line (the error), a floor that lost to the budget, an empty result, or a plan that
 * differs between two runs on the same input. So each gets its own case with sizes
 * chosen so the arithmetic is exact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPrune, keptText } from '../lib/prune.js'

/** `count` segments of `size` characters each, named by index. */
const units = (sizes) => sizes.map((size, index) => ({ text: String(index).repeat(size), where: `seg${index}` }))
/** All segments the same size, with explicit scores. */
const even = (count, size) => units(Array.from({ length: count }, () => size))

test('the first and last segments survive a budget that fits almost nothing', () => {
  // Ten 100-char segments, 1000 total, budget 10 — smaller than one segment.
  const input = even(10, 100)
  const plan = planPrune(input, input.map((_, i) => (i === 4 ? 1 : 0.1)), { budgetChars: 10 })
  assert.equal(plan.keep[0], true, 'the command and its opening lines are never pruned')
  assert.equal(plan.keep[9], true, 'and neither is the tail, where the failure or summary lives')
  assert.equal(plan.keptChars >= 200, true, 'the floor beats the budget rather than the reverse')
  assert.equal(plan.floorDecided, true, 'and the plan says the budget was not honoured')
})

test('the floor beats the budget, and the plan admits it', () => {
  const input = even(8, 100) // 800 chars, default floor 25% = 200
  const plan = planPrune(input, input.map(() => 0), { budgetChars: 20 })
  assert.equal(plan.totalChars, 800)
  assert.equal(plan.keptChars >= 200, true, 'a floor that loses to the budget is not a floor')
  assert.equal(plan.keptChars > 20, true)
  assert.equal(plan.floorDecided, true)
  assert.match(plan.reason, /超出预算/)
})

test('inside the budget the highest scores win, and ties keep the earlier segment', () => {
  /*
   * Six 100-char segments (600 total), floor 25% = 150, budget 350. The two ends are
   * pinned (200 chars); the floor is already met, so the budget binds: 200 + one more
   * segment = 300 fits, a second would be 400 and does not.
   */
  const input = even(6, 100)
  const scores = [0, 0, 0.9, 0.9, 0, 0] // head and tail are pinned anyway
  const plan = planPrune(input, scores, { budgetChars: 350, minKeepRatio: 0.25 })
  assert.equal(plan.keep[0], true)
  assert.equal(plan.keep[5], true)
  assert.equal(plan.keep[2], true, 'the top score is taken')
  assert.equal(plan.keep[3], false, 'the next one would exceed the budget')
  assert.equal(plan.keptChars, 300, '3 x 100')
  assert.equal(plan.floorDecided, false, 'the budget was enough, so it is the binding rule')
  assert.deepEqual(plan.dropped.map(unit => unit.where), ['seg1', 'seg3', 'seg4'], 'the losers are named, not just counted')
})

test('an unjudged segment is neutral, never a zero', () => {
  /*
   * Treating a missing score as 0 would silently prefer exactly the segments that
   * happened to get judged — "we pruned the part we never looked at". Neutral segments
   * are filled in original order until the budget is full.
   */
  const input = even(6, 100)
  const plan = planPrune(input, [undefined, undefined, undefined, undefined, undefined, undefined], { budgetChars: 500, minKeepRatio: 0.25 })
  assert.equal(plan.kept.length, 5, 'edges plus everything that fits in 500')
  assert.deepEqual(plan.kept.map(unit => unit.where), ['seg0', 'seg1', 'seg2', 'seg3', 'seg5'])
  assert.equal(plan.keptChars, 500)
  // A judged zero scores strictly worse than an unjudged segment, so it is dropped first.
  const judged = planPrune(input, [undefined, undefined, 0, undefined, undefined, undefined], { budgetChars: 500, minKeepRatio: 0.25 })
  assert.equal(judged.keep[2], false, 'the segment the model actually rejected goes first')
  assert.equal(judged.keptChars, 500, 'and the room it frees is used by a neutral segment')
  assert.deepEqual(judged.kept.map(unit => unit.where), ['seg0', 'seg1', 'seg3', 'seg4', 'seg5'])
})

test('a non-finite or out-of-range score is unusable, not a wildcard', () => {
  const input = even(5, 100)
  const plan = planPrune(input, [Number.NaN, 1.4, -3, 0.5, Number.POSITIVE_INFINITY], { budgetChars: 400, minKeepRatio: 0.2 })
  // NaN/Infinity are treated as unjudged (0.5); out-of-range finite values are used as
  // given, which for 1.4 means "keep me first" — documented, since the channel is a noul.
  assert.equal(plan.kept.length >= 3, true)
  assert.equal(plan.keep[0], true, 'edges still pinned')
  assert.equal(plan.keep[4], true)
})

test('the plan is deterministic, and its accounting is exact', () => {
  const input = units([30, 120, 45, 200, 15, 90])
  const scores = [0.2, 0.2, 0.8, 0.8, 0.2, 0.2] // a genuine tie at 0.8, and a tie at 0.2
  const first = planPrune(input, scores, { budgetChars: 260 })
  const second = planPrune(input, scores, { budgetChars: 260 })
  assert.deepEqual(first.keep, second.keep, 'two runs on one input cannot disagree')
  assert.equal(first.keptChars + first.droppedChars, first.totalChars, 'every character is accounted for')
  assert.equal(first.baselineKeptChars, first.totalChars, 'the counterfactual is "keep everything"')
  assert.equal(first.keptChars, first.kept.reduce((sum, unit) => sum + unit.text.length, 0))
  assert.equal(keptText(input, first).length > 0, true)
})

test('an empty input is a plan, not a crash — and still says nothing was dropped', () => {
  const plan = planPrune([], [], { budgetChars: 100 })
  assert.deepEqual(plan.keep, [])
  assert.equal(plan.totalChars, 0)
  assert.equal(plan.droppedChars, 0)
  assert.match(plan.reason, /没有分段/)
})

test('one segment is not "all head and no tail"', () => {
  const plan = planPrune(units([500]), [0], { budgetChars: 1, minKeepRatio: 0.25 })
  assert.deepEqual(plan.keep, [true], 'the floor must never produce an empty result')
  assert.equal(plan.keptChars, 500)
  assert.equal(plan.edges.head + plan.edges.tail, 1, 'the same segment is not pinned twice')
})

test('two segments are both ends, so neither can be pruned', () => {
  const plan = planPrune(units([100, 100]), [0, 0], { budgetChars: 1, minKeepRatio: 0.1 })
  assert.deepEqual(plan.keep, [true, true])
  assert.deepEqual(plan.edges, { head: 1, tail: 1 })
})

test('keptText returns the kept segments in their original order, not score order', () => {
  const input = units([10, 10, 10, 10])
  const plan = planPrune(input, [0, 0.9, 0.95, 0], { budgetChars: 40, minKeepRatio: 0.25 })
  const text = keptText(input, plan)
  const order = text.split('\n\n').map(part => part[0])
  assert.deepEqual(order, [...order].sort((a, b) => Number(a) - Number(b)), 'reordering the result would corrupt it')
})
