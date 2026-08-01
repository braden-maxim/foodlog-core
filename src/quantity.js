// Turn "how much did you have?" into a multiplier against a known serving.
//
// The point is cost. When a barcode or a label has already given us exact
// per-serving values, scaling them is arithmetic -- there is no reason to pay
// for a model call to multiply by two. But real answers include "8 meatballs"
// when a serving is 4, which needs judgement this cannot supply.
//
// So: handle the common, unambiguous forms and return null for anything else.
// Null means "ask the model", never "guess". Returning a wrong multiplier
// would silently scale someone's whole day.

const G_PER_OZ = 28.3495;
const G_PER_LB = 453.592;

/**
 * @param {string} text        what the user typed
 * @param {object} serving     { serving_size, serving_unit } from the row
 * @returns {number|null}      multiplier to apply, or null if unclear
 */
export function parseQuantity(text, serving = {}) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;

  // "2", "1.5", "2 servings", "2 x"
  const servings = t.match(/^(\d+(?:\.\d+)?)\s*(servings?|x|portions?)?$/);
  if (servings) {
    const n = parseFloat(servings[1]);
    return n > 0 && n < 100 ? n : null;
  }

  // A weight only helps if the serving is itself expressed as a weight.
  const size = Number(serving.serving_size);
  const unit = String(serving.serving_unit || "").toLowerCase();
  if (!size || size <= 0) return null;

  const weight = t.match(/^(\d+(?:\.\d+)?)\s*(g|gram|grams|oz|ounce|ounces|lb|lbs|pound|pounds|ml)$/);
  if (!weight) return null;

  const n = parseFloat(weight[1]);
  const u = weight[2];
  if (!(n > 0)) return null;

  // ml is only comparable to a gram serving for things near water density.
  // Treating them as equivalent is standard for drinks and close enough here.
  const servingIsWeight = unit === "g" || unit === "gram" || unit === "grams" || unit === "ml";
  if (!servingIsWeight) return null;

  let grams;
  if (u === "g" || u === "gram" || u === "grams" || u === "ml") grams = n;
  else if (u === "oz" || u === "ounce" || u === "ounces") grams = n * G_PER_OZ;
  else grams = n * G_PER_LB;

  const mult = grams / size;
  return mult > 0 && mult < 100 ? mult : null;
}

/** Apply a multiplier to a nutrition row, rounding the way the app displays. */
export function scaleNutrition(perServing, mult) {
  return {
    calories: Math.round((perServing.calories || 0) * mult),
    protein: Math.round((perServing.protein || 0) * mult * 10) / 10,
    carbs: Math.round((perServing.carbs || 0) * mult * 10) / 10,
    fat: Math.round((perServing.fat || 0) * mult * 10) / 10,
  };
}
