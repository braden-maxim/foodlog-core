// How much a day's food log should be trusted as a record of what was eaten.
//
// THE PROBLEM
// Someone logs breakfast and forgets the rest of the day. That day still
// exists, and read at face value it says "ate 450 kcal" -- indistinguishable
// from genuinely eating 450 kcal. Averaged into a measured-maintenance
// calculation it drags the estimate DOWN, which sets the calorie target too
// low. That is the harmful direction to be wrong in.
//
// WHY NOT JUST DROP THIN DAYS
// Dropping low days deletes the bottom of the distribution and inflates the
// average, which argues for feeding someone MORE. Also the wrong direction,
// just at the other end. Days are weighted instead: an uninformative day
// shrinks toward zero influence without ever being scored as high or low.
//
// WHY TIME SPREAD, NOT ENTRY COUNT
// Entry count alone misses the common case. Measured against real logs:
//
//   450 kcal,  2 entries, spread 0.0h, last 6:42am   <- count catches this
//   764 kcal,  4 entries, spread 0.1h, last 9:54am   <- count says "fine"
//   530 kcal,  3 entries, spread 0.1h, last 8:12am   <- count says "fine"
//  1093 kcal, 11 entries, spread 1.7h, last 6:00pm   <- count says "fine"
//
// Four items logged inside six minutes is one breakfast, not a tracked day.
// Spread is the signal that separates a logged day from a logged meal.

export const CONFIDENCE_FULL_SPREAD_H = 6;   // spread at which a day is fully trusted
export const CONFIDENCE_FULL_ENTRIES = 3;    // entries at which count stops limiting

/**
 * @param {object} day
 * @param {number} day.entryCount    how many items were logged
 * @param {number} day.spreadHours   last entry minus first, in hours
 * @param {boolean} [day.wholeDayTotal] a hand-entered daily total -- nothing
 *        partial about it, so it is fully trusted regardless of shape
 * @returns {number} 0..1
 */
export function dayConfidence({ entryCount = 0, spreadHours = 0, wholeDayTotal = false } = {}) {
  if (wholeDayTotal) return 1;
  if (!entryCount) return 0;

  // A single entry can never demonstrate a tracked day, however it is timed.
  const byCount = Math.min(1, entryCount / CONFIDENCE_FULL_ENTRIES);
  const bySpread = Math.min(1, spreadHours / CONFIDENCE_FULL_SPREAD_H);

  // Both must hold. A day with many entries in one sitting, or a wide spread
  // with a single item, is not full evidence -- taking the lower of the two is
  // what makes the pair meaningful rather than either alone.
  return Math.round(Math.min(byCount, bySpread) * 100) / 100;
}

/** Confidence-weighted mean, and the effective number of days behind it. */
export function weightedIntake(days) {
  let wSum = 0, vSum = 0;
  for (const d of days) {
    const w = dayConfidence(d);
    if (!w) continue;
    wSum += w;
    vSum += w * d.calories;
  }
  return { average: wSum ? vSum / wSum : null, effectiveDays: Math.round(wSum * 10) / 10 };
}

// Smooth damping ramp for a correction whose evidence is confounded.
//
// Replaces a hard step. A step at 20% meant 19% off target kept full strength
// and 21% dropped to a third of it -- a trivial logging difference visibly
// moving someone's calorie prescription.
//
// The deadband exists because logged intake is a LOWER bound on real intake:
// people forget meals, they do not invent them. Someone who habitually logs
// 15% light would otherwise sit permanently damped while eating exactly as
// prescribed.
export const DAMP_DEADBAND = 0.20;
export const DAMP_SLOPE = 2;
export const DAMP_FLOOR = 0.3;

export function dampingFactor(gapPct) {
  const excess = Math.abs(gapPct) - DAMP_DEADBAND;
  return excess > 0 ? Math.max(DAMP_FLOOR, 1 - excess * DAMP_SLOPE) : 1;
}
