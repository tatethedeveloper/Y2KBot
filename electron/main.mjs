// Y2Kbot — desktop shell.
// Runs the agent server in-process on localhost and gives every messenger
// window (sign-on, agent list, each IM, each XP viewer) its own native window.
import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog, shell, safeStorage, clipboard } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

// ---------------- data folder ----------------
app.setName("Y2Kbot");
app.setPath("userData", path.join(app.getPath("appData"), "Y2Kbot"));

// app.quit() isn't immediate, so a second copy must also skip starting up (see whenReady).
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
if (isWin) app.setAppUserModelId("io.y2kbot.app");

// ---------------- settings (userData/settings.json) ----------------
const userDir = () => app.getPath("userData");
const settingsFile = () => path.join(userDir(), "settings.json");

const DEFAULTS = {
  provider: "anthropic",
  model: "",
  baseUrls: {},
  xpBaseImage: "",
  qemuBin: isWin ? "C:\\Program Files\\qemu\\qemu-system-i386.exe" : "qemu-system-i386",
  xpMemoryMb: 512,
  xpMaxVms: 2,
  xpNetwork: "none",
  xpAccel: "",       // "" = auto (plain emulation on Windows; WHPX crashes 32-bit XP)
  xpCpu: "pentium3", // newer CPU models make XP blue-screen with STOP 0xA
  xpAcpi: false,     // must match how XP was installed
  xpShare: true,
  xpShareBus: "usb", // "usb" (allows checkpoints/undo) or "ide" (an extra hard disk, the old way)
  searchProvider: "", // "", "brave", "tavily", "searxng"
  searxngUrl: "",
  webAllowPrivate: false,
  chatLogs: false, // keep a log file of every conversation (data folder → logs)
  xpInstantBoot: true, // start XP machines from a saved desktop once one has been prepared
  checkUpdates: true,  // look for a new version on GitHub at startup
  skipVersion: "",     // "Skip this version" in the update window
};

// provider id → env vars the server reads (see server/src/providers.ts)
const KEY_ENV = {
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", ollama: "OLLAMA_API_KEY", openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY", groq: "GROQ_API_KEY", custom: "CUSTOM_API_KEY",
  brave: "BRAVE_API_KEY", tavily: "TAVILY_API_KEY", // web search
};
const URL_ENV = { openai: "OPENAI_BASE_URL", ollama: "OLLAMA_BASE_URL", lmstudio: "LMSTUDIO_BASE_URL", custom: "CUSTOM_BASE_URL" };
// providers you sign in to instead of pasting a key (handled by the server, see server/src/chatgpt.ts)
const SIGN_IN = new Set(["chatgpt"]);

function readSettings() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; }
  catch { s = { ...DEFAULTS }; }
  s.keys ??= {};
  // migrate the single Anthropic key from older versions
  if (s.apiKeyEnc || s.apiKeyPlain) {
    s.keys.anthropic ??= s.apiKeyEnc ? { enc: s.apiKeyEnc } : { plain: s.apiKeyPlain };
    delete s.apiKeyEnc; delete s.apiKeyPlain;
  }
  return s;
}

function decodeKey(k) {
  if (!k) return "";
  if (k.enc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(k.enc, "base64")); } catch { return ""; }
  }
  return k.plain || "";
}
function encodeKey(v) {
  return safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(v).toString("base64") } : { plain: v }; // plain e.g. Linux without a keyring
}

function writeSettings(input) {
  const next = readSettings();
  for (const k of Object.keys(DEFAULTS)) if (k in input && k !== "baseUrls") next[k] = input[k];
  next.xpMemoryMb = Math.max(128, Math.min(4096, Number(next.xpMemoryMb) || 512));
  next.xpMaxVms = Math.max(1, Math.min(8, Number(next.xpMaxVms) || 2));
  if (!["none", "restricted", "user"].includes(next.xpNetwork)) next.xpNetwork = "none";
  if (!(next.provider in KEY_ENV) && !(next.provider in URL_ENV) && !SIGN_IN.has(next.provider)) next.provider = "anthropic";
  if (!["", "tcg", "whpx", "kvm", "hvf"].includes(next.xpAccel)) next.xpAccel = "";
  if (!["pentium3", "coreduo", "qemu32", "max"].includes(next.xpCpu)) next.xpCpu = "pentium3";
  next.xpAcpi = !!next.xpAcpi;
  next.xpShare = next.xpShare !== false;
  if (!["usb", "ide"].includes(next.xpShareBus)) next.xpShareBus = "usb";
  if (!["", "brave", "tavily", "searxng"].includes(next.searchProvider)) next.searchProvider = "";
  next.searxngUrl = /^https?:\/\//.test(String(next.searxngUrl || "").trim()) ? String(next.searxngUrl).trim() : "";
  next.webAllowPrivate = !!next.webAllowPrivate;
  next.chatLogs = !!next.chatLogs;
  next.xpInstantBoot = next.xpInstantBoot !== false;
  next.checkUpdates = next.checkUpdates !== false;
  next.skipVersion = String(next.skipVersion || "").slice(0, 40);
  for (const [id, v] of Object.entries(input.baseUrls || {})) {
    if (!(id in URL_ENV)) continue;
    const url = String(v || "").trim();
    if (url && !/^https?:\/\//.test(url)) continue;
    if (url) next.baseUrls[id] = url; else delete next.baseUrls[id];
  }
  for (const [id, v] of Object.entries(input.keys || {})) {
    if (id in KEY_ENV && typeof v === "string" && v.trim()) next.keys[id] = encodeKey(v.trim());
  }
  for (const id of input.clearKeys || []) delete next.keys[id];
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

function applySettingsToEnv() {
  const s = readSettings();
  // Saved keys win; an env var you already had set still works if nothing is saved.
  for (const [id, env] of Object.entries(KEY_ENV)) { const v = decodeKey(s.keys[id]); if (v) process.env[env] = v; }
  for (const [id, env] of Object.entries(URL_ENV)) if (s.baseUrls?.[id]) process.env[env] = s.baseUrls[id];
  process.env.Y2K_PROVIDER = s.provider || "anthropic";
  if (s.model) process.env.Y2K_MODEL = s.model; else delete process.env.Y2K_MODEL;
  process.env.XP_BASE_IMAGE = s.xpBaseImage || process.env.XP_BASE_IMAGE || "";
  process.env.QEMU_BIN = s.qemuBin || DEFAULTS.qemuBin;
  process.env.XP_MEMORY_MB = String(s.xpMemoryMb);
  process.env.XP_MAX_VMS = String(s.xpMaxVms);
  process.env.XP_NETWORK = s.xpNetwork;
  if (s.xpAccel) process.env.XP_ACCEL = s.xpAccel; else delete process.env.XP_ACCEL;
  process.env.XP_CPU = s.xpCpu || "pentium3";
  process.env.XP_ACPI = s.xpAcpi ? "on" : "off";
  process.env.XP_SHARE = s.xpShare === false ? "0" : "1";
  process.env.XP_SHARE_BUS = s.xpShareBus === "ide" ? "ide" : "usb";
  process.env.SEARCH_PROVIDER = s.searchProvider || "";
  if (s.searxngUrl) process.env.SEARXNG_URL = s.searxngUrl;
  process.env.WEB_ALLOW_PRIVATE = s.webAllowPrivate ? "1" : "0";
  process.env.CHAT_LOGS = s.chatLogs ? "1" : "0";
  process.env.XP_INSTANT_BOOT = s.xpInstantBoot === false ? "0" : "1";
}

// ---------------- windows ----------------
const SIZES = {
  signon: [250, 470], buddylist: [240, 580], im: [440, 420], viewer: [720, 620],
  info: [380, 420], editor: [420, 720], help: [400, 380], prefs: [470, 860],
  room: [620, 480], invite: [330, 420], mcp: [500, 600], bench: [720, 780], skills: [480, 620], approve: [420, 330], update: [400, 360], gallery: [460, 600],
};
const FIXED = new Set(["signon", "info", "help", "approve", "update"]);
const wins = new Map(); // "view:arg" -> BrowserWindow
let base = "";
let srv = null;
let tray = null;
let cascade = 0;
let quitting = false;

function placement(view, w, h) {
  const wa = screen.getPrimaryDisplay().workArea;
  if (view === "buddylist") return { x: wa.x + wa.width - w - 24, y: wa.y + 24 };
  if (["signon", "prefs", "editor", "help", "info", "invite", "mcp", "skills", "approve", "update", "gallery"].includes(view))
    return { x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + Math.max(20, (wa.height - h) / 2)) };
  if (view === "viewer") return { x: wa.x + Math.max(20, wa.width - w - 300), y: wa.y + 40 };
  const n = cascade++ % 8;
  return { x: wa.x + 60 + n * 28, y: wa.y + 50 + n * 26 };
}

function open({ view, arg = "", focus = true }) {
  if (!SIZES[view]) return;
  const key = `${view}:${arg}`;
  const existing = wins.get(key);
  if (existing && !existing.isDestroyed()) {
    if (focus) { if (existing.isMinimized()) existing.restore(); existing.show(); existing.focus(); }
    else if (!existing.isFocused()) existing.flashFrame(true);
    return;
  }
  const [width, height] = SIZES[view];
  const win = new BrowserWindow({
    width, height, ...placement(view, width, height),
    minWidth: 220, minHeight: 160,
    frame: false,
    // Transparent windows give the rounded XP title bar corners, but can't be resized on Windows.
    transparent: !isWin,
    backgroundColor: isWin ? "#0831d9" : "#00000000",
    resizable: !FIXED.has(view),
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Y2Kbot",
    icon: path.join(root, "assets/icon.png"),
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.loadURL(`${base}?view=${view}&arg=${encodeURIComponent(arg)}`);
  win.once("ready-to-show", () => {
    if (focus) win.show();
    else { win.showInactive(); win.flashFrame(true); }
  });
  win.on("focus", () => win.flashFrame(false));
  win.on("closed", () => {
    wins.delete(key);
    if (view === "buddylist" && !quitting) signOff();
  });
  // Links in chats open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(base)) { e.preventDefault(); shell.openExternal(url); } });
  wins.set(key, win);
  return win;
}

function signOff() {
  for (const [k, w] of wins) if (!k.startsWith("signon:") && !w.isDestroyed()) w.destroy();
  open({ view: "signon" });
}

function setupTray() {
  const img = nativeImage.createFromPath(path.join(root, "assets/tray.png")).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip("Y2Kbot");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Agent List", click: () => (wins.has("buddylist:") ? open({ view: "buddylist" }) : open({ view: "signon" })) },
    { label: "Preferences…", click: () => open({ view: "prefs" }) },
    { label: "Check for Updates…", click: () => checkForUpdates(true) },
    { type: "separator" },
    { label: "Sign Off", click: signOff },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.on("click", () => (wins.has("buddylist:") ? open({ view: "buddylist" }) : open({ view: "signon" })));
}

// ---------------- IPC ----------------
const fromEvent = (e) => BrowserWindow.fromWebContents(e.sender);
ipcMain.on("y2k:open", (_e, o) => open(o || {}));
ipcMain.on("y2k:close", (e) => fromEvent(e)?.close());
ipcMain.on("y2k:minimize", (e) => fromEvent(e)?.minimize());
ipcMain.on("y2k:flash", (e) => { const w = fromEvent(e); if (w && !w.isFocused()) w.flashFrame(true); });
// Size a dialog to its content, as tall as the screen allows, and keep it fully on screen.
ipcMain.on("y2k:fit", (e, h) => {
  const w = fromEvent(e);
  if (!w || !Number.isFinite(h)) return;
  const wa = screen.getDisplayMatching(w.getBounds()).workArea;
  const frame = w.getSize()[1] - w.getContentSize()[1]; // 0 for our frameless windows, but just in case
  const [cw] = w.getContentSize();
  w.setContentSize(cw, Math.max(120, Math.min(Math.round(h), wa.height - frame - 16)));
  const b = w.getBounds();
  const y = Math.max(wa.y + 8, Math.min(b.y, wa.y + wa.height - b.height - 8));
  if (y !== b.y) w.setPosition(b.x, y);
});
ipcMain.on("y2k:signedOn", (e) => { open({ view: "buddylist" }); fromEvent(e)?.close(); });
ipcMain.on("y2k:signOff", () => signOff());
ipcMain.on("y2k:relaunch", () => { app.relaunch(); app.quit(); });
// Only folders inside the app's own data folder (the buddies' shared folders) can be opened.
// Folders, never files: opening a .bat or .exe an agent wrote there would run it.
ipcMain.on("y2k:openPath", (_e, p) => {
  const target = path.resolve(String(p || ""));
  const root = path.resolve(userDir()) + path.sep;
  if (target.startsWith(root) && fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) shell.openPath(target);
});
// Folders inside the data folder the UI may open (created if missing).
ipcMain.on("y2k:openDataFolder", (_e, sub) => {
  if (!["logs", "shared", "memory", "bench"].includes(sub)) return;
  const dir = path.join(userDir(), sub);
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});
ipcMain.handle("y2k:saveText", async (e, o = {}) => {
  const r = await dialog.showSaveDialog(fromEvent(e), { defaultPath: path.join(app.getPath("documents"), String(o.defaultName || "untitled.txt").replace(/[\\/:*?"<>|]/g, "_")), filters: o.filters });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, String(o.text ?? ""));
  return r.filePath;
});
ipcMain.handle("y2k:openText", async (e, o = {}) => {
  const r = await dialog.showOpenDialog(fromEvent(e), { properties: ["openFile"], filters: o.filters, title: o.title });
  if (r.canceled || !r.filePaths[0]) return null;
  const f = r.filePaths[0];
  if (fs.statSync(f).size > 1024 * 1024) throw new Error("That file is too big.");
  return { name: path.basename(f), text: fs.readFileSync(f, "utf8") };
});
ipcMain.handle("y2k:readClipboard", () => clipboard.readText());
ipcMain.handle("y2k:getSettings", () => {
  const { keys, ...rest } = readSettings();
  // never send keys back to the UI, only whether each one is set
  const keysSet = Object.fromEntries(Object.entries(KEY_ENV).map(([id, env]) => [id, !!decodeKey(keys[id]) || !!process.env[env]]));
  return { ...rest, keysSet, health: srv ? { demoMode: srv.demoMode, xp: srv.xp, provider: srv.provider, model: srv.model, providers: srv.providers } : null };
});
ipcMain.handle("y2k:saveSettings", (_e, s) => { writeSettings(s || {}); return true; });
ipcMain.handle("y2k:pickFile", async (e, o = {}) => {
  const r = await dialog.showOpenDialog(fromEvent(e), { properties: ["openFile"], filters: o.filters, title: o.title });
  return r.canceled ? null : r.filePaths[0];
});

// ---------------- lifecycle ----------------
app.on("second-instance", () => (wins.has("buddylist:") ? open({ view: "buddylist" }) : open({ view: "signon" })));
app.on("before-quit", () => { quitting = true; srv?.close(); });
app.on("window-all-closed", () => { if (!isMac) app.quit(); });
app.on("activate", () => { if (firstInstance && base && wins.size === 0) open({ view: "signon" }); });

app.whenReady().then(async () => {
  if (!firstInstance) return;
  applySettingsToEnv();
  // First run: copy the starter agent list somewhere writable.
  const agentsFile = path.join(userDir(), "agents.json");
  if (!fs.existsSync(agentsFile)) {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.copyFileSync(path.join(root, "server/agents.json"), agentsFile);
  }
  const { startServer } = await import(pathToFileURL(path.join(root, "dist/server.js")).href);
  const preferred = Number(process.env.Y2K_PORT || 47823); // fixed port keeps your saved screen name
  const dataDir = userDir(); // memory notes + shared folders live next to settings.json
  // Sign-in tokens (ChatGPT plan) are encrypted with the OS keychain, like API keys.
  const secrets = safeStorage.isEncryptionAvailable()
    ? { encrypt: (t) => safeStorage.encryptString(t).toString("base64"), decrypt: (t) => safeStorage.decryptString(Buffer.from(t, "base64")) }
    : undefined;
  try { srv = await startServer({ port: preferred, host: "127.0.0.1", agentsFile, dataDir, secrets }); }
  catch { srv = await startServer({ port: 0, host: "127.0.0.1", agentsFile, dataDir, secrets }); }
  base = `http://127.0.0.1:${srv.port}/`;
  if (isMac) app.dock?.setIcon(path.join(root, "assets/icon.png"));
  setupTray();
  open({ view: "signon" });
  if (readSettings().checkUpdates !== false) {
    setTimeout(() => checkForUpdates(false), 15_000);
    setInterval(() => checkForUpdates(false), 6 * 60 * 60_000).unref();
  }
});

// ---------------- updates ----------------
// New versions come from GitHub Releases (the "publish" setting in package.json). Windows and the
// Linux AppImage download and install them; macOS builds aren't code-signed, which macOS requires
// for self-updating, so there the update window links to the download page instead.
const RELEASES = "https://github.com/tatethedeveloper/Y2KBot/releases/latest";
const update = { state: "idle", current: app.getVersion(), version: "", notes: "", percent: 0, error: "", manual: false };
let updater = null;
const canSelfUpdate = () => app.isPackaged && (isWin || (process.platform === "linux" && !!process.env.APPIMAGE));

function setUpdate(patch) {
  Object.assign(update, patch);
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("y2k:update", update);
}

async function getUpdater() {
  if (updater) return updater;
  const { default: pkg } = await import("electron-updater");
  updater = pkg.autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.logger = null;
  updater.on("update-available", (info) => {
    const notes = Array.isArray(info.releaseNotes) ? info.releaseNotes.map((n) => n.note || "").join("\n\n") : String(info.releaseNotes || "");
    setUpdate({ state: "available", version: info.version, notes: htmlToText(notes), error: "", manual: !canSelfUpdate() });
  });
  updater.on("update-not-available", () => setUpdate({ state: "none", error: "" }));
  updater.on("download-progress", (p) => setUpdate({ state: "downloading", percent: Math.round(p.percent || 0) }));
  updater.on("update-downloaded", () => setUpdate({ state: "ready", percent: 100 }));
  updater.on("error", (e) => setUpdate({ state: "error", error: String(e?.message || e).split("\n")[0].slice(0, 300) }));
  return updater;
}

/** @param {boolean} asked true when you picked "Check for Updates…" (always show the window then) */
async function checkForUpdates(asked) {
  if (!app.isPackaged) {
    if (asked) { setUpdate({ state: "error", error: "Updates only work in the installed app. You're running from source: use git pull." }); open({ view: "update" }); }
    return;
  }
  if (["checking", "downloading", "ready"].includes(update.state)) { if (asked) open({ view: "update" }); return; }
  setUpdate({ state: "checking", error: "" });
  if (asked) open({ view: "update" });
  try {
    await (await getUpdater()).checkForUpdates();
  } catch (e) {
    setUpdate({ state: "error", error: String(e?.message || e).split("\n")[0].slice(0, 300) });
  }
  // Only interrupt you unasked for a version you haven't skipped.
  if (!asked && update.state === "available" && update.version !== readSettings().skipVersion) open({ view: "update", focus: false });
}

function htmlToText(html) {
  return String(html)
    .replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "• ").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
}

ipcMain.handle("y2k:update:get", () => update);
ipcMain.on("y2k:update:check", () => checkForUpdates(true));
ipcMain.on("y2k:update:download", async () => {
  if (update.state !== "available") return;
  if (update.manual) { shell.openExternal(RELEASES); return; }
  setUpdate({ state: "downloading", percent: 0 });
  try { await (await getUpdater()).downloadUpdate(); }
  catch (e) { setUpdate({ state: "error", error: String(e?.message || e).split("\n")[0].slice(0, 300) }); }
});
ipcMain.on("y2k:update:install", () => {
  if (update.state !== "ready" || !updater) return;
  quitting = true;
  srv?.close();
  setImmediate(() => updater.quitAndInstall(false, true));
});
ipcMain.on("y2k:update:skip", () => {
  if (update.version) writeSettings({ skipVersion: update.version });
});
ipcMain.on("y2k:update:releases", () => shell.openExternal(RELEASES));
