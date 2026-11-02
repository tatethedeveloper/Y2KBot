import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface Agent {
  screenName: string;
  group: string;
  color: string;
  profile: string;
  awayMessage: string | null;
  /** memory defaults to on when missing */
  capabilities: { xp: boolean; imBuddies: boolean; memory?: boolean; web?: boolean };
  /** MCP servers this buddy may use: names from mcp.json, or "all". */
  mcp?: string[] | "all";
  /** How the model gives screen positions for XP clicks: auto (by model name), pixels, or 0–1000. */
  coords?: "auto" | "pixels" | "norm1000";
  persona: string;
  /** Provider id (anthropic, openai, ollama, openrouter, gemini, groq, lmstudio, custom). Blank = default. */
  provider?: string;
  /** Model name for that provider. Blank = default. "ollama:llama3.2" style also works. */
  model?: string;
}

export class AgentStore {
  private agents: Agent[] = [];
  constructor(private file: string) {
    this.agents = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  }
  all() { return this.agents; }
  get(name: string) {
    return this.agents.find((a) => a.screenName.toLowerCase() === name.toLowerCase());
  }
  upsert(a: Agent) {
    const i = this.agents.findIndex((x) => x.screenName.toLowerCase() === a.screenName.toLowerCase());
    if (i >= 0) this.agents[i] = { ...this.agents[i], ...a };
    else this.agents.push(a);
    this.save();
  }
  remove(name: string) {
    this.agents = this.agents.filter((a) => a.screenName.toLowerCase() !== name.toLowerCase());
    this.save();
  }
  setAway(name: string, msg: string | null) {
    const a = this.get(name);
    if (a) { a.awayMessage = msg; this.save(); }
  }
  private save() { writeFileSync(this.file, JSON.stringify(this.agents, null, 2) + "\n"); }
}
