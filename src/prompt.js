// The food-estimation prompt, shared by both apps.
//
// SCOPE BOUNDARY -- read before adding anything here.
// This function takes a food description and (optionally) one nutrition-cache
// row. That is the entire input surface, deliberately: there is no parameter
// through which a goal, target, phase, training plan, or athlete programme
// could reach this prompt, so app-specific concepts cannot leak in even by
// accident. If a change needs to know who the user is or what they are
// training for, it belongs in that app, not here.
//
// dbRef is a nutrition_cache row: { name, calories, protein, carbs, fat,
// serving_size, serving_unit, source }. Pass null when the lookup missed.

import { GRAIN_PATTERN } from "./matching.js";

export function buildEstimatePrompt({ description, dbRef }) {
  // USDA names its meat/fish entries by PREPARATION STATE, and the raw ones
  // win the relevance match for a bare query like "skirt steak" (there is
  // often no cooked entry indexed at all). That collides head-on with the
  // COOKED MEAT WEIGHT rule below, which tells the model to assume a stated
  // weight is cooked: the reference block says "use these exact values and
  // only scale by quantity" while the rule says "use cooked values", and
  // nothing tells the model the reference it was handed is raw.
  //
  // The model resolves the contradiction by splitting the difference, which
  // is the one answer that's wrong under BOTH readings. Real report
  // (2026-07-26): "skirt steak 6 ounces" came back 386 kcal and NAMED ITSELF
  // COOKED -- 227 kcal/100g, when raw is 195 and actually-cooked is ~260.
  // Right answer is ~332 if the 6 oz was weighed raw, ~440 if cooked.
  //
  // So: say the state out loud and give the conversion. Cooked meat loses
  // ~25% of its weight as water, so the same food at cooked weight is
  // proportionally denser -- raw-per-100g / 0.75. That reconstructs USDA's
  // own cooked figures closely (195/0.75 = 260 vs USDA's ~255-270 broiled),
  // which is why it's worth deriving rather than making the model guess.
  const dbName = (dbRef?.name || "").toLowerCase();
  const isRawRef = /\braw\b|\buncooked\b/.test(dbName);
  const isCookedRef = /\bcooked\b|\bbroiled\b|\broasted\b|\bgrilled\b|\bbraised\b|\bpan-?fried\b|\bbaked\b/.test(dbName);

  // A raw GRAIN reference must never get the meat conversion. Meat LOSES
  // ~25% of its weight cooking, so cooked is denser; grains ABSORB water and
  // roughly triple in weight, so cooked is far less dense. Applying the meat
  // maths to dry rice at 365 kcal/100g yields 487 when the real cooked figure
  // is ~130 — worse than giving no guidance at all. Caught 2026-07-31 while
  // checking why "brown rice" looked wrong.
  const isRawGrain = isRawRef && GRAIN_PATTERN.test(dbName);

  const stateNote = isRawGrain
    ? `\n\nSTATE OF THIS REFERENCE — DRY/UNCOOKED GRAIN. These numbers are for the DRY product. Do NOT scale them against a weight the user stated, and do NOT apply any meat-style conversion — grains absorb water and roughly triple in weight when cooked, so dry values are far denser than cooked ones.
- Unless the user explicitly said "dry" or "uncooked", treat their stated weight as COOKED and use the COOKED GRAINS & LEGUMES anchors below instead of this reference.
- Only use the numbers above if the user actually specified a dry/uncooked weight.`
    : isRawRef
    ? `\n\nSTATE OF THIS REFERENCE — RAW. These numbers are per 100g of RAW weight. Do not scale them directly against a weight the user gave for cooked food.
- If the user weighed the food RAW (they said "raw", or described it before cooking): apply the values above to their stated weight directly.
- Otherwise assume the stated weight is COOKED (per the COOKED MEAT WEIGHT rule below). Cooked meat has lost ~25% of its weight as water, so convert first: cooked per-100g = (raw per-100g ÷ 0.75). Apply THAT to their stated weight. Do the same for protein and fat.
- Say which reading you used in "name" (e.g. "Skirt steak, cooked, 6 oz").
Worked example: reference 195 kcal/100g raw, user says "6 ounces" (170g, assumed cooked) → 195 ÷ 0.75 = 260 kcal/100g cooked → 260 × 1.70 = 442 kcal. NOT 195 × 1.70 = 332, and never a number in between.`
    : isCookedRef
      ? `\n\nSTATE OF THIS REFERENCE — COOKED. These numbers are per 100g of COOKED weight. Apply them directly to the user's stated weight unless they explicitly said the weight was raw.`
      : "";

  // "Per serving (3serving)" IS NOT A UNIT, IT IS AN AMBIGUITY. A weight or
  // volume basis reads fine -- "Per serving (100g)" can only mean one thing --
  // but a COUNT basis renders as "Per serving (3serving): 1200 kcal", which
  // says per-serving and then names three of them. The values are the TOTAL
  // for all 3, so the natural misreading multiplies an already-complete figure
  // by the count again.
  //
  // Not hypothetical: ~40% of the curated rows use serving_unit "serving", and
  // the convention is consistent across every one checked 2026-08-14 --
  // Hideaway Pizza 1200/3 slices, Texas Roadhouse rolls 390/3, dumplings
  // 207/5, Waffle House bacon 90/3 strips, Sara Lee bread 90/2 slices. Each is
  // the combined value, and each renders as if it were per-one.
  //
  // So say TOTAL out loud and give the per-unit figure, rather than leaving
  // the model to infer which reading was meant.
  // DECIDED BY UNIT SHAPE, NOT BY A LIST OF COUNT WORDS. The first version of
  // this checked for the literal unit "serving", which covers today's rows and
  // nothing else: a curated row saying 3 strips, 2 slices, 5 dumplings or 4
  // cookies renders "Per serving (3strips)" and reintroduces the whole bug.
  // Listing the count words instead is the failure the word lists in
  // matching.js kept hitting -- the list is only ever as complete as the last
  // person to remember it. (Portal's suggestion, 2026-08-14.)
  //
  // So invert it: MEASURES are a closed, genuinely finite set -- mass and
  // volume. Anything else with a number in front of it is a count of things.
  //
  // The trap in inverting it is VOLUME. cup/tbsp/tsp are not weights, but they
  // are not counts either, and "brussels sprouts, cooked" is cached at 0.5 cup
  // today. Treating those as counts would drop the measure from the line and
  // tell the model 0.5 cup of sprouts is "one serving as named".
  const MEASURE_UNITS = new Set([
    "g", "gram", "grams", "kg", "kilogram", "kilograms", "mg",
    "oz", "ounce", "ounces", "floz", "fl oz", "lb", "lbs", "pound", "pounds",
    "ml", "milliliter", "milliliters", "l", "liter", "liters", "litre", "litres",
    "cup", "cups", "tbsp", "tablespoon", "tablespoons", "tsp", "teaspoon", "teaspoons",
    "pint", "pints", "quart", "quarts", "gallon", "gallons",
  ]);
  const svSize = Number(dbRef?.serving_size);
  const svUnit = String(dbRef?.serving_unit || "").toLowerCase().trim();
  const isCountBasis = Number.isFinite(svSize) && svUnit !== "" && !MEASURE_UNITS.has(svUnit);
  // "3 serving" reads as a typo and undercuts the sentence doing the work.
  const plural = svSize > 1 && !svUnit.endsWith("s") ? `${svUnit}s` : svUnit;
  const basisLine = !dbRef
    ? ""
    : isCountBasis && svSize > 1
      ? `TOTAL for all ${svSize} ${plural} (NOT per one — divide by ${svSize} for a single ${svUnit}): `
      : isCountBasis
        ? `For one ${svUnit} of the item as named: `
        : `Per serving (${dbRef.serving_size}${dbRef.serving_unit}): `;

  const dbRefBlock = dbRef
    ? `DATABASE REFERENCE — from ${dbRef.source === "usda" ? "USDA FoodData Central" : dbRef.source === "claude_web_search" ? "a live web search of the brand's published nutrition" : "Open Food Facts"} (authoritative). Use these exact values and only scale by quantity${isRawRef ? ", after the raw→cooked conversion described below" : ""}.\nItem: ${dbRef.name}\n${basisLine}${dbRef.calories} kcal · ${dbRef.protein}g protein · ${dbRef.carbs}g carbs · ${dbRef.fat}g fat${stateNote}\n\n`
    : "";

  const prompt = `You are a nutrition estimator. The user describes what they ate conversationally, often by voice, so expect informal language, filler words, phonetic spellings, and spoken numbers.
${dbRefBlock ? `\n${dbRefBlock}` : ""}
VOICE & TEXT CLEANUP — before interpreting, strip filler words and artifacts: ignore "um", "uh", "like", "just", "so", "I think", "I had", "maybe", "probably", "some", "a little bit of". Convert spoken numbers and fractions to decimals: "two eggs" = 2 eggs, "a couple slices" = 2 slices, "a few pieces" = 3, "half a cup" = 0.5 cup, "X and a half" = X.5 (e.g. "10 and a half ounces" = 10.5 oz), "X and a quarter" = X.25, "X and three quarters" = X.75. Always use decimals in item names, never fractions (10.5 oz not 10 1/2 oz).

SPLITTING — return one entry per distinct food. Treat commas, slashes, "and", "with", "plus", "+", "&", and line breaks as separators. A restaurant entrée and a side/snack are SEPARATE entries.
Example: "tropical smoothie chipotle chicken flatbread with mrs. vickies salt and vinegar chips" → TWO entries: (1) Tropical Smoothie Cafe Chipotle Chicken Flatbread, (2) Miss Vickie's Salt & Vinegar Chips.
A single named composite dish (e.g. "Cava chicken and rice bowl") is ONE entry unless the user lists its components.

RECOGNITION — interpret brand and restaurant names generously even when misspelled, abbreviated, or phonetic:
"chick fil a" / "chickfila" = Chick-fil-A | "mcdonald's" / "mcdonalds" / "micky d's" = McDonald's | "chipolte" / "chipoltay" = Chipotle | "qdoba" / "kadoba" = Qdoba | "panara" / "panera bread" = Panera Bread | "tropical smoothie" = Tropical Smoothie Cafe | "mrs vickies" / "mrs vickys" = Miss Vickie's | "wawa" = Wawa | "sheetz" = Sheetz | "bojangles" / "bojangos" = Bojangles | "cookout" = Cook Out | "zaxbys" = Zaxby's | "canes" / "raising canes" = Raising Cane's | "dutch bros" = Dutch Bros — and apply the same generous logic to any other brand.

MODIFICATIONS — apply each modifier precisely to that ingredient only:
- "no" / "without" / "hold the" / "remove": exclude that ingredient entirely (zero contribution).
- "extra" / "double" / "add" / "added": approximately 1.5–2× the typical amount of that ingredient.
- "light" / "easy on the" / "a little": approximately half the typical amount.
- "on the side": include at roughly half the typical amount (people use less when it's separate).
- Size words apply to the whole item — look up that exact size: "small" / "medium" / "large" for fast food; "tall" / "grande" / "venti" / "trenta" for Starbucks.

COOKING QUALIFIERS — these change the fat content meaningfully:
- "fat drained" / "drained" / "grease drained": use USDA values for pan-broiled, drained ground meat — fat is reduced ~30–40% vs undrained. This is the standard for cooked ground beef logged with a weight.
- "rinsed" (e.g. rinsed ground beef): fat reduced ~50% vs undrained — a more aggressive fat removal.
- "dry cooked" / "no oil" / "no butter" / "air fried" / "grilled": no added fat beyond what's in the food itself.
- "cooked in oil" / "sautéed" / "pan fried with butter/oil": add ~5–15g fat depending on stated amount; if no amount given, add ~10g fat for a typical pan.
- "baked" / "roasted" / "broiled" / "steamed" / "boiled": no added fat unless specified.

ACCURACY — CRITICAL: do not reconstruct macros from ingredients for any named brand or chain item. Use the actual published nutrition label from your training knowledge.
- Chain restaurants and fast food (Chipotle, Chick-fil-A, McDonald's, Panera, Starbucks, Tropical Smoothie, Wawa, Sheetz, Cook Out, Raising Cane's, Bojangles, Zaxby's, Dutch Bros, Subway, etc.): use the exact published menu nutrition for that item and size. Do not estimate from ingredients.
- Warehouse / retail stores (Costco Food Court, Sam's Club, BJ's, Trader Joe's, etc.): these items have specific published label values — use them. Common example: Costco Food Court Cheese Pizza = 700 kcal, 44g protein, 70g carbs, 28g fat per slice (1/8 of 18" pizza). Do not reconstruct warehouse items from scratch.
- Packaged branded products (chips, bars, frozen meals, yogurt, etc.): use the labeled value for the stated serving size.
- For generic whole foods (eggs, chicken breast, rice, vegetables, fruits, plain grains): estimate from USDA values.
- VERIFY (generic foods only): calories should equal protein×4 + carbs×4 + fat×9 within ~5%. Do NOT apply this check to branded/chain products — their published calorie is always correct.
- When no quantity is given: restaurant items at standard menu size; generic items at a typical single serving (2 eggs, 1 cup oatmeal, 1 medium fruit, 12 oz coffee). For raw meat with a stated weight, calculate from that exact weight.
- COOKED MEAT WEIGHT: when the user gives a weight for cooked meat (chicken breast, ground beef, steak, turkey, etc.), use USDA cooked values — do NOT use raw values. Cooked meat loses 25–35% water and some fat, so cooked weights are significantly more calorie- and protein-dense per gram than raw. If the user does not specify cooked or raw, DEFAULT TO COOKED — people log what was on the plate. Only treat a weight as raw when they say so ("raw", "before cooking", "uncooked").
  USDA cooked meat anchors per 100g — use these as your baseline:
  · Chicken breast (grilled/baked, no skin): 165 kcal · 31g protein · 0g carbs · 3.6g fat
  · Ground beef 85/15 (pan-cooked, fat drained): 232 kcal · 25g protein · 0g carbs · 14g fat
  · Ground beef 90/10 (pan-cooked, fat drained): 196 kcal · 26g protein · 0g carbs · 10g fat
  · Beef top sirloin steak (broiled): 219 kcal · 29g protein · 0g carbs · 10.5g fat
  · Beef ribeye (broiled): 291 kcal · 24g protein · 0g carbs · 21g fat
  · Pork tenderloin (roasted): 166 kcal · 26g protein · 0g carbs · 6g fat
  · Salmon (baked): 206 kcal · 20g protein · 0g carbs · 13g fat
  · Shrimp (cooked): 99 kcal · 24g protein · 0g carbs · 0.3g fat
  · Turkey breast (roasted, no skin): 135 kcal · 30g protein · 0g carbs · 1g fat
- COOKED GRAINS & LEGUMES WEIGHT: when the user gives a weight for rice, pasta, oats, quinoa, beans, lentils, chickpeas, or other grains/legumes, assume COOKED unless they explicitly say "dry" or "uncooked". Never use dry/uncooked values for a weight the user stated unless they specified dry. Cooked anchors per 100g: rice ≈ 130 kcal · 2.5g protein · 28g carbs · 0.2g fat. Pasta ≈ 158 kcal · 6g protein · 31g carbs · 1g fat. Oats ≈ 71 kcal · 2.5g protein · 12g carbs · 1.5g fat. Black beans ≈ 132 kcal · 8.9g protein · 24g carbs · 0.5g fat. Chickpeas ≈ 164 kcal · 8.9g protein · 27g carbs · 2.6g fat. Lentils ≈ 116 kcal · 9g protein · 20g carbs · 0.4g fat. Kidney beans ≈ 127 kcal · 8.7g protein · 23g carbs · 0.5g fat. Pinto beans ≈ 143 kcal · 9g protein · 26g carbs · 0.6g fat.

SERVING MATH — for packaged or portioned foods, always do explicit math:
1. Find the product's labeled serving size (e.g. "1 serving = 4 meatballs = 180 kcal, 15g protein, 7g carbs, 10g fat")
2. Determine the number of servings from whatever the user stated:
   - "2 servings" → 2 × per-serving values
   - "8 meatballs" when 1 serving = 4 meatballs → 8 ÷ 4 = 2 servings → 2 × per-serving values
   - "1.5 cups" when 1 serving = 0.5 cup → 3 servings → 3 × per-serving values
3. Multiply ALL macros by that number exactly — never re-estimate the total from scratch.

Respond with ONLY a JSON object — no preamble, no commentary, no citations, no markdown fences:
{"items":[{"name":"short name","calories":number,"protein":number,"carbs":number,"fat":number}]}
Grams for macros, kcal for calories, whole numbers.

Food: "${description}"`;

  return prompt;
}
