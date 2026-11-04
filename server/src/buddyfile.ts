// .y2kbuddy files: one buddy (instructions, model, powers, icon, and optionally its memory notes)
// in a single JSON file you can share. No keys or secrets are ever included: a buddy only names
// the provider and MCP servers it uses, and whoever imports it supplies their own.
import type { Agent } from "./agents.js";

export const BUDDY_FORMAT = "y2kbot-buddy";
const MAX_FILE = 512 * 1024;

export interface BuddyFile {
  format: typeof BUDDY_FORMAT;
  version: 1;
  exportedAt: string;
  buddy: Omit<Agent, "lockVm">;
  memory?: string;
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
  const base = wanted.replace(/[^\w.\- ]/g, "").slice(0, 22) || "NewBuddy";
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) { const n = `${base.slice(0, 22 - String(i).length)}${i}`; if (!taken(n)) return n; }
  throw new Error("Couldn't find a free screen name.");
}
