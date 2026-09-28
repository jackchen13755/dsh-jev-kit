/**
 * Calibration: does the score mean what a threshold assumes it means?
 *
 * The benchmark's own doc says the two engines "are calibrated differently — Laya
 * ships over-confident and needs per-domain temperature fitting, while Jev's
 * probability is documented as a ranking signal rather than a probability", and the
 * report prints that as an explanation of a low pass rate: 「分离度好而通过率低 =
 * 排序对、概率刻度不对」. Until this file existed that sentence was an **assertion**:
 * the kit measured ranking (separation) and never measured the scale, so "概率刻度不对"
 * was the author's belief, not a number. Here it becomes a number — confirmed or
 * withdrawn, and in the second case nobody should be tuning cuts on that theory.
 *
 * **Not the primary metric.** Separation is threshold-free and comparable across
 * engines, which is what a "should this move to a local model" decision needs.
 * Calibration answers a different question — *does a cut at 0.5 mean anything here* —
 * and a bad number below does **not** invalidate a good separation. It means the score
 * is an ordering rather than a probability, so the cut has to be fitted per channel,
 * which is exactly what `fitThresholds` does (and why it fits a cut at all).
 *
 * Three numbers, because "calibration" is not one thing:
 *
 *   · **Brier** — mean squared error of the score read as P(positive).
 *   · **baseline / skill** — Brier compared against the no-skill guess that always
 *     answers the base rate. On a balanced corpus that baseline is the well-known
 *     **0.25**; on a lopsided one it is lower, so `skill` (1 − brier/baseline) is the
 *     number to read, and an absolute Brier is not comparable across channels. Measured
 *     on the real corpus this mattered immediately: one channel scores Brier 0.247,
 *     which looks respectable until its baseline is 0.25 — its scale carries **no**
 *     probability information, and only the skill score says so.
 *   · **ECE** — expected calibration error: sample-weighted mean |observed −
 *     predicted| over equal-width bins. It is an *average*, so one systematically
 *     wrong band hides behind a well-calibrated majority.
 *   · **maxGap** — the worst band's |observed − predicted| **among bands with at least
 *     `MIN_BIN_N` samples**, which is what surfaces that band. The floor is measured,
 *     not assumed: on the real corpus the worst band was a single fixture claiming 0.79
 *     and landing negative, and reporting a one-case band as "the worst miscalibration"
 *     is a headline that moves on a single fixture.
 *
 * Nothing here is dropped silently: values outside [0,1] are counted (`outOfRange`)
 * and non-finite values are counted (`unusable`) rather than vanishing from a mean.
 *
 * @module dsh-jev-kit/calibration
 */

/** One scored case: the model's number, and what a human says is true about it. */
export interface Scored {
  /** The model's score for the channel's primary field. */
  value: number
  /** True when the fixture is a positive case — the field *should* come out high. */
  high: boolean
}

/** One equal-width band of the reliability diagram. */
export interface ReliabilityBin {
  lo: number
  hi: number
  n: number
  /** Mean score inside the band — what the model claimed. */
  predicted: number
  /** Share of the band that really is a positive case — what happened. */
  observed: number
}

export interface Calibration {
  /** Cases that entered the numbers. */
  n: number
  /** Share of cases that really are positive — the base rate a no-skill guess would use. */
  baseRate: number
  /** Mean squared error of the score read as P(positive). */
  brier: number
  /**
   * Brier of always answering `baseRate`. Undefined when every case is the same class,
   * because then there is no variance to explain and a skill score would divide by zero.
   *
   * With balanced classes this is the 0.25 the module doc quotes; with 90/10 classes it
   * is 0.09, which is why the comparison has to be against *this* number and not a
   * memorised 0.25 — a lopsided corpus would otherwise make a useless score look good.
   */
  baseline: number | undefined
  /** Brier skill score, `1 − brier/baseline`: 0 = no better than the base rate. */
  skill: number | undefined
  /** Sample-weighted mean |observed − predicted| across the bins. */
  ece: number
  /**
   * The worst band's gap **among bands with enough samples to judge** (see
   * `MIN_BIN_N`), or undefined when no band qualified.
   *
   * Measuring on the real corpus is what forced this rule: the first version reported
   * `maxGap 0.79` for a channel whose worst band was a single fixture (claimed 0.79,
   * turned out negative). One case is not a band that lies, and a headline number that
   * moves on single fixtures is the same "cry wolf" failure the gates in this repo
   * already had to fix.
   */
  maxGap: number | undefined
  /** Bands with at least `MIN_BIN_N` samples — the only ones `maxGap` may be read from. */
  qualified: number
  /** Bands below `MIN_BIN_N`. Counted, because a band dropped in silence looks like one that passed. */
  thin: number
  /** Non-empty bands only, lowest first. */
  bins: ReliabilityBin[]
  /** Finite scores outside [0,1]: a scale that is not a probability at all. */
  outOfRange: number
  /** NaN/Infinity scores, excluded from the means and counted so they cannot hide. */
  unusable: number
}

/** Bands in the reliability diagram. Five is the usual reading width for n in the tens. */
export const CALIBRATION_BINS = 5

/**
 * Samples a band needs before its gap may be reported as the worst one.
 *
 * Three is not a statistical threshold, it is a floor against the specific failure
 * measured above: at one or two cases a band's "gap" is the fixture, not the scale.
 */
export const MIN_BIN_N = 3

/** Brier score of the score read as P(positive). */
export function brier (pairs: Scored[]): number | undefined {
  const usable = pairs.filter(pair => Number.isFinite(pair.value))
  if (!usable.length) return undefined
  return usable.reduce((sum, pair) => sum + (pair.value - (pair.high ? 1 : 0)) ** 2, 0) / usable.length
}

/**
 * The reliability diagram: equal-width bands over [0,1], empty bands omitted.
 *
 * A score lands in a band by clamping, not by rejection: clamping keeps a 1.0 out of
 * the void between the last band and the edge, and `calibration` reports how many
 * clamped values were out of range so the clamp cannot pass for a clean fit.
 */
export function reliabilityBins (pairs: Scored[], binCount = CALIBRATION_BINS): ReliabilityBin[] {
  const usable = pairs.filter(pair => Number.isFinite(pair.value))
  const bandOf = (value: number): number => Math.min(binCount - 1, Math.max(0, Math.floor(value * binCount)))
  const bins: ReliabilityBin[] = []
  for (let index = 0; index < binCount; index++) {
    const own = usable.filter(pair => bandOf(pair.value) === index)
    if (!own.length) continue
    bins.push({
      lo: Number((index / binCount).toFixed(3)),
      hi: Number(((index + 1) / binCount).toFixed(3)),
      n: own.length,
      predicted: Number((own.reduce((sum, pair) => sum + pair.value, 0) / own.length).toFixed(3)),
      observed: Number((own.filter(pair => pair.high).length / own.length).toFixed(3)),
    })
  }
  return bins
}

/**
 * Everything above, for one channel's scored fixtures.
 *
 * @param pairs - the same `{value, high}` pairs the threshold fit is computed from, so
 *   the two readings describe one measurement rather than two.
 * @returns the numbers, or `undefined` when there is nothing to measure — an absent
 *   number must not be rendered as a good one.
 */
export function calibration (pairs: Scored[], binCount = CALIBRATION_BINS): Calibration | undefined {
  const usable = pairs.filter(pair => Number.isFinite(pair.value))
  if (!usable.length) return undefined
  const bins = reliabilityBins(usable, binCount)
  if (!bins.length) return undefined
  const score = brier(usable) as number
  const baseRate = usable.filter(pair => pair.high).length / usable.length
  const baseline = baseRate > 0 && baseRate < 1 ? baseRate * (1 - baseRate) : undefined
  const qualified = bins.filter(bin => bin.n >= MIN_BIN_N)
  return {
    n: usable.length,
    baseRate: Number(baseRate.toFixed(3)),
    brier: Number(score.toFixed(4)),
    baseline: baseline === undefined ? undefined : Number(baseline.toFixed(4)),
    skill: baseline === undefined ? undefined : Number((1 - score / baseline).toFixed(4)),
    ece: Number((bins.reduce((sum, bin) => sum + bin.n * Math.abs(bin.observed - bin.predicted), 0) / usable.length).toFixed(4)),
    maxGap: qualified.length ? Number(Math.max(...qualified.map(bin => Math.abs(bin.observed - bin.predicted))).toFixed(4)) : undefined,
    qualified: qualified.length,
    thin: bins.length - qualified.length,
    bins,
    outOfRange: usable.filter(pair => pair.value < 0 || pair.value > 1).length,
    unusable: pairs.length - usable.length,
  }
}

/**
 * The one-line *reading* of a calibration — the qualitative half only.
 *
 * The numbers are deliberately not repeated here: every caller so far prints them in
 * their own columns, and a helper that also formatted them produced a table cell that
 * had to strip its own prefix back off.
 *
 * Judged on the **skill score**, not on Brier's absolute value, because the yardstick
 * depends on the class balance: 0.25 is the no-skill score only on a balanced corpus,
 * and a lopsided one would let a useless score pass a fixed bar.
 *
 * The wording is about what was *measured*, never about what to do: a bad scale is a
 * reason to keep fitting a per-channel cut, and never a reason to move the cut toward
 * the score's nominal 0.5.
 */
export function describeCalibration (value: Calibration | undefined): string {
  if (!value) return '样本不足，未测'
  if (value.skill === undefined) return '只有一类样本，刻度无从判断'
  const shape = value.skill >= 0.9 ? '刻度可信'
    : value.skill >= 0.5 ? '刻度大致可用'
      : value.skill > 0 ? '刻度偏乐观，只当排序用'
        : '刻度不含概率信息（与恒答基率无异）'
  // The worst band that can be judged — pick from the same qualified set `maxGap` was
  // measured over, or the sentence would name a band the number did not come from.
  const worst = [...value.bins]
    .filter(bin => bin.n >= MIN_BIN_N)
    .sort((a, b) => Math.abs(b.observed - b.predicted) - Math.abs(a.observed - a.predicted))[0]
  const gap = worst && value.maxGap !== undefined && value.maxGap >= 0.2
    ? `（最差一段 ${worst.lo}–${worst.hi}：声称 ${worst.predicted.toFixed(2)}、实际 ${worst.observed.toFixed(2)}，n=${worst.n}）`
    : ''
  const thin = value.thin ? `（另有 ${value.thin} 段样本 < ${MIN_BIN_N}，未参与最大偏差）` : ''
  return `${shape}${gap}${thin}`
}
