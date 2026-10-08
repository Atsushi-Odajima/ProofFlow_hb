// Ported from ErrorRelay core (privacy/exif.ts). Pure-byte metadata stripping; browser and Node safe.
/** Pure-byte metadata stripping for JPEG and PNG. Returns a new buffer; never mutates the input. */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME", "pHYs" /* keep pHYs? it's harmless; drop for uniformity */]);
const PNG_KEEP_ALWAYS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "pHYs"]);

export function detectImageType(bytes: Uint8Array): "jpeg" | "png" | "webp" | "gif" | "unknown" {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && PNG_SIG.every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  return "unknown";
}

export interface StripResult {
  bytes: Uint8Array;
  removed: string[];
  supported: boolean;
}

export function stripJpegMetadata(input: Uint8Array): StripResult {
  const removed: string[] = [];
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 4 <= input.length) {
    if (input[i] !== 0xff) break;
    const marker = input[i + 1]!;
    if (marker === 0xda) {
      // Start of scan: copy rest verbatim.
      for (let j = i; j < input.length; j++) out.push(input[j]!);
      return { bytes: Uint8Array.from(out), removed, supported: true };
    }
    if (marker === 0xd9) break;
    const len = (input[i + 2]! << 8) | input[i + 3]!;
    const segEnd = i + 2 + len;
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isCom = marker === 0xfe;
    // Keep APP0 (JFIF) and APP14 (Adobe) so decoders behave; drop APP1 (EXIF/XMP), APP2 (ICC could be kept, but may embed data), others, and COM.
    if ((isApp && marker !== 0xe0 && marker !== 0xee) || isCom) {
      removed.push(isCom ? "COM" : `APP${marker - 0xe0}`);
    } else {
      for (let j = i; j < segEnd; j++) out.push(input[j]!);
    }
    i = segEnd;
  }
  for (let j = i; j < input.length; j++) out.push(input[j]!);
  return { bytes: Uint8Array.from(out), removed, supported: true };
}

export function stripPngMetadata(input: Uint8Array): StripResult {
  const removed: string[] = [];
  const out: number[] = [...PNG_SIG];
  let i = 8;
  while (i + 8 <= input.length) {
    const len = ((input[i]! << 24) | (input[i + 1]! << 16) | (input[i + 2]! << 8) | input[i + 3]!) >>> 0;
    const type = String.fromCharCode(input[i + 4]!, input[i + 5]!, input[i + 6]!, input[i + 7]!);
    const chunkEnd = i + 12 + len;
    if (chunkEnd > input.length) break;
    if (PNG_DROP.has(type) && !PNG_KEEP_ALWAYS.has(type)) {
      removed.push(type);
    } else {
      for (let j = i; j < chunkEnd; j++) out.push(input[j]!);
    }
    i = chunkEnd;
    if (type === "IEND") break;
  }
  return { bytes: Uint8Array.from(out), removed, supported: true };
}

/** Strip metadata when the format is supported; otherwise return the input untouched and supported=false. */
export function stripImageMetadata(input: Uint8Array): StripResult {
  const t = detectImageType(input);
  if (t === "jpeg") return stripJpegMetadata(input);
  if (t === "png") return stripPngMetadata(input);
  return { bytes: input, removed: [], supported: false };
}

/** Best-effort read of EXIF DateTimeOriginal ("YYYY:MM:DD HH:MM:SS") from a JPEG. Returns null when absent. */
export function readJpegExifDateTime(input: Uint8Array): string | null {
  if (detectImageType(input) !== "jpeg") return null;
  const s = latin1(input.subarray(0, Math.min(input.length, 128 * 1024)));
  const m = /(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  return m ? m[0] : null;
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}
