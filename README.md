# foodlog-core

Shared food-logging logic for two apps that keep one nutrition cache between them:

- **health tracker** (`fuel.fitruvian.com`)
- **Fitruvian player portal**

Both apps let someone type what they ate and get calories and macros back. Both look the food up in a shared `nutrition_cache` table (USDA / Open Food Facts / web-searched brand data) before asking Claude. That lookup logic and that prompt used to exist twice, and were hand-copied between the two repos every time either changed — seven separate ports in one week, each an opportunity to transcribe something wrong. This package is the single copy.

## Scope boundary

**This package is about food. Nothing else.**

The two apps share a food log and nothing else. The health tracker has plan generation, phases, weight targets and deep reviews. The portal has athlete programming and lifting. **None of that belongs here, ever.**

The rule: *if a function needs to know who the user is, or anything about their goals or training, it does not go in this package.*

That boundary is enforced by the API shape, not by discipline. The prompt builder's entire input surface is:

```js
buildEstimatePrompt({ description, dbRef })
```

A food description, and one nutrition-cache row. There is no parameter through which a goal, phase, target or training plan could reach it — so app concepts cannot leak in even by accident. Keep it that way. If a change seems to need more context, it belongs in the calling app.

Also out of scope, for different reasons: auth, HTTP routes, Supabase clients, and Claude API calls. Those differ between the apps and would drag dependencies into what is currently a zero-dependency package.

## Install

```bash
npm install github:braden-maxim/foodlog-core
```

Both apps track `main`. Note that npm records the resolved commit in `package-lock.json`, so an app stays pinned until you run `npm update foodlog-core` there — a change reaches production as: push here → `npm update` + commit + deploy in each app.

## Exports

### Matching

| | |
|---|---|
| `normalizeQuery(q)` | Strips weights, units, containers, percentages. The cache key. |
| `relevanceScore(query, name)` | Word-overlap ratio. Compare against `MIN_SCORE` (0.75). |
| `isOverlySpecific(query, name)` | Rejects candidates adding >2 words beyond the query, plus per-food subtype qualifiers. |
| `firstSegmentMatches(query, name)` | For 2-segment USDA names, the pre-comma part must contain a query word. |
| `isDryGrainEntry(row)` / `queryImpliesDry(q)` | Keeps dry-weight grain rows away from cooked-weight queries. |
| `extractSize(text)` / `brandCacheKey(q)` / `brandedSizeMismatch(q, row)` | Size-aware keys so a 20oz and 32oz branded item don't collide. |
| `STOP_WORDS`, `MIN_SCORE`, `GRAIN_PATTERN`, `SIZE_RE`, `SUBTYPE_QUALIFIERS` | Constants the above are built from. |

### Brands

`isBranded(description)`, `BRAND_KEYWORDS` — is this a restaurant or packaged brand that USDA and Open Food Facts won't cover, and therefore worth a web search?

### Prompt

`buildEstimatePrompt({ description, dbRef })` — the full estimation prompt, including the raw→cooked conversion when the matched row is a raw USDA entry.

### Parsing

`extractJSON(text)`, `parseModelJSON(data, label)` — pull the JSON payload out of a Claude response. `parseModelJSON` distinguishes "cut off mid-thinking" (`stop_reason: max_tokens`) from "returned something unparseable", because those need different handling and conflating them silently double-bills.

## Read the comments

Almost every guard here exists because of a specific production bug: `eggs` matching egg whites, `honey` matching Manuka, `strip of bacon` matching a seitan product, a raw USDA row being averaged against a cooked weight. The comments record which bug and why the fix takes the shape it does. They are the main defence against someone tidying a guard back into the bug it was written for.

## Tests

```bash
node test.mjs
```

Covers the specific bugs above. When changing a guard, add the case that made you change it.

## Maintenance sweep

```bash
USDA_API_KEY=xxx node scripts/dish-collision-sweep.mjs
```

Probes plain single-food queries against live USDA and prints the rows a dish
word rejected, filtered to rows that would otherwise have been accepted. It
exists because `tender` was disqualifying in its adjective sense (`TENDER RED
BEANS`, `mock tender steak`) as well as its dish-noun sense, and words like that
are invisible until a real row trips one.

**Read the output, do not act on the count.** Every rejection found so far has
been correct — deli loaves, canned hash, Polish sausage are composite products a
plain query genuinely should not return. Guessing which word is next has already
been wrong once: `loaf` was the obvious suspect and the data cleared it.

`DEMO_KEY` works but 429s after about five queries, which silently truncates the
probe list and makes a negative result look stronger than it is. Use a real key.
