// How much a day's food log should be trusted as a record of what was eaten.
//
// THE PROBLEM
// A day that was only partly logged reads at face value as a genuinely light
// day -- "ate 1700 kcal" is indistinguishable from actually eating 1700 kcal.
// Averaged into a measured-maintenance calculation it drags the estimate DOWN,
// which sets the calorie target too low. That is the harmful direction.
//
// WHY NOT JUST DROP THIN DAYS
// Dropping low days deletes the bottom of the distribution and inflates the
// average, which argues for feeding someone MORE. Also wrong, at the other end.
// Days are weighted instead: an uninformative day shrinks toward zero influence
// without ever being scored as high or low.
//
// WHY THE CLOCK, NOT ENTRY COUNT
// Entry count is nearly inert on real data. Across both apps' full exports
// (2026-08-03) essentially every day clears three entries -- 0 of 41 days in
// one, ~1 of 72 in the other. A day of 9 items is not evidence of a tracked
// day: all three athletes in the other app had past days of 7-9 items logged
// inside 3-4 minutes. The clock is what separates a logged day from a day
// reconstructed in one sitting. Count is kept only to catch the genuinely thin
// day, which is rare rather than absent.
//
// THE CASE THAT FORCED isCurrentDay
// A still-running day and a burst-logged finished day have the SAME shape --
// healthy entry count, tiny spread -- and need opposite treatment. Measured:
//
//   finished, burst-logged   9 items / 3 min    <- complete. Keep it.
//   still running            10 items / 153 min <- half a day. Discount it.
//
// No curve separates those, because span alone cannot see which one it is.
// The caller knows, so it passes the flag. For a finished day a short span
// means the logging was compressed; for the current day it means the day is
// not over. Both apps confirmed the signature: in the other app all three
// athletes' current-day rows sat far below their own medians (8/222min,
// 2/155min, 3/1min against medians of 14/754, 9/547, 9/498).

export const CONFIDENCE_FULL_SPREAD_H = 6;   // clock hours at which spread stops limiting
export const CONFIDENCE_FULL_ENTRIES = 3;    // entries at which count stops limiting

// How far a COMPLETE day logged in a single burst is trusted. This is an
// assertion neither app has data to calibrate: that reconstructing a day from
// memory is ~60% as reliable as logging it as you eat. It is named rather than
// left to fall out of the arithmetic so it can be argued with and revisited.
export const RECONSTRUCTED_DAY_WEIGHT = 0.6;

// How far a day with no usable timestamps is trusted. Default discounts it,
// because nothing corroborates the count. An app whose legacy format stored
// whole-day totals should pass untimedIsWholeDay -- there a missing clock
// means the format had no clock, not that the day is suspect.
export const UNTIMED_DAY_WEIGHT = 0.6;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} day
 * @param {number} day.entryCount     how many items were logged
 * @param {number} day.spreadHours    last entry minus first, in hours
 * @param {boolean} [day.hasTimestamps=true]  false if no entry carried a usable time
 * @param {boolean} [day.isCurrentDay=false]  true only if this day is STILL ACCRUING.
 *        Defaults false: a caller that already excludes today never has to think
 *        about it, and no caller inherits the other's assumption by accident.
 * @param {object} [opts]
 * @param {boolean} [opts.untimedIsWholeDay=false]  treat an untimed day as a
 *        complete hand-entered total (full trust) rather than discounting it
 * @returns {number} 0..1
 */
export function dayConfidence(
  { entryCount = 0, spreadHours = 0, hasTimestamps = true, isCurrentDay = false } = {},
  { untimedIsWholeDay = false } = {}
) {
  if (!entryCount) return 0;

  const byCount = Math.min(1, entryCount / CONFIDENCE_FULL_ENTRIES);
  const bySpread = Math.min(1, spreadHours / CONFIDENCE_FULL_SPREAD_H);

  // Still accruing. Entries and span so far are LOWER BOUNDS on the finished
  // day, so neither can vouch for the other -- both must hold, hence the
  // minimum. This is what makes a half-finished day cheap instead of counting
  // as a real light day.
  if (isCurrentDay) return round2(Math.min(byCount, bySpread));

  if (!hasTimestamps) return untimedIsWholeDay ? 1 : round2(byCount * UNTIMED_DAY_WEIGHT);

  // Finished. A short span here means the day was reconstructed in one sitting,
  // not that it is missing -- so it keeps a floor rather than collapsing.
  return round2(RECONSTRUCTED_DAY_WEIGHT * byCount
    + (1 - RECONSTRUCTED_DAY_WEIGHT) * bySpread);
}

/** Confidence-weighted mean, and the effective number of days behind it. */
export function weightedIntake(days, opts) {
  let wSum = 0, vSum = 0;
  for (const d of days) {
    const w = dayConfidence(d, opts);
    if (!w) continue;
    wSum += w;
    vSum += w * d.calories;
  }
  return { average: wSum ? vSum / wSum : null, effectiveDays: Math.round(wSum * 10) / 10 };
}

// Reduce a day's entries to the shape dayConfidence() scores. Both apps had
// written this separately -- the scoring was shared but the translation into it
// was not, which is the same drift one layer down.
//
// Entries store a locale-formatted clock string, so this parses rather than
// reading a number. Accepts 12- and 24-hour forms; a 12-hour-only reader
// silently treats every time in a 24-hour locale as missing, and a day of
// real entries then scores as untimed.
export function parseClockMinutes(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp])?/);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  if (m[3]) { const pm = /[Pp]/.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return (h > 23 || min > 59) ? null : h * 60 + min;
}

/**
 * @param {Array<{time?: string}>} entries a single day's logged items
 * @param {object} [opts]
 * @param {string} [opts.timeKey="time"] property holding the clock string
 * @returns {{entryCount: number, spreadHours: number, hasTimestamps: boolean}}
 */
export function dayShape(entries, { timeKey = "time" } = {}) {
  const list = entries || [];
  const times = list.map((e) => parseClockMinutes(e && e[timeKey])).filter((t) => t != null);
  // TWO readable times, not one. A spread cannot be computed from a single
  // point, and calling that "spread 0" would report a day we know nothing about
  // as one logged in a single instant -- a different claim.
  const hasTimestamps = times.length >= 2;
  return {
    entryCount: list.length,
    spreadHours: hasTimestamps ? (Math.max(...times) - Math.min(...times)) / 60 : 0,
    hasTimestamps,
  };
}
