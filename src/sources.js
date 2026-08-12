// Barcode source lookups. Both apps query the same two databases with the
// same normalisation, so this lives here rather than being written twice --
// the shape of a returned row has to match exactly or the shared cache ends
// up with two dialects of the same product.

import {
  energyKcal, relevanceScore, genericnessRank, firstSegmentMatches, isOverlySpecific,
  isDryGrainEntry, queryImpliesDry, preferMedianComposition, preferMedianValue, MIN_SCORE,
} from "./matching.js";

// USDA nutrient IDs. These were left behind in the health tracker when
// buildUsdaResult moved here, and their absence threw a ReferenceError on
// EVERY call -- which the caller's try/catch swallowed, so USDA lookups
// silently fell through to Open Food Facts instead of failing loudly.
// Energy deliberately isn't here: it goes through energyKcal(), which reads
// the unit rather than trusting an id (see the kJ-as-kcal bug).
const N_PROTEIN = 1003, N_CARBS = 1005, N_FAT = 1004;

export function getNutrient(nutrients, id) {
  const n = nutrients.find((x) => x.nutrientId === id || x.nutrientNumber === String(id));
  return n ? n.value : null;
}

/* CANDIDATE SELECTION — the single implementation for both apps.
 *
 * This lived as a private `bestMatch` in each app's api/nutrition-lookup.js.
 * They did not drift from a common ancestor; they were two different
 * algorithms (the portal's never called buildUsdaResult at all), and the same
 * class of bug had to be found and fixed twice — the per-candidate dry-grain
 * filter and the null-energy filter both landed in one app only, and the gap
 * was visible solely by measuring output.
 *
 * THE RULE THIS ENCODES, learned four separate times: a guard must reject a
 * CANDIDATE, never the WINNER. Disqualifying the winner throws away every
 * usable row behind it and turns a good pool into no answer at all.
 *
 * Ordering is deliberate and load-bearing:
 *   relevance      - does the row contain what was asked for
 *   first segment  - is it the same head food
 *   overly-specific- is it a narrower/other food than was asked for
 *   energy present - a row with no kcal can never answer
 *   dry grain      - raw grain must not answer a cooked query
 *   sort           - relevance, then genericness, then USDA's own order
 *   tie-break      - composition, else calories, among rows tied on BOTH
 */
export function selectBestFood(foods, query) {
  const scored = (foods || [])
    .map((food, i) => ({ food, i, score: relevanceScore(query, food.description), rank: genericnessRank(query, food.description) }))
    .filter(({ score }) => score >= MIN_SCORE)
    .filter(({ food }) => firstSegmentMatches(query, food.description))
    .filter(({ food }) => !isOverlySpecific(query, food.description))
    .filter(({ food }) => energyKcal(food.foodNutrients))
    .filter(({ food }) => queryImpliesDry(query) || !isDryGrainEntry({
      name: food.description,
      calories: energyKcal(food.foodNutrients),
      fat: getNutrient(food.foodNutrients, 1004) ?? 0,
      serving_size: 100,
      serving_unit: "g",
    }))
    // The index keeps the sort stable, so USDA's own order still decides when
    // nothing else distinguishes two rows.
    .sort((a, b) => b.score - a.score || a.rank - b.rank || a.i - b.i);
  if (!scored.length) return null;

  // Only consulted among rows already tied on BOTH score and rank. Composition
  // first when they differ by grade; calories otherwise, that being the only
  // numeric axis a set of varieties shares. `??` not `||`: index 0 is valid.
  const top = scored[0];
  const tied = scored.filter((x) => x.score === top.score && x.rank === top.rank);
  const pick = preferMedianComposition(query, tied.map((x) => x.food.description))
    ?? preferMedianValue(tied.map((x) => energyKcal(x.food.foodNutrients)));
  return (pick != null ? tied[pick].food : top.food) || null;
}

export function buildUsdaResult(food, query) {
  const nutrients = food.foodNutrients || [];
  // energyKcal reads unitName rather than trusting whichever energy entry
  // USDA listed first -- taking the first match is what stored a kilojoule
  // value as kilocalories and put 1580 kcal on brown rice.
  const per100Cal = energyKcal(nutrients);
  if (!per100Cal) return null;
  const per100P = getNutrient(nutrients, N_PROTEIN) || 0;
  const per100C = getNutrient(nutrients, N_CARBS) || 0;
  const per100F = getNutrient(nutrients, N_FAT) || 0;
  const servingSize = food.servingSize || 100;
  const servingUnit = food.servingUnit || "g";
  const f = servingSize / 100;
  return {
    name: food.description,
    calories: Math.round(per100Cal * f),
    protein: Math.round(per100P * f * 10) / 10,
    carbs: Math.round(per100C * f * 10) / 10,
    fat: Math.round(per100F * f * 10) / 10,
    serving_size: servingSize,
    serving_unit: servingUnit,
    source: "usda",
    source_id: String(food.fdcId),
  };
}

export async function lookupBarcodeOFF(code) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,nutriments,serving_quantity,code`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;

  const p = data.product;
  const n = p.nutriments || {};
  const per100Cal = n["energy-kcal_100g"];
  if (!per100Cal || per100Cal <= 0) return null;

  // serving_size comes back as free text ("about 24 chips (28 g) (28 g)"),
  // so use the numeric serving_quantity -- the same field searchOFF relies
  // on. Falls back to per-100g when a product declares no serving.
  const servingQty = parseFloat(p.serving_quantity) || 100;
  const f = servingQty / 100;
  const brand = (p.brands || "").split(",")[0].trim();
  const title = [brand, p.product_name].filter(Boolean).join(" ").trim();

  return {
    name: title || `Barcode ${code}`,
    calories: Math.round(per100Cal * f),
    protein: Math.round((n["proteins_100g"] || 0) * f * 10) / 10,
    carbs: Math.round((n["carbohydrates_100g"] || 0) * f * 10) / 10,
    fat: Math.round((n["fat_100g"] || 0) * f * 10) / 10,
    serving_size: servingQty,
    serving_unit: "g",
    source: "off_barcode",
    source_id: p.code || code,
  };
}

// Open Food Facts is strongest in Europe and patchier for US store brands,
// so USDA Branded (which carries gtinUpc) is the second source.
export async function lookupBarcodeUSDA(code, apiKey) {
  if (!apiKey) return null;
  // The leading zero we add to normalise UPC-A is not how USDA stores it,
  // so try both forms.
  const candidates = code.startsWith("0") ? [code.slice(1), code] : [code];
  for (const c of candidates) {
    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${apiKey}&dataType=Branded&pageSize=5&query=${encodeURIComponent(c)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res || !res.ok) continue;
    const data = await res.json();
    // Compare with leading zeros stripped, since USDA and the scanner
    // disagree about them -- but never on an empty string. A blank gtinUpc
    // and an all-zero scan both reduce to "", which matched arbitrary
    // records and returned the wrong product entirely (found live).
    const want = c.replace(/^0+/, "");
    const hit = !want ? null : (data.foods || []).find((f) => {
      const got = String(f.gtinUpc || "").replace(/^0+/, "");
      return got && got === want;
    });
    if (!hit) continue;
    const built = buildUsdaResult(hit, hit.description || "");
    if (built) return { ...built, source: "usda_barcode", source_id: String(hit.fdcId) };
  }
  return null;
}
