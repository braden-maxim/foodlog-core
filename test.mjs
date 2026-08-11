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

// A cooking method that does not change the food must not count against the
// match. "baked salmon" scored 0.50 against every salmon row in the database --
// under MIN_SCORE -- so the lookup returned nothing and the model guessed 2g of
// protein for 81g of fish. "cooked salmon" worked the whole time, because that
// one word happened to be in the stop list and the rest were not.
for (const prep of ["baked", "grilled", "roasted", "broiled", "seared", "poached", "braised"]) {
  is(`"${prep} salmon" still matches a plain salmon row`,
     core.relevanceScore(`${prep} salmon`, "Salmon, Atlantic, farmed, raw") >= core.MIN_SCORE, true);
}
// Preparations that DO change the food stay required content.
is("fried stays content (oil, breading)", core.relevanceScore("fried chicken", "Chicken, breast, cooked, roasted") >= core.MIN_SCORE, false);
is("smoked stays content (different product)", core.relevanceScore("smoked salmon", "Salmon, Atlantic, farmed, raw") >= core.MIN_SCORE, false);
is("bbq stays content (sauce, sugar)", core.relevanceScore("bbq chicken", "Chicken, breast, cooked, roasted") >= core.MIN_SCORE, false);
// The words that were accidentally dropped while adding the above.
is("cooked is still a stop word", core.relevanceScore("cooked salmon", "Salmon, Atlantic, farmed, raw") >= core.MIN_SCORE, true);
is("steamed is still a stop word", core.relevanceScore("steamed white rice", "Rice, white, medium-grain, cooked, unenriched") >= core.MIN_SCORE, true);

// A dish is not its ingredient. A real shared-cache row, "BAKED SALMON SALAD"
// at 90 kcal in a 21g deli serving, was returned to anyone typing "baked
// salmon" -- it passed relevance, first-segment, dry-grain, size and macro
// checks, and its single extra word sat under the extra-word tolerance of 2.
is("ingredient must not resolve to a dish", core.isOverlySpecific("baked salmon", "BAKED SALMON SALAD"), true);
is("nor chicken to chicken salad", core.isOverlySpecific("chicken", "Chicken salad"), true);
is("nor rice to a rice cake", core.isOverlySpecific("rice", "Rice cake"), true);
is("nor chicken to a chicken patty", core.isOverlySpecific("chicken", "Chicken patty"), true);
// Asymmetric: once the query names a dish, further dish words describe THAT
// dish rather than changing category.
is("a dish query still matches its dish", core.isOverlySpecific("chicken salad", "Chicken salad, with mayo"), false);
is("hamburger tolerates single patty", core.isOverlySpecific("hamburger", "Hamburger, single patty"), false);
is("plain food is untouched", core.isOverlySpecific("baked salmon", "Salmon, Atlantic, farmed, raw"), false);

// The dish check used to sit BELOW the >2-segment comma bypass, so it only ever
// saw short names. It caught the all-caps cache row and waved through USDA's
// own spelling of the same food. Reported by the portal 2026-08-07, live case:
// "ground beef" was answering with the frozen-patty row at 295 kcal/23g.
// These are the multi-segment twins of the four cases above -- if the guard
// ever drifts back below the bypass, every one of them flips.
is("multi-segment dish is rejected too", core.isOverlySpecific("baked salmon", "Salmon, baked, salad"), true);
is("nor chicken to a 4-segment nugget row", core.isOverlySpecific("chicken", "Chicken, nuggets, frozen, cooked"), true);
is("nor potato to home-prepared potato salad", core.isOverlySpecific("potato", "Potato, salad, home-prepared"), true);
is("nor ground beef to frozen patties", core.isOverlySpecific("ground beef", "Beef, ground, patties, frozen, cooked, broiled"), true);
// The bypass still does its job for long names that name no dish at all.
is("long descriptor names still pass", core.isOverlySpecific("chicken breast", "Chicken, broilers or fryers, breast, meat only, cooked, roasted"), false);
is("and so does ground beef proper", core.isOverlySpecific("ground beef", "Beef, ground, 85% lean meat / 15% fat, raw"), false);

// A processed form is a different product, not a description of one.
is("roast breast is not deli slices", core.isOverlySpecific("roasted turkey breast", "Turkey breast, sliced, prepackaged"), true);
is("unrequested sweetening is rejected", core.isOverlySpecific("frozen blueberries", "Blueberries, frozen, sweetened"), true);
is("but unsweetened is not", core.isOverlySpecific("frozen blueberries", "Blueberries, frozen, unsweetened"), false);
is("and asking for deli gets deli", core.isOverlySpecific("deli turkey breast", "Turkey breast, sliced, prepackaged"), false);

// --- unrequested venue or brand --------------------------------------------
// "grilled chicken" was returning "CAVA Grilled Chicken" at 250 kcal/4oz: a row
// seeded on purpose under "cava grilled chicken", then reached by fuzzy match
// from the plain query. Nothing else can see this -- by every other measure it
// IS grilled chicken.
is("brand the query never named", core.unrequestedVenueOrBrand("grilled chicken", "CAVA Grilled Chicken"), true);
is("naming the brand still matches it", core.unrequestedVenueOrBrand("cava grilled chicken", "CAVA Grilled Chicken"), false);
is("hyphenated brand spelling matches", core.unrequestedVenueOrBrand("chick-fil-a grilled chicken", "Chick-fil-A Grilled Chicken"), false);
is("venue row on a plain query", core.unrequestedVenueOrBrand("white rice", "Rice, white, steamed, Chinese restaurant"), true);
is("fast food row on a plain query", core.unrequestedVenueOrBrand("biscuit", "Fast foods, biscuit"), true);
// USDA capitalisation must NOT read as a brand -- this is why the check uses
// the keyword list and never isBranded(), which treats any capitalised
// non-leading word as branded.
is("capitalised USDA name is not a brand", core.unrequestedVenueOrBrand("salmon", "Salmon, Atlantic, farmed, cooked, dry heat"), false);
is("nor is a plain SR Legacy row", core.unrequestedVenueOrBrand("chicken breast", "Chicken, broilers or fryers, breast, meat only, cooked, roasted"), false);

// --- dish families and aliases ---------------------------------------------
// From the 2026-08-07 cache scan, which is where all six of these came from.
//
// The guard used to be a boolean: name any dish and every dish word in the
// result was forgiven. "hamburger" returned "Rolls, hamburger or hotdog,
// plain" -- 279 kcal of bread -- on exactly that hole.
is("a bun is not a burger", core.isOverlySpecific("hamburger", "Rolls, hamburger or hotdog, plain"), true);
is("but a patty still is", core.isOverlySpecific("cheeseburger", "Cheese Burger, single patty"), false);
is("and a salad query still gets salad", core.isOverlySpecific("chicken salad", "Chicken salad, with mayo"), false);
// The other half was equally wrong: a query can name a dish without using a
// dish word for it. A breakfast link IS a sausage.
is("links are sausage", core.isOverlySpecific("small turkey links", "Sausage, turkey, breakfast links, mild, raw"), false);
is("sticks are sausage", core.isOverlySpecific("cheese and beef stick", "Sausage, summer, pork and beef, sticks, with cheddar cheese"), false);
// A parenthetical is a cross-reference, not the food. Reading "soup" out of
// this bracket rejected the canonical saltine row and left the query with no
// database answer at all.
is("parenthetical is not the food", core.isOverlySpecific("saltine crackers", "Crackers, saltines (includes oyster, soda, soup)"), false);
// "chili" is the pepper far more often than the stew, and blocked three
// deliberately-seeded Chipotle rows in one scan.
is("chili pepper is not the stew", core.isOverlySpecific("chipotle corn salsa", "Chipotle Roasted Chili-Corn Salsa (Medium)"), false);
is("nor in a tomatillo salsa", core.isOverlySpecific("chipotle tomatillo green salsa", "Chipotle Tomatillo-Green Chili Salsa"), false);
// Still rejected, and still should be.
is("sandwich crackers are crackers", core.isOverlySpecific("ritz peanut butter crackers small", "Crackers, wheat, sandwich, with peanut butter filling"), false);
is("sandwich cookies are cookies", core.isOverlySpecific("peanut butter cookie", "Cookies, peanut butter sandwich, regular"), false);
is("mac and cheese is not pizza", core.isOverlySpecific("mac and cheese", "MAC ATTACK MAC & CHEESE PIZZA, MAC & CHEESE"), true);
is("ice cream is not a sandwich", core.isOverlySpecific("ice cream", "Ice cream sandwich"), true);

// --- accent folding --------------------------------------------------------
// Every normalizer reduces text to [a-z0-9 ], which turned an accented letter
// into a SPACE: "Entrée" became "entr e". Found 2026-08-07 -- a deliberately
// seeded "Chipotle Steak Entrée (4 oz)" scored 0.67 against "chipotle steak
// entree", under MIN_SCORE, so a correct row that existed returned nothing.
is("accented name matches plain query", core.relevanceScore("chipotle steak entree 4oz", "Chipotle Steak Entr\u00e9e (4 oz)") >= core.MIN_SCORE, true);
is("two accents in one word", core.relevanceScore("creme brulee", "Cr\u00e8me Br\u00fbl\u00e9e") >= core.MIN_SCORE, true);
is("tilde folds", core.relevanceScore("chomps jalapeno beef stick", "CHOMPS Jalape\u00f1o Beef Sticks") >= core.MIN_SCORE, true);
// Both spellings must collapse onto ONE cache key -- they were two before.
is("accented query folds to one key", core.normalizeQuery("Chomps Jalape\u00f1o Beef Stick"), "chomps jalapeno beef stick");
is("plain query gives the same key", core.normalizeQuery("Chomps Jalapeno Beef Stick"), "chomps jalapeno beef stick");

// --- from the live verification run, 2026-08-07 -----------------------------
// All four queries were typed into the app and the results read out of the
// Vercel logs. Two of the four came back wrong.
//
// "hamburger" -> "WENDY'S, Jr. Hamburger, with cheese". unrequestedVenueOrBrand
// would have caught it, but that guard runs only on the cache read; the USDA
// ranking had no brand signal at all. A branded row now takes the same penalty
// a venue row does -- it loses to any generic candidate, but still wins if it
// is the only one left.
is("branded row is penalised", core.genericnessRank("hamburger", "WENDY\u2019S, Jr. Hamburger, with cheese") >= 100, true);
// A NAMED BRAND must outrank a generic venue category, not tie with it. Both
// were 100 and "hamburger" STILL resolved to Wendy's after the brand penalty
// shipped: USDA has no generic hamburger row, so every survivor was penalised
// and the extra-word tie-break preferred the more specific brand.
is("brand is worse than venue",
   core.genericnessRank("hamburger", "WENDY\u2019S, Jr. Hamburger, with cheese")
   > core.genericnessRank("hamburger", "Fast foods, hamburger; single, regular patty; plain"), true);
is("generic row is not", core.genericnessRank("hamburger", "Hamburger, single patty, plain") < 100, true);
is("naming the brand removes the penalty", core.genericnessRank("wendys hamburger", "WENDY\u2019S, Jr. Hamburger, with cheese") < 100, true);

// "ground beef" -> "Beef, grass-fed, ground, raw", 198 kcal/100g against ~254
// for conventional 80/20. "grass" and "fed" were deliberately kept out of
// STOP_WORDS because grass-fed IS leaner -- but nothing acted on that, and the
// 4-segment name tripped the comma bypass before the extra-word count ran.
is("grass-fed is a subtype", core.isOverlySpecific("ground beef", "Beef, grass-fed, ground, raw"), true);
is("asking for grass-fed still works", core.isOverlySpecific("grass fed ground beef", "Beef, grass-fed, ground, raw"), false);
is("plain ground beef unaffected", core.isOverlySpecific("ground beef", "Beef, ground, 80% lean meat / 20% fat, raw"), false);

// "grilled chicken" -> "Chicken spread", a pate at 17.6g fat/100g. One extra
// word, no dish word, invisible to every guard.
is("a spread is not the meat", core.isOverlySpecific("grilled chicken", "Chicken spread"), true);
// With the spread rejected, the SAME query then resolved to "Chicken,
// meatless" -- soy protein at 224 kcal/100g. It won because genericnessRank
// rewards few extra words, so a terse wrong name (rank 1) outranked the
// correct SR Legacy one (rank 7). Brevity is a bad proxy for generality.
is("a meat substitute is not the meat", core.isOverlySpecific("grilled chicken", "Chicken, meatless"), true);
is("imitation crab is not crab", core.isOverlySpecific("crab", "Crab, imitation, made from surimi"), true);
is("asking for it still gets it", core.isOverlySpecific("vegan chicken", "Chicken, meatless"), false);
// Deliberately NOT rejected -- these describe the same food, not a substitute.
is("vegetarian baked beans are baked beans", core.isOverlySpecific("baked beans", "Beans, baked, canned, vegetarian"), false);
is("almond milk really is plant based", core.isOverlySpecific("almond milk", "Beverages, almond milk, plant based, unsweetened"), false);
is("roast chicken still matches", core.isOverlySpecific("grilled chicken", "Chicken, broilers or fryers, breast, meat only, cooked, roasted"), false);

// --- tender: adjective vs dish noun -----------------------------------------
// Reported by the portal 2026-08-07: "red beans and sausage" stayed blocked
// against "TENDER RED BEANS & RICE WITH SAUSAGE" even after dish families,
// because "tender" was disqualifying in its ADJECTIVE sense.
//
// The singular/plural split is not a guess -- it is USDA's own naming. Every
// dish-sense tender in the database is plural; every singular one is an
// adjective or a cut name.
is("tender as an adjective", core.isOverlySpecific("red beans and sausage", "TENDER RED BEANS & RICE WITH SAUSAGE"), false);
is("mock tender steak is a cut", core.isOverlySpecific("beef steak", "Beef, chuck, mock tender steak, boneless, choice, raw"), false);
is("petite tender is a cut", core.isOverlySpecific("pork", "Pork, shoulder petite tender, boneless, separable lean and fat, raw"), false);
// The dish sense must still be caught, and a query naming it must still match.
is("chicken tenders still blocked for chicken", core.isOverlySpecific("chicken", "Chicken tenders, breaded, frozen, prepared"), true);
is("fast food tenders too", core.isOverlySpecific("chicken", "Fast foods, chicken tenders"), true);
is("asking for a tender still matches", core.isOverlySpecific("chicken tender", "Chicken tenders, breaded, frozen, prepared"), false);

// A plural is not an extra word. "chicken tender" against "Fast foods, chicken
// tenders" counted "tenders" as extra, which with "fast" and "foods" made
// three and rejected the row the query plainly asked for. The dish alias was
// working; the generic extra-word count was what fired. Portal, 2026-08-07.
is("singular query matches plural row", core.isOverlySpecific("chicken tender", "Fast foods, chicken tenders"), false);
is("plural query still matches", core.isOverlySpecific("chicken tenders", "Fast foods, chicken tenders"), false);
is("but a plain query does not", core.isOverlySpecific("chicken", "Fast foods, chicken tenders"), true);
// The fold must not dissolve a real difference: "egg" vs "egg white" is still
// two different foods, and a double-s word is left alone.
is("plural fold does not soften subtypes", core.isOverlySpecific("egg", "Eggs, Grade A, Large, egg white"), true);
is("grass is not a plural", core.isOverlySpecific("ground beef", "Beef, grass-fed, ground, raw"), true);

// --- implausibly low calorie density ----------------------------------------
// The one bad-data class no word guard can see: the name is accurate, the
// macros reconcile against 4/4/9, every text guard passes, and the published
// numbers are simply about half of reality. All from USDA, not the cache.
const at100 = (name, calories) => ({ name, calories, serving_size: 100, serving_unit: "g" });
is("grilled salmon at 103", core.implausiblyLowForFood(at100("GRILLED SALMON", 103)), true);
is("shredded chicken at 83", core.implausiblyLowForFood(at100("SHREDDED CHICKEN BREAST MEAT", 83)), true);
is("babyfood beef at 81", core.implausiblyLowForFood(at100("Babyfood, meat, beef, junior", 81)), true);
// Case-insensitive on purpose. The first cut was not, and it missed both
// all-caps rows above while catching the lowercase one -- and all-caps is
// exactly the shape these rows come in.
is("lowercase form is caught too", core.implausiblyLowForFood(at100("grilled salmon fillet", 103)), true);

// Every floor sits BELOW the leanest legitimate form. These must all survive.
is("lox is real salmon", core.implausiblyLowForFood(at100("Salmon, smoked (lox)", 117)), false);
is("raw chicken breast survives", core.implausiblyLowForFood(at100("Chicken, broilers, breast, meat only, raw", 120)), false);
is("raw turkey breast survives", core.implausiblyLowForFood(at100("Turkey, breast, meat only, raw", 111)), false);
is("95% lean beef survives", core.implausiblyLowForFood(at100("Beef, ground, 95% lean, raw", 137)), false);
// Diluted and composite foods are exempt -- a low density is honest there, and
// flooring them would be the false rejection this guard exists to avoid.
is("chicken soup is meant to be dilute", core.implausiblyLowForFood(at100("Soup, chicken noodle, canned", 40)), false);
is("broth even more so", core.implausiblyLowForFood(at100("Chicken broth", 7)), false);
is("chicken salad is composite", core.implausiblyLowForFood(at100("Chicken salad", 50)), false);
// Unlisted foods are never floored -- shrimp really is ~71.
is("shrimp is not in the table", core.implausiblyLowForFood(at100("Shrimp, raw", 71)), false);
// Non-gram servings cannot be assessed, same restriction isDryGrainEntry has.
is("oz rows are skipped", core.implausiblyLowForFood({ name: "GRILLED SALMON", calories: 103, serving_size: 4, serving_unit: "oz" }), false);

// Nobody querying beef wants a junior-stage puree.
is("babyfood is a form", core.isOverlySpecific("beef meat", "Babyfood, meat, beef, junior"), true);

// --- composition percentages ------------------------------------------------
// Reported 2026-08-09: lean percentages on ground meat were not being
// recognised. They were destroyed twice -- normalizeQuery stripped them, and
// the tokenizer's length filter would have dropped the bare number anyway.
//
// The cache-key collision is the worse half: "1% milk" and "2% milk" both
// normalised to "% milk" and SHARED ONE ROW, so whichever was looked up first
// fed both.
is("percent survives the cache key", core.normalizeQuery("2% milk"), "2pct milk");
is("and 1% is a different key", core.normalizeQuery("1% milk"), "1pct milk");
is("lean percent survives", core.normalizeQuery("85% lean ground beef"), "85pct lean ground beef");
// A lean RATIO is the same fact written differently -- but only when the parts
// sum to about 100, which is what separates it from a date or a fraction.
is("lean ratio expands", core.normalizeQuery("85/15 ground beef"), "85pct 15pct ground beef");
// A ratio that is not a lean split must NOT become a composition token. (The
// bare numbers are still stripped by the existing standalone-number rule --
// that is pre-existing and not what this asserts.)
is("a non-100 ratio is not a composition", /pct/.test(core.normalizeQuery("beef 3/4")), false);
is("nor is a date-like pair", /pct/.test(core.normalizeQuery("chicken 1/2 breast")), false);

// A stated composition must match a stated composition. Both of these scored
// at or above MIN_SCORE and had multi-segment names, so the comma bypass let
// them through before this.
is("85% must not match 73%", core.isOverlySpecific("85% lean ground beef", "Beef, ground, 73% lean meat / 27% fat, raw"), true);
is("85% matches 85%", core.isOverlySpecific("85% lean ground beef", "Beef, ground, 85% lean meat / 15% fat, raw"), false);
is("the ratio form matches too", core.isOverlySpecific("85/15 ground beef", "Beef, ground, 85% lean meat / 15% fat, raw"), false);
is("2% must not match 1%", core.isOverlySpecific("2% milk", "Milk, lowfat, fluid, 1% milkfat"), true);
// Only when BOTH sides state one -- a plain query is left to the tie-break.
is("a plain query is not blocked", core.isOverlySpecific("ground beef", "Beef, ground, 85% lean meat / 15% fat, raw"), false);
// The pct marker must survive the digit/letter splitter, which is what breaks
// "12oz" into "12 oz" -- without a guard it split "85pct" into "85" and "pct",
// making every percentage the identical token and every comparison a match.
is("count compounds still split", core.isOverlySpecific("chicken nuggets 8piece", "Chicken Nuggets (8ct)"), false);

// --- composition queries must match the HEAD food -------------------------
// Regression from the percentage tokens, caught by the portal 2026-08-11.
// Both scored relevance 1.00 and passed every guard: the composition token
// matched, and "milk" was satisfied by "milkfat" or by the phrase "prepared
// with 2% milk". Four segments, so the >2-segment bypass returned accept
// before the extra-word count could see them.
is("1% milk is not cottage cheese", core.firstSegmentMatches("1% milk", "Cheese, cottage, lowfat, 1% milkfat"), false);
is("2% milk is not egg custard", core.firstSegmentMatches("2% milk", "Egg custards, dry mix, prepared with 2% milk"), false);
// Segment count cannot separate these -- the CORRECT row has four segments too.
is("but real 2% milk still matches", core.firstSegmentMatches("2% milk", "Milk, reduced fat, fluid, 2% milkfat"), true);
is("and real 1% milk does", core.firstSegmentMatches("1% milk", "Milk, lowfat, fluid, 1% milkfat"), true);
is("and lean ground beef does", core.firstSegmentMatches("85% lean ground beef", "Beef, ground, 85% lean meat / 15% fat, raw"), true);
// The bypass still applies when the query states NO composition, which is the
// case it was written for.
is("plain multi-segment query still bypasses", core.firstSegmentMatches("chicken breast", "Chicken, broilers or fryers, breast, meat only, cooked, roasted"), true);
is("a plain milk query is unaffected", core.firstSegmentMatches("milk", "Milk, whole, 3.25% milkfat"), true);

// --- composition tie-break, head food, additions --------------------------
// All from the portal's USDA composition-spread probe, 2026-08-11.
//
// "beef patty" returns 16 variants that ALL score gen=6 -- every one states a
// composition, so the tie fell to USDA's ordering, which lists the fattiest
// first: 70/30 at 277 kcal against 93/7 at 193.
const beefVariants = [
  "Beef, ground, 70% lean meat / 30% fat, patty, cooked",
  "Beef, ground, 80% lean meat / 20% fat, patty, cooked",
  "Beef, ground, 85% lean meat / 15% fat, patty, cooked",
  "Beef, ground, 90% lean meat / 10% fat, patty, cooked",
  "Beef, ground, 95% lean meat / 5% fat, patty, cooked",
];
is("composition tie-break avoids the extreme", core.preferMedianComposition("beef patty", beefVariants), 2);
// The same probe showed ground beef/turkey/pork are FINE, because USDA
// publishes a composition-free row that genericnessRank already ranks clear.
// So this must not fire there -- it is not a general "prefer lean" rule.
is("leaves it alone when a plain row exists",
   core.preferMedianComposition("ground beef", ["Beef, ground, unspecified fat content, cooked", ...beefVariants]), null);
is("respects a stated composition", core.preferMedianComposition("93/7 beef patty", beefVariants), null);
is("reads a stated composition", core.statedCompositionPct("Beef, ground, 85% lean meat / 15% fat"), 85);

// "milk" reached "Cheese, mozzarella, whole milk" -- milk as a MODIFIER of a
// different food -- because firstSegmentMatches exempts >2-segment names.
// A penalty, not a rejection: the cut-of-meat case that exemption exists for
// must still win when it is the only survivor.
is("plain milk outranks mozzarella",
   core.genericnessRank("milk", "Milk, buttermilk, fluid, whole") < core.genericnessRank("milk", "Cheese, mozzarella, whole milk"), true);
is("a bar is a composite", core.isOverlySpecific("milk", "Milk and cereal bar"), true);

// "cottage cheese" resolved to the vegetable variant because "with vegetables"
// is FEWER words than "creamed, large or small curd". Additions are not
// descriptors.
is("plain cottage cheese outranks the vegetable one",
   core.genericnessRank("cottage cheese", "Cheese, cottage, creamed, large or small curd")
   < core.genericnessRank("cottage cheese", "Cheese, cottage, with vegetables"), true);
is("asking for the addition costs nothing",
   core.genericnessRank("cottage cheese with vegetables", "Cheese, cottage, with vegetables") === 0, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
