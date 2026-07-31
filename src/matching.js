// Query matching for the shared nutrition cache.
//
// Extracted verbatim from the health tracker's api/nutrition-lookup.js so the
// two apps stop drifting. Every comment came with its function on purpose --
// most of these guards exist because of a specific production bug, and the
// reasoning is what stops someone "simplifying" them back into that bug.
//
// PURE FUNCTIONS ONLY. Nothing here knows about users, auth, goals, plans, or
// training. If a change needs any of that, it does not belong in this package.

// Every unit word normalizeQuery() strips (both the weight-measurement regex
// and the container/unit regex below) needs a matching entry here too, or
// it gets treated as REQUIRED content in relevance scoring instead of a
// unit of measure — the exact bug that made "strip of bacon" match a seitan
// product and "2 tbsp honey" fail to match plain honey at all. Keep these
// two lists in sync; a gap here silently reintroduces that bug for whatever
// word is missing.
export const STOP_WORDS = new Set(["the","of","with","and","in","on","a","an","cup","cups","oz","lb","lbs","gram","grams","ounce","ounces","pound","pounds","liter","liters","tub","tubs","jar","jars","container","bag","box","pack","bottle","can","cans","tbsp","tbsps","tablespoon","tablespoons","tsp","tsps","teaspoon","teaspoons","slice","slices","piece","pieces","strip","strips","serving","servings","whole","cooked","fresh","plain","large","small","medium"]);

export const MIN_SCORE = 0.75;

export const GRAIN_PATTERN = /\b(rice|oat|oats|pasta|quinoa|barley|farro|lentil|lentils|couscous|bulgur|millet|buckwheat|grits|polenta|beans?|chickpeas?|garbanzo|pinto|cannellini|kidney|navy)\b/i;

// Is this row DRY-weight grain/legume data, which must not be scaled against
// a weight the user stated for cooked food?
//
// The original test was `serving_size < 70` -- a small serving implying a dry
// portion. That is a no-op for the entries that matter most: USDA Foundation
// and SR Legacy records carry no servingSize, both apps fall back to 100, and
// 100 is never < 70. So raw rice at 365 kcal/100g sailed through, which is
// precisely the case the guard was written for. Reported by the portal
// 2026-07-31 and confirmed here.
//
// Density is the reliable signal. Dry grains and legumes run 340-390
// kcal/100g; their cooked forms run 70-160. Nothing sits near 250.
export const DRY_GRAIN_KCAL_PER_100G = 250;

export function isDryGrainEntry(result) {
  if (!result || !GRAIN_PATTERN.test(result.name || "")) return false;
  const name = String(result.name).toLowerCase();

  // An explicit preparation state in the name beats any inference.
  if (/\bcooked\b|\bboiled\b|\bsteamed\b/.test(name)) return false;
  if (/\braw\b|\bdry\b|\buncooked\b/.test(name)) return true;

  const size = Number(result.serving_size);
  if (size && size < 70) return true;   // original heuristic, still valid

  const cal = Number(result.calories);
  if (!cal) return false;
  const per100 = size ? (cal / size) * 100 : cal;
  return per100 > DRY_GRAIN_KCAL_PER_100G;
}

// Returns true if the user's original query explicitly indicates dry/uncooked
export function queryImpliesDry(query) {
  return /\b(dry|uncooked|raw)\b/i.test(query);
}

export const SIZE_RE = /\b(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|floz|ounces?|oz\.?|milliliters?|ml|grams?|g|kilograms?|kg|pounds?|lbs?|pieces?|pcs?|ct|count)\b/i;
export function extractSize(text) {
  const m = text.match(SIZE_RE);
  if (!m) return null;
  let unit = m[2].toLowerCase().replace(/[.\s]/g, "");
  if (unit.startsWith("floz") || unit === "oz" || unit.startsWith("ounce")) unit = "oz";
  else if (unit.startsWith("ml") || unit.startsWith("millilit")) unit = "ml";
  else if (unit.startsWith("kg") || unit.startsWith("kilo")) unit = "kg";
  else if (unit === "g" || unit.startsWith("gram")) unit = "g";
  else if (unit.startsWith("lb") || unit.startsWith("pound")) unit = "lb";
  else if (unit.startsWith("piece") || unit.startsWith("pc") || unit === "ct" || unit.startsWith("count")) unit = "piece";
  return { value: parseFloat(m[1]), unit };
}

// Branded cache entries key on a canonical "base + size" string so different
// sizes of the same item (20oz vs 32oz Hulk) get distinct rows instead of
// colliding under normalizeQuery's size-stripped key.
export function brandCacheKey(query) {
  const base = normalizeQuery(query);
  const size = extractSize(query);
  return size ? `${base} ${size.value}${size.unit}` : base;
}

// The generic step-1 fuzzy cache check (pg_trgm similarity) has no concept
// of size — "smoothie king hulk 32oz" fuzzy-matches a cached "...20oz" row
// just fine, and would silently return the 20oz values unscaled for a 32oz
// request. Only matters for branded entries: USDA/OFF rows are designed to
// be scaled downstream via the Claude prompt regardless of their cached
// serving_size, so this check is scoped to source === "claude_web_search"
// only, where different sizes are genuinely different published values.
export function brandedSizeMismatch(query, cachedRow) {
  if (cachedRow.source !== "claude_web_search") return false;
  const qSize = extractSize(query);
  if (!qSize || cachedRow.serving_size == null || !cachedRow.serving_unit) return false;
  if (qSize.unit !== String(cachedRow.serving_unit).toLowerCase()) return true;
  return Math.abs(qSize.value - cachedRow.serving_size) > 0.01;
}

export function normalizeQuery(q) {
  return q
    .toLowerCase()
    .trim()
    .replace(/\b\d+(\.\d+)?\s*(g|oz|lb|lbs|gram|grams|ounce|ounces|pound|pounds|ml|kg|mg|l|liter|liters|tbsp|tbsps|tablespoon|tablespoons|tsp|tsps|teaspoon|teaspoons)\b/g, "") // strip weights/measurements
    .replace(/\b\d+(\.\d+)?%\b/g, "") // strip percentages
    .replace(/\b\d+\b/g, "")          // strip standalone numbers
    .replace(/\b(cup|cups|tub|tubs|jar|jars|container|bag|box|pack|bottle|can|cans|tbsp|tbsps|tablespoon|tablespoons|tsp|tsps|teaspoon|teaspoons|slice|slices|piece|pieces|strip|strips|serving|servings)\b/g, "") // strip containers/units
    .replace(/\s+/g, " ")
    .trim();
}

// Reject results that don't meaningfully match the query — prevents e.g. "Pizza Hut" matching "kirkland cheese pizza"
export function relevanceScore(query, resultName) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ");
  const qWords = norm(query).split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  if (!qWords.length) return 1;
  const rNorm = norm(resultName);
  const matches = qWords.filter((w) => rNorm.includes(w));
  return matches.length / qWords.length;
}

// Component/subtype/varietal words that change what food this actually is,
// not a cut/prep descriptor — the 3+ comma-segment exemption below is meant
// for structural segments (cut, prep method), but a qualifier like "white"/
// "yolk" tucked into a trailing segment can describe an entirely different
// food than the base item, and needs to disqualify a candidate the query
// never asked for it. Keyed PER BASE FOOD on purpose — real regression
// (2026-07-21): an earlier version of this list applied "white"/"yolk"
// globally to any query, which correctly caught "eggs" -> "egg white" but
// also wrongly rejected completely normal foods like "rice" -> "White Rice",
// "bread" -> "White Bread", "wine" -> "White Wine", since "white" is just an
// ordinary descriptor for those, not a different food the way it is for
// eggs. Scoping per base food (only applies when the query is actually
// asking about that food) fixes both without reintroducing the other.
// Original bug this was built for: "eggs" (and "egg", "raw egg") only ever
// matched "Eggs, Grade A, Large, egg white" over the correct "...egg whole"
// entry — both tie at a perfect relevanceScore, the multi-segment exemption
// let "white" through unchecked, and USDA's own opaque result ordering won
// the tie. Second real bug it now also catches: plain "honey" always
// resolving to a cached "MANUKA HONEY 20+" row — a single extra word
// ("manuka") didn't clear the >2-extra-words threshold below on its own,
// even though a named varietal is exactly the kind of thing a generic
// "honey" query never asked for.
export const SUBTYPE_QUALIFIERS = {
  egg: ["white", "whites", "yolk", "yolks"],
  eggs: ["white", "whites", "yolk", "yolks"],
  honey: ["manuka", "buckwheat", "acacia", "clover", "wildflower", "tupelo", "sourwood", "alfalfa", "sage", "eucalyptus"],
};

// relevanceScore alone treats a short/generic query as 100% relevant against any
// candidate whose name merely contains its word(s) — e.g. relevanceScore("honey",
// "Kirkland Raw Manuka Honey") is 1/1 = 1, regardless of how many extra brand/
// qualifier words the candidate tacks on. Reject candidates that add more than 2
// words beyond the query. Exempt complex multi-segment SR Legacy names (3+ comma
// segments, e.g. "Chicken, broilers or fryers, breast, meat only, cooked, roasted")
// — same exemption firstSegmentMatches already uses, since those extra segments are
// structural (cut, prep method), not brand specificity.

// Processing forms that make a candidate a DIFFERENT food from the query,
// not merely a more specific one. "Flour, rice, white" is not rice; corn
// syrup is not corn; garlic powder is not garlic. These slip past every
// other guard: the extra-word count is small, and multi-segment USDA names
// like "Flour, rice, white, unenriched" trip the comma bypass below before
// the word count is ever reached.
//
// Real instance (2026-07-31): a query of "white rice" resolved to "Flour,
// rice, white, unenriched" at 359 kcal/100g — dry flour, served as if it
// were rice, in the shared cache.
//
// Kept deliberately short. Words like "oil" and "milk" were considered and
// left out: "Tuna, canned in oil" is legitimately tuna and "Yogurt, whole
// milk" is legitimately yogurt, so including them would reject good matches.
// Only forms that genuinely rename the food belong here.
export const FORM_QUALIFIERS = ["flour", "flours", "bran", "starch", "syrup", "extract", "powder"];

export function isOverlySpecific(query, resultName) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const qWords = norm(query).split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const rWords = norm(resultName).split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  // Only checks a base food's qualifier list when the query is actually
  // about that food (qWords includes "egg"/"honey"/etc.) — this is what
  // keeps "rice"/"bread"/"wine" out of the egg qualifier list's blast
  // radius. Checked against the query's own words (not a fixed singular
  // form) so an explicit "egg whites" query still matches a "white"-named
  // entry — only disqualify when the query never mentioned the qualifier.
  for (const base of qWords) {
    const qualifiers = SUBTYPE_QUALIFIERS[base];
    if (!qualifiers) continue;
    const queryMentionsQualifier = qualifiers.some((w) => qWords.includes(w));
    if (!queryMentionsQualifier && rWords.some((w) => qualifiers.includes(w))) return true;
  }
  // Checked BEFORE the comma bypass, for the same reason the subtype list is:
  // the names this catches are exactly the multi-segment ones the bypass
  // would wave through.
  if (rWords.some((w) => FORM_QUALIFIERS.includes(w)) && !qWords.some((w) => FORM_QUALIFIERS.includes(w))) return true;

  if (resultName.split(",").length > 2) return false;
  const extra = rWords.filter((w) => !qWords.includes(w));
  return extra.length > 2;
}

// For simple 2-segment USDA names (e.g. "Pie, Peach" / "Peaches, raw"), the text before
// the first comma is the main food — it must contain a query word or we reject it.
// This prevents composite dishes like "Pie, Peach" from matching a query of "peach".
// Multi-segment SR Legacy entries (e.g. "Beef, top sirloin, steak, cooked, broiled") are
// exempt — their first segment is the protein type ("Beef"), not the cut, so the check
// would incorrectly block valid meat matches. Relevance score handles those.
export function firstSegmentMatches(query, resultName) {
  if (!resultName.includes(",")) return true;
  const segments = resultName.split(",");
  if (segments.length > 2) return true; // complex SR Legacy entry — trust relevance score
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const firstSegment = norm(segments[0]);
  const qWords = norm(query).split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return qWords.some((w) => firstSegment.includes(w));
}

// A row whose stated calories disagree with its own macros is corrupt, and
// the disagreement is the cheapest signal we have that something upstream
// went wrong.
//
// Real instance (2026-07-31): "brown rice" resolved to USDA's "Flour, rice,
// brown" with calories 1580 against macros of P7/C76/F4 — which imply 368.
// The ratio is 4.29, i.e. the kJ→kcal factor: the energy nutrient was read
// in KILOJOULES and stored as kilocalories. USDA publishes both (nutrient
// 1008 kcal, 1062 kJ) and getNutrient took whichever the API listed first.
// Every user logging brown rice got numbers 4.3x too high, in a cache shared
// by two apps, and nothing caught it.
//
// Deliberately loose at 30%: Atwater factors are approximations, fibre and
// sugar alcohols legitimately shift the sum, and alcohol contributes 7
// kcal/g that these three macros don't capture at all. This is here to catch
// unit errors and order-of-magnitude corruption, NOT to second-guess real
// data. Rows with no macros at all are exempt rather than assumed bad.
export const MACRO_TOLERANCE = 0.3;

// Alcohol contributes 7 kcal/g and appears in NONE of protein/carbs/fat, so
// a real beer or spirit legitimately reads as "calories far exceed macros".
// Exempting it explicitly rather than relying on the low-macro floor below,
// because a higher-carb beer clears that floor and would be flagged as
// corrupt. This is the same trap as the Miller Lite bug (2026-07-17), where
// calories were reconstructed from a P/C/F formula that cannot represent
// alcohol and came out at 16 kcal instead of ~96.
const ALCOHOL_PATTERN = /\b(beer|ale|lager|stout|porter|ipa|pilsner|wine|champagne|prosecco|cider|mead|sake|vodka|whiskey|whisky|bourbon|rum|gin|tequila|brandy|cognac|liqueur|schnapps|seltzer|spirits?|alcohol(ic)?|cocktail|margarita|mojito)\b/i;

export function caloriesContradictMacros(row) {
  if (!row) return false;
  if (ALCOHOL_PATTERN.test(row.name || "")) return false;
  const cal = Number(row.calories);
  const p = Number(row.protein) || 0, c = Number(row.carbs) || 0, f = Number(row.fat) || 0;
  if (!cal || cal <= 0) return false;
  const implied = p * 4 + c * 4 + f * 9;
  // No macro data, or a genuinely near-zero-calorie food: nothing to compare.
  if (implied < 20) return false;
  return Math.abs(cal - implied) / implied > MACRO_TOLERANCE;
}

// USDA publishes food energy in BOTH kilocalories and kilojoules, and a
// naive .find() on the energy nutrient takes whichever the API happened to
// list first. That is how "brown rice" ended up cached at 1580 kcal instead
// of 368 (2026-07-31) -- the kJ value, stored as kcal, 4.29x too high, in a
// cache shared by two apps.
//
// Read the unit instead of assuming it. Prefer a genuine kcal entry; fall
// back to converting a kJ one rather than returning nothing, since some
// records carry only kJ.
const KCAL_PER_KJ = 1 / 4.184;

export function energyKcal(nutrients) {
  if (!Array.isArray(nutrients)) return null;
  const energy = nutrients.filter(
    (n) => n.nutrientId === 1008 || n.nutrientId === 1062 ||
           n.nutrientNumber === "208" || n.nutrientNumber === "268"
  );
  if (!energy.length) return null;

  const unitOf = (n) => String(n.unitName || "").toUpperCase();
  const kcal = energy.find((n) => unitOf(n) === "KCAL" && Number(n.value) > 0);
  if (kcal) return Number(kcal.value);

  const kj = energy.find((n) => (unitOf(n) === "KJ" || unitOf(n) === "KILOJOULES") && Number(n.value) > 0);
  if (kj) return Math.round(Number(kj.value) * KCAL_PER_KJ);

  // No usable unit label. Falling back to the id is what caused the bug, so
  // only trust id 1008 here, never 1062, and never an unlabelled value.
  const byId = energy.find((n) => n.nutrientId === 1008 && Number(n.value) > 0 && !unitOf(n));
  return byId ? Number(byId.value) : null;
}
