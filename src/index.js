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
} from "./matching.js";

export { BRAND_KEYWORDS, isBranded } from "./brands.js";
export { buildEstimatePrompt } from "./prompt.js";
export { extractJSON, parseModelJSON } from "./parse.js";
