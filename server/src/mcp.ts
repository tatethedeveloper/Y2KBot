// MCP client: connects to the MCP servers listed in mcp.json (same format as Claude Desktop's
// claude_desktop_config.json) and offers their tools to the buddies you allow.
//
// {
//   "mcpServers": {
//     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\me\\Documents"] },
//     "homelab":    { "url": "http://192.168.1.20:8000/mcp", "headers": { "Authorization": "Bearer ..." } },
//     "old-thing":  { "url": "http://localhost:9000/sse", "type": "sse" },
//     "off-for-now": { "command": "...", "disabled": true }
//   }
// }
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export interface ServerConfig {
  command?: string; args?: string[]; env?: Record<string, string>; cwd?: string;
  url?: string; headers?: Record<string, string>; type?: "stdio" | "http" | "sse" | "streamable-http";
  disabled?: boolean;
  /** Ask the user before calling this server's tools: "risky" (default: anything not marked read-only), "always" or "never". */
  approve?: "risky" | "always" | "never";
}

/** What a buddy is about to do with an MCP tool, for the "Are you sure?" dialog. */
export interface ToolRisk { server: string; tool: string; title: string; ask: boolean; why: string }
export interface ServerStatus { name: string; state: "connecting" | "connected" | "error" | "disabled"; error?: string; tools: string[]; kind: string }

interface Conn {
  name: string; client?: Client; status: ServerStatus; tools: Anthropic.Tool[]; map: Map<string, string>;
  approve: "risky" | "always" | "never";
  /** per real tool name: what the server says about it */
  hints: Map<string, { readOnly?: boolean; destructive?: boolean; title?: string }>;
}

// Tool names that only look things up. Used when a server doesn't say whether a tool is read-only.
const LOOKS_READ_ONLY = /^(get|list|read|search|find|fetch|query|describe|show|view|lookup|count|check|status|info|inspect|browse|preview)([_\-.A-Z]|$)/i;

const TOOL_TIMEOUT = 120_000;
const EXAMPLE = `{
  "mcpServers": {
  }
}
`;

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for every provider. */
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export class McpManager extends EventEmitter {
  private conns = new Map<string, Conn>();
  private generation = 0;

  constructor(private file: string) { super(); }

  readConfigText(): string {
    return existsSync(this.file) ? readFileSync(this.file, "utf8") : EXAMPLE;
  }

  /** Validate, save and reconnect. Throws with a readable message on bad JSON. */
  async saveConfig(text: string) {
    parseConfig(text);
    writeFileSync(this.file, text.endsWith("\n") ? text : text + "\n");
    await this.connectAll();
  }

  status(): ServerStatus[] { return [...this.conns.values()].map((c) => c.status); }
  names(): string[] { return [...this.conns.keys()]; }

  async connectAll() {
    const gen = ++this.generation;
    await this.closeAll();
    let servers: Record<string, ServerConfig> = {};
    try { servers = parseConfig(this.readConfigText()); }
    catch (e) { this.emit("changed"); throw e; }
    for (const [name, cfg] of Object.entries(servers)) {
      const kind = cfg.url ? (cfg.type === "sse" ? "sse" : "http") : "stdio";
      const approve = cfg.approve === "always" || cfg.approve === "never" ? cfg.approve : "risky";
      const conn: Conn = { name, status: { name, state: cfg.disabled ? "disabled" : "connecting", tools: [], kind }, tools: [], map: new Map(), approve, hints: new Map() };
      this.conns.set(name, conn);
    }
    this.emit("changed");
    await Promise.all(Object.entries(servers).filter(([, c]) => !c.disabled).map(([name, cfg]) => this.connect(name, cfg, gen)));
    this.emit("changed");
  }

  private async connect(name: string, cfg: ServerConfig, gen: number) {
    const conn = this.conns.get(name)!;
    const client = new Client({ name: "y2kbot", version: "0.1.0" });
    try {
      if (cfg.url) {
        const url = new URL(cfg.url);
        const requestInit = { headers: cfg.headers ?? {} };
        if (cfg.type === "sse") await client.connect(new SSEClientTransport(url, { requestInit }));
        else {
          try { await client.connect(new StreamableHTTPClientTransport(url, { requestInit })); }
          catch (e) {
            if (cfg.type === "http" || cfg.type === "streamable-http") throw e;
            // older servers only speak SSE
            await client.connect(new SSEClientTransport(url, { requestInit }));
          }
        }
      } else if (cfg.command) {
        const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: cfg.env, cwd: cfg.cwd, stderr: "pipe" });
        let stderr = "";
        transport.stderr?.on("data", (d) => { stderr = (stderr + d.toString()).slice(-2000); });
        try { await withTimeout(client.connect(transport), 60_000, "server didn't start within 60s"); }
        catch (e) { throw new Error(`${(e as Error).message}${stderr.trim() ? ` — ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`); }
      } else {
        throw new Error('needs either "command" or "url"');
      }
      if (gen !== this.generation) { await client.close().catch(() => {}); return; }
      const listed = await withTimeout(client.listTools(), 30_000, "listing tools timed out");
      conn.client = client;
      for (const t of listed.tools) {
        let full = `mcp__${safe(name)}__${safe(t.name)}`.slice(0, 64);
        while (conn.map.has(full)) full = full.slice(0, 60) + Math.random().toString(36).slice(2, 5);
        conn.map.set(full, t.name);
        const a: any = (t as any).annotations ?? {};
        conn.hints.set(t.name, { readOnly: a.readOnlyHint, destructive: a.destructiveHint, title: a.title ?? (t as any).title });
        conn.tools.push({
          name: full,
          description: `[MCP: ${name}] ${t.description ?? t.name}`.slice(0, 1024),
          input_schema: (t.inputSchema as Anthropic.Tool["input_schema"]) ?? { type: "object", properties: {} },
        });
      }
      conn.status = { name, state: "connected", tools: listed.tools.map((t) => t.name), kind: conn.status.kind };
    } catch (e) {
      await client.close().catch(() => {});
      conn.status = { name, state: "error", error: (e as Error).message.slice(0, 400), tools: [], kind: conn.status.kind };
    }
    this.emit("changed");
  }

  /** Tools for a buddy: allowed = list of server names, or "all". */
  toolsFor(allowed: string[] | "all" | undefined): Anthropic.Tool[] {
    if (!allowed || (Array.isArray(allowed) && !allowed.length)) return [];
    const out: Anthropic.Tool[] = [];
    for (const c of this.conns.values()) if (c.client && (allowed === "all" || allowed.includes(c.name))) out.push(...c.tools);
    return out;
  }

  owns(toolName: string) { return toolName.startsWith("mcp__"); }

  /** Should the user be asked before this tool runs? */
  risk(toolName: string): ToolRisk | null {
    for (const c of this.conns.values()) {
      const real = c.map.get(toolName);
      if (!real) continue;
      const h = c.hints.get(real) ?? {};
      const base = { server: c.name, tool: real, title: h.title || real };
      if (c.approve === "never") return { ...base, ask: false, why: "approvals are off for this server" };
      if (c.approve === "always") return { ...base, ask: true, why: "this server is set to always ask" };
      if (h.readOnly === true) return { ...base, ask: false, why: "the server marks it read-only" };
      if (h.destructive === true) return { ...base, ask: true, why: "the server says it can delete or overwrite things" };
      if (h.readOnly === false) return { ...base, ask: true, why: "the server says it can change things" };
      return LOOKS_READ_ONLY.test(real)
        ? { ...base, ask: false, why: "its name says it only looks things up" }
        : { ...base, ask: true, why: "it might change, send or delete something" };
    }
    return null;
  }

  async call(toolName: string, args: unknown, allowed: string[] | "all" | undefined): Promise<{ content: Anthropic.ToolResultBlockParam["content"]; isError: boolean; server: string; tool: string }> {
    for (const c of this.conns.values()) {
      const real = c.map.get(toolName);
      if (!real) continue;
      if (!(allowed === "all" || allowed?.includes(c.name))) throw new Error(`You don't have access to the ${c.name} MCP server.`);
      if (!c.client) throw new Error(`MCP server ${c.name} isn't connected.`);
      const res: any = await c.client.callTool({ name: real, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { timeout: TOOL_TIMEOUT });
      const content: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];
      for (const part of res.content ?? []) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "image" && /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType))
          content.push({ type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } });
        else if (part.type === "resource") content.push({ type: "text", text: part.resource?.text ?? `[resource ${part.resource?.uri}]` });
        else if (part.type === "resource_link") content.push({ type: "text", text: `[resource link: ${part.uri}]` });
        else content.push({ type: "text", text: `[${part.type} content]` });
      }
      if (!content.length && res.structuredContent) content.push({ type: "text", text: JSON.stringify(res.structuredContent) });
      return { content: content.length ? content : "(no output)", isError: !!res.isError, server: c.name, tool: real };
    }
    throw new Error(`Unknown MCP tool ${toolName}`);
  }

  async closeAll() {
    const old = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(old.map((c) => c.client?.close().catch(() => {})));
  }
}

function parseConfig(text: string): Record<string, ServerConfig> {
  let j: any;
  try { j = JSON.parse(text); }
  catch (e) { throw new Error(`mcp.json isn't valid JSON: ${(e as Error).message}`); }
  const servers = j?.mcpServers ?? j?.servers;
  if (!servers || typeof servers !== "object") throw new Error('mcp.json needs a top-level "mcpServers" object.');
  for (const [name, c] of Object.entries<any>(servers)) {
    if (!c || typeof c !== "object") throw new Error(`Server "${name}" must be an object.`);
    if (!c.command && !c.url) throw new Error(`Server "${name}" needs "command" (local) or "url" (remote).`);
  }
  return servers;
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}
