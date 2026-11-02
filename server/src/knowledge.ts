// How-to guides the agents can look up (currently: the Windows XP field guide).
// A guide is a markdown file split into topics by "## id: Title" headings.
// The bundled copy lives in server/knowledge/; a copy in <data folder>/knowledge/ overrides it,
// so users can extend the guide without touching the app.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface Topic { id: string; title: string; body: string }

export class Guide {
  private cache: { mtime: number; file: string; topics: Topic[] } | null = null;

  constructor(private candidates: string[]) {}

  private load(): Topic[] {
    const file = this.candidates.find((f) => existsSync(f));
    if (!file) return [];
    const mtime = statSync(file).mtimeMs;
    if (this.cache && this.cache.file === file && this.cache.mtime === mtime) return this.cache.topics; // reload when edited
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const topics: Topic[] = [];
    const re = /^## ([a-z0-9-]+):\s*(.+)$/gm;
    const marks = [...text.matchAll(re)];
    marks.forEach((m, i) => {
      const start = m.index! + m[0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index! : text.length;
      topics.push({ id: m[1], title: m[2].trim(), body: text.slice(start, end).trim() });
    });
    this.cache = { mtime, file, topics };
    return topics;
  }

  topics() { return this.load().map(({ id, title }) => ({ id, title })); }

  /** Look up a topic by id, or by words in its title/body if the id doesn't match. */
  lookup(query: string): Topic[] {
    const all = this.load();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const exact = all.find((t) => t.id === q);
    if (exact) return [exact];
    const STOP = new Set(["how", "the", "and", "for", "with", "can", "what", "does", "this", "that", "into", "from", "you", "your", "use", "using", "get", "make", "want", "need", "xp", "windows"]);
    const words = q.split(/[^a-z0-9.]+/).filter((w) => w.length > 2 && !STOP.has(w));
    // rarer words count for more (a word in every topic tells us nothing)
    const docs = all.map((t) => ({ t, id: t.id, title: t.title.toLowerCase(), hay: `${t.id} ${t.title} ${t.body}`.toLowerCase() }));
    const idf = (w: string) => Math.log((docs.length + 1) / (1 + docs.filter((d) => d.hay.includes(w)).length)) + 0.1;
    const scored = docs
      .map((d) => ({
        t: d.t,
        score: words.reduce((n, w) => {
          if (!d.hay.includes(w)) return n;
          const inTitle = d.id.includes(w) || d.title.includes(w);
          const hits = d.hay.split(w).length - 1;
          return n + idf(w) * ((inTitle ? 3 : 0) + Math.min(3, hits));
        }, 0),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 2).map((x) => x.t);
  }
}

export function xpGuide(projectRoot: string, dataDir: string) {
  return new Guide([path.join(dataDir, "knowledge", "xp-guide.md"), path.join(projectRoot, "server", "knowledge", "xp-guide.md")]);
}
