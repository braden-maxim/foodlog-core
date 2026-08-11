// Query matching for the shared nutrition cache.
//
// Extracted verbatim from the health tracker's api/nutrition-lookup.js so the
// two apps stop drifting. Every comment came with its function on purpose --
// most of these guards exist because of a specific production bug, and the
// reasoning is what stops someone "simplifying" them back into that bug.
//
// PURE FUNCTIONS ONLY. Nothing here knows about users, auth, goals, plans, or
// training. If a change needs any of that, it does not belong in this package.

import { BRAND_KEYWORDS } from "./brands.js";

// Accents are FOLDED, not stripped. Every normalizer below reduces text to
// [a-z0-9 ], and doing that to an accented letter turns it into a SPACE --
// "Entrée" became "entr e" and "Crème Brûlée" became "cr me br l e", which
// matches nothing. Found 2026-08-07 in the shared cache, where a deliberately
// seeded "Chipotle Steak Entrée (4 oz)" scored 0.67 against "chipotle steak
// entree", under MIN_SCORE -- so the row existed, was correct, and the lookup
// returned nothing anyway. Same shape as the "baked salmon" bug: the guard was
// not wrong, the text never survived to be compared.
//
// NFD splits a letter from its combining mark; dropping the marks leaves the
// plain letter. This also collapses "jalapeño" and "jalapeno" onto one cache
// key, which they should always have shared.
const foldAccents = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/* COMPOSITION PERCENTAGES survive as words, everywhere.
 *
 * A percentage in a food query is never a quantity -- it is what the food IS.
 * "2% milk", "85% lean ground beef", "70% dark chocolate". They were being
 * destroyed twice over:
 *
 *   normalizeQuery stripped them, so "1% milk" and "2% milk" both collapsed to
 *   "% milk" and SHARED ONE CACHE ROW -- whichever was looked up first fed
 *   both. Found 2026-08-09 while investigating ground beef.
 *
 *   The tokenizer then dropped what was left: "%" becomes a space and the bare
 *   "85" is two characters, under the length filter every scorer applies. So
 *   even preserved, a percentage could never be content on either side.
 *
 * Rewriting to "85pct" fixes both -- a token long enough to survive, produced
 * identically from the query and from USDA's own "Beef, ground, 85% lean meat
 * / 15% fat, raw", so for once the two sides agree.
 *
 * Lean RATIOS ("85/15", "93/7") are the same fact written differently, and
 * only when the parts sum to about 100 -- that is what separates a lean ratio
 * from a date, a fraction or a serving range. */
export function expandPercents(s) {
  return String(s)
    .replace(/(\d{1,3})\s*\/\s*(\d{1,3})(?!\d)/g, (m, a, b) =>
      Math.abs(Number(a) + Number(b) - 100) <= 2 ? `${a}pct ${b}pct` : m)
    .replace(/(\d{1,3}(?:\.\d+)?)\s*%/g, "$1pct");
}


// Every unit word normalizeQuery() strips (both the weight-measurement regex
// and the container/unit regex below) needs a matching entry here too, or
// it gets treated as REQUIRED content in relevance scoring instead of a
// unit of measure — the exact bug that made "strip of bacon" match a seitan
// product and "2 tbsp honey" fail to match plain honey at all. Keep these
// two lists in sync; a gap here silently reintroduces that bug for whatever
// word is missing.
//
// "steamed" and "boiled" sit alongside "cooked" deliberately: they are
// preparation methods that do not change a food's composition, so requiring
// them as literal content only narrows the candidate pool. Real case
// (2026-07-31): "steamed white rice" scored the plain cooked-rice entries at
// 0.67 -- below MIN_SCORE -- because they lack the word "steamed", leaving a
// "Chinese restaurant" row as the ONLY survivor at 1.00. The venue penalty
// never got to run, since genericness only breaks ties within a relevance
// tier. Stripping the word puts every candidate back in the same tier.
//
// "fried" is deliberately NOT here -- it adds fat and genuinely changes the
// food, so it must stay required content. Same for roasted/grilled/broiled,
// which USDA uses to distinguish real meat entries.
export const STOP_WORDS = new Set(["the","of","with","and","in","on","a","an","cup","cups","oz","lb","lbs","gram","grams","ounce","ounces","pound","pounds","liter","liters","tub","tubs","jar","jars","container","bag","box","pack","bottle","can","cans","tbsp","tbsps","tablespoon","tablespoons","tsp","tsps","teaspoon","teaspoons","slice","slices","piece","pieces","strip","strips","serving","servings","whole","cooked","steamed","boiled","fresh","plain","large","small","medium",
  // COOKING METHODS THAT DO NOT CHANGE THE FOOD. Preparation is handled
  // elsewhere -- the raw/cooked state note and the yield conversion -- so
  // leaving these as content words only counted them against the match:
  // "baked salmon" scored 0.50 against "Salmon, Atlantic, farmed, raw" because
  // "baked" appears nowhere in the name. Under MIN_SCORE, so the database
  // returned nothing and the model was left to guess. It guessed 2g of protein
  // for 81g of salmon.
  //
  // The list was already half-doing this: "cooked", "steamed" and "boiled" were
  // here, so "cooked salmon" worked and "baked salmon" did not -- an
  // inconsistency nobody would ever report as a rule.
  //
  // NOT included, deliberately: "fried" (adds oil and often breading -- there
  // is a test asserting it stays content), "bbq"/"barbecued" (sauce, so sugar),
  // "smoked"/"cured"/"dried"/"pickled" (different product), and
  // "raw"/"dry"/"uncooked" (the dry-grain guards match on those, and they are a
  // real state distinction rather than a cooking method).
  "baked","grilled","roasted","broiled","seared","sauteed","poached",
  "braised","stewed","griddled","blackened","oven","charbroiled","chargrilled",
  "simmered","parboiled","blanched","microwaved","reheated","warmed","heated",
  // GEOMETRY. Cutting something up does not change what is in it, but these
  // were being demanded as literal words in a database name that never carries
  // them: "diced chicken breast" scored 0.50 for exactly the same reason
  // "baked salmon" did.
  "sliced","diced","chopped","shredded","minced","cubed","halved","quartered",
  "grated","crushed",
  // NEUTRAL STATE. None of these move a macro.
  "homemade","leftover","leftovers","frozen","thawed","defrosted","chilled",
  "refrigerated","hot","cold","warm","organic",
  // Still NOT stop words, and each for a reason: "fried" and "breaded" and
  // "battered" (oil, coating), "bbq"/"glazed"/"marinated" (sugar), "smoked" and
  // "cured" and "dried" and "pickled" (a different product), "ground" and
  // "mashed" (a different cut or preparation with additions), "wild" and
  // "farmed" (farmed salmon carries roughly twice the fat), "grass"/"fed"
  // (leaner beef), and "free"/"range" -- "free" alone would swallow "sugar
  // free" and "fat free", which are exactly the words that matter most.
  ]);

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
  const unit = String(result.serving_unit || "g").toLowerCase();
  const inGrams = unit === "g" || unit === "gram" || unit === "grams";

  if (inGrams && size && size < 70) return true;   // original heuristic

  // Density fallback, for dry entries whose name states no preparation --
  // "Oats, rolled" at 389 kcal/100g. Two guards on it, both from live false
  // positives found 2026-07-31:
  //
  // 1. GRAMS ONLY. The formula assumes a gram serving, so a branded row like
  //    "Chipotle Cilantro-Lime Brown Rice, 210 kcal / 4 oz" computed as 5250
  //    "kcal/100g" and was rejected as dry grain. Anything measured in oz, ml
  //    or servings cannot be assessed this way.
  //
  // 2. LOW FAT. Dry grains and legumes are almost pure starch -- under ~7g
  //    fat per 100g. A prepared dish can clear 250 kcal/100g honestly:
  //    "pasta salad" at 450 kcal/150g is 300, but it is dressed pasta, not
  //    dry pasta. Fat is what separates them.
  const cal = Number(result.calories);
  if (!cal || !inGrams) return false;
  const per100 = size ? (cal / size) * 100 : cal;
  if (per100 <= DRY_GRAIN_KCAL_PER_100G) return false;
  const fatPer100 = size ? (Number(result.fat) || 0) / size * 100 : (Number(result.fat) || 0);
  return fatPer100 < 10;
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
  return expandPercents(foldAccents(q))
    .toLowerCase()
    .trim()
    .replace(/\b\d+(\.\d+)?\s*(g|oz|lb|lbs|gram|grams|ounce|ounces|pound|pounds|ml|kg|mg|l|liter|liters|tbsp|tbsps|tablespoon|tablespoons|tsp|tsps|teaspoon|teaspoons)\b/g, "") // strip weights/measurements
    .replace(/\b\d+\b/g, "")          // strip standalone numbers
    .replace(/\b(cup|cups|tub|tubs|jar|jars|container|bag|box|pack|bottle|can|cans|tbsp|tbsps|tablespoon|tablespoons|tsp|tsps|teaspoon|teaspoons|slice|slices|piece|pieces|strip|strips|serving|servings)\b/g, "") // strip containers/units
    .replace(/\s+/g, " ")
    .trim();
}

// Count abbreviations glue a digit to a word ("8piece", "8ct", "12oz"), and
// the two sides of a match rarely agree on which form. A query of
// "...nuggets 8piece" against a cached "...Nuggets (8ct)" shared no textual
// overlap on that token at all, scoring 0.60-0.67 and needlessly rejecting
// ~10 otherwise-good branded rows (2026-07-31). Splitting digit/letter runs
// lets STOP_WORDS and the length filter drop both forms, so relevance is
// computed on the real content words.
//
// Mild known cost: a product name that IS a digit-letter compound, like V8,
// splits into two sub-3-character tokens and stops being required content.
// Rare enough in food queries to be worth the trade.
// Reject results that don't meaningfully match the query — prevents e.g. "Pizza Hut" matching "kirkland cheese pizza"
export function relevanceScore(query, resultName) {
  const norm = (s) => expandPercents(foldAccents(s)).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/(\d)(?!pct\b)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2").replace(/\s+/g, " ");
  const qWords = norm(query).split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  if (!qWords.length) return 1;
  const rNorm = norm(resultName);
  // Tolerate a simple plural/singular difference. USDA is inconsistent about
  // it -- "Eggs, Grade A, Large" but "Egg, whole, cooked, hard-boiled" -- so a
  // query of "eggs" scored 0.00 against the singular entry and was filtered
  // out entirely. Same for "oats", "beans", "grapes". This is not stemming;
  // it only tries the word with and without a trailing "s", which is enough
  // for the food names in play and cannot pull in an unrelated match (the
  // shortened form still has to appear in the candidate).
  const matchesWord = (w) => {
    if (rNorm.includes(w)) return true;
    if (w.length > 3 && w.endsWith("s") && rNorm.includes(w.slice(0, -1))) return true;
    return rNorm.includes(w + "s");
  };
  const matches = qWords.filter(matchesWord);
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
  // Rice varieties that are NUTRITIONALLY different, not merely named
  // differently. Found live 2026-07-31: a query of "white rice" resolved to
  // "Rice, white, glutinous, unenriched, cooked" at 97 kcal/100g against
  // regular white rice's ~130 -- a 25% underestimate on one of the most
  // commonly logged foods. Same mechanism as eggs/egg-white: relevance
  // scores a perfect 1.00 and the 5-comma name trips the bypass below.
  //
  // basmati and jasmine are deliberately absent. They are named varieties
  // too, but nutritionally equivalent to plain white rice, so rejecting them
  // would lose good matches for no accuracy gain. Only list a qualifier when
  // it changes the numbers.
  rice: ["glutinous", "sticky", "wild"],
  // Grass-fed beef is genuinely leaner, which is exactly why "grass" and "fed"
  // were kept OUT of STOP_WORDS. But nothing acted on that: "ground beef"
  // resolved to "Beef, grass-fed, ground, raw" at 198 kcal/100g against ~254
  // for conventional 80/20, and the 4-segment name tripped the comma bypass
  // before the extra-word count could see it. Live 2026-08-07.
  beef: ["grass", "fed"],
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
// "prepackaged"/"deli"/"luncheon" earn their place by the same test: sliced
// deli turkey is a different product from roast turkey breast, not a
// description of it (15g protein against ~30). Found live 2026-08-07 —
// "roasted turkey breast" was resolving to "Turkey breast, sliced,
// prepackaged", and "sliced" being a neutral stop word left "prepackaged" as
// the lone extra word, comfortably inside the two-word tolerance.
//
// "sweetened" is here for the same reason and NOT its opposite: an
// unrequested "Blueberries, frozen, sweetened" is 85 kcal against ~57. The
// token is matched exactly, so "unsweetened" is untouched -- a plain query
// landing on the unsweetened row is the right answer, not a rejection.
export const FORM_QUALIFIERS = [
  "flour", "flours", "bran", "starch", "syrup", "extract", "powder",
  "prepackaged", "deli", "luncheon", "sweetened", "presweetened",
  // "grilled chicken" resolved to "Chicken spread" -- a pate, 17.6g fat per
  // 100g. One extra word, no dish word, nothing else could see it.
  "spread", "spreads",
  // MEAT SUBSTITUTES. With "spread" rejected, the same query then resolved to
  // "Chicken, meatless" -- soy protein, 224 kcal/100g. Worth understanding why
  // it won: genericnessRank rewards FEW extra words, so a terse wrong name
  // ("Chicken, meatless", rank 1) outranks the correct "Chicken, broiler or
  // fryers, breast, skinless, boneless, meat only, cooked, grilled" (rank 7).
  // Brevity is a bad proxy for generality, and the guard has to catch this
  // rather than the ranking.
  //
  // "vegetarian" and "plant" are deliberately NOT here: vegetarian baked beans
  // are still baked beans, and almond milk really is plant based, so both
  // would reject good matches.
  "meatless", "imitation", "substitute", "substitutes", "analog", "analogue", "vegan",
  // Nobody querying beef wants a junior-stage puree. "8 oz of beef meat"
  // resolved to "Babyfood, meat, beef, junior" at 81 kcal/100g against ~250.
  "babyfood", "babyfoods",
  // CONCENTRATED STATES. "milk" was resolving to "Milk, buttermilk, dried" at
  // 387 kcal/100g against ~62 for fluid. Removing the water makes it a
  // different product, not a description of the same one. (These are
  // deliberately absent from STOP_WORDS for the same reason.)
  "dried", "dehydrated", "condensed", "evaporated",
  // ORGAN MEATS AND PARTS. "chicken" was resolving to "Chicken, feet, boiled"
  // -- and NOT as a tie: feet scored gen=1 against ground chicken's gen=2,
  // because "feet" is one short word and brevity still reads as generality.
  // "skin" is deliberately NOT here: "meat and skin" is standard USDA phrasing
  // for ordinary chicken and rejecting it would cost good matches.
  "feet", "foot", "giblets", "liver", "livers", "gizzard", "gizzards",
  "heart", "hearts", "neck", "necks", "tripe", "tongue", "kidney", "kidneys",
  // A soy version of a dairy food is a substitute, same as the meat ones above.
  "tofu",
];

/* A DISH is not its ingredient, and one extra word is enough to make it one.
 *
 * The extra-word check below tolerates up to two, which is right for
 * descriptors -- "Salmon, Atlantic, farmed" is still salmon. It is wrong for
 * this: a real cache row named "BAKED SALMON SALAD" (90 kcal in a 21g
 * deli-counter serving) was being returned to anyone typing "baked salmon",
 * because "salad" was its single extra word. Every other guard passed it. The
 * user got 2g of protein for 81g of fish.
 *
 * Asymmetric on purpose: a query naming the dish still matches the dish. Only
 * a plain ingredient resolving to a composite is rejected. */
export const DISH_QUALIFIERS = [
  "salad", "sandwich", "wrap", "burger", "cheeseburger", "hamburger", "soup", "stew", "chowder",
  "bisque", "casserole", "pizza", "sushi", "roll", "rolls", "patty", "patties",
  "nugget", "nuggets", "tenders", "cake", "cakes", "pie", "dip",
  // "milk" was resolving to "Milk and cereal bar" at 413 kcal (portal,
  // 2026-08-11). A bar is a composite that CONTAINS the queried food.
  "bar", "bars", "cracker", "crackers", "cookie", "cookies",
  // "tender" SINGULAR is not here, and the split is not a guess -- it is what
  // USDA's own naming does. Every dish-sense tender in the database is plural
  // ("Fast foods, chicken tenders", "Chicken breast tenders, breaded"); every
  // singular one is an adjective or a cut: "Beef, chuck, mock tender steak",
  // "Pork, shoulder petite tender", "HORMEL ALWAYS TENDER". Reported by the
  // portal 2026-08-07 against a real row, "TENDER RED BEANS & RICE WITH
  // SAUSAGE", where it blocked a query that had already said sausage.
  //
  // It stays in DISH_ALIASES, so a query typing "chicken tender" still counts
  // as naming the dish -- only the RESULT side stops being disqualified.
  "bowl", "platter", "taco", "tacos", "burrito", "quesadilla", "melt", "sub",
  "curry", "lasagna", "lasagne", "pasta", "smoothie", "shake", "jerky",
  "sausage", "meatball", "meatballs", "loaf", "pate", "mousse", "souffle",
  "quiche", "omelet", "omelette", "frittata", "hash", "pilaf", "risotto",
  "paella", "gumbo", "jambalaya", "stirfry", "fritter", "croquette",
  // "chili" was here and had to come out. It is the pepper far more often than
  // the stew, and it blocked three deliberately-seeded rows in one scan:
  // "chipotle corn salsa" -> "Chipotle Roasted Chili-Corn Salsa", plus both
  // tomatillo salsas. Zero true positives against three false ones. The stew
  // sense is already covered by "stew".
];

/* Which dish words describe the SAME dish. Without this the guard is all or
 * nothing: either a query names some dish and every dish word in the result is
 * forgiven, or it names none and they are all fatal. Both halves were wrong.
 *
 * Live case for the forgiving half: "hamburger" returned "Rolls, hamburger or
 * hotdog, plain" -- 279 kcal of BREAD -- because the query said "hamburger",
 * which switched the guard off entirely, and the two remaining extra words sat
 * inside the tolerance. A bun is not a burger.
 *
 * So the test is containment, not a boolean: every dish family the RESULT names
 * must be one the QUERY named. "cheeseburger" vs "Cheese Burger, single patty"
 * passes because patty is the burger family. "hamburger" vs "Rolls, hamburger"
 * fails because rolls are not.
 *
 * Anything absent is its own family, which is the safe default -- it can only
 * match itself. Only put two words together when one genuinely describes the
 * other. */
const DISH_FAMILY = {
  cheeseburger: "burger", hamburger: "burger", burger: "burger",
  patty: "burger", patties: "burger",
  nugget: "nugget", nuggets: "nugget",
  tender: "tender", tenders: "tender",
  meatball: "meatball", meatballs: "meatball",
  cake: "cake", cakes: "cake",
  cracker: "cracker", crackers: "cracker",
  cookie: "cookie", cookies: "cookie",
  lasagna: "lasagna", lasagne: "lasagna",
  omelet: "omelet", omelette: "omelet",
  taco: "taco", tacos: "taco",
  roll: "roll", rolls: "roll",
};

/* Words that name a dish without BEING one, so a query using them still counts
 * as having asked for it. "small turkey links" and "cheese and beef stick" were
 * both rejected against correct sausage rows: neither query contains a dish
 * word, so every dish word in the result was fatal -- but a breakfast link IS a
 * sausage. Same for "core power protein drink" against a protein shake. */
const DISH_ALIASES = {
  link: "sausage", links: "sausage", stick: "sausage", sticks: "sausage",
  brat: "sausage", bratwurst: "sausage", chorizo: "sausage",
  kielbasa: "sausage", frank: "sausage", franks: "sausage",
  drink: "shake", beverage: "shake",
  // "sandwich" in a cracker or cookie name is the SHAPE -- two wafers with a
  // filling -- not a different food. "Crackers, wheat, sandwich, with peanut
  // butter filling" is exactly what "ritz peanut butter crackers" means, and
  // the rejection cost real coverage: the same guard runs on the fresh USDA
  // result, so the query fell through to an unaided estimate.
  tender: "tender",
  // Arrays: a cracker query names BOTH the cracker family and the sandwich
  // family, because "Crackers, wheat, sandwich, with peanut butter filling"
  // uses sandwich as the shape. Needed once "crackers" itself became a dish
  // word -- "rice" was resolving to "Rice crackers" at 416 kcal/100g.
  cracker: ["cracker", "sandwich"], crackers: ["cracker", "sandwich"],
  cookie: ["cookie", "sandwich"], cookies: ["cookie", "sandwich"],
};

const dishFamily = (w) => DISH_FAMILY[w] || w;

export function isOverlySpecific(query, resultName) {
  const norm = (s) => expandPercents(foldAccents(s)).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/(\d)(?!pct\b)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2").replace(/\s+/g, " ").trim();
  // A parenthetical in a USDA name is a CROSS-REFERENCE, not the food: "Crackers,
  // saltines (includes oyster, soda, soup)" is a saltine, and the canonical one.
  // Reading "soup" out of that bracket rejected it and left a plain "saltine
  // crackers" query with no database row at all.
  const stripParens = (s) => String(s).replace(/\([^)]*\)/g, " ");
  const qWords = norm(query).split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const rWords = norm(stripParens(resultName)).split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  // Only checks a base food's qualifier list when the query is actually
  // about that food (qWords includes "egg"/"honey"/etc.) — this is what
  // keeps "rice"/"bread"/"wine" out of the egg qualifier list's blast
  // radius. Checked against the query's own words (not a fixed singular
  // form) so an explicit "egg whites" query still matches a "white"-named
  // entry — only disqualify when the query never mentioned the qualifier.
  // A STATED COMPOSITION MUST MATCH A STATED COMPOSITION. "85% lean ground
  // beef" against "Beef, ground, 73% lean meat / 27% fat, raw" scored 0.75 --
  // exactly MIN_SCORE, so it passed -- and the 4-segment name then tripped the
  // comma bypass before the extra-word count could look at it. Same for "2%
  // milk" landing on 1% milkfat.
  //
  // Only fires when BOTH sides state one. A plain "milk" query is left alone,
  // because choosing between whole and 2% for someone who did not say is the
  // genericness tie-break's job, not a rejection.
  const pcts = (words) => words.filter((w) => /^\d+(\.\d+)?pct$/.test(w));
  const qPct = pcts(qWords), rPct = pcts(rWords);
  if (qPct.length && rPct.length && !qPct.some((w) => rPct.includes(w))) return true;

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

  // A candidate word that is PART of a compound query word is not "extra".
  // Users type compounds ("milkshake", "cheeseburger", "peanutbutter") that
  // USDA splits ("Milk Protein Shake", "Cheese Burger"). Counting each half
  // separately inflates the extra-word total and rejects a good row: real
  // case (2026-07-31) "equate ultra filtered milkshake" vs "Equate Ultra
  // Filtered Milk Protein Shake" counted milk/protein/shake as 3 extra when
  // only "protein" genuinely is.
  //
  // Requires 4+ characters so short fragments can't dissolve real
  // differences, and the fragment must actually appear inside a query word,
  // so this can only ever forgive a word the user already half-typed.
  const partOfCompound = (w) =>
    w.length >= 4 && qWords.some((q) => q.length > w.length && q.includes(w));

  // A plural is not an extra word. "chicken tender" against "Fast foods,
  // chicken tenders" counted "tenders" as extra, which with "fast" and "foods"
  // made three and rejected the row the query plainly asked for. partOfCompound
  // cannot help here -- it only forgives a result word contained in a LONGER
  // query word, and this is the other direction.
  //
  // Reported by the portal 2026-08-07 as a wrong claim in my own note: the
  // dish alias was working, the generic extra-word count was what fired.
  // Applied to both sides so the comparison stays symmetric; a word that is
  // not really a plural ("grass", "hummus") is transformed identically on both
  // sides and so is unaffected.
  const singular = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  const qStems = new Set(qWords.map(singular));
  const extra = rWords.filter((w) => !qStems.has(singular(w)) && !partOfCompound(w));

  // A composite dish the query never asked for is disqualifying on its own,
  // whatever the extra-word count says. One word is the whole difference
  // between a fillet and a deli salad.
  //
  // Only when the query names a plain INGREDIENT, though. Once the user has
  // said "cheeseburger" or "chicken salad", further dish words in the result
  // are describing that same dish rather than changing category -- "Cheese
  // Burger, single patty" is the thing they asked for, and rejecting it over
  // the word "patty" would break a match this suite already protects.
  //
  // Checked BEFORE the comma bypass, like the two lists above and for the same
  // reason -- and this one had to be moved there after the fact. Sitting below
  // the bypass, it only ever saw names with two or fewer segments, so it caught
  // "BAKED SALMON SALAD" and waved through USDA's own spelling of the identical
  // food, "Salmon, baked, salad". Live consequence (2026-08-07): "ground beef"
  // was answering with "Beef, ground, patties, frozen, cooked, broiled".
  const queryDishes = new Set(
    qWords.filter((w) => DISH_QUALIFIERS.includes(w) || DISH_ALIASES[w])
          .flatMap((w) => {
            const a = DISH_ALIASES[w];
            return a ? (Array.isArray(a) ? a : [a]) : [dishFamily(w)];
          })
  );
  const resultDishes = extra.filter((w) => DISH_QUALIFIERS.includes(w)).map(dishFamily);
  if (resultDishes.some((f) => !queryDishes.has(f))) return true;

  if (resultName.split(",").length > 2) return false;
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
  const norm = (s) => expandPercents(foldAccents(s)).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/(\d)(?!pct\b)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2");
  const firstSegment = norm(segments[0]);
  const qWords = norm(query).split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // A COMPOSITION QUERY IS NOT EXEMPT FROM THE HEAD-FOOD CHECK.
  //
  // The >2-segment bypass exists because a complex SR Legacy name adds many
  // legitimate words -- "Chicken, broilers or fryers, breast, meat only,
  // cooked, roasted" -- and its first segment really is the food. It hands off
  // to relevance, which is fine right up until relevance can be satisfied by
  // the composition token alone.
  //
  // Regression introduced by percentage tokens (2fb8af7), reported by the
  // portal 2026-08-11:
  //   "1% milk" -> "Cheese, cottage, lowfat, 1% milkfat"        72 kcal
  //   "2% milk" -> "Egg custards, dry mix, prepared with 2% milk" 112
  // Both scored 1.00: "1pct" matched, and "milk" was satisfied by "milkfat"
  // or by the phrase "prepared with 2% milk". Four segments, so the bypass
  // returned accept before the extra-word count could see three or five extra
  // words. That is the third distinct class of error this bypass has hidden.
  //
  // Segment count cannot separate these -- the CORRECT row, "Milk, reduced
  // fat, fluid, 2% milkfat", also has four. The first segment can: Milk vs
  // Cheese vs Egg custards. So when the user has stated a composition, which
  // is the most specific they can be, the head food has to match.
  const queryStatesComposition = qWords.some((w) => /^\d+(\.\d+)?pct$/.test(w));
  if (segments.length > 2 && !queryStatesComposition) return true;

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

/* WHOLE-FOOD CALORIE FLOORS -- the one bad-data class no word guard can see.
 *
 * These rows are not mismatches. The name is accurate, the macros reconcile
 * against 4/4/9, and every text guard passes them. The published numbers are
 * simply wrong, roughly halved, and they come from USDA rather than from
 * anything we cached. Four found live 2026-08-07:
 *
 *   GRILLED SALMON               103 kcal/100g   real ~200
 *   SHREDDED CHICKEN BREAST MEAT  83             real ~165
 *   Babyfood, meat, beef, junior  81             real ~250
 *
 * Every pattern is case-INSENSITIVE. The first cut was not, and it missed
 * GRILLED SALMON and SHREDDED CHICKEN BREAST MEAT while catching the lowercase
 * babyfood row -- and all-caps is precisely the shape these bad rows come in.
 *
 * Deliberately conservative, because a wrongly rejected row costs more than
 * the pollution it prevents -- the athlete gets no reference at all. Each
 * floor is set BELOW the leanest legitimate form of that food, and the
 * counter-example that set it is named. Only whole muscle foods are listed:
 * anything composite varies too much to floor.
 */
export const WHOLE_FOOD_KCAL_FLOOR = [
  // Smoked salmon (lox) is the leanest real salmon at ~117, so 110 clears it
  // while still catching 103.
  { re: /\bsalmon\b/i, min: 110, label: "salmon" },
  // Raw skinless chicken breast is ~120; deli/rotisserie forms are lower but
  // those are rejected as FORM_QUALIFIERS before they reach here.
  { re: /\bchicken\b/i, min: 90, label: "chicken" },
  // Raw turkey breast is ~111.
  { re: /\bturkey\b/i, min: 85, label: "turkey" },
  // 95% lean raw ground beef is ~137; eye of round ~130.
  { re: /\b(beef|steak|sirloin|ribeye)\b/i, min: 105, label: "beef" },
  { re: /\bpork\b/i, min: 100, label: "pork" },
];

// Words that mean the row is DILUTED or a composite, where a low density is
// honest. A chicken soup at 40 kcal/100g is correct; flooring it would be the
// false rejection this whole guard is trying not to make.
const DILUTE_RE = /\b(soup|broth|stock|bouillon|consomme|juice|water|drink|beverage|smoothie|shake|sauce|gravy|dressing|marinade|brine|salad|stew|chowder|bisque)\b/i;

/** True when a row claims a calorie density no real form of that food reaches.
 *  Grams only -- an oz/ml/serving row cannot be assessed this way, the same
 *  restriction isDryGrainEntry carries and for the same reason. */
export function implausiblyLowForFood(row) {
  if (!row || !row.name) return false;
  const name = String(row.name);
  if (DILUTE_RE.test(name)) return false;

  const unit = String(row.serving_unit || "g").toLowerCase();
  if (!["g", "gram", "grams"].includes(unit)) return false;
  const size = Number(row.serving_size);
  const cal = Number(row.calories);
  if (!cal || !size || size <= 0) return false;

  const per100 = (cal / size) * 100;
  const rule = WHOLE_FOOD_KCAL_FLOOR.find((r) => r.re.test(name));
  return !!rule && per100 < rule.min;
}

// Where a food was prepared or served, as opposed to what it is. USDA's SR
// Legacy carries a lot of these -- "Rice, white, steamed, Chinese
// restaurant", "Fast foods, biscuit", school-lunch entries -- and they are
// legitimate data, just not what a bare "white rice" query means.
//
// Kept separate from FORM_QUALIFIERS, which rejects outright: a venue entry
// is still the right food, so it should LOSE A TIE rather than be discarded.
// If it is the only survivor, using it beats returning nothing.
export const VENUE_QUALIFIERS = ["restaurant", "restaurants", "cafeteria", "cafeterias", "school", "buffet", "diner", "takeout", "vending", "concession"];
const FAST_FOOD_RE = /\bfast\s+foods?\b/;

// How generic a candidate is for this query. LOWER IS MORE GENERIC, so sort
// ascending. Used only to break ties in relevance -- every candidate reaching
// here has already passed the same relevance bar, and the alternative
// tie-break was whatever order USDA happened to return, which is how "white
// rice" ended up as restaurant-steamed rice at 151 kcal/100g instead of the
// canonical 130.
//
// NOTE the extra-word count deliberately does NOT dominate. Tested against
// the real candidates: the restaurant entry adds 3 words and the canonical
// SR Legacy one adds 4, so ranking on word count alone picks the wrong row.
// Venue has to outweigh it.
export function genericnessRank(query, resultName) {
  const norm = (s) => expandPercents(foldAccents(s)).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/(\d)(?!pct\b)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2").replace(/\s+/g, " ").trim();
  const words = (s) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const qWords = words(query);
  const rWords = words(resultName);
  const rNorm = norm(resultName);

  const queryWantsVenue =
    qWords.some((w) => VENUE_QUALIFIERS.includes(w)) || FAST_FOOD_RE.test(norm(query));
  const isVenue =
    rWords.some((w) => VENUE_QUALIFIERS.includes(w)) || FAST_FOOD_RE.test(rNorm);

  // A BRAND the query never named loses a tie exactly as a venue does, and for
  // the same reason. Live 2026-08-07: "hamburger" resolved to "WENDY'S, Jr.
  // Hamburger, with cheese". unrequestedVenueOrBrand would have caught it, but
  // that runs only on the cache read -- here a rejection could leave nothing,
  // so the branded row has to lose the ranking instead of being discarded.
  // A NAMED BRAND is worse than a generic venue category, so the two penalties
  // must not be equal. They were, at 100 each, and "hamburger" still resolved
  // to "WENDY'S, Jr. Hamburger, with cheese" after the brand penalty shipped:
  // USDA has no generic hamburger row at all, so every survivor was penalised,
  // and the extra-word tie-break then preferred the SPECIFIC brand (102) over
  // the generic fast-food row (105). Ordering the penalties is what makes
  // "Fast foods, hamburger; single, regular patty; plain" win, which is the
  // right answer to a bare "hamburger".
  //
  // The gap is wide enough that no extra-word count can bridge it -- the whole
  // point is that brand beats word count, the same reason venue already did.
  const rBrand = BRAND_KEYWORDS.find((b) => rNorm.replace(/[-–—_]/g, " ").includes(b));
  const brandPenalty = rBrand && !norm(query).replace(/[-–—_]/g, " ").includes(rBrand) ? 1000 : 0;

  // HEAD-FOOD PENALTY. firstSegmentMatches waves through any name with more
  // than two segments, because a cut-of-meat query legitimately has the animal
  // in the first segment ("skirt steak" -> "Beef, plate steak, inside skirt").
  // That same exemption lets "milk" reach "Cheese, mozzarella, whole milk",
  // where milk is a MODIFIER of a different food. Both tie at 2 extra words,
  // so USDA's ordering decides (portal, 2026-08-11).
  //
  // A penalty rather than a rejection, deliberately: the cut-of-meat case is
  // real and must still win when it is the only survivor. This only decides
  // which of several survivors is the more generic answer.
  // ADDITIONS ARE NOT DESCRIPTORS. Extra-word count treats "with vegetables"
  // as MORE generic than "creamed, large or small curd", because it is fewer
  // words -- so "cottage cheese" resolved to the vegetable variant while plain
  // sat below it (portal, 2026-08-11). Same brevity bias that put "Chicken,
  // meatless" above the correct seven-word chicken row.
  //
  // Anything the query did not ask for that arrives after "with" or "and" is
  // something ADDED to the food, so it makes the row less generic, not more.
  // Scoped to extras, so a query that does ask for it pays nothing.
  const addedTail = rNorm.split(/\b(?:with|and)\b/).slice(1).join(" ");
  const addedWords = new Set(addedTail.split(" ").filter(Boolean));
  const additions = rWords.filter((w) => !qWords.includes(w) && addedWords.has(w)).length;

  const rSegs = String(resultName).split(",");
  const headMismatch = rSegs.length > 1 && !qWords.some((w) => norm(rSegs[0]).includes(w));
  const headPenalty = headMismatch ? 50 : 0;

  const venuePenalty = isVenue && !queryWantsVenue ? 100 : 0;
  const extra = rWords.filter((w) => !qWords.includes(w)).length;
  return brandPenalty + venuePenalty + headPenalty + additions * 10 + extra;
}

/* A restaurant's version of a food, answering a query that never named the
 * restaurant. Live case (2026-08-07): "grilled chicken" returned "CAVA Grilled
 * Chicken" at 250 kcal/4oz -- seeded deliberately under "cava grilled chicken",
 * then reached by fuzzy match from the plain query. Every existing guard passed
 * it, because by every one of their measures it IS grilled chicken. The only
 * thing wrong with it is the word the user didn't type.
 *
 * A REJECTION here, unlike genericnessRank's venue penalty, and the asymmetry
 * is deliberate. That penalty ranks USDA candidates against each other, where
 * discarding the last survivor means returning nothing at all. This runs on a
 * cache read, where rejecting means "keep looking" -- and the next step is
 * USDA, which is exactly the canonical row the penalty was trying to reach.
 *
 * Brand detection here is the KEYWORD LIST ONLY, never isBranded(): that
 * function also treats any capitalised non-leading word as a brand signal,
 * which is correct for judging a user's typing and catastrophic against USDA
 * names -- "Salmon, Atlantic, farmed" would read as branded. */
export function unrequestedVenueOrBrand(query, resultName) {
  const norm = (s) => expandPercents(foldAccents(s)).toLowerCase().replace(/['’.]/g, "").replace(/[-–—_]/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const qNorm = norm(query);
  const rNorm = norm(resultName);

  const brand = BRAND_KEYWORDS.find((b) => rNorm.includes(b));
  if (brand && !qNorm.includes(brand)) return true;

  const words = (s) => s.split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const isVenue = words(rNorm).some((w) => VENUE_QUALIFIERS.includes(w)) || FAST_FOOD_RE.test(rNorm);
  const queryWantsVenue = words(qNorm).some((w) => VENUE_QUALIFIERS.includes(w)) || FAST_FOOD_RE.test(qNorm);
  return isVenue && !queryWantsVenue;
}

/* COMPOSITION TIE-BREAK.
 *
 * Portal data, 2026-08-11: "beef patty" returns 16 variants that ALL score
 * gen=6, because every one states a composition and they differ only in the
 * numbers. The tie falls to USDA's ordering, which happens to list the
 * fattiest first -- 70/30 at 277 kcal/100g against 93/7 at 193. A 135
 * kcal/100g spread decided by list position.
 *
 * The same probe showed ground beef, ground turkey and ground pork are all
 * FINE, because USDA publishes a composition-free row for each ("Pork, fresh,
 * ground, cooked") which genericnessRank already ranks well clear of the
 * variants. So this is not a general "prefer lean" or "prefer middle" rule --
 * both of those were wrong. It applies only where no composition-free
 * candidate exists at all, which is the one case nothing else covers.
 *
 * The target is the MEDIAN of the candidates' own compositions, not a
 * hardcoded number: it needs no per-food table, and it lands near the common
 * retail grade without asserting one.
 */
export function statedCompositionPct(name) {
  const m = expandPercents(String(name)).match(/(\d+(?:\.\d+)?)pct/);
  return m ? Number(m[1]) : null;
}

/** Index of the candidate to prefer, or null when this does not apply.
 *  `names` must be the surviving candidates, already ordered by the caller's
 *  normal ranking, and is only consulted when they are otherwise tied. */
export function preferMedianComposition(query, names) {
  if (!Array.isArray(names) || names.length < 2) return null;
  if (/(\d+(?:\.\d+)?)pct/.test(expandPercents(String(query)))) return null;  // user stated one
  const pcts = names.map(statedCompositionPct);
  if (pcts.some((p) => p == null)) return null;                                 // a composition-free row exists; let it win
  const sorted = [...pcts].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  let best = 0;
  for (let i = 1; i < pcts.length; i++) {
    if (Math.abs(pcts[i] - median) < Math.abs(pcts[best] - median)) best = i;
  }
  return best;
}

/** Index of the value closest to the set's median, or null when the set gives
 *  no usable signal. Needs THREE values: with two, the median sits exactly
 *  between them and both are equidistant, so it would silently fall back to
 *  whichever came first -- which is the arbitrary ordering this exists to
 *  escape. */
export function preferMedianValue(values) {
  if (!Array.isArray(values) || values.length < 3) return null;
  if (values.some((v) => typeof v !== "number" || !isFinite(v))) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  if (sorted[0] === sorted[sorted.length - 1]) return null;   // no spread, nothing to choose
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i] - median) < Math.abs(values[best] - median)) best = i;
  }
  return best;
}
