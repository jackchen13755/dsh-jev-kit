/**
 * Calibration metrics, checked against cases whose answer is known by construction.
 *
 * These numbers decide whether a channel's score may be read as a probability, so the
 * test cannot be "it returns something": every expectation here is arithmetic that can
 * be done by hand. Two of them are not invented — they are the shape the **real corpus**
 * produced on 2026-09-28 and are kept so the fixes cannot be undone:
 *
 *   · a worst "band" that was a single fixture (claimed 0.79, turned out negative);
 *   · a channel whose Brier of 0.247 looked respectable until its own baseline turned
 *     out to be 0.25 — no probability information at all, which only the skill score
 *     reveals.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brier, calibration, reliabilityBins, describeCalibration, CALIBRATION_BINS, MIN_BIN_N } from '../lib/calibration.js'

/** `count` cases all scoring `value`, of which `high` are positive. */
const at = (value, high, count) => Array.from({ length: count }, () => ({ value, high }))

test('a perfect score has zero error and a skill of 1', () => {
  const value = calibration([...at(1, true, 5), ...at(0, false, 5)])
  assert.equal(value.brier, 0)
  assert.equal(value.ece, 0)
  assert.equal(value.maxGap, 0)
  assert.equal(value.n, 10)
  assert.equal(value.baseRate, 0.5)
  assert.equal(value.baseline, 0.25, 'balanced classes: the 0.25 the module doc quotes')
  assert.equal(value.skill, 1, 'perfect beats the base rate completely')
  assert.deepEqual(value.bins.map(bin => bin.n), [5, 5], 'only the two occupied bands are reported')
})

test('always answering 0.5 scores exactly 0.25 and a skill of 0 — the reference point quoted in the doc', () => {
  const value = calibration([...at(0.5, true, 2), ...at(0.5, false, 2)])
  assert.equal(value.brier, 0.25, 'a coin flip is the baseline every channel must beat')
  assert.equal(value.skill, 0, 'and on a balanced corpus it is exactly the baseline: skill 0')
  // It is also honest about itself: claiming 0.5 and being right half the time is calibrated.
  assert.equal(value.ece, 0)
  assert.equal(value.bins.length, 1)
  assert.equal(value.bins[0].predicted, 0.5)
  assert.equal(value.bins[0].observed, 0.5)
})

test('over-confidence and under-confidence land on the same error, in opposite directions', () => {
  // 10 cases claiming 0.9, half of them really positive: MSE = (0.01*5 + 0.81*5)/10.
  const over = calibration(at(0.9, true, 5).concat(at(0.9, false, 5)))
  assert.equal(over.brier, 0.41)
  assert.equal(over.ece, 0.4)
  assert.equal(over.maxGap, 0.4)
  assert.equal(over.skill, -0.64, 'worse than the base rate: negative skill')
  assert.equal(over.bins[0].predicted, 0.9)
  assert.equal(over.bins[0].observed, 0.5)

  const under = calibration(at(0.1, true, 5).concat(at(0.1, false, 5)))
  assert.equal(under.brier, 0.41, 'symmetric: the same numbers, mirrored')
  assert.equal(under.ece, 0.4)
  assert.equal(under.skill, -0.64)
  assert.equal(under.bins[0].predicted, 0.1)
  assert.equal(under.bins[0].observed, 0.5)
})

test('maxGap catches the wrong band that ECE averages away', () => {
  /*
   * 90 cases claiming 0.1, right 10% of the time (a well-calibrated bulk), plus 10
   * claiming 0.9 and never right (a systematically wrong band). ECE is a weighted
   * average and stays small; maxGap is the number that says a whole band is lying.
   */
  const value = calibration(at(0.1, true, 9).concat(at(0.1, false, 81)).concat(at(0.9, false, 10)))
  assert.equal(value.n, 100)
  assert.equal(value.ece, 0.09, 'the average is comfortable')
  assert.equal(value.maxGap, 0.9, 'while one band is off by 0.9')
  assert.equal(value.qualified, 2, 'both bands have enough samples to be judged')
  assert.equal(value.thin, 0)
  assert.equal(describeCalibration(value).includes('最差一段'), true, 'and the reading names that band')
})

test('a band of one fixture is not "the worst miscalibration" — the failure the real corpus produced', () => {
  /*
   * Measured on the live 317-fixture run: `memory_write` reported maxGap 0.79, and the
   * band behind it held a single fixture (claimed 0.79, turned out negative). A headline
   * that moves on one fixture is the "cry wolf" failure this repo has already had to fix
   * in its gates, so bands below MIN_BIN_N may not set maxGap — and they are counted
   * rather than dropped, because a band removed in silence looks like one that passed.
   */
  const value = calibration(at(0.8, false, 1).concat(at(0.8, true, 9)))
  assert.equal(value.bins.length, 1)
  assert.equal(value.bins[0].n, 10)
  // One fixture claimed 0.8 and was wrong; nine claimed 0.8 and were right, so the band
  // as a whole sits at observed 0.9 — a gap of 0.1, not the 0.8 the single case implies.
  assert.equal(value.bins[0].observed, 0.9)
  assert.equal(value.maxGap, 0.1, 'the band that can be judged sets the number')

  const thin = calibration(at(0.79, false, 1))
  assert.equal(thin.maxGap, undefined, 'one fixture cannot establish a worst band')
  assert.equal(thin.qualified, 0)
  assert.equal(thin.thin, 1, 'and the excluded band is reported')
  // Only one class here, so the reading stops at the more fundamental fact.
  assert.equal(describeCalibration(thin), '只有一类样本，刻度无从判断')

  // With both classes present, a thin band is still named — dropped in silence it would
  // read as a band that passed.
  const mixed = calibration(at(0.8, true, 9).concat(at(0.8, false, 1)).concat(at(0.1, true, 1)))
  assert.equal(mixed.qualified, 1, 'the ten-case band is judged')
  assert.equal(mixed.thin, 1, 'the one-case band is not')
  assert.equal(mixed.maxGap, 0.1, 'and it does not set the worst-gap number')
  assert.equal(describeCalibration(mixed).includes(`样本 < ${MIN_BIN_N}`), true, 'the reading says so')
})

test('skill is judged against the corpus own base rate, not a memorised 0.25', () => {
  /*
   * The real finding that forced this: one channel scored Brier 0.247, close enough to
   * 0.25 to look fine — but its classes are balanced, so its baseline *is* 0.25 and the
   * score carries no probability information. On a lopsided corpus the same absolute
   * Brier would be respectable, which is why the bar must move with the base rate.
   */
  const balancedUseless = calibration(at(0.5, true, 5).concat(at(0.5, false, 5)))
  assert.equal(balancedUseless.baseline, 0.25)
  assert.equal(balancedUseless.skill, 0, 'no information on a balanced corpus')

  const lopsidedUseful = calibration(at(0.1, false, 90).concat(at(0.9, true, 10)))
  assert.equal(lopsidedUseful.baseRate, 0.1)
  assert.equal(Math.round(lopsidedUseful.baseline * 1000) / 1000, 0.09, 'the base rate sets a much lower bar')
  // brier = (0.01*90 + 0.01*10)/100 = 0.01, so skill = 1 − 0.01/0.09.
  assert.equal(lopsidedUseful.skill, 0.8889, 'and here the score really does beat it')
  assert.equal(lopsidedUseful.skill > balancedUseless.skill, true, 'the same absolute Brier, the opposite conclusion')
  // Same-ish absolute Brier, opposite conclusions — the point of the skill score.
  assert.equal(lopsidedUseful.brier < balancedUseless.brier, true)
})

test('bands are equal-width, and a score of exactly 1 stays inside the last band', () => {
  const bins = reliabilityBins(at(0, false, 1).concat(at(1, true, 1)))
  assert.deepEqual(bins.map(bin => [bin.lo, bin.hi]), [[0, 0.2], [0.8, 1]], 'five bands over [0,1], empty ones omitted')
  // Clamping is what keeps 1.0 from falling between the last band and the edge.
  assert.equal(bins.length, 2)
  assert.equal(CALIBRATION_BINS, 5)
})

test('nothing is dropped silently: out-of-range and unusable scores are counted', () => {
  const value = calibration([{ value: 0.5, high: true }, { value: 1.4, high: true }, { value: -0.2, high: false }, { value: Number.NaN, high: false }])
  assert.equal(value.n, 3, 'the NaN case cannot enter a mean')
  assert.equal(value.unusable, 1, 'and is reported rather than vanishing')
  assert.equal(value.outOfRange, 2, 'two scores are not on a probability scale at all')
  assert.equal(value.maxGap, undefined, 'three one-case bands judge nothing')
  assert.equal(value.thin, 3)
})

test('an absent measurement is undefined, never a good-looking zero', () => {
  assert.equal(calibration([]), undefined)
  assert.equal(calibration([{ value: Number.NaN, high: true }]), undefined)
  assert.equal(brier([]), undefined)
  assert.equal(describeCalibration(undefined), '样本不足，未测', 'absent must not read as calibrated')
  // Brier 0 would mean a perfect score, so the two must never be confused.
  const perfect = calibration([...at(1, true, 3), ...at(0, false, 3)])
  assert.notEqual(describeCalibration(undefined), describeCalibration(perfect))
  // One class only: there is no base rate to beat, so no skill score is claimed.
  const oneSided = calibration(at(1, true, 6))
  assert.equal(oneSided.skill, undefined)
  assert.equal(oneSided.baseline, undefined)
  assert.equal(describeCalibration(oneSided), '只有一类样本，刻度无从判断')
})
