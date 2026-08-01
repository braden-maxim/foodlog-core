// Decode a barcode from a still photo. Browser-only -- the server never
// calls this, and the heavy import below stays lazy so importing anything
// else from this package costs nothing.
//
// WHY A STILL PHOTO AND NOT A LIVE SCANNER
// A streaming scanner needs getUserMedia, a video element, a decode loop and
// torch/permission handling -- several times the work -- and the fast path for
// it, the native BarcodeDetector API, is not reliably available on iOS Safari,
// which is the primary platform here. Decoding one captured image works
// identically everywhere and reuses the camera input the photo flow already
// has. A live scanner is a worthwhile later addition, not the thing to build
// first.
//
// WHY THE IMPORT IS DYNAMIC
// The decoder is a few hundred KB and is only needed once someone takes a
// photo. The main bundle is already large; this must never be part of the
// initial load. The import below is awaited inside the function on purpose --
// moving it to the top of the file would undo that.

let readerPromise = null;

async function getReader() {
  if (!readerPromise) {
    readerPromise = (async () => {
      const { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } = await import("@zxing/library");
      // Restrict to the retail formats actually found on food packaging.
      // Leaving every format enabled makes decoding slower and raises the
      // chance of a spurious read off background clutter.
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
      ]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      return new BrowserMultiFormatReader(hints);
    })();
  }
  return readerPromise;
}

/**
 * Look for a barcode in an image File.
 *
 * Returns the raw decoded string, or null when there isn't one. A miss is the
 * normal case -- most photos are food -- so this must be cheap and silent
 * rather than throwing. The caller treats null as "carry on to the vision
 * call", so an exception here would break ordinary food logging.
 */
export async function scanBarcodeFromFile(file) {
  let url;
  try {
    const reader = await getReader();
    url = URL.createObjectURL(file);
    const result = await reader.decodeFromImageUrl(url);
    return result?.getText?.() || null;
  } catch {
    // zxing throws NotFoundException when no barcode is present, which is the
    // expected outcome for a plate of food.
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
