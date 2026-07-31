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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
