// foodlog-core — shared food-logging logic for the health tracker and the
// Fitruvian player portal.
//
// WHAT BELONGS HERE: pure functions about food. Query normalisation, matching
// USDA/Open Food Facts results, brand detection, the estimation prompt,
// response parsing.
//
// WHAT DOES NOT: anything touching auth, routes, Supabase, or the Claude API,
// and every goal, target, phase, plan, training or programming concept. The
// two apps share a food log and nothing else — keeping that line sharp is the
// whole reason this package can exist without coupling them.

export {
  STOP_WORDS, MIN_SCORE, GRAIN_PATTERN, SIZE_RE, SUBTYPE_QUALIFIERS,
  normalizeQuery, relevanceScore, isOverlySpecific, firstSegmentMatches,
  isDryGrainEntry, queryImpliesDry,
  extractSize, brandCacheKey, brandedSizeMismatch,
  MACRO_TOLERANCE, caloriesContradictMacros,
  FORM_QUALIFIERS, DISH_QUALIFIERS, DRY_GRAIN_KCAL_PER_100G, energyKcal,
  VENUE_QUALIFIERS, genericnessRank, unrequestedVenueOrBrand,
  WHOLE_FOOD_KCAL_FLOOR, implausiblyLowForFood,
} from "./matching.js";

export { BRAND_KEYWORDS, isBranded } from "./brands.js";
export { buildEstimatePrompt } from "./prompt.js";
export { extractJSON, parseModelJSON } from "./parse.js";
export { normalizeBarcode, isValidBarcode, barcodeCacheKey } from "./barcode.js";
export { parseQuantity, scaleNutrition } from "./quantity.js";
export { dayConfidence, weightedIntake, dayShape, parseClockMinutes,
  CONFIDENCE_FULL_SPREAD_H, CONFIDENCE_FULL_ENTRIES,
  RECONSTRUCTED_DAY_WEIGHT, UNTIMED_DAY_WEIGHT } from "./logQuality.js";
export { scanBarcodeFromFile } from "./scan.js";
export { buildPhotoPrompt, buildLabelPrompt } from "./photoPrompts.js";
export { buildUsdaResult, lookupBarcodeOFF, lookupBarcodeUSDA } from "./sources.js";
