// Response parsing shared by both apps' food-logging paths.

// Extract the first JSON object OR array from a model response, tolerating
// markdown fences and prose. Array support matters: prompts that ask for a
// bare array (e.g. meal categorization) would otherwise fail to parse.
export function extractJSON(text) {
  const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const match = clean.match(/[\[{][\s\S]*[\]}]/);
  return JSON.parse(match ? match[0] : clean);
}

// Pull the JSON payload out of a Claude response, distinguishing "the model
// wrote something we couldn't parse" from "the model never got to the JSON".
//
// The second case is the one that kept biting us. ESTIMATION_MODEL is
// claude-sonnet-5, which runs ADAPTIVE THINKING BY DEFAULT when the request
// sends no `thinking` field -- and max_tokens is a hard cap on thinking PLUS
// visible text, with thinking spent first. So a tight max_tokens doesn't
// produce a short answer, it produces NO answer: the budget is gone before
// the model emits a single text token, `text` comes back empty, and
// extractJSON throws a bare SyntaxError that says nothing about why.
//
// Real report (2026-07-26): "skirt steak 6 ounces" errored on every retry.
// The DB reference for it is a RAW cut (195 kcal/100g) while the prompt's
// COOKED MEAT WEIGHT rule says to assume cooked and gives cooked anchors --
// resolving that conflict is exactly the kind of reasoning that runs long,
// so thinking ate the whole 512-token budget. Ordinary items think briefly
// and fit, which is why this looked food-specific rather than systemic.
// Same failure mode as the searchBrandedNutrition max_tokens note below;
// this is the shared guard so the next instance is self-diagnosing.
export function parseModelJSON(data, label) {
  const text = (data.content || []).map((i) => i.type === "text" ? i.text : "").join("");
  if (!text.trim()) {
    console.error(`${label}: model returned no text`, { stopReason: data.stop_reason, usage: data.usage });
    throw new Error(data.stop_reason === "max_tokens" ? "truncated" : "empty");
  }
  try {
    return extractJSON(text);
  } catch (e) {
    console.error(`${label}: failed to parse response`, { stopReason: data.stop_reason, textPreview: text.slice(0, 300) });
    throw new Error(data.stop_reason === "max_tokens" ? "truncated" : "unparseable");
  }
}
