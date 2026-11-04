// Offline OCR for XP screenshots (tesseract.js + bundled English data; nothing is downloaded).
//
// XP's interface text is tiny (8pt Tahoma ≈ 11px tall), so two passes are used:
//   1. the whole screen, greyed and smoothly scaled ×3, read as sparse text
//   2. small text-shaped blobs that pass 1 missed (short button labels like "Yes"/"No",
//      light-on-dark text) are cropped and read one at a time as single lines
// Boxes are reported in the screenshot's own pixels.
import { createRequire } from "node:module";
import path from "node:path";
import { PNG } from "pngjs";

export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface Word extends Box { text: string; conf: number }
export interface Line extends Box { text: string; conf: number; words: Word[] }

const SCALE = 3;          // whole-screen upscaling before OCR
const CROP_SCALE = 4;     // upscaling for single-blob crops
const MIN_CONF = 35;      // ignore words tesseract is very unsure of
const MIN_CROP_CONF = 60; // single crops must be fairly sure
const MAX_CROPS = 120;    // cap on blobs read per screen

type Worker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;

/** Where the English language data lives (works from source, dist/ and an unpacked Electron app). */
function langPath(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("@tesseract.js-data/eng/package.json");
  return path.join(path.dirname(pkg), "4.0.0_best_int").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

const grey = (p: PNG) => {
  const g = new Float32Array(p.width * p.height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (p.data[j] * 299 + p.data[j + 1] * 587 + p.data[j + 2] * 114) / 1000;
  return g;
};

/** Crop (x0,y0)-(x1,y1) of a grey image, scale it smoothly, optionally invert, return a PNG. */
function render(g: Float32Array, W: number, H: number, x0: number, y0: number, x1: number, y1: number, scale: number, invert: boolean): Buffer {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
  const w = (x1 - x0) * scale, h = (y1 - y0) * scale;
  const out = new PNG({ width: w, height: h });
  const at = (x: number, y: number) => g[Math.min(y1 - 1, Math.max(y0, y)) * W + Math.min(x1 - 1, Math.max(x0, x))];
  for (let y = 0; y < h; y++) {
    const fy = y0 + (y + 0.5) / scale - 0.5, ay = Math.floor(fy), dy = fy - ay;
    for (let x = 0; x < w; x++) {
      const fx = x0 + (x + 0.5) / scale - 0.5, ax = Math.floor(fx), dx = fx - ax;
      let v = at(ax, ay) * (1 - dx) * (1 - dy) + at(ax + 1, ay) * dx * (1 - dy) + at(ax, ay + 1) * (1 - dx) * dy + at(ax + 1, ay + 1) * dx * dy;
      if (invert) v = 255 - v;
      const i = (y * w + x) * 4;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
      out.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(out);
}

/**
 * Find small text-shaped blobs: pixels that stand out from their local background, joined
 * horizontally into word-sized boxes. Cheap, and good at the short labels whole-screen OCR skips.
 */
function textBlobs(g: Float32Array, W: number, H: number): Box[] {
  // local background = 15×15 box blur (via an integral image)
  const R = 7, I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += g[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
  const ink = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const xa = Math.max(0, x - R), xb = Math.min(W, x + R + 1), ya = Math.max(0, y - R), yb = Math.min(H, y + R + 1);
    const bg = (I[yb * (W + 1) + xb] - I[ya * (W + 1) + xb] - I[yb * (W + 1) + xa] + I[ya * (W + 1) + xa]) / ((xb - xa) * (yb - ya));
    if (Math.abs(g[y * W + x] - bg) > 45) ink[y * W + x] = 1;
  }
  // join letters into words: grow ink 3px sideways
  const grown = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { let last = -99; for (let x = 0; x < W; x++) { if (ink[y * W + x]) last = x; if (x - last <= 3) grown[y * W + x] = 1; } let next = 1e9; for (let x = W - 1; x >= 0; x--) { if (ink[y * W + x]) next = x; if (next - x <= 3) grown[y * W + x] = 1; } }
  // connected components
  const seen = new Uint8Array(W * H), boxes: Box[] = [], stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!grown[start] || seen[start]) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!, x = p % W, y = (p - x) / W;
      n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [p - 1, p + 1, p - W, p + W]) if (q >= 0 && q < W * H && !seen[q] && grown[q] && Math.abs((q % W) - x) <= 1) { seen[q] = 1; stack.push(q); }
      if (n > 40000) break; // a big picture, not text
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (h >= 6 && h <= 22 && w >= 6 && w <= 420 && w >= h * 0.6) boxes.push({ x0, y0, x1: x1 + 1, y1: y1 + 1 });
  }
  return boxes;
}

export class Ocr {
  private worker: Promise<Worker> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, Line[]>();

  private getWorker(): Promise<Worker> {
    this.worker ??= (async () => {
      const { createWorker, OEM, PSM } = await import("tesseract.js");
      const w = await createWorker("eng", OEM.LSTM_ONLY, { langPath: langPath(), gzip: true, cacheMethod: "none" });
      // sparse text: UI screens are scattered labels, not paragraphs
      await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: "1" });
      return w;
    })();
    return this.worker;
  }

  /** Read every line of text on the screenshot. */
  read(png: Buffer | PNG): Promise<Line[]> {
    // one OCR at a time (tesseract.js workers are single-threaded)
    const job = this.queue.then(() => this.readNow(png));
    this.queue = job.catch(() => {});
    return job;
  }

  private async readNow(input: Buffer | PNG): Promise<Line[]> {
    const src = input instanceof PNG ? input : PNG.sync.read(input);
    const key = hashFrame(src);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const w = await this.getWorker();
    const { PSM } = await import("tesseract.js");
    const W = src.width, H = src.height, g = grey(src);
    const lines: Line[] = [];

    // pass 1: the whole screen as sparse text
    await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    const { data } = await w.recognize(render(g, W, H, 0, 0, W, H, SCALE, false), {}, { blocks: true });
    for (const block of data.blocks ?? []) for (const para of block.paragraphs) for (const ln of para.lines) {
      const words: Word[] = ln.words
        .filter((wd) => wd.confidence >= MIN_CONF && /[a-z0-9]/i.test(wd.text))
        .map((wd) => ({ text: wd.text.trim(), conf: wd.confidence, ...scaleBox(wd.bbox, SCALE) }));
      if (words.length) lines.push(lineOf(words));
    }

    // pass 2: text blobs pass 1 didn't cover, read one by one
    const covered = (b: Box) => lines.some((l) => l.words.some((wd) => overlap(wd, b) > 0.4));
    const blobs = textBlobs(g, W, H).filter((b) => !covered(b)).slice(0, MAX_CROPS);
    if (blobs.length) {
      await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      for (const b of blobs) {
        // dark background (title bar, icon label) → invert so the text is dark on light
        let sum = 0; for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) sum += g[y * W + x];
        const dark = sum / ((b.x1 - b.x0) * (b.y1 - b.y0)) < 128;
        const pad = 3;
        const { data: d } = await w.recognize(render(g, W, H, b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y1 + pad, CROP_SCALE, dark));
        const text = d.text.replace(/\s+/g, " ").trim();
        if (d.confidence < MIN_CROP_CONF || !/[a-z0-9]{1,}/i.test(text) || /^[^a-z0-9]+$/i.test(text)) continue;
        // split the blob into word boxes in proportion to their length
        const parts = text.split(" ").filter(Boolean), total = parts.reduce((n, p) => n + p.length, 0) + parts.length - 1;
        let cx = b.x0;
        const words: Word[] = parts.map((p) => {
          const w0 = cx, w1 = cx + ((b.x1 - b.x0) * p.length) / total;
          cx = w1 + (b.x1 - b.x0) / total;
          return { text: p, conf: d.confidence, x0: Math.round(w0), y0: b.y0, x1: Math.round(w1), y1: b.y1 };
        });
        lines.push(lineOf(words));
      }
    }
    lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    this.cache.set(key, lines);
    if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value!);
    return lines;
  }

  async close() {
    if (this.worker) { (await this.worker).terminate().catch(() => {}); this.worker = null; }
  }
}

const scaleBox = (b: Box, k: number): Box => ({ x0: Math.round(b.x0 / k), y0: Math.round(b.y0 / k), x1: Math.round(b.x1 / k), y1: Math.round(b.y1 / k) });

const lineOf = (words: Word[]): Line => ({
  text: words.map((x) => x.text).join(" "),
  conf: words.reduce((n, x) => n + x.conf, 0) / words.length,
  words,
  x0: Math.min(...words.map((x) => x.x0)), y0: Math.min(...words.map((x) => x.y0)),
  x1: Math.max(...words.map((x) => x.x1)), y1: Math.max(...words.map((x) => x.y1)),
});

function overlap(a: Box, b: Box) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const area = Math.max(1, Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)));
  return (ix * iy) / area;
}

function hashFrame(p: PNG): string {
  let h = 2166136261;
  const d = p.data;
  for (let i = 0; i < d.length; i += 97) { h ^= d[i]; h = Math.imul(h, 16777619); }
  return `${p.width}x${p.height}:${h >>> 0}`;
}

// ---------------------------------------------------------------- finding a label
export interface Match { text: string; box: Box; score: number; how: string }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

/**
 * Find where a label appears. Looks at runs of consecutive words in each line, so "Save as type"
 * or "Turn Off Computer" match as a phrase, and tolerates small OCR slips ("Cancei" for "Cancel").
 */
export function findText(lines: Line[], wanted: string): Match[] {
  const q = norm(wanted);
  if (!q) return [];
  const qw = q.split(" ").length;
  // two-line labels (desktop icons wrap "My / Computer"): also try stacked pairs of lines
  const all: Line[] = [...lines];
  if (qw > 1) for (const a of lines) for (const b of lines) {
    if (a === b || b.y0 < a.y1 - 2 || b.y0 - a.y1 > 8) continue;
    if (Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) > 24) continue;
    all.push({ ...lineOf([...a.words, ...b.words]) });
  }
  const out: Match[] = [];
  for (const line of all) {
    const ws = line.words;
    const whole = norm(line.text);
    for (let i = 0; i < ws.length; i++) {
      for (let n = 1; n <= Math.min(ws.length - i, qw + 1); n++) {
        const span = ws.slice(i, i + n);
        const t = norm(span.map((w) => w.text).join(" "));
        if (!t) continue;
        let score = 0, how = "";
        const d = n === qw ? lev(t, q) : 99;
        if (t === q) { score = 100; how = t === whole ? "exact" : "exact word inside a longer label"; if (t !== whole) score -= 15; }
        else if (q.length >= 4 && d <= (q.length <= 6 ? 1 : 2) && t[0] === q[0]) { score = 80 - d * 10; how = "close (OCR slip)"; }
        else if (q.length >= 3 && (t.startsWith(q + " ") || t.endsWith(" " + q) || t.includes(" " + q + " "))) { score = 55; how = "part of a longer label"; }
        else if (q.length >= 5 && t.replace(/ /g, "").includes(q.replace(/ /g, ""))) { score = 45; how = "inside a longer label"; }
        if (!score) continue;
        // only the words that matched, so the click lands on the label itself
        const box: Box = { x0: Math.min(...span.map((w) => w.x0)), y0: Math.min(...span.map((w) => w.y0)), x1: Math.max(...span.map((w) => w.x1)), y1: Math.max(...span.map((w) => w.y1)) };
        out.push({ text: span.map((w) => w.text).join(" "), box, score: score + Math.min(9, line.conf / 11) - Math.max(0, n - qw) * 3, how });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  const kept: Match[] = [];
  for (const m of out) if (!kept.some((k) => overlap(k.box, m.box) > 0.6)) kept.push(m);
  return kept.sort((a, b) => b.score - a.score || a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
}
