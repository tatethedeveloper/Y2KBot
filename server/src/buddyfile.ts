// .y2kbuddy files: one buddy (instructions, model, powers, icon, and optionally its memory notes)
// in a single JSON file you can share. No keys or secrets are ever included: a buddy only names
// the provider and MCP servers it uses, and whoever imports it supplies their own.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Agent } from "./agents.js";

export const BUDDY_FORMAT = "y2kbot-buddy";
const MAX_FILE = 512 * 1024;

export interface BuddyFile {
  format: typeof BUDDY_FORMAT;
  version: 1;
  exportedAt: string;
  buddy: Omit<Agent, "lockVm">;
  memory?: string;
  /** Only in the gallery's files (buddies/ in the repo): how the gallery shows it. Import ignores it. */
  gallery?: { title?: string; blurb?: string; category?: string };
}

export interface GalleryEntry {
  file: string; screenName: string; icon?: string; color: string; profile: string;
  title: string; blurb: string; category: string; xp: boolean;
}

/** The ready-made buddies shipped in buddies/*.y2kbuddy. */
export function readGallery(dir: string): GalleryEntry[] {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".y2kbuddy")); } catch { return []; }
  const out: GalleryEntry[] = [];
  for (const file of names.sort((a, b) => a.localeCompare(b))) {
    try {
      const j = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
      const b = parseBuddyFile(JSON.stringify(j)).buddy;
      out.push({
        file, screenName: String(b.screenName), icon: b.icon, color: String(b.color || "#0000c0"), profile: String(b.profile || ""),
        title: String(j.gallery?.title || ""), blurb: String(j.gallery?.blurb || ""), category: String(j.gallery?.category || "Other"),
        xp: !!b.capabilities?.xp,
      });
    } catch {} // a broken file just doesn't show
  }
  return out;
}

export function readGalleryFile(dir: string, file: string): string {
  if (!/^[\w.\-]+\.y2kbuddy$/.test(file)) throw new Error("No such buddy in the gallery.");
  try { return readFileSync(path.join(dir, file), "utf8"); } catch { throw new Error("No such buddy in the gallery."); }
}

export function exportBuddy(agent: Agent, memory?: string): string {
  const { lockVm: _internal, ...buddy } = agent;
  const file: BuddyFile = { format: BUDDY_FORMAT, version: 1, exportedAt: new Date().toISOString(), buddy };
  if (memory?.trim()) file.memory = memory;
  return JSON.stringify(file, null, 2) + "\n";
}

export function parseBuddyFile(text: string): { buddy: any; memory?: string } {
  if (text.length > MAX_FILE) throw new Error("That file is too big to be a buddy.");
  let j: any;
  try { j = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new Error("That isn't a Y2Kbot buddy file (it's not valid JSON)."); }
  if (j?.format !== BUDDY_FORMAT || !j.buddy || typeof j.buddy !== "object") throw new Error("That isn't a Y2Kbot buddy file.");
  if (Number(j.version) > 1) throw new Error("This buddy was saved by a newer version of Y2Kbot. Update the app to import it.");
  return { buddy: j.buddy, memory: typeof j.memory === "string" ? j.memory.slice(0, 20000) : undefined };
}

/** A screen name that isn't taken yet: Dave, Dave2, Dave3… */
export function freeName(wanted: string, taken: (n: string) => boolean): string {
  const cleaned = wanted.replace(/[^\w.\- ]/g, "").slice(0, 22);
  const base = /\w/.test(cleaned) ? cleaned : "NewBuddy"; // never ".." or other dots-only names
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) { const n = `${base.slice(0, 22 - String(i).length)}${i}`; if (!taken(n)) return n; }
  throw new Error("Couldn't find a free screen name.");
}
