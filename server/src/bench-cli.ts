// Run Y2Kbench without the app window:
//   npm run bench -- --provider ollama --model qwen3-vl:8b [--tasks make-file,rename-file] [--repeat 3] [--coords auto|pixels|norm1000]
//
// It reuses the settings you saved in the desktop app (XP disk, QEMU, CPU/ACPI, Ollama/LM Studio/custom URLs,
// web search URL) and saves results into the app's data folder, so runs show up in Bench → History.
// Env vars still win if you set them. API keys can't be read here (the app stores them encrypted with
// your OS keychain), so cloud providers need their key as an env var, e.g. $env:ANTHROPIC_API_KEY="...".
// The same goes for Sign in with ChatGPT: to bench on your ChatGPT plan, use the app's Bench window.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const usage = "usage: npm run bench -- --provider <id> --model <name> [--tasks a,b] [--repeat n] [--coords auto|pixels|norm1000] [--label text] [--data folder] [--list]";
if (args.includes("--help")) { console.log(usage); process.exit(0); }

// ---- the desktop app's data folder (same place Electron uses)
function appDataDir(): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Y2Kbot");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Y2Kbot");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Y2Kbot");
}
const dataDir = arg("data") ?? appDataDir();

// ---- apply the app's saved (non-secret) settings, unless an env var already says otherwise
const settingsFile = path.join(dataDir, "settings.json");
let usedSettings = false;
if (existsSync(settingsFile)) {
  try {
    const s = JSON.parse(readFileSync(settingsFile, "utf8"));
    const set = (env: string, v: unknown) => { if (v !== undefined && v !== null && v !== "" && process.env[env] === undefined) process.env[env] = String(v); };
    set("RAM_PROVIDER", s.provider);
    set("RAM_MODEL", s.model);
    set("XP_BASE_IMAGE", s.xpBaseImage);
    set("QEMU_BIN", s.qemuBin);
    set("XP_MEMORY_MB", s.xpMemoryMb);
    set("XP_MAX_VMS", s.xpMaxVms);
    set("XP_NETWORK", s.xpNetwork);
    set("XP_ACCEL", s.xpAccel);
    set("XP_CPU", s.xpCpu);
    if (s.xpAcpi !== undefined) set("XP_ACPI", s.xpAcpi ? "on" : "off");
    if (s.xpShare !== undefined) set("XP_SHARE", s.xpShare === false ? "0" : "1");
    if (s.xpShareBus) set("XP_SHARE_BUS", s.xpShareBus);
    const urls = s.baseUrls || {};
    set("OPENAI_BASE_URL", urls.openai);
    set("OLLAMA_BASE_URL", urls.ollama);
    set("LMSTUDIO_BASE_URL", urls.lmstudio);
    set("CUSTOM_BASE_URL", urls.custom);
    set("SEARCH_PROVIDER", s.searchProvider);
    set("SEARXNG_URL", s.searxngUrl);
    usedSettings = true;
  } catch (e) {
    console.warn(`Couldn't read ${settingsFile}: ${(e as Error).message}`);
  }
}

// imported after the env is set, because the server reads its config at start-up
const { startServer } = await import("./server.js");
const { toMarkdown } = await import("./bench.js");

const srv = await startServer({ port: 0, dataDir, agentsFile: existsSync(path.join(dataDir, "agents.json")) ? path.join(dataDir, "agents.json") : undefined });
const { bench } = srv;

if (args.includes("--list")) {
  for (const t of bench.tasksFile().tasks) console.log(`${t.id.padEnd(18)} ${t.level.padEnd(7)} ${t.title}`);
  srv.close(); setTimeout(() => process.exit(0), 300);
} else {
  if (!arg("model")) { console.log(usage); srv.close(); setTimeout(() => process.exit(1), 300); }
  else await main();
}

async function main() {
  console.log(`Y2Kbench: data folder ${dataDir}${usedSettings ? " (using the app's saved settings)" : ""}`);
  console.log(`XP: ${srv.xp.ok ? `ready (CPU ${srv.xp.cpu}, ACPI ${srv.xp.acpi ? "on" : "off"}, accel ${srv.xp.accel})` : srv.xp.problems.join(" ")}`);
  console.log("Tip: don't run a benchmark from the app at the same time.\n");

  const icons: Record<string, string> = { pass: "PASS", fail: "FAIL", error: "ERR ", stopped: "STOP" };
  bench.on("progress", (p: any) => {
    if (p.phase === "done") {
      const r = p.result;
      console.log(`[${p.index + 1}/${p.total}] ${icons[r.status]} ${r.id.padEnd(18)} ${(r.ms / 1000).toFixed(0).padStart(4)}s ${String(r.toolCalls).padStart(3)} steps  ${r.error ?? r.checks.filter((c: any) => !c.ok).map((c: any) => `${c.label}: ${c.detail}`).join("; ")}`);
    } else if (!p.event) console.log(`[${p.index + 1}/${p.total}] ${p.task}: ${p.phase}`);
  });
  process.on("SIGINT", () => { console.log("\nstopping…"); bench.stop(); });

  try {
    const rec = await bench.run({
      provider: arg("provider") ?? process.env.RAM_PROVIDER ?? "anthropic",
      model: arg("model")!,
      coords: arg("coords") as any,
      taskIds: arg("tasks")?.split(",").map((s) => s.trim()).filter(Boolean),
      repeat: Number(arg("repeat") ?? 1),
      label: arg("label"),
    });
    console.log(`\n${rec.label}: ${rec.summary.pass}/${rec.summary.total} passed\n`);
    console.log(toMarkdown([rec], bench.tasksFile().tasks));
    console.log(`\nSaved to ${path.join(dataDir, "bench", "runs")}. It also shows up in the app under Bench → History.`);
  } catch (e) {
    console.error("bench failed:", (e as Error).message);
    process.exitCode = 1;
  } finally {
    srv.close();
    setTimeout(() => process.exit(), 500);
  }
}
