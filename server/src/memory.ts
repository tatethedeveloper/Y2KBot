// Long-term memory: one small markdown notes file per buddy, kept between sessions.
// The whole file is put in the buddy's system prompt each turn; the buddy edits it with tools.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

export const MEMORY_LIMIT = 6000; // characters per buddy

export class MemoryStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(name: string) {
    return path.join(this.dir, name.replace(/[^\w.\- ]/g, "_") + ".md");
  }

  get(name: string): string {
    const f = this.file(name);
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  }

  set(name: string, text: string) {
    writeFileSync(this.file(name), text.trim() ? text.trim() + "\n" : "");
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
  }
}
