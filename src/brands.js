// Brand and restaurant detection. A query
// mentioning one of these has no USDA/OFF coverage (neither database covers
// restaurant menus or these specific alcohol brands), so it's routed to a
// real web-search-backed lookup instead of a blind guess. Single copy on
// purpose: this used to be duplicated verbatim in both files, and letting
// two copies of the same keyword list drift out of sync has caused real
// bugs in this app before.
export const BRAND_KEYWORDS = [
  "mcdonalds","chick fil a","chickfila","chipotle","qdoba","panera","tropical smoothie",
  "wawa","sheetz","bojangles","cook out","cookout","zaxbys","raising canes","canes",
  "dutch bros","starbucks","subway","taco bell","wendys","burger king","popeyes","kfc",
  "dominos","pizza hut","papa johns","five guys","in n out","whataburger","culvers",
  "sonic","dairy queen","jimmy johns","jersey mikes","firehouse subs","panda express",
  "chuys","chilis","applebees","olive garden","texas roadhouse","cracker barrel",
  "waffle house","ihop","dennys","cava","sweetgreen","jamba juice","smoothie king",
  "orange julius","dunkin","tim hortons","costco","sams club","bjs","trader joes",
  "shake shack","moes","del taco","el pollo loco","carls jr","hardees","arbys",
  "long john silvers","captain ds","krystal","white castle","checkers","rallys",
  "boston market","noodles and company","potbelly","jasons deli","mcalisters",
  "zoes kitchen","corner bakery","au bon pain","einstein bros","insomnia cookies",
  "crumbl","great harvest",
  // Common beer/alcohol brands — same reasoning: USDA/OFF have generic
  // "beer, light"-style entries but not brand-specific ones, and these
  // names rarely get typed with a capital letter (the only other branded
  // signal below), so without an explicit keyword they silently fall
  // through to an uncorrected blind guess with no web-search backing at all.
  "miller lite","miller high life","bud light","budweiser","coors light","coors banquet",
  "corona","modelo","heineken","michelob ultra","michelob","blue moon","guinness",
  "yuengling","natural light","natty light","busch light","busch","pabst","pbr",
  "stella artois","dos equis","sam adams","samuel adams","angry orchard",
  "white claw","truly hard seltzer","high noon",
];

export function isBranded(description) {
  // Hyphens become SPACES, they are not stripped. Every multi-word brand in
  // the list above is stored space-separated, so the canonical hyphenated
  // spelling of a brand has to normalize to that same shape. Stripping would
  // give "innout" for "In-N-Out" and still miss; replacing gives "in n out",
  // which matches. (The one-word forms like "chickfila" are separate list
  // entries and keep working either way.)
  //
  // Real bug, found 2026-07-29 while porting this file to the sister app:
  // "Chick-fil-A sandwich" — the brand's actual spelling, and the app's own
  // placeholder text — returned false, while the sloppy "chick fil a
  // sandwich" returned true. Exactly backwards, and it silently denied a
  // web-search correction to the queries most likely to be typed correctly.
  const lower = description
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[-–—_]/g, " ")
    .replace(/\s+/g, " ");
  if (BRAND_KEYWORDS.some((b) => lower.includes(b))) return true;
  const words = description.trim().split(/\s+/);
  return words.slice(1).some((w) => /^[A-Z]/.test(w));
}
