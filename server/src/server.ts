import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { AgentStore, type Agent } from "./agents.js";
import { Runner, type Bus } from "./runner.js";
import { XPManager } from "./vm/xp.js";
import { PRESETS, ProviderRegistry } from "./providers.js";
import { MemoryStore } from "./memory.js";
import { Rooms } from "./rooms.js";
import { AttachmentStore } from "./files.js";
import { McpManager } from "./mcp.js";
import { searchReady, type SearchConfig } from "./web.js";
import { xpGuide } from "./knowledge.js";
import { Bench, toMarkdown } from "./bench.js";
import { Ocr } from "./ocr.js";
import { SkillStore, skillsFile } from "./skills.js";
import { dismissAutoPlay } from "./tools.js";
import { ChatLogger, toHtml, toText, type LogItem } from "./logs.js";
import { exportBuddy, parseBuddyFile, freeName } from "./buddyfile.js";
import type { ToolRisk } from "./mcp.js";
import { ChatGPTAuth, ChatGPTProvider, type SecretBox } from "./chatgpt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from server/src (tsx) and from dist/ (compiled, inside the desktop app).
export const projectRoot = existsSync(path.join(here, "../package.json")) ? path.resolve(here, "..") : path.resolve(here, "../..");

export interface StartOptions {
  port?: number;
  host?: string;
  agentsFile?: string;
  /** Where memory notes and shared folders live. Desktop app: its user-data folder. */
  dataDir?: string;
  /** Encrypts saved sign-in tokens (the desktop app passes the OS keychain). */
  secrets?: SecretBox;
}

const MAX_UPLOAD = 25 * 1024 * 1024;

const HISTORY_PER_WINDOW = 400;

export async function startServer(opts: StartOptions = {}) {
  const dataDir = opts.dataDir ?? path.join(projectRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  const providers = new ProviderRegistry();
  // Sign in with ChatGPT: tokens live next to settings, encrypted when the app gives us a keychain.
  const chatgpt = new ChatGPTAuth(path.join(dataDir, "chatgpt-signin.json"), opts.secrets);
  providers.add(new ChatGPTProvider(chatgpt));
  const PROVIDER = providers.get(process.env.RAM_PROVIDER || "") ? process.env.RAM_PROVIDER! : "anthropic";
  const MODEL = process.env.RAM_MODEL || PRESETS.find((p) => p.id === PROVIDER)!.exampleModel;
  const providerInfo = () => PRESETS.map((p) => ({ id: p.id, label: p.label, ready: !!providers.get(p.id)?.ready, exampleModel: p.exampleModel }));
  const memory = new MemoryStore(path.join(dataDir, "memory"));
  const files = new AttachmentStore(path.join(dataDir, "files"));
  const mcp = new McpManager(path.join(dataDir, "mcp.json"));
  const search: SearchConfig = {
    provider: (["brave", "tavily", "searxng"].includes(process.env.SEARCH_PROVIDER || "") ? process.env.SEARCH_PROVIDER : "") as SearchConfig["provider"],
    braveKey: process.env.BRAVE_API_KEY, tavilyKey: process.env.TAVILY_API_KEY, searxngUrl: process.env.SEARXNG_URL,
  };
  const webCfg = () => ({ search, allowPrivate: process.env.WEB_ALLOW_PRIVATE === "1" });
  const webInfo = () => ({ search: search.provider || null, ready: searchReady(search), allowPrivate: webCfg().allowPrivate });
  const store = new AgentStore(opts.agentsFile ?? path.join(projectRoot, "server/agents.json"));
  const vms = new XPManager({
    qemuBin: process.env.QEMU_BIN || "qemu-system-i386",
    baseImage: process.env.XP_BASE_IMAGE || "",
    memoryMb: Number(process.env.XP_MEMORY_MB || 512),
    maxVms: Number(process.env.XP_MAX_VMS || 2),
    network: (process.env.XP_NETWORK as any) || "none",
    vga: process.env.XP_VGA || "cirrus",
    accel: process.env.XP_ACCEL || undefined,
    cpu: process.env.XP_CPU || "pentium3",
    acpi: (process.env.XP_ACPI || "off") === "on",
    sharedRoot: process.env.XP_SHARE === "0" ? "" : path.join(dataDir, "shared"),
    shareBus: process.env.XP_SHARE_BUS === "ide" ? "ide" : "usb",
  });

  const app = express();
  // Answer only requests addressed to this machine by its loopback name (blocks DNS-rebinding pages).
  app.use((req, res, next) => (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "") ? next() : res.status(403).end()));
  app.use(express.static(path.join(projectRoot, "web")));
  app.get("/api/health", (_req, res) => res.json({ provider: PROVIDER, model: MODEL, providers: providerInfo(), demoMode: runner.demoMode, xp: vms.doctor(), vms: vms.list() }));

  app.get("/bench/shot/:run/:file", (req, res) => {
    const p = bench.screenshotPath(req.params.run, req.params.file);
    p ? res.sendFile(p) : res.status(404).end();
  });

  const server = createServer(app);
  // Only the app's own windows may connect. Browsers let ANY website open a WebSocket to
  // localhost, so without this a web page you visit could drive your buddies (and their XP machines).
  const wss = new WebSocketServer({
    server, path: "/ws",
    verifyClient: ({ origin, req }: { origin: string; req: import("node:http").IncomingMessage }) => {
      const port = (server.address() as AddressInfo | null)?.port;
      return !!port && [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin) && /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || "");
    },
  });
  const busy = new Set<string>();
  // Presence: when each buddy last finished something (for "Idle 5m"), and why its brain is failing (for "Away").
  const startedAt = Date.now();
  const idleSince = new Map<string, number>();
  const down = new Map<string, string>();
  let me = "Me"; // the user's screen name, for chat logs
  const logger = new ChatLogger(path.join(dataDir, "logs"), process.env.CHAT_LOGS === "1");

  // Transcript per IM window, so windows opened later (or reopened) can replay it.
  let seq = 0;
  const history = new Map<string, object[]>();
  const record = (window: string, msg: Record<string, unknown>) => {
    const m = { ...msg, seq: ++seq };
    const h = history.get(window) ?? [];
    h.push(m);
    if (h.length > HISTORY_PER_WINDOW) h.splice(0, h.length - HISTORY_PER_WINDOW);
    history.set(window, h);
    logger.append(window, m as unknown as LogItem, me);
    return m;
  };

  function broadcast(msg: object) {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  }

  const buddyList = () => ({
    type: "buddies",
    buddies: store.all().map((a) => ({
      ...a,
      route: routeLabel(a),
      busy: busy.has(a.screenName),
      vm: vms.list().find((v) => v.owner === a.screenName) ?? null,
      sharedDir: a.capabilities.xp ? vms.sharedDir(a.screenName) : null,
      memoryChars: memory.get(a.screenName).length,
      idleSince: idleSince.get(a.screenName) ?? startedAt,
      down: down.get(a.screenName) ?? null,
    })),
  });

  const bus: Bus = {
    im: (window, from, text, o) => broadcast(record(window, { type: "im", window, from, text, relayTo: o?.relayTo, at: Date.now() })),
    event: (window, text) => broadcast(record(window, { type: "event", window, text, at: Date.now() })),
    typing: (window, who, on) => broadcast({ type: "typing", window, who, on }),
    status: (who, s) => {
      s === "busy" ? busy.add(who) : busy.delete(who);
      if (s === "online") idleSince.set(who, Date.now());
      broadcast(buddyList());
    },
    presence: (who, why) => {
      if ((down.get(who) ?? null) === why) return;
      why ? down.set(who, why.replace(/\s+/g, " ").slice(0, 200)) : down.delete(who);
      broadcast(buddyList());
    },
  };

  const ocr = new Ocr();
  const skills = new SkillStore(skillsFile(dataDir));
  skills.on("changed", () => broadcast({ type: "skills", skills: skills.list() }));
  // ---- "Are you sure?" approvals for risky MCP actions
  type Answer = "yes" | "no" | "timeout" | "nobody";
  const approvalsFile = path.join(dataDir, "approvals.json");
  const alwaysAllowed = new Set<string>((() => { try { return JSON.parse(readFileSync(approvalsFile, "utf8")) as string[]; } catch { return []; } })());
  const pending = new Map<string, { req: ToolRisk & { who: string; args: unknown; id: string; at: number }; done: (a: Answer) => void }>();
  const allowKey = (who: string, server: string, tool: string) => `${who}|${server}|${tool}`;
  const approve = (req: ToolRisk & { who: string; args: unknown }): Promise<Answer> => {
    if (alwaysAllowed.has(allowKey(req.who, req.server, req.tool))) return Promise.resolve("yes");
    if (![...wss.clients].some((c) => c.readyState === WebSocket.OPEN)) return Promise.resolve("nobody");
    const id = Math.random().toString(36).slice(2, 10);
    let args = "";
    try { args = JSON.stringify(req.args ?? {}, null, 2); } catch { args = String(req.args); }
    const full = { ...req, args: args.length > 4000 ? args.slice(0, 4000) + "\n…" : args, id, at: Date.now() };
    bus.event(req.who, `*** ${req.who} wants to use ${req.title} (${req.server}). Waiting for you to say yes or no…`);
    return new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => finish("timeout"), 5 * 60_000);
      const finish = (a: Answer) => {
        if (!pending.has(id)) return;
        clearTimeout(timer);
        pending.delete(id);
        broadcast({ type: "approve_done", id, answer: a });
        bus.event(req.who, a === "yes" ? `*** You allowed ${req.title}.` : a === "no" ? `*** You said no to ${req.title}.` : `*** Nobody answered, so ${req.title} wasn't run.`);
        resolve(a);
      };
      pending.set(id, { req: full, done: finish });
      broadcast({ type: "approve_request", ...full });
    });
  };

  const extras = { files, mcp, web: webCfg, guide: xpGuide(projectRoot, dataDir), ocr, skills, approve };
  const runner = new Runner(store, vms, bus, providers, { provider: PROVIDER, model: MODEL }, memory, extras);
  const bench = new Bench({ projectRoot, dataDir, vms, providers, memory, extras });
  bench.on("progress", (p) => broadcast({ type: "bench_progress", ...p }));
  bench.on("finished", (rec) => broadcast({ type: "bench_finished", run: rec }));
  chatgpt.on("changed", (status) => {
    providers.forgetModels("chatgpt");
    broadcast({ type: "chatgpt", ...status });
    broadcast({ type: "providers", providers: providerInfo(), demoMode: runner.demoMode });
    broadcast(buddyList()); // "(not set up)" labels on buddies that use ChatGPT
  });
  mcp.on("changed", () => { broadcast({ type: "mcp", servers: mcp.status() }); broadcast(buddyList()); });
  mcp.connectAll().catch((e) => console.error("MCP:", (e as Error).message));
  const rooms = new Rooms(runner, store, {
    changed: () => broadcast({ type: "rooms", rooms: rooms.list() }),
    event: (room, text) => bus.event(room, text),
  });
  /** Validate a buddy coming from the UI or an imported file, keeping only known fields. */
  function cleanAgent(a: any): Agent | null {
    if (!a?.screenName || !/^[\w.\- ]{2,24}$/.test(String(a.screenName))) return null;
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
    return {
      screenName: String(a.screenName),
      group: str(a.group, 40) || "Buddies",
      color: /^#[0-9a-f]{3,8}$/i.test(a.color) ? a.color : "#0000c0",
      profile: str(a.profile, 2000),
      awayMessage: str(a.awayMessage, 300) || null,
      capabilities: {
        xp: !!a.capabilities?.xp, imBuddies: !!a.capabilities?.imBuddies,
        memory: a.capabilities?.memory !== false, web: a.capabilities?.web !== false,
        xpCmd: a.capabilities?.xpCmd !== false, skills: a.capabilities?.skills !== false,
      },
      mcp: a.mcp === "all" ? "all" : Array.isArray(a.mcp) ? a.mcp.map(String).slice(0, 50) : [],
      coords: a.coords === "pixels" || a.coords === "norm1000" ? a.coords : "auto",
      persona: str(a.persona, 20000) || "You are a helpful assistant.",
      provider: a.provider && providers.get(a.provider) ? a.provider : undefined,
      model: str(a.model, 200) || undefined,
      icon: /^[a-z0-9-]{1,30}$/.test(a.icon ?? "") ? a.icon : undefined,
    };
  }

  function routeLabel(a: Agent) {
    try { const r = runner.route(a); return { provider: r.provider.id, label: r.provider.label, model: r.model, ready: r.provider.ready }; }
    catch (e) { return { provider: a.provider ?? "?", label: a.provider ?? "?", model: a.model ?? "", ready: false }; }
  }

  vms.on("started", (vm) => { broadcast({ type: "vm_started", vm }); broadcast(buddyList()); });
  vms.on("stopped", (vm) => { broadcast({ type: "vm_stopped", vm }); broadcast(buddyList()); });
  vms.on("frame", ({ owner, id, png }) => broadcast({ type: "vm_frame", owner, id, png: (png as Buffer).toString("base64") }));

  // Keep viewers live even while an agent is "thinking".
  const ticker = setInterval(async () => {
    if (wss.clients.size === 0) return;
    for (const vm of vms.list()) await vms.screenshot(vm.owner).catch(() => {});
  }, 2000);

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", web: webInfo(), provider: PROVIDER, model: MODEL, providers: providerInfo(), demoMode: runner.demoMode, xp: vms.doctor() }));
    // rooms + MCP first: windows render as soon as the agent list arrives
    ws.send(JSON.stringify({ type: "rooms", rooms: rooms.list() }));
    ws.send(JSON.stringify({ type: "mcp", servers: mcp.status() }));
    ws.send(JSON.stringify({ type: "chatgpt", ...chatgpt.status() }));
    ws.send(JSON.stringify(buddyList()));
    for (const p of pending.values()) ws.send(JSON.stringify({ type: "approve_request", ...p.req })); // after buddies, so the dialog has icons
    const reply = (m: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

    ws.on("message", async (raw) => {
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      switch (m.type) {
        case "models_get": {
          const id = String(m.provider || "");
          try { reply({ type: "models", provider: id, models: await providers.listModels(id, !!m.force) }); }
          catch (e) { reply({ type: "models", provider: id, models: [], error: (e as Error).message }); }
          break;
        }
        case "chatgpt_login":
          try { reply({ type: "chatgpt_login_url", url: await chatgpt.startLogin(!!m.fresh) }); }
          catch (e) { reply({ type: "chatgpt", ...chatgpt.status(), error: `Couldn't start the sign-in: ${(e as Error).message}` }); }
          break;
        case "chatgpt_cancel": chatgpt.cancelLogin(); break;
        case "chatgpt_logout": await chatgpt.signOut(); break;
        case "history":
          ws.send(JSON.stringify({ type: "history", window: m.window, items: history.get(m.window) ?? [] }));
          break;
        case "im": {
          const agent = store.get(m.to);
          if (!agent) return;
          const attachments: string[] = Array.isArray(m.attachments) ? m.attachments.map(String).slice(0, 20) : [];
          broadcast(record(agent.screenName, { type: "im", window: agent.screenName, from: "You", text: m.text, attachments, at: Date.now(), clientId: m.clientId }));
          if (agent.awayMessage) broadcast(record(agent.screenName, { type: "im", window: agent.screenName, from: agent.screenName, text: agent.awayMessage, auto: true, at: Date.now() }));
          else if (down.has(agent.screenName)) broadcast(record(agent.screenName, { type: "im", window: agent.screenName, from: agent.screenName, auto: true, at: Date.now(), text: `I'm away: my brain (${routeLabel(agent).label}) stopped answering last time. I'll give it another go. (${down.get(agent.screenName)})` }));
          const content = attachments.length ? [{ type: "text" as const, text: String(m.text || "(see attached)") }, ...(await files.blocks(agent.screenName, attachments))] : String(m.text);
          runner.send(agent.screenName, content).catch((e) => bus.event(agent.screenName, `*** ${e.message}`));
          break;
        }
        case "stop": m.who?.startsWith("#") ? rooms.stop(m.who) : runner.stop(m.who); break;
        case "reset":
          if (m.who?.startsWith("#")) runner.resetRoom(m.who); else runner.reset(m.who);
          history.delete(m.who);
          broadcast({ type: "cleared", window: m.who });
          bus.event(m.who, `conversation with ${m.who} was reset`);
          break;
        case "upsert_agent": {
          const a = cleanAgent(m.agent);
          if (!a) return;
          store.upsert(a);
          broadcast(buddyList());
          break;
        }
        // ---- chat rooms
        case "room_create":
          try {
            const name = rooms.create(m.room, Array.isArray(m.members) ? m.members : []);
            reply({ type: "room_created", room: name, clientId: m.clientId });
          } catch (e) { reply({ type: "error", text: (e as Error).message }); }
          break;
        case "room_invite": rooms.invite(m.room, m.who); break;
        case "room_leave": rooms.leave(m.room, m.who); break;
        case "room_close": rooms.close(m.room); history.delete(m.room); break;
        case "room_say": {
          const attachments: string[] = Array.isArray(m.attachments) ? m.attachments.map(String).slice(0, 20) : [];
          if (!rooms.get(m.room) || (!String(m.text || "").trim() && !attachments.length)) return;
          const me = String(m.me || "You").slice(0, 24);
          broadcast(record(m.room, { type: "im", window: m.room, from: "You", me, text: m.text, attachments, at: Date.now(), clientId: m.clientId }));
          const text = String(m.text || "") + (attachments.length ? ` [attached: ${attachments.join(", ")}]` : "");
          rooms.say(m.room, me, text, attachments.length ? await files.blocks(m.room, attachments) : undefined);
          break;
        }
        // ---- memory
        case "memory_get": {
          const a = store.get(m.who);
          if (a) reply({ type: "memory", who: a.screenName, text: memory.get(a.screenName) });
          break;
        }
        case "memory_set": {
          const a = store.get(m.who);
          if (!a) return;
          memory.set(a.screenName, String(m.text ?? "").slice(0, 20000));
          reply({ type: "memory", who: a.screenName, text: memory.get(a.screenName) });
          broadcast(buddyList());
          break;
        }
        // ---- attachments (files dropped onto any IM or room window)
        case "attach": {
          const win = String(m.window || "");
          const isRoom = win.startsWith("#");
          const agent = isRoom ? null : store.get(win);
          if (isRoom ? !rooms.get(win) : !agent) return;
          const key = isRoom ? win : agent!.screenName;
          try {
            const info = files.save(key, String(m.name || "file"), Buffer.from(String(m.data || ""), "base64"));
            reply({ type: "attached", window: key, file: info, clientId: m.clientId });
            // XP buddies also get it on their shared drive (only safe while the machine is off)
            const dir = agent?.capabilities.xp ? vms.sharedDir(agent.screenName) : null;
            if (dir && !vms.has(agent!.screenName)) writeFileSync(path.join(dir, info.name), Buffer.from(String(m.data || ""), "base64"));
          } catch (e) { reply({ type: "attach_failed", window: key, name: m.name, error: (e as Error).message, clientId: m.clientId }); }
          break;
        }
        // ---- Y2Kbench
        case "bench_tasks": {
          try { const d = bench.tasksFile(); reply({ type: "bench_tasks", tasks: d.tasks.map(({ id, title, level, prompt }) => ({ id, title, level, prompt })), busy: bench.busy }); }
          catch (e) { reply({ type: "bench_tasks", tasks: [], error: (e as Error).message }); }
          break;
        }
        case "bench_history": reply({ type: "bench_history", runs: bench.history(), busy: bench.busy }); break;
        case "bench_run":
          bench.run({ provider: String(m.provider || PROVIDER), model: String(m.model || MODEL), coords: m.coords, taskIds: Array.isArray(m.taskIds) ? m.taskIds.map(String) : undefined, repeat: Number(m.repeat) || 1, label: m.label ? String(m.label).slice(0, 80) : undefined, cmd: m.cmd !== false, skills: !!m.skills })
            .catch((e) => broadcast({ type: "bench_error", error: (e as Error).message }));
          break;
        case "bench_stop": bench.stop(); break;
        case "bench_delete": bench.deleteRun(String(m.runId || "")); reply({ type: "bench_history", runs: bench.history(), busy: bench.busy }); break;
        case "bench_markdown": {
          const ids: string[] = Array.isArray(m.runIds) ? m.runIds : [];
          const runs = bench.history().filter((r) => ids.includes(r.id));
          reply({ type: "bench_markdown", text: toMarkdown(runs, bench.tasksFile().tasks) });
          break;
        }
        // ---- MCP servers
        case "mcp_config_get": reply({ type: "mcp_config", text: mcp.readConfigText() }); break;
        case "mcp_config_set":
          try { await mcp.saveConfig(String(m.text || "")); reply({ type: "mcp_saved" }); }
          catch (e) { reply({ type: "mcp_saved", error: (e as Error).message }); }
          break;
        case "mcp_reconnect": mcp.connectAll().catch(() => {}); break;
        // ---- shared folder uploads (files dropped onto an IM window)
        case "share_upload": {
          const a = store.get(m.who);
          const dir = a?.capabilities.xp ? vms.sharedDir(a.screenName) : null;
          if (!a || !dir) return;
          const name = path.basename(String(m.name || "")).replace(/[<>:"|?*\x00-\x1f]/g, "_");
          if (!name || name.startsWith(".")) return;
          if (vms.has(a.screenName)) { bus.event(a.screenName, `couldn't add ${name}: ${a.screenName}'s XP machine is on. Shut it down first; files appear on the next boot.`); return; }
          const data = Buffer.from(String(m.data || ""), "base64");
          if (data.length > MAX_UPLOAD) { bus.event(a.screenName, `${name} is too big (max 25 MB).`); return; }
          writeFileSync(path.join(dir, name), data);
          bus.event(a.screenName, `sent ${name} (${Math.ceil(data.length / 1024)} KB) to ${a.screenName}'s shared folder`);
          break;
        }
        case "remove_agent": rooms.removeBuddyEverywhere(m.who); runner.reset(m.who); await vms.shutdown(m.who); store.remove(m.who); broadcast(buddyList()); break;
        case "vm_shutdown": await vms.shutdown(m.owner); break;
        case "vm_boot": {
          const a = store.get(m.owner);
          if (!a?.capabilities.xp) return;
          try { await vms.boot(a.screenName); }
          catch (e) { bus.event(a.screenName, `*** couldn't boot XP: ${(e as Error).message}`); }
          break;
        }
        case "vm_click": // the human can grab the mouse too
          if (vms.has(m.owner)) { await vms.click(m.owner, m.x, m.y, m.button ?? "left", !!m.double).catch(() => {}); vms.screenshot(m.owner).catch(() => {}); }
          break;
        case "iam": if (typeof m.name === "string" && m.name.trim()) me = m.name.trim().slice(0, 24); break;
        case "approve_reply": {
          const p = pending.get(String(m.id));
          if (!p) break;
          if (m.ok && m.always) {
            alwaysAllowed.add(allowKey(p.req.who, p.req.server, p.req.tool));
            writeFileSync(approvalsFile, JSON.stringify([...alwaysAllowed], null, 2));
          }
          p.done(m.ok ? "yes" : "no");
          break;
        }
        case "approvals_reset": alwaysAllowed.clear(); writeFileSync(approvalsFile, "[]"); break;
        case "log_get": { // File → Save Conversation
          const w = String(m.window || "");
          const items = (history.get(w) ?? []) as LogItem[];
          const fmt = m.format === "html" ? "html" : "txt";
          reply({ type: "log", window: w, format: fmt, text: fmt === "html" ? toHtml(w, items, me) : toText(w, items, me), reqId: m.reqId });
          break;
        }
        case "buddy_export": {
          const a = store.get(String(m.who || ""));
          if (!a) break;
          reply({ type: "buddy_file", reqId: m.reqId, name: `${a.screenName}.y2kbuddy`, text: exportBuddy(a, m.withMemory ? memory.get(a.screenName) : undefined) });
          break;
        }
        case "buddy_import": {
          try {
            const { buddy, memory: notes } = parseBuddyFile(String(m.text || ""));
            const wanted = String(buddy.screenName || "").trim();
            const name = freeName(wanted, (n) => !!store.get(n));
            const a = cleanAgent({ ...buddy, screenName: name });
            if (!a) throw new Error("The buddy in that file has an invalid screen name.");
            const notesOut: string[] = [];
            if (name !== wanted) notesOut.push(`You already have a ${wanted}, so this one is called ${name}.`);
            if (buddy.provider && !a.provider) notesOut.push(`It used the "${buddy.provider}" provider, which this app doesn't have, so it'll use your default.`);
            else if (a.provider && !providers.get(a.provider)?.ready) notesOut.push(`It uses ${providers.get(a.provider)!.label}, which isn't set up here yet (Prefs).`);
            const known = new Set(mcp.status().map((x) => x.name));
            const missing = Array.isArray(a.mcp) ? a.mcp.filter((n) => !known.has(n)) : [];
            if (missing.length) notesOut.push(`It expects MCP server${missing.length > 1 ? "s" : ""} you haven't set up: ${missing.join(", ")}.`);
            store.upsert(a);
            if (notes && a.capabilities.memory !== false) memory.set(a.screenName, notes);
            broadcast(buddyList());
            reply({ type: "buddy_imported", reqId: m.reqId, screenName: a.screenName, notes: notesOut, withMemory: !!notes });
          } catch (e) { reply({ type: "buddy_imported", reqId: m.reqId, error: (e as Error).message }); }
          break;
        }
        case "skills_get": reply({ type: "skills", skills: skills.list() }); break;
        case "skill_put":
          try { skills.put({ id: m.id, title: String(m.title ?? ""), when: String(m.when ?? ""), steps: String(m.steps ?? ""), by: "You" }); }
          catch (e) { reply({ type: "skill_error", error: (e as Error).message }); }
          break;
        case "skill_delete": skills.remove(String(m.id)); break;
        case "vm_checkpoint": // the human's buttons in the XP viewer
        case "vm_undo": {
          const owner = String(m.owner);
          if (!vms.has(owner)) break;
          const win = owner;
          let error = "";
          try {
            if (m.type === "vm_checkpoint") {
              const cp = await vms.checkpoint(owner, "saved by you");
              bus.event(win, `*** You saved a checkpoint of ${owner}'s XP machine (${new Date(cp.at).toLocaleTimeString()}).`);
            } else {
              const cp = await vms.undo(owner);
              bus.event(win, `*** You put ${owner}'s XP machine back to checkpoint "${cp.label}".`);
            }
            void dismissAutoPlay(vms, ocr, owner).catch(() => {});
            vms.screenshot(owner).catch(() => {});
          } catch (e) { error = (e as Error).message; bus.event(win, `*** ${error}`); }
          reply({ type: "vm_checkpoints", owner, action: m.type, error, checkpoints: vms.checkpoints(owner) });
          break;
        }
        case "vm_key":
          if (vms.has(m.owner)) { await vms.key(m.owner, m.combo).catch(() => {}); vms.screenshot(m.owner).catch(() => {}); }
          break;
      }
    });
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => { server.off("error", reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    provider: PROVIDER,
    model: MODEL,
    // live, so Prefs sees a ChatGPT sign-in without a restart
    get providers() { return providerInfo(); },
    get demoMode() { return runner.demoMode; },
    xp: vms.doctor(),
    bench,
    close() {
      clearInterval(ticker);
      chatgpt.cancelLogin(false);
      bench.stop();
      ocr.close().catch(() => {});
      mcp.closeAll().catch(() => {});
      vms.shutdownAll();
      for (const c of wss.clients) c.terminate();
      server.close();
    },
  };
}
