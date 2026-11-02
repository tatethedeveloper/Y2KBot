// Model providers. The agent loop keeps history in one canonical shape (Anthropic's
// content blocks); each adapter translates to and from its own API.
//
//   anthropic          → Anthropic Messages API
//   everything else    → OpenAI-compatible Chat Completions (OpenAI, Ollama, OpenRouter,
//                        Gemini, Groq, LM Studio, vLLM, llama.cpp, Together, Mistral, ...)
import Anthropic from "@anthropic-ai/sdk";

export type Msg = Anthropic.MessageParam;
export type Block = Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam;

export interface CompleteArgs {
  model: string;
  system: string;
  messages: Msg[];
  tools: Anthropic.Tool[];
  signal: AbortSignal;
  maxTokens?: number;
}
export interface CompleteResult {
  content: Block[];
  stop: "tool_use" | "end";
}

export interface ModelInfo {
  id: string;
  /** what it can do, when the provider says: "vision", "tools", ... */
  caps?: string[];
}

export interface Provider {
  id: string;
  label: string;
  /** Can this provider actually be called (key present, etc.)? */
  ready: boolean;
  complete(a: CompleteArgs): Promise<CompleteResult>;
  /** Models this provider offers right now. */
  listModels(): Promise<ModelInfo[]>;
}

// ---------------------------------------------------------------- presets
export interface Preset {
  id: string;
  label: string;
  kind: "anthropic" | "openai";
  baseURL?: string;
  keyEnv?: string;      // env var holding the API key
  urlEnv?: string;      // env var that overrides the base URL
  needsKey: boolean;
  exampleModel: string;
}

export const PRESETS: Preset[] = [
  { id: "anthropic", label: "Anthropic", kind: "anthropic", keyEnv: "ANTHROPIC_API_KEY", needsKey: true, exampleModel: "claude-sonnet-5-5" },
  { id: "openai", label: "OpenAI", kind: "openai", baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", urlEnv: "OPENAI_BASE_URL", needsKey: true, exampleModel: "gpt-5" },
  { id: "ollama", label: "Ollama (local)", kind: "openai", baseURL: "http://localhost:11434/v1", keyEnv: "OLLAMA_API_KEY", urlEnv: "OLLAMA_BASE_URL", needsKey: false, exampleModel: "qwen2.5vl:7b" },
  { id: "openrouter", label: "OpenRouter", kind: "openai", baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", needsKey: true, exampleModel: "anthropic/claude-sonnet-5.5" },
  { id: "gemini", label: "Google Gemini", kind: "openai", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY", needsKey: true, exampleModel: "gemini-2.5-flash" },
  { id: "groq", label: "Groq", kind: "openai", baseURL: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", needsKey: true, exampleModel: "llama-3.3-70b-versatile" },
  { id: "lmstudio", label: "LM Studio (local)", kind: "openai", baseURL: "http://localhost:1234/v1", urlEnv: "LMSTUDIO_BASE_URL", needsKey: false, exampleModel: "local-model" },
  { id: "custom", label: "Custom (OpenAI-compatible)", kind: "openai", baseURL: "", keyEnv: "CUSTOM_API_KEY", urlEnv: "CUSTOM_BASE_URL", needsKey: false, exampleModel: "" },
];

export class ProviderRegistry {
  private map = new Map<string, Provider>();

  constructor(env = process.env) {
    for (const p of PRESETS) {
      const key = p.keyEnv ? env[p.keyEnv] ?? "" : "";
      const baseURL = (p.urlEnv && env[p.urlEnv]) || p.baseURL || "";
      if (p.kind === "anthropic") this.map.set(p.id, new AnthropicProvider(p, key));
      else this.map.set(p.id, new OpenAICompatProvider(p, baseURL, key));
    }
  }

  get(id: string) { return this.map.get(id); }

  private modelCache = new Map<string, { at: number; models: ModelInfo[] }>();
  /** Cached for a minute; force=true refreshes. */
  async listModels(id: string, force = false): Promise<ModelInfo[]> {
    const p = this.map.get(id);
    if (!p) throw new Error(`Unknown provider "${id}"`);
    if (!p.ready) throw new Error(`${p.label} isn't set up yet.`);
    const hit = this.modelCache.get(id);
    if (hit && !force && Date.now() - hit.at < 60_000) return hit.models;
    const models = (await p.listModels()).sort((a, b) => a.id.localeCompare(b.id));
    this.modelCache.set(id, { at: Date.now(), models });
    return models;
  }
  all() { return [...this.map.values()]; }

  /** Resolve "provider:model", a bare model (uses the default provider), or nothing. */
  resolve(spec: { provider?: string; model?: string }, defaults: { provider: string; model: string }) {
    let providerId = spec.provider || "";
    let model = spec.model || "";
    const m = /^([a-z0-9-]+):(.+)$/.exec(model);
    if (!providerId && m && this.map.has(m[1])) { providerId = m[1]; model = m[2]; }
    if (!providerId) providerId = defaults.provider;
    if (!model) model = providerId === defaults.provider ? defaults.model : PRESETS.find((p) => p.id === providerId)?.exampleModel ?? defaults.model;
    const provider = this.map.get(providerId);
    if (!provider) throw new Error(`Unknown provider "${providerId}"`);
    return { provider, model };
  }
}

// ---------------------------------------------------------------- Anthropic
class AnthropicProvider implements Provider {
  id: string; label: string; ready: boolean;
  private client: Anthropic | null;
  constructor(p: Preset, key: string) {
    this.id = p.id; this.label = p.label;
    this.ready = !!key;
    this.client = key ? new Anthropic({ apiKey: key }) : null;
  }
  async complete(a: CompleteArgs): Promise<CompleteResult> {
    if (!this.client) throw new Error("No Anthropic API key set (Prefs → Providers).");
    const resp = await this.client.messages.create(
      { model: a.model, max_tokens: a.maxTokens ?? 4096, system: a.system, tools: a.tools.length ? a.tools : undefined, messages: a.messages },
      { signal: a.signal },
    );
    const content: Block[] = [];
    for (const b of resp.content) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
    return { content, stop: resp.stop_reason === "tool_use" ? "tool_use" : "end" };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.client) throw new Error("No Anthropic API key set.");
    const out: ModelInfo[] = [];
    for await (const m of this.client.models.list({ limit: 100 })) out.push({ id: m.id, caps: ["vision", "tools"] });
    return out;
  }
}

// ---------------------------------------------------------------- OpenAI-compatible
type OAIMsg =
  | { role: "system" | "user"; content: string | any[] }
  | { role: "assistant"; content: string | null; tool_calls?: any[] }
  | { role: "tool"; tool_call_id: string; content: string };

class OpenAICompatProvider implements Provider {
  id: string; label: string; ready: boolean;
  constructor(p: Preset, private baseURL: string, private key: string) {
    this.id = p.id; this.label = p.label;
    this.ready = !!baseURL && (!p.needsKey || !!key);
  }

  async complete(a: CompleteArgs): Promise<CompleteResult> {
    if (!this.baseURL) throw new Error(`${this.label}: no base URL set (Prefs → Providers).`);
    if (!this.ready) throw new Error(`${this.label}: no API key set (Prefs → Providers).`);
    const body: Record<string, unknown> = {
      model: a.model,
      messages: toOpenAI(a.system, a.messages),
      max_tokens: a.maxTokens ?? 4096,
    };
    if (a.tools.length) {
      body.tools = a.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      body.tool_choice = "auto";
    }
    const res = await fetch(this.baseURL.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
        ...(this.id === "openrouter" ? { "HTTP-Referer": "https://github.com/y2kbot", "X-Title": "Y2Kbot" } : {}),
      },
      body: JSON.stringify(body),
      signal: a.signal,
    }).catch((e) => {
      if (a.signal.aborted) throw e;
      throw new Error(`${this.label}: couldn't reach ${this.baseURL} (${(e as Error).message})${this.id === "ollama" || this.id === "lmstudio" ? " — is it running?" : ""}`);
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try { const j = JSON.parse(text); detail = j.error?.message ?? j.error ?? j.message ?? text; } catch {}
      throw new Error(`${this.label} ${res.status}: ${String(detail).slice(0, 300)}`);
    }
    const data = JSON.parse(text);
    const msg = data.choices?.[0]?.message ?? {};
    const content: Block[] = [];
    const said = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => p.text ?? "").join("") : "";
    // Some local reasoning models wrap their thinking in <think> tags; don't IM that to the user.
    const clean = said.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (clean) content.push({ type: "text", text: clean });
    for (const tc of msg.tool_calls ?? []) {
      let input: unknown = {};
      try { input = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments || "{}") : tc.function?.arguments ?? {}; }
      catch { input = { _unparseable_arguments: tc.function?.arguments }; }
      content.push({ type: "tool_use", id: tc.id || `call_${Math.random().toString(36).slice(2)}`, name: tc.function?.name, input });
    }
    const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end";
    return { content, stop };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.baseURL) throw new Error(`${this.label}: no base URL set.`);
    const base = this.baseURL.replace(/\/+$/, "");
    const headers: Record<string, string> = this.key ? { authorization: `Bearer ${this.key}` } : {};

    if (this.id === "ollama") {
      // Ollama's own API also says what each model can do (vision, tools, thinking...)
      const root = base.replace(/\/v1$/, "");
      const tags = await getJson(`${root}/api/tags`, headers, this.label);
      const names: string[] = (tags.models ?? []).map((m: any) => m.name ?? m.model).filter(Boolean);
      return Promise.all(names.slice(0, 80).map(async (name) => {
        try {
          const show = await getJson(`${root}/api/show`, { ...headers, "content-type": "application/json" }, this.label, { method: "POST", body: JSON.stringify({ model: name }) });
          return { id: name, caps: (show.capabilities ?? []).filter((c: string) => c !== "completion") };
        } catch { return { id: name }; }
      }));
    }

    const j = await getJson(`${base}/models`, headers, this.label);
    const list: any[] = Array.isArray(j) ? j : j.data ?? j.models ?? [];
    return list.map((m) => {
      const id = String(m.id ?? m.name ?? "").replace(/^models\//, ""); // Gemini prefixes ids with "models/"
      const caps: string[] = [];
      // OpenRouter describes each model's inputs and parameters
      if (m.architecture?.input_modalities?.includes("image")) caps.push("vision");
      if (m.supported_parameters?.includes("tools")) caps.push("tools");
      return caps.length ? { id, caps } : { id };
    }).filter((m) => m.id);
  }
}

/** GET a JSON URL with a timeout and a readable error. */
async function getJson(url: string, headers: Record<string, string>, label: string, init: RequestInit = {}): Promise<any> {
  let r: Response;
  try { r = await fetch(url, { headers, signal: AbortSignal.timeout(15000), ...init }); }
  catch (e) { throw new Error(`${label}: couldn't reach ${new URL(url).origin} (${(e as Error).message})`); }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    let d = t; try { const j = JSON.parse(t); d = j.error?.message ?? j.error ?? j.message ?? t; } catch {}
    throw new Error(`${label} ${r.status}: ${String(d).slice(0, 200)}`);
  }
  return r.json();
}

/** Canonical (Anthropic-shaped) history → OpenAI chat messages. */
export function toOpenAI(system: string, messages: Msg[]): OAIMsg[] {
  const out: OAIMsg[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content } as OAIMsg); continue; }

    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n\n");
      const calls = m.content.filter((b) => b.type === "tool_use").map((b: any) => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    // user turn: tool results become `tool` messages; screenshots can't go inside a
    // tool message on most OpenAI-compatible servers, so they follow as a user message.
    const images: any[] = [];
    const userParts: any[] = [];
    for (const b of m.content as any[]) {
      if (b.type === "tool_result") {
        const parts = typeof b.content === "string" ? [{ type: "text", text: b.content }] : b.content ?? [];
        const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
        const imgs = parts.filter((p: any) => p.type === "image");
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "ERROR: " : "") + (text || "(done)") + (imgs.length ? " [screenshot attached in the next message]" : "") });
        images.push(...imgs);
      } else if (b.type === "text") userParts.push({ type: "text", text: b.text });
      else if (b.type === "image") images.push(b);
    }
    if (images.length) {
      userParts.push({ type: "text", text: images.length > 1 ? "Screenshots:" : "Screenshot:" });
      for (const img of images) userParts.push({ type: "image_url", image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` } });
    }
    if (userParts.length) out.push({ role: "user", content: userParts.length === 1 && userParts[0].type === "text" ? userParts[0].text : userParts });
  }
  return out;
}
