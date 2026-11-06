// Long-term memory: one small markdown notes file per buddy, kept between sessions.
// The whole file is put in the buddy's system prompt each turn; the buddy edits it with tools.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { safeSegment } from "./agents.js";

export const MEMORY_LIMIT = 6000; // characters per buddy

export class MemoryStore {
  /** file → its text as of mtime, so the buddy list doesn't re-read every notes file on each update */
  private cache = new Map<string, { mtime: number; text: string }>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(name: string) {
    return path.join(this.dir, safeSegment(name) + ".md");
  }

  get(name: string): string {
    const f = this.file(name);
    if (!existsSync(f)) return "";
    const mtime = statSync(f).mtimeMs;
    const hit = this.cache.get(f);
    if (hit && hit.mtime === mtime) return hit.text;
    const text = readFileSync(f, "utf8");
    this.cache.set(f, { mtime, text });
    return text;
  }

  set(name: string, text: string) {
    const f = this.file(name);
    writeFileSync(f, text.trim() ? text.trim() + "\n" : "");
    this.cache.delete(f);
  }

  add(name: string, note: string): string {
    const clean = note.replace(/\s+/g, " ").trim();
    if (!clean) throw new Error("Empty note.");
    const cur = this.get(name);
    const line = `- (${new Date().toISOString().slice(0, 10)}) ${clean}`;
    const next = (cur.trim() ? cur.trim() + "\n" : "") + line;
    if (next.length > MEMORY_LIMIT)
      throw new Error(`Memory is full (${cur.length}/${MEMORY_LIMIT} chars). Use memory_replace to merge or delete old notes first.`);
    this.set(name, next);
    return line;
  }

  replace(name: string, oldText: string, newText: string) {
    const cur = this.get(name);
    const hits = cur.split(oldText).length - 1;
    if (!oldText || hits === 0) throw new Error("That text isn't in your memory. Copy it exactly.");
    if (hits > 1) throw new Error("That text appears more than once. Include more of the line.");
    let next = cur.replace(oldText, newText);
    next = next.split("\n").filter((l) => l.trim() && l.trim() !== "-").join("\n"); // drop emptied lines
    if (next.length > MEMORY_LIMIT) throw new Error(`That would make memory too long (limit ${MEMORY_LIMIT} chars).`);
    this.set(name, next);
  }

  clear(name: string) {
    rmSync(this.file(name), { force: true });
    this.cache.delete(this.file(name));
  }
}
