// Prompts for the photo paths, shared so the two apps cannot drift.
//
// These are the highest-risk thing to duplicate: a prompt edit in one app is
// invisible in the other, and the symptom is subtly different numbers rather
// than an error. Every photo prompt lives here.

// ONE call that works out what it is looking at, rather than making the user
// declare it first. The tracker's photo flow used to default to "food on a
// plate" with a toggle for "nutrition label", so someone had to classify
// their own photo before the app would look at it -- and a wrong choice
// silently produced a food estimate of a label.
//
// Returns {kind:"food", items} or {kind:"label", name, servingText,
// perServing}. A label CANNOT become an entry on its own: it states what is
// in one serving, not how much was eaten, so the caller asks for a quantity
// only in that case. Food needs no follow-up at all.
//
// CALLERS MUST DEFAULT TO FOOD when "kind" is missing. A wrong "label" guess
// interrogates someone who photographed their dinner; a wrong "food" guess
// just produces an estimate they can edit. Fail toward the harmless one.
export function buildPhotoPrompt({ note } = {}) {
  return `You are a nutrition estimator looking at a PHOTO. It is ONE of two things, and your first job is to work out which:

A) PREPARED FOOD — a plate, bowl, tray, glass or packet of food as it is about to be eaten.
B) A NUTRITION LABEL — a printed nutrition facts panel on packaging.

If BOTH are visible (a labelled package sitting next to a served plate), treat it as PREPARED FOOD and read the label to inform your estimate.
${note ? `\nUSER CONTEXT: "${note}"\nThis is your most important input — use it to identify the specific restaurant, dish, or product. If it names a restaurant or brand, use that item's actual published nutrition rather than estimating from the photo.\n` : ""}
─────────────────────────────────────────
IF IT IS PREPARED FOOD (A)

SPLITTING — one entry per distinct item (entrée, side, drink = three entries). A single named composite dish is one entry.

PORTIONS — estimate using visual reference points:
- Standard dinner plate ≈ 10 in diameter; bowl ≈ 2 cups; side dish ≈ 1 cup
- Palm ≈ 3 oz protein; fist ≈ 1 cup starch or veg; thumb ≈ 1 tbsp fat
- Restaurant portions run 20–50% larger than home servings
- Do not underestimate — unaided visual estimates run 30–40% low on average

HIDDEN CALORIES — always account for ingredients not visible as separate items:
- Cooking oil or butter in sautéed, stir-fried, or roasted foods (add 1–2 tbsp per serving)
- Dressings, sauces, gravies coating or pooled under food (100–200 kcal per serving)
- Cheese melted into or on top of dishes
- Breading and coatings on proteins
- Butter on bread, vegetables, or pasta

ACCURACY — for any recognizable restaurant item, chain dish, or packaged product (from branding, packaging, or user context), use that item's known nutrition. For everything else, estimate from what's visible using the guidelines above.

Respond with ONLY this JSON — no preamble, no commentary, no markdown fences:
{"kind":"food","items":[{"name":"short name","calories":number,"protein":number,"carbs":number,"fat":number}]}

─────────────────────────────────────────
IF IT IS A NUTRITION LABEL (B)

READ the printed numbers exactly. Do NOT estimate, and do NOT guess how much was eaten — you cannot see that from a label, and the user will be asked separately.

Report the values for ONE serving exactly as the label states them, and quote the label's own serving description verbatim (e.g. "1 cup (55g)", "2 tbsp (32g)", "about 24 chips (28g)").

Respond with ONLY this JSON — no preamble, no commentary, no markdown fences:
{"kind":"label","name":"product name if visible, else the food","servingText":"the label's serving size, verbatim","perServing":{"calories":number,"protein":number,"carbs":number,"fat":number}}

─────────────────────────────────────────
Grams for macros, kcal for calories, whole numbers.`;
}

// Used only when a quantity could not be parsed in code -- "8 meatballs" when
// a serving is 4 needs judgement. Anything unambiguous is scaled by
// parseQuantity/scaleNutrition without a model call at all.
export function buildLabelPrompt({ quantity } = {}) {
  return `You are reading a nutrition facts label in this photo.

STEP 1 — Read the label exactly as printed:
- Product name (from packaging or label header)
- Serving size — both household measure (e.g. "4 meatballs", "1 cup") AND gram/oz weight (e.g. "85g", "3 oz")
- Per-serving values: calories, protein (g), total carbohydrates (g), total fat (g)

STEP 2 — The user is having: "${quantity}"
Convert to number of servings using the serving size you just read:
- "2 servings" → 2
- "8 meatballs" when 1 serving = 4 meatballs → 8 ÷ 4 = 2
- "170g" when 1 serving = 85g → 170 ÷ 85 = 2
- "6 oz" when 1 serving = 3 oz → 6 ÷ 3 = 2
- "0.5 serving" or "half" → 0.5
- If no quantity given, assume 1 serving

STEP 3 — Multiply ALL per-serving values by that number exactly.
Use the label's calorie number directly — do not recalculate from macros.

Respond with ONLY a JSON object — no preamble, no commentary, no markdown fences:
{"items":[{"name":"product name","calories":number,"protein":number,"carbs":number,"fat":number}]}
Grams for macros, kcal for calories, whole numbers.`;
}
