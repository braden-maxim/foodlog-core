// Look for word-sense collisions in DISH_QUALIFIERS against real USDA data.
//
// WHY THIS EXISTS: "tender" was disqualifying in its adjective sense ("TENDER
// RED BEANS", "mock tender steak") as well as its dish-noun sense ("chicken
// tenders"). Words like that are invisible until a real row trips one, and
// guessing which word is next has already been wrong once -- "loaf" was the
// obvious suspect and the data says it is doing its job.
//
// So: probe plain single-food queries, keep candidates that clear the relevance
// floor, and print the ones a dish word rejected. Then READ THEM. Every
// rejection so far has been correct; the sweep is for finding the one that
// is not.
//
//   USDA_API_KEY=xxx node scripts/dish-collision-sweep.mjs
//
// DEMO_KEY works but 429s after about five queries, which is what stopped the
// portal's first pass -- half the probe list never ran. A real key is free and
// makes the whole list a single cheap run.

import { relevanceScore, firstSegmentMatches, isOverlySpecific, MIN_SCORE, DISH_QUALIFIERS } from "../src/index.js";

const KEY = process.env.USDA_API_KEY || "DEMO_KEY";

// Plain, unqualified foods -- the queries most likely to expose a dish word
// firing on a descriptor. Anything that already names a dish is pointless here.
const PROBES = [
  "bread", "whole wheat bread", "cheese", "beef", "pork", "chicken", "turkey",
  "ham", "tuna", "salmon", "rice", "milk", "yogurt", "potato", "beans",
  "oats", "pasta", "egg", "butter", "apple", "steak", "shrimp", "cod",
];

const dishWordsIn = (name) => {
  const words = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  return [...new Set(words.filter((w) => DISH_QUALIFIERS.includes(w)))];
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rejections = 0;
for (const q of PROBES) {
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${KEY}`
    + `&pageSize=25&query=${encodeURIComponent(q)}&dataType=Foundation,SR+Legacy`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`\n!! ${q}: USDA returned ${res.status}`
      + (res.status === 429 ? " -- rate limited. Set a real USDA_API_KEY; DEMO_KEY caps at ~5 queries." : ""));
    if (res.status === 429) break;
    continue;
  }
  const { foods = [] } = await res.json();

  const hits = foods
    .map((f) => f.description)
    // Only rows that would otherwise have been accepted -- a row failing
    // relevance or the first-segment check was never a candidate, so a dish
    // word rejecting it proves nothing.
    .filter((n) => relevanceScore(q, n) >= MIN_SCORE && firstSegmentMatches(q, n))
    .filter((n) => isOverlySpecific(q, n))
    .map((n) => ({ n, dish: dishWordsIn(n) }))
    .filter((x) => x.dish.length);

  if (hits.length) {
    console.log(`\n${q}`);
    for (const { n, dish } of hits) console.log(`  [${dish.join(",")}] ${n}`);
    rejections += hits.length;
  }
  await sleep(250);
}

console.log(`\n${rejections} dish-word rejections to review.`);
console.log("Each one is a judgement call: is that word naming the FOOD, or describing it?");
console.log("Composite processed products (deli loaf, canned hash, Polish sausage) are correct rejections.");
