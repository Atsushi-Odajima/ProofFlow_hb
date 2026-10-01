import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface VisualCompareResult { status: 'match' | 'diff' | 'size_mismatch'; diffPixels: number; diffRatio: number; width: number; height: number; diffPng?: Buffer; }

/** Pixel comparison (pixelmatch). Baselines must come from the same browser/viewport/environment to avoid false positives. */
export function compareScreenshots(baseline: Buffer, current: Buffer, opts: { threshold?: number; maxDiffRatio?: number } = {}): VisualCompareResult {
  const a = PNG.sync.read(baseline); const b = PNG.sync.read(current);
  const width = Math.max(a.width, b.width); const height = Math.max(a.height, b.height);
  const pad = (img: PNG) => { if (img.width === width && img.height === height) return img; const out = new PNG({ width, height, fill: true }); PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0); return out; };
  const pa = pad(a); const pb = pad(b);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(pa.data, pb.data, diff.data, width, height, { threshold: opts.threshold ?? 0.2, includeAA: false });
  const sizeMismatch = a.width !== b.width || a.height !== b.height;
  const diffRatio = diffPixels / (width * height) + (sizeMismatch ? Math.abs(a.width * a.height - b.width * b.height) / (width * height) : 0);
  const status = sizeMismatch ? 'size_mismatch' : diffRatio > (opts.maxDiffRatio ?? 0.001) ? 'diff' : 'match';
  return { status, diffPixels, diffRatio, width, height, diffPng: status === 'match' ? undefined : PNG.sync.write(diff) };
}
