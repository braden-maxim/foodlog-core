// Regression tests. Every case here is a bug that reached production in one
// of the two apps — the value is in the specific inputs, not the coverage
// percentage. When you change a guard, add the case that made you change it.

import * as core from "./src/index.js";

let pass = 0, fail = 0;
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; }
  else { fail++; console.log(`  FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
};

// --- brand detection -------------------------------------------------------
// The hyphen bug: the brand's REAL spelling failed while the sloppy one
// worked, because hyphens weren't normalised to spaces.
is("Chick-fil-A is branded", core.isBranded("Chick-fil-A sandwich"), true);
is("chick fil a is branded", core.isBranded("chick fil a sandwich"), true);
is("In-N-Out is branded", core.isBranded("In-N-Out burger"), true);
is("lowercase beer brand", core.isBranded("miller lite"), true);
is("plain food is not branded", core.isBranded("chicken breast 6 oz"), false);
is("plain food is not branded 2", core.isBranded("skirt steak 6 ounces"), false);

// --- subtype qualifiers ----------------------------------------------------
// "eggs" resolved to egg whites for months: both tie at a perfect relevance
// score, and the 3+ comma-segment bypass let "white" through unchecked.
is("eggs rejects egg white", core.isOverlySpecific("eggs", "Eggs, Grade A, Large, egg white"), true);
is("explicit egg whites still allowed", core.isOverlySpecific("egg whites", "Eggs, Grade A, Large, egg white"), false);
is("honey rejects manuka", core.isOverlySpecific("honey", "Manuka Honey 20+"), true);
// Scoped per base food on purpose: an earlier global version of the qualifier
// list broke ordinary foods where "white" is just a descriptor.
is("white wine unaffected", core.isOverlySpecific("wine", "Wine, table, white"), false);
// Found live 2026-07-31: "white rice" was resolving to glutinous (sticky)
// rice at 97 kcal/100g against regular white rice's ~130 — a 25%
// underestimate, hidden behind a passing verification run.
is("white rice rejects glutinous", core.isOverlySpecific("white rice", "Rice, white, glutinous, unenriched, cooked"), true);
is("rice rejects wild rice", core.isOverlySpecific("rice", "Rice, wild, cooked"), true);
is("explicit glutinous query allowed", core.isOverlySpecific("glutinous rice", "Rice, white, glutinous, unenriched, cooked"), false);
// basmati/jasmine are named varieties but nutritionally equivalent, so they
// must NOT be rejected — listing a qualifier that doesn't change the numbers
// loses good matches for nothing.
is("basmati still matches a plain query", core.isOverlySpecific("white rice", "Rice, white, basmati, cooked"), false);
is("plain long-grain still matches", core.isOverlySpecific("white rice", "Rice, white, long-grain, regular, cooked"), false);

// --- query normalisation ---------------------------------------------------
// "2 tbsp honey" once failed to match plain honey at all, because unit words
// were treated as required content instead of units.
is("strips unit words", core.normalizeQuery("2 tbsp honey"), "honey");
is("strips weights", core.normalizeQuery("jasmine rice 200g"), "jasmine rice");
is("strips containers", core.normalizeQuery("1 cup jasmine rice"), "jasmine rice");

// --- composite dishes ------------------------------------------------------
is("Pie, Peach rejected for peach", core.firstSegmentMatches("peach", "Pie, Peach"), false);
is("Peaches, raw accepted for peach", core.firstSegmentMatches("peach", "Peaches, raw"), true);
// Multi-segment SR Legacy names are exempt — their first segment is the
// protein type, not the cut, so the check would block valid meat matches.
is("multi-segment meat exempt", core.firstSegmentMatches("skirt steak", "Beef, plate steak, inside skirt, choice, raw"), true);

// --- dry vs cooked grains --------------------------------------------------
is("small serving grain is dry", core.isDryGrainEntry({ serving_size: 45, name: "Rice, white, long-grain, raw" }), true);
is("real portion is not dry", core.isDryGrainEntry({ serving_size: 200, name: "Rice, white, cooked" }), false);
is("explicit dry query detected", core.queryImpliesDry("dry oats 50g"), true);

// --- branded sizes ---------------------------------------------------------
// normalizeQuery strips sizes, so without a size-aware key a 20oz and a 32oz
// of the same drink collide on one row and overwrite each other.
is("size extracted", core.extractSize("smoothie king hulk 32oz"), { value: 32, unit: "oz" });
is("size kept in the key", core.brandCacheKey("smoothie king hulk 32oz"), "smoothie king hulk 32oz");
is("size mismatch caught", core.brandedSizeMismatch("hulk 32oz", { source: "claude_web_search", serving_size: 20, serving_unit: "oz" }), true);
is("matching size accepted", core.brandedSizeMismatch("hulk 32oz", { source: "claude_web_search", serving_size: 32, serving_unit: "oz" }), false);
// USDA/OFF rows get scaled downstream regardless of their cached serving, so
// the size check is deliberately scoped to web-searched brand rows only.
is("usda row exempt from size check", core.brandedSizeMismatch("hulk 32oz", { source: "usda", serving_size: 100, serving_unit: "g" }), false);

// --- prompt ----------------------------------------------------------------
const rawRef = { name: 'Beef, plate steak, inside skirt, trimmed to 0" fat, choice, raw', calories: 195, protein: 20.1, carbs: 0, fat: 12.8, serving_size: 100, serving_unit: "g", source: "usda" };
const rawPrompt = core.buildEstimatePrompt({ description: "skirt steak 6 ounces", dbRef: rawRef });
// A raw reference used to be averaged against a cooked weight, producing a
// number wrong under both readings (386 kcal, vs 332 raw / 442 cooked).
is("raw state named", /STATE OF THIS REFERENCE — RAW/.test(rawPrompt), true);
is("conversion given", /÷ 0\.75/.test(rawPrompt), true);

const cookedPrompt = core.buildEstimatePrompt({ description: "8 oz ribeye", dbRef: { ...rawRef, name: "Beef, ribeye, cooked, broiled" } });
is("cooked state named", /STATE OF THIS REFERENCE — COOKED/.test(cookedPrompt), true);
is("cooked skips conversion", /÷ 0\.75/.test(cookedPrompt), false);

const noRef = core.buildEstimatePrompt({ description: "chicken breast", dbRef: null });
is("no reference block without a hit", /DATABASE REFERENCE/.test(noRef), false);
is("anchors present regardless", /COOKED MEAT WEIGHT/.test(noRef), true);

// --- scope boundary --------------------------------------------------------
// The package must stay food-only. If one of these ever fires, something from
// an app's plan/programming side has leaked into shared code.
for (const term of ["goal", "phase", "athlete", "programming", "TDEE", "deficit", "surplus", "workout"]) {
  is(`prompt free of "${term}"`, new RegExp("\\b" + term + "\\b", "i").test(rawPrompt), false);
}

// --- parsing ---------------------------------------------------------------
is("parses fenced json", core.extractJSON('```json\n{"items":[{"name":"x"}]}\n```').items.length, 1);
is("parses bare array", core.extractJSON('[{"id":"a"}]').length, 1);
try {
  core.parseModelJSON({ content: [], stop_reason: "max_tokens" }, "test");
  is("truncation throws", false, true);
} catch (e) {
  // Must be distinguishable from an unparseable response — conflating them is
  // what silently double-billed every truncated call.
  is("truncation reported as truncated", e.message, "truncated");
}


// --- calories contradicting their own macros -------------------------------
// "brown rice" resolved to USDA's "Flour, rice, brown" with calories 1580
// against macros implying 368 — a 4.29x gap, i.e. the kJ->kcal factor. The
// energy nutrient was read in kilojoules. Shared cache, unflagged, live.
is("kJ-as-kcal corruption caught", core.caloriesContradictMacros({ name: "Flour, rice, brown", calories: 1580, protein: 7, carbs: 76, fat: 4 }), true);
is("the corrected row passes", core.caloriesContradictMacros({ name: "Flour, rice, brown", calories: 368, protein: 7, carbs: 76, fat: 4 }), false);
is("ordinary food passes", core.caloriesContradictMacros({ name: "Chicken, breast, cooked", calories: 165, protein: 31, carbs: 0, fat: 3.6 }), false);
is("pure fat passes", core.caloriesContradictMacros({ name: "Oil, olive", calories: 884, protein: 0, carbs: 0, fat: 100 }), false);
// Alcohol is 7 kcal/g and in none of the three macros. Flagging it would
// recreate the Miller Lite bug, where calories were rebuilt from a formula
// that cannot represent alcohol and came out 16 instead of ~96.
is("light beer exempt", core.caloriesContradictMacros({ name: "Alcoholic beverage, beer, light", calories: 96, protein: 0.6, carbs: 3.2, fat: 0 }), false);
is("higher-carb beer exempt", core.caloriesContradictMacros({ name: "Beer, regular", calories: 150, protein: 1.6, carbs: 13, fat: 0 }), false);
is("wine exempt", core.caloriesContradictMacros({ name: "Wine, table, red", calories: 85, protein: 0.1, carbs: 2.6, fat: 0 }), false);

// --- raw grain must not get the meat conversion ----------------------------
// Meat loses ~25% cooking so cooked is denser; grains absorb water and roughly
// triple, so cooked is much LESS dense. Applying meat maths to dry rice gives
// 487 kcal/100g against a real cooked figure near 130.
const rawGrain = core.buildEstimatePrompt({ description: "brown rice 200g", dbRef: { name: "Rice, brown, long-grain, raw", calories: 370, protein: 7.9, carbs: 77, fat: 2.9, serving_size: 100, serving_unit: "g", source: "usda" } });
is("raw grain gets the dry-grain note", /DRY\/UNCOOKED GRAIN/.test(rawGrain), true);
is("raw grain avoids meat conversion", /÷ 0\.75/.test(rawGrain), false);
is("raw meat still gets meat conversion", /÷ 0\.75/.test(core.buildEstimatePrompt({ description: "skirt steak 6 oz", dbRef: { name: "Beef, plate steak, inside skirt, raw", calories: 195, protein: 20.1, carbs: 0, fat: 12.8, serving_size: 100, serving_unit: "g", source: "usda" } })), true);


// --- energy unit safety ----------------------------------------------------
// USDA publishes energy in kcal AND kJ; a naive .find() took whichever came
// first, putting 1580 kcal on brown rice instead of 368.
is("prefers kcal over kJ", core.energyKcal([{ nutrientId: 1062, unitName: "kJ", value: 1540 }, { nutrientId: 1008, unitName: "KCAL", value: 368 }]), 368);
is("kJ listed first still yields kcal", core.energyKcal([{ nutrientId: 1008, unitName: "kJ", value: 1540 }, { nutrientId: 1008, unitName: "KCAL", value: 368 }]), 368);
is("converts when only kJ exists", core.energyKcal([{ nutrientId: 1062, unitName: "kJ", value: 1540 }]), 368);
is("no energy nutrient", core.energyKcal([{ nutrientId: 1003, unitName: "G", value: 31 }]), null);

// --- form qualifiers -------------------------------------------------------
// Flour is not rice. These slip past the word-count guard because the
// multi-segment name trips the comma bypass first.
is("rice rejects rice flour", core.isOverlySpecific("white rice", "Flour, rice, white, unenriched"), true);
is("corn rejects corn syrup", core.isOverlySpecific("corn", "Syrup, corn, high-fructose"), true);
is("garlic rejects garlic powder", core.isOverlySpecific("garlic", "Spices, garlic powder"), true);
is("explicit rice flour allowed", core.isOverlySpecific("rice flour", "Flour, rice, white, unenriched"), false);
// "oil" and "milk" are deliberately NOT form qualifiers -- these must pass.
is("tuna canned in oil is still tuna", core.isOverlySpecific("tuna", "Tuna, light, canned in oil, drained"), false);
is("whole milk yogurt is still yogurt", core.isOverlySpecific("yogurt", "Yogurt, whole milk, plain"), false);

// --- dry grains by density -------------------------------------------------
// serving_size < 70 was a no-op for SR Legacy rows, which always fall back to
// 100 -- exactly the raw-grain entries the guard existed to catch.
is("SR Legacy raw rice at serving 100", core.isDryGrainEntry({ name: "Rice, white, long-grain, regular, raw", serving_size: 100, calories: 365 }), true);
is("dense dry oats with no state word", core.isDryGrainEntry({ name: "Oats, rolled", serving_size: 100, calories: 389 }), true);
is("cooked rice not dry", core.isDryGrainEntry({ name: "Rice, white, long-grain, cooked", serving_size: 100, calories: 130 }), false);
is("cooked beans not dry", core.isDryGrainEntry({ name: "Beans, black, mature seeds, cooked, boiled", serving_size: 100, calories: 132 }), false);
is("non-grain unaffected", core.isDryGrainEntry({ name: "Chicken, breast, cooked", serving_size: 100, calories: 165 }), false);


// --- generic preference ----------------------------------------------------
// When several candidates pass every guard with an identical relevance score,
// the old tie-break was whatever order USDA returned. That is how "white
// rice" became restaurant-steamed rice at 151 kcal/100g instead of the
// canonical ~130.
//
// Note the extra-word count deliberately does not dominate: measured against
// the real candidates, the restaurant entry adds 3 words and the canonical
// SR Legacy row adds 4, so ranking on word count alone picks the WRONG one.
const riceCandidates = [
  "Rice, white, steamed, Chinese restaurant",
  "Rice, white, long-grain, regular, cooked, enriched",
];
const pickBy = (q, names) => names.map((n) => ({ n, r: core.genericnessRank(q, n) })).sort((a, b) => a.r - b.r)[0].n;
is("plain query avoids the venue entry", pickBy("white rice", riceCandidates), "Rice, white, long-grain, regular, cooked, enriched");
is("explicit venue query finds it", pickBy("chinese restaurant rice", riceCandidates), "Rice, white, steamed, Chinese restaurant");
is("fast food phrase detected", core.genericnessRank("biscuit", "Fast Foods, biscuit") >= 100, true);
is("fast food query exempt", core.genericnessRank("fast food biscuit", "Fast Foods, biscuit") < 100, true);
// A venue entry still wins when it is the only survivor — it is the right
// food, just context-specific, so using it beats returning nothing.
is("venue entry not discarded", core.isOverlySpecific("white rice", "Rice, white, steamed, Chinese restaurant"), false);


// --- preparation words are not content -------------------------------------
// "steamed white rice" scored every plain cooked-rice entry at 0.67 -- below
// MIN_SCORE -- because they lack the literal word "steamed", leaving a
// "Chinese restaurant" row as the only survivor at 1.00. The venue penalty
// never ran, since genericness only breaks ties WITHIN a relevance tier.
is("plain rice clears the bar for a steamed query", core.relevanceScore("steamed white rice", "Rice, white, medium-grain, cooked, unenriched") >= core.MIN_SCORE, true);
is("and outranks the venue entry", core.genericnessRank("steamed white rice", "Rice, white, medium-grain, cooked, unenriched") < core.genericnessRank("steamed white rice", "Rice, white, steamed, Chinese restaurant"), true);
// "fried" must stay required content -- it adds fat and changes the food.
is("fried is still content", core.relevanceScore("fried chicken", "Chicken, breast, cooked, roasted") >= core.MIN_SCORE, false);

// --- plural/singular tolerance ---------------------------------------------
// USDA is inconsistent: "Eggs, Grade A, Large" but "Egg, whole, cooked".
// A query of "eggs" scored 0.00 against the singular entry and was filtered
// out before any other guard could run.
is("eggs matches a singular Egg entry", core.relevanceScore("eggs", "Egg, whole, cooked, hard-boiled") >= core.MIN_SCORE, true);
is("oats matches Oats", core.relevanceScore("oats", "Oats, rolled") >= core.MIN_SCORE, true);
// Must not manufacture matches from a shared prefix.
is("rice does not match ricotta", core.relevanceScore("rice", "Cheese, ricotta, whole milk") >= core.MIN_SCORE, false);
is("goat does not match oats", core.relevanceScore("goat", "Oats, rolled") >= core.MIN_SCORE, false);
is("subtype guard still holds with plurals", core.isOverlySpecific("eggs", "Eggs, Grade A, Large, egg white"), true);


// --- dry-grain density needs unit and fat guards ---------------------------
// Live false positives from the first density implementation (2026-07-31),
// found by scanning the real cache rather than by any test.
// The formula assumes a GRAM serving: a branded row at 210 kcal / 4 oz
// computed as 5250 "kcal/100g" and was rejected as dry grain.
is("oz serving not assessed by density", core.isDryGrainEntry({ name: "Chipotle Cilantro-Lime Brown Rice 4 oz", calories: 210, serving_size: 4, serving_unit: "oz", fat: 4 }), false);
is("small oz serving not assessed either", core.isDryGrainEntry({ name: "Boston Market Green Beans (3.2 oz)", calories: 60, serving_size: 3.2, serving_unit: "oz", fat: 2 }), false);
// A dressed dish can honestly exceed 250 kcal/100g. Fat separates it from
// dry starch, which runs under ~7g per 100g.
is("dressed pasta salad is not dry pasta", core.isDryGrainEntry({ name: "PASTA SALAD, PASTA", calories: 450, serving_size: 150, serving_unit: "g", fat: 30 }), false);
is("dry pasta still detected", core.isDryGrainEntry({ name: "Pasta, dry, enriched", calories: 371, serving_size: 100, serving_unit: "g", fat: 1.5 }), true);
is("dry oats still detected", core.isDryGrainEntry({ name: "Oats, rolled", calories: 389, serving_size: 100, serving_unit: "g", fat: 6.9 }), true);


// --- compound words -------------------------------------------------------
// Users type compounds that USDA splits. "equate ultra filtered milkshake"
// vs "Equate Ultra Filtered Milk Protein Shake" counted milk/protein/shake
// as three extra words when only "protein" genuinely is — a false rejection
// of a good cached row, costing a needless fresh lookup.
is("milkshake tolerates Milk...Shake", core.isOverlySpecific("equate ultra filtered milkshake", "Equate Ultra Filtered Milk Protein Shake"), false);
is("cheeseburger tolerates Cheese Burger", core.isOverlySpecific("cheeseburger", "Cheese Burger, single patty"), false);
// Must not dissolve real over-specificity.
is("honey still rejects manuka", core.isOverlySpecific("honey", "Manuka Honey 20+"), true);
is("white rice still rejects flour", core.isOverlySpecific("white rice", "Flour, rice, white, unenriched"), true);


// --- count abbreviations and apostrophes -----------------------------------
// Found by scanning the live cache (2026-07-31): ~10 branded rows scored
// 0.60-0.67 and would be needlessly rejected. Two separate causes.
//
// A digit glued to a word ("8piece" vs "8ct") shares no textual overlap, so
// the count token counted as required content neither side could satisfy.
is("8piece matches 8ct", core.relevanceScore("chick fil a nuggets 8piece", "Chick-fil-A Nuggets (8ct)") >= core.MIN_SCORE, true);
is("4piece matches 4ct", core.relevanceScore("chick fil a chicken strips 4piece", "Chick-fil-A Chicken Strips (4ct)") >= core.MIN_SCORE, true);
// An apostrophe became a SPACE, so "PJ's" normalised to "pj s" while a user
// typing "pjs" stayed "pjs". Apostrophes are now stripped, hyphens still
// become spaces (Chick-fil-A needs that).
is("pjs matches PJ's", core.relevanceScore("pjs coffee 20oz", "PJ's Coffee Iced Latte (20 oz)") >= core.MIN_SCORE, true);
is("kinders matches Kinder's", core.relevanceScore("kinders bbq sauce", "Kinder's Hickory BBQ Sauce") >= core.MIN_SCORE, true);
// None of this may loosen the real guards.
is("honey still rejects manuka", core.isOverlySpecific("honey", "Manuka Honey 20+"), true);
is("white rice still rejects glutinous", core.isOverlySpecific("white rice", "Rice, white, glutinous, unenriched, cooked"), true);


// --- barcodes --------------------------------------------------------------
// All three codes below were verified against Open Food Facts before the
// feature was scoped, so these are real products, not invented digits.
is("UPC-A validates", core.isValidBarcode("038000138416"), true);          // Pringles
is("EAN-13 validates", core.isValidBarcode("5000112637922"), true);        // Coca-Cola
is("UPC-A pads to EAN-13", core.normalizeBarcode("038000138416"), "0038000138416");
// One product must yield ONE cache key however the scanner reported it.
is("both formats share a key", core.barcodeCacheKey("038000138416") === core.barcodeCacheKey("0038000138416"), true);
is("key is prefixed", core.barcodeCacheKey("038000138416"), "upc:0038000138416");
// Misreads rejected before they cost a network round trip.
is("bad check digit rejected", core.isValidBarcode("0038000138417"), false);
is("altered body digit rejected", core.isValidBarcode("0038000138516"), false);
is("wrong length rejected", core.isValidBarcode("12345"), false);
is("non-numeric rejected", core.isValidBarcode("hello world"), false);
is("hyphens tolerated", core.isValidBarcode("0-38000-13841-6"), true);

// An all-zero GTIN passes the check-digit maths (sum 0, check 0) but is not a
// product. Live: scanning it matched a USDA record with a blank gtinUpc.
is("all-zero barcode rejected", core.isValidBarcode("0000000000000"), false);


// --- quantity parsing ------------------------------------------------------
// Scaling exact per-serving values is arithmetic; paying a model to multiply
// by two is waste. But "8 meatballs" when a serving is 4 needs judgement, so
// anything unclear must return null -- ask the model, never guess. A wrong
// multiplier silently scales someone's whole day.
const svc = { serving_size: 28, serving_unit: "g" };
is("plain number", core.parseQuantity("1", svc), 1);
is("servings", core.parseQuantity("2 servings", svc), 2);
is("grams against a gram serving", core.parseQuantity("56g", svc), 2);
is("unclear returns null", core.parseQuantity("8 meatballs", svc), null);
is("vague returns null", core.parseQuantity("half the bag", svc), null);
// A weight is meaningless against a per-piece serving.
is("grams vs per-piece serving is null", core.parseQuantity("50g", { serving_size: 1, serving_unit: "serving" }), null);
is("scales and rounds", core.scaleNutrition({ calories: 150, protein: 2, carbs: 16, fat: 9 }, 2), { calories: 300, protein: 4, carbs: 32, fat: 18 });


// --- buildUsdaResult -------------------------------------------------------
// Moved into this package without its nutrient-ID constants, so it threw a
// ReferenceError on EVERY call. The caller's try/catch swallowed it, so USDA
// lookups silently fell through to Open Food Facts rather than failing
// loudly, and nothing in the build or the suite noticed. Found by the portal
// on 2026-08-01, ~20 minutes after it shipped.
const usdaFood = {
  description: "Celeriac, raw", fdcId: 170400,
  foodNutrients: [
    { nutrientId: 1008, unitName: "KCAL", value: 42 },
    { nutrientId: 1003, unitName: "G", value: 1.5 },
    { nutrientId: 1005, unitName: "G", value: 9.2 },
    { nutrientId: 1004, unitName: "G", value: 0.3 },
  ],
};
const usdaRow = core.buildUsdaResult(usdaFood, "celeriac");
is("returns a row at all", !!usdaRow, true);
is("calories read", usdaRow.calories, 42);
// Each macro has its own constant; a single missing one is the whole bug.
is("protein read", usdaRow.protein, 1.5);
is("carbs read", usdaRow.carbs, 9.2);
is("fat read", usdaRow.fat, 0.3);
is("marked as usda", usdaRow.source, "usda");
// Energy still goes through the unit-aware reader, so a kJ-only record is
// converted rather than stored 4.3x high.
const kjOnly = core.buildUsdaResult({ description: "X", fdcId: 1, foodNutrients: [{ nutrientId: 1062, unitName: "kJ", value: 1540 }, { nutrientId: 1003, unitName: "G", value: 7 }] }, "x");
is("kJ-only energy converted", kjOnly.calories, 368);


// A caller with no structured serving info reasonably passes null -- a
// nutrition label states its serving as free text ("2/3 cup (55g)"), not as
// a number and a unit. A default parameter only covers undefined, so a
// weight threw a TypeError. A count still worked, because that branch
// returns before the serving is read, which is why it looked fine.
is("null serving, count still works", core.parseQuantity("2 servings", null), 2);
is("null serving, bare number works", core.parseQuantity("1", null), 1);
is("null serving, weight defers rather than throwing", core.parseQuantity("50g", null), null);
is("undefined serving is safe too", core.parseQuantity("2", undefined), 2);


// --- log quality -----------------------------------------------------------
// Every case below is a REAL day measured from production logs on 2026-08-03.
// A partially-logged day read at face value drags a measured-maintenance
// estimate down, which sets the calorie target too low.
//
// Entry count alone misses most of them -- 4, 3 and 11 entries all look
// healthy. The time spread is what betrays a day that is really one meal.
// --- finished days: short span means compressed logging, not a missing day ---
is("finished burst: 9 items in 3 min keeps the floor",
   core.dayConfidence({ entryCount: 9, spreadHours: 0.05 }), core.RECONSTRUCTED_DAY_WEIGHT);
is("finished burst: 3 items in 1 min keeps the floor",
   core.dayConfidence({ entryCount: 3, spreadHours: 0.02 }), core.RECONSTRUCTED_DAY_WEIGHT);
is("genuinely thin finished day scores below the floor",
   core.dayConfidence({ entryCount: 1, spreadHours: 0 }) < core.RECONSTRUCTED_DAY_WEIGHT, true);
is("8 entries across 11.3h is a real day", core.dayConfidence({ entryCount: 8, spreadHours: 11.3 }), 1);
is("6 entries across 9.8h is a real day", core.dayConfidence({ entryCount: 6, spreadHours: 9.8 }), 1);
is("no entries is no evidence", core.dayConfidence({ entryCount: 0, spreadHours: 0 }), 0);

// --- the current day: still accruing, so both signals must hold ---
is("tracker's real today (10 items / 2.55h) is heavily discounted",
   core.dayConfidence({ entryCount: 10, spreadHours: 2.55, isCurrentDay: true }), 0.43);
is("portal athlete today (3 items / 1 min) is near zero",
   core.dayConfidence({ entryCount: 3, spreadHours: 0.017, isCurrentDay: true }) < 0.01, true);
is("a current day that already spans the full window is trusted",
   core.dayConfidence({ entryCount: 8, spreadHours: 11.3, isCurrentDay: true }), 1);
is("the SAME shape scores far higher once the day is finished",
   core.dayConfidence({ entryCount: 9, spreadHours: 0.05, isCurrentDay: false })
     > core.dayConfidence({ entryCount: 9, spreadHours: 0.05, isCurrentDay: true }), true);

// --- isCurrentDay must be a real parameter, not an inherited assumption ---
is("isCurrentDay defaults to false",
   core.dayConfidence({ entryCount: 9, spreadHours: 0.05 }),
   core.dayConfidence({ entryCount: 9, spreadHours: 0.05, isCurrentDay: false }));

// --- untimed days are the caller's call, not the package's ---
is("untimed day is discounted by default",
   core.dayConfidence({ entryCount: 6, spreadHours: 0, hasTimestamps: false }),
   core.UNTIMED_DAY_WEIGHT);
is("untimed day is whole when the app says its legacy format stored totals",
   core.dayConfidence({ entryCount: 6, spreadHours: 0, hasTimestamps: false },
                      { untimedIsWholeDay: true }), 1);

const wi = core.weightedIntake([
  { calories: 3100, entryCount: 16, spreadHours: 11.4 },
  { calories: 3100, entryCount: 16, spreadHours: 11.4 },
  { calories: 1727, entryCount: 10, spreadHours: 2.55, isCurrentDay: true },
]);
// unweighted this trio averages 2642; weighting recovers ~215 kcal of that.
is("a half-finished day barely moves the weighted mean", Math.round(wi.average), 2857);
is("and barely counts toward effective days", wi.effectiveDays, 2.4);
is("weightedIntake passes options through to every day",
   Math.round(core.weightedIntake(
     [{ calories: 2000, entryCount: 6, spreadHours: 0, hasTimestamps: false }],
     { untimedIsWholeDay: true }).effectiveDays * 10) / 10, 1);

// --- dayShape: the translation both apps had written separately ---
const d1 = core.dayShape([{time:"9:25 AM"},{time:"1:49 PM"},{time:"9:44 PM"}]);
is("dayShape counts entries", d1.entryCount, 3);
is("dayShape spans the clock", Math.round(d1.spreadHours * 100) / 100, 12.32);
is("dayShape sees timestamps", d1.hasTimestamps, true);
is("one readable time is NOT a spread of zero",
   core.dayShape([{time:"9:25 AM"},{name:"no time"}]).hasTimestamps, false);
is("no entries at all", core.dayShape([]).entryCount, 0);
is("null entries tolerated", core.dayShape(null).entryCount, 0);

is("parses 12-hour with meridiem", core.parseClockMinutes("1:07 PM"), 13 * 60 + 7);
is("parses midnight hour correctly", core.parseClockMinutes("12:05 AM"), 5);
is("parses noon hour correctly", core.parseClockMinutes("12:35 PM"), 12 * 60 + 35);
is("parses a 24-hour locale string", core.parseClockMinutes("13:25"), 13 * 60 + 25);
is("tolerates the narrow no-break space ICU emits",
   core.parseClockMinutes("1:07\u202fPM"), 13 * 60 + 7);
is("rejects an impossible clock", core.parseClockMinutes("25:00"), null);
is("rejects a non-string", core.parseClockMinutes(undefined), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
