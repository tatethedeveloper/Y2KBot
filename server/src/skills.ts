// Skills: recipes that worked, shared by every buddy.
// After finishing a task, a buddy saves the steps that worked ("rename a file in Explorer: select it, F2,
// type, Enter"). Before a new task, the closest skills are put in front of it, so the whole buddy list
// gets better at XP over time instead of rediscovering the same tricks.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export interface Skill {
  id: string;
  title: string;
  /** when to use it, in a sentence */
  when: string;
  /** the steps or commands that worked */
  steps: string;
  /** buddy who saved (or last improved) it */
  by: string;
  created: string;
  updated: string;
  /** how often it's been handed to a buddy */
  uses: number;
}

const MAX_SKILLS = 300;
const MAX_STEPS = 2000;
const STOP = new Set(["the", "and", "for", "with", "how", "can", "you", "your", "this", "that", "into", "from", "what", "does", "use", "using", "get", "make", "want", "need", "please", "then", "there", "file", "files", "xp", "windows", "machine", "some", "all", "out", "about", "have", "will", "just", "it's", "its"]);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 2 && !STOP.has(w));

/** Emits "changed" whenever a skill is saved or removed. */
export class SkillStore extends EventEmitter {
  private skills: Skill[] = [];
  constructor(private file: string) {
    super();
    try { this.skills = JSON.parse(readFileSync(file, "utf8")); } catch { this.skills = []; }
  }

  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.skills, null, 2));
    renameSync(tmp, this.file);
    this.emit("changed");
  }

  list(): Skill[] { return [...this.skills].sort((a, b) => b.updated.localeCompare(a.updated)); }
  get(id: string) { return this.skills.find((s) => s.id === id); }

  /** Save a new skill, or improve the one with the same title. */
  put(input: { title: string; when: string; steps: string; by: string; id?: string }): { skill: Skill; updated: boolean } {
    const title = input.title.replace(/\s+/g, " ").trim().slice(0, 100);
    const when = input.when.replace(/\s+/g, " ").trim().slice(0, 300);
    const steps = input.steps.replace(/\r\n/g, "\n").trim();
    if (!title) throw new Error("Give the skill a short title, e.g. \"Rename a file in Explorer\".");
    if (!steps) throw new Error("Write down the steps or commands that worked.");
    if (steps.length > MAX_STEPS) throw new Error(`Keep the steps under ${MAX_STEPS} characters: just what worked, not the whole story.`);
    const now = new Date().toISOString();
    const existing = (input.id && this.get(input.id)) || this.skills.find((s) => s.title.toLowerCase() === title.toLowerCase());
    if (existing) {
      Object.assign(existing, { title, when: when || existing.when, steps, by: input.by, updated: now });
      this.save();
      return { skill: existing, updated: true };
    }
    if (this.skills.length >= MAX_SKILLS) throw new Error(`The skill library is full (${MAX_SKILLS}). Improve an existing skill (same title) instead.`);
    const skill: Skill = { id: `sk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, title, when, steps, by: input.by, created: now, updated: now, uses: 0 };
    this.skills.push(skill);
    this.save();
    return { skill, updated: false };
  }

  remove(id: string) {
    const n = this.skills.length;
    this.skills = this.skills.filter((s) => s.id !== id);
    if (this.skills.length !== n) this.save();
  }

  /**
   * Skills that look relevant to some text, best first. Rarer words count for more, and words in the
   * title or "when" count more than words in the steps. minScore filters out weak, accidental matches.
   */
  search(query: string, limit = 3, minScore = 0): Skill[] {
    const q = [...new Set(words(query))];
    if (!q.length || !this.skills.length) return [];
    const docs = this.skills.map((s) => ({ s, head: `${s.title} ${s.when}`.toLowerCase(), body: s.steps.toLowerCase() }));
    const idf = (w: string) => Math.log((docs.length + 1) / (1 + docs.filter((d) => d.head.includes(w) || d.body.includes(w)).length)) + 0.5;
    return docs
      .map((d) => ({ s: d.s, score: q.reduce((n, w) => n + (d.head.includes(w) ? 3 * idf(w) : d.body.includes(w) ? idf(w) : 0), 0) }))
      .filter((x) => x.score > minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.s);
  }

  /** Count that these were handed to a buddy. */
  used(skills: Skill[]) {
    if (!skills.length) return;
    for (const s of skills) s.uses++;
    this.save();
  }
}

export function format(s: Skill): string {
  return `### ${s.title}\nWhen: ${s.when || "(not given)"}\nSaved by ${s.by}, ${s.updated.slice(0, 10)}${s.uses ? `, used ${s.uses}×` : ""}\n${s.steps}`;
}

export const skillsFile = (dataDir: string) => path.join(dataDir, "skills.json");
