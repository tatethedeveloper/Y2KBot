import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from server/src (tsx) and from dist/ (compiled, inside the desktop app).
export const projectRoot = existsSync(path.join(here, "../package.json")) ? path.resolve(here, "..") : path.resolve(here, "../..");

export interface StartOptions {
  port?: number;
  host?: string;
  agentsFile?: string;
  /** Where memory notes and shared folders live. Desktop app: its user-data folder. */
  dataDir?: string;
}

const MAX_UPLOAD = 25 * 1024 * 1024;

const HISTORY_PER_WINDOW = 400;

export async function startServer(opts: StartOptions = {}) {
  const providers = new ProviderRegistry();
  const PROVIDER = providers.get(process.env.RAM_PROVIDER || "") ? process.env.RAM_PROVIDER! : "anthropic";
  const MODEL = process.env.RAM_MODEL || PRESETS.find((p) => p.id === PROVIDER)!.exampleModel;
  const providerInfo = () => PRESETS.map((p) => ({ id: p.id, label: p.label, ready: !!providers.get(p.id)?.ready, exampleModel: p.exampleModel }));
  const dataDir = opts.dataDir ?? path.join(projectRoot, "data");
  mkdirSync(dataDir, { recursive: true });
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
  });

  const app = express();
  app.use(express.static(path.join(projectRoot, "web")));
  app.get("/api/health", (_req, res) => res.json({ provider: PROVIDER, model: MODEL, providers: providerInfo(), demoMode: runner.demoMode, xp: vms.doctor(), vms: vms.list() }));

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  const busy = new Set<string>();

  // Transcript per IM window, so windows opened later (or reopened) can replay it.
  let seq = 0;
  const history = new Map<string, object[]>();
  const record = (window: string, msg: Record<string, unknown>) => {
    const m = { ...msg, seq: ++seq };
    const h = history.get(window) ?? [];
    h.push(m);
    if (h.length > HISTORY_PER_WINDOW) h.splice(0, h.length - HISTORY_PER_WINDOW);
    history.set(window, h);
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
    })),
  });

  const bus: Bus = {
    im: (window, from, text, o) => broadcast(record(window, { type: "im", window, from, text, relayTo: o?.relayTo, at: Date.now() })),
    event: (window, text) => broadcast(record(window, { type: "event", window, text, at: Date.now() })),
    typing: (window, who, on) => broadcast({ type: "typing", window, who, on }),
    status: (who, s) => {
      s === "busy" ? busy.add(who) : busy.delete(who);
      broadcast(buddyList());
    },
  };

  const runner = new Runner(store, vms, bus, providers, { provider: PROVIDER, model: MODEL }, memory, { files, mcp, web: webCfg });
  mcp.on("changed", () => { broadcast({ type: "mcp", servers: mcp.status() }); broadcast(buddyList()); });
  mcp.connectAll().catch((e) => console.error("MCP:", (e as Error).message));
  const rooms = new Rooms(runner, store, {
    changed: () => broadcast({ type: "rooms", rooms: rooms.list() }),
    event: (room, text) => bus.event(room, text),
  });
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
    ws.send(JSON.stringify(buddyList()));
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
        case "history":
          ws.send(JSON.stringify({ type: "history", window: m.window, items: history.get(m.window) ?? [] }));
          break;
        case "im": {
          const agent = store.get(m.to);
          if (!agent) return;
          const attachments: string[] = Array.isArray(m.attachments) ? m.attachments.map(String).slice(0, 20) : [];
          broadcast(record(agent.screenName, { type: "im", window: agent.screenName, from: "You", text: m.text, attachments, at: Date.now(), clientId: m.clientId }));
          if (agent.awayMessage) broadcast(record(agent.screenName, { type: "im", window: agent.screenName, from: agent.screenName, text: agent.awayMessage, auto: true, at: Date.now() }));
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
          const a = m.agent as Agent;
          if (!a?.screenName || !/^[\w.\- ]{2,24}$/.test(a.screenName)) return;
          store.upsert({
            screenName: a.screenName,
            group: a.group || "Buddies",
            color: a.color || "#0000c0",
            profile: a.profile || "",
            awayMessage: a.awayMessage ?? null,
            capabilities: { xp: !!a.capabilities?.xp, imBuddies: !!a.capabilities?.imBuddies, memory: a.capabilities?.memory !== false, web: a.capabilities?.web !== false },
            mcp: a.mcp === "all" ? "all" : Array.isArray(a.mcp) ? a.mcp.map(String).slice(0, 50) : [],
            coords: a.coords === "pixels" || a.coords === "norm1000" ? a.coords : "auto",
            persona: a.persona || "You are a helpful assistant.",
            provider: a.provider && providers.get(a.provider) ? a.provider : undefined,
            model: a.model || undefined,
          });
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
    providers: providerInfo(),
    demoMode: runner.demoMode,
    xp: vms.doctor(),
    close() {
      clearInterval(ticker);
      mcp.closeAll().catch(() => {});
      vms.shutdownAll();
      for (const c of wss.clients) c.terminate();
      server.close();
    },
  };
}
