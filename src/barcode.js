// Barcode handling for scanned packaged products.
//
// A barcode is an EXACT identifier, which makes this the one lookup path with
// no relevance scoring, no tie-breaking and no guessing. None of the matching
// guards apply — either the code resolves to a product or it doesn't.

// One product must produce ONE cache key however it was scanned. UPC-A (12
// digits, the US format) is the same GTIN as EAN-13 (13 digits) with a
// leading zero, and a scanner may report either. Padding here means a US
// product scanned in both formats hits the same cached row instead of
// creating two.
export function normalizeBarcode(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 12) return "0" + digits;
  return digits;
}

// Check-digit validation, so a misread is rejected before it costs a network
// round trip. Camera decodes of a blurred or partially-occluded barcode do
// return plausible-looking wrong digits; the check digit catches most of them.
//
// It is not a guarantee, and the limit is worth knowing: an EAN check digit
// catches every single-digit error, but NOT every transposition -- swapping
// adjacent digits that differ by 5 passes, because the weights 1 and 3 differ
// by 2 and 2x5 is a multiple of 10. A misread that survives this will simply
// fail to resolve to a product, which is the acceptable outcome.
export function isValidBarcode(raw) {
  const code = normalizeBarcode(raw);
  if (code.length !== 13 && code.length !== 8) return false;
  if (!/^\d+$/.test(code)) return false;

  const digits = code.split("").map(Number);
  const check = digits.pop();
  // Weights alternate 1,3 from the left for EAN-13 and 3,1 for EAN-8.
  const startsWithThree = code.length === 8;
  const sum = digits.reduce(
    (acc, d, i) => acc + d * ((i % 2 === 0) === startsWithThree ? 3 : 1),
    0
  );
  return (10 - (sum % 10)) % 10 === check;
}

// Cache key. Prefixed so it can never collide with a normalised food query,
// and stored in the existing `query` column so the shared table needs no
// migration — see BARCODE-SCOPE.md for why that beat adding a column.
export function barcodeCacheKey(raw) {
  return "upc:" + normalizeBarcode(raw);
}
