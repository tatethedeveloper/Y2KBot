// Y2Kbench: a repeatable set of Windows XP tasks for measuring how well an agent drives XP.
//
// For each task:
//   1. clean the benchmark agent's shared folder and write fixtures + a setup and a check batch file
//   2. boot a fresh XP machine (snapshot mode, so every task starts clean) and wait for the desktop
//   3. run the setup batch inside XP, then give the agent the task (with a time limit)
//   4. run the check batch inside XP; it writes its findings to the shared drive
//   5. shut down, read the findings from the shared folder on this computer, score the task
//
// A task "fails" when the agent didn't do it; it's an "error" when the benchmark itself couldn't
// run or read its checks (so harness trouble doesn't count against the model).
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentStore, type Agent } from "./agents.js";
import { Runner, type Bus, type Extras } from "./runner.js";
import type { ProviderRegistry } from "./providers.js";
import type { MemoryStore } from "./memory.js";
import type { XPManager } from "./vm/xp.js";

export const BENCH_AGENT = "y2kbench";
const RESULT_FILE = "_y2kbench_result.txt";
const SETUP_BAT = "_y2kbench_setup.bat";
const CHECK_BAT = "_y2kbench_check.bat";

// ---------------------------------------------------------------- task format
export type Expect = { contains?: string | string[]; notContains?: string | string[]; regex?: string; equals?: string };
export type Check =
  | { label: string; probe: string; expect?: Expect; matchReply?: boolean } // command run inside XP
  | { label: string; reply: Expect }                                      // the agent's final reply
  | { label: string; sharedFile: string; expect: Expect };                // a file in the shared folder
export interface Task {
  id: string; title: string; level: "easy" | "medium" | "hard"; prompt: string;
  setup?: { xp?: string[]; shared?: Record<string, string> };
  checks: Check[];
  timeoutMin?: number;
}
export interface TaskFile { name: string; version: number; words: string[]; tasks: Task[] }

export interface CheckResult { label: string; ok: boolean; detail: string }
export interface TaskResult {
  id: string; title: string; level: Task["level"];
  status: "pass" | "fail" | "error" | "stopped";
  checks: CheckResult[];
  ms: number; toolCalls: number; reply: string; error?: string; screenshot?: string;
  log: string[];
}
export interface RunRecord {
  id: string; startedAt: string; finishedAt?: string; label: string;
  provider: string; model: string; coords: string;
  /** could the agent use xp_cmd / saved skills? (older runs: undefined = GUI only, no skills) */
  cmd?: boolean; skills?: boolean;
  tasks: TaskResult[];
  summary: { pass: number; total: number; byLevel: Record<string, { pass: number; total: number }> };
}
export interface RunOptions {
  provider: string; model: string; coords?: "auto" | "pixels" | "norm1000";
  taskIds?: string[]; repeat?: number; label?: string;
  bootTimeoutMin?: number;
  /** let the agent use xp_cmd (default on) */
  cmd?: boolean;
  /** let the agent use and save skills (default off, so runs stay comparable) */
  skills?: boolean;
}

// ---------------------------------------------------------------- helpers
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
const lc = (s: string) => s.toLowerCase();
const arr = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function evaluate(text: string, e: Expect): { ok: boolean; detail: string } {
  const t = text.replace(/\r\n/g, "\n").trim();
  for (const c of arr(e.contains)) if (!lc(t).includes(lc(c))) return { ok: false, detail: `expected to contain "${c}"` };
  for (const c of arr(e.notContains)) if (lc(t).includes(lc(c))) return { ok: false, detail: `should not contain "${c}"` };
  if (e.regex && !new RegExp(e.regex, "im").test(t)) return { ok: false, detail: `didn't match /${e.regex}/` };
  if (e.equals !== undefined && lc(t) !== lc(e.equals)) return { ok: false, detail: `expected "${e.equals}"` };
  return { ok: true, detail: "ok" };
}

/** Split the check batch's output into one string per probe. */
export function parseProbeOutput(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  const parts = raw.replace(/\r\n/g, "\n").split(/^===Y2K (\d+|END)===\s*$/m);
  for (let i = 1; i < parts.length; i += 2) if (parts[i] !== "END") out.set(Number(parts[i]), (parts[i + 1] ?? "").trim());
  return out;
}

export function checkBatch(task: Task): string {
  const lines = ["@echo off", `set OUT=%~d0\\${RESULT_FILE}`, 'echo ===Y2K START===> "%OUT%"'];
  task.checks.forEach((c, i) => {
    if (!("probe" in c)) return;
    lines.push(`echo ===Y2K ${i}===>> "%OUT%"`);
    lines.push(`(${c.probe}) >> "%OUT%" 2>&1`);
  });
  lines.push('echo ===Y2K END===>> "%OUT%"');
  return crlf(lines.join("\n") + "\n");
}

export function setupBatch(task: Task): string {
  return crlf([
    "@echo off", "md C:\\work 2>nul", ...(task.setup?.xp ?? []), `echo done> "%~d0\\_y2kbench_setup_done.txt"`,
    // tell the benchmark which letter the shared drive got (it differs between USB and hard-disk setups)
    "mode COM1 BAUD=115200 >nul 2>&1", "echo y2kdrive %~d0>COM1",
  ].join("\n") + "\n");
}

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");

// ---------------------------------------------------------------- fixtures
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A tiny zip writer (stored, no compression), enough for XP's built-in "Extract All". */
export function makeZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "latin1");
    const nm = Buffer.from(name, "latin1"), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); // time/date: 1980-01-01
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm);
    offset += lh.length + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A small VBScript "installer": licence Yes/No, an install-folder box, a done message. */
const INSTALL_VBS = crlf(`' Y2K Demo setup: a pretend installer used by Y2Kbench
Option Explicit
Dim fso, r, dest, f
Set fso = CreateObject("Scripting.FileSystemObject")
r = MsgBox("Welcome to Y2K Demo Setup." & vbCrLf & vbCrLf & _
  "Y2K Demo licence: you may use this demo for testing only." & vbCrLf & vbCrLf & _
  "Do you accept the licence agreement?", vbYesNo + vbQuestion, "Y2K Demo Setup")
If r <> vbYes Then
  MsgBox "Setup was cancelled. Y2K Demo was not installed.", vbExclamation, "Y2K Demo Setup"
  WScript.Quit
End If
dest = InputBox("Choose the folder to install Y2K Demo into:", "Y2K Demo Setup", "C:\\Program Files\\Y2K Demo")
If dest = "" Then
  MsgBox "Setup was cancelled. Y2K Demo was not installed.", vbExclamation, "Y2K Demo Setup"
  WScript.Quit
End If
If Not fso.FolderExists(dest) Then fso.CreateFolder dest
Set f = fso.CreateTextFile(dest & "\\installed.txt", True)
f.WriteLine "Y2K Demo installed " & Now
f.Close
MsgBox "Y2K Demo was installed to " & dest & ".", vbInformation, "Y2K Demo Setup"
`);

export function fixture(name: string): Buffer {
  if (name === "install.vbs") return Buffer.from(INSTALL_VBS, "latin1");
  if (name === "archive.zip") return makeZip({ "readme.txt": "Unpacked by Y2Kbot\r\n", "data.csv": "id,name\r\n1,alpha\r\n2,beta\r\n" });
  throw new Error(`Unknown fixture ${name}`);
}

// ---------------------------------------------------------------- the runner
export class Bench extends EventEmitter {
  private running: { id: string; stop: boolean; bootMs: number } | null = null;
  private dir: string;

  constructor(
    private o: {
      projectRoot: string; dataDir: string; vms: XPManager; providers: ProviderRegistry;
      memory: MemoryStore; extras: Extras;
    },
  ) {
    super();
    this.dir = path.join(o.dataDir, "bench");
    mkdirSync(path.join(this.dir, "runs"), { recursive: true });
  }

  tasksFile(): TaskFile {
    const own = path.join(this.dir, "tasks.json"); // your own copy overrides the bundled one
    const file = existsSync(own) ? own : path.join(this.o.projectRoot, "server", "bench", "tasks.json");
    return JSON.parse(readFileSync(file, "utf8"));
  }

  get busy() { return this.running?.id ?? null; }

  history(): RunRecord[] {
    const runs = path.join(this.dir, "runs");
    return readdirSync(runs).filter((f) => f.endsWith(".json")).map((f) => {
      try { return JSON.parse(readFileSync(path.join(runs, f), "utf8")) as RunRecord; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b!.startedAt.localeCompare(a!.startedAt)) as RunRecord[];
  }

  screenshotPath(runId: string, file: string) {
    const p = path.join(this.dir, "runs", path.basename(runId), path.basename(file));
    return existsSync(p) ? p : null;
  }

  deleteRun(runId: string) {
    const base = path.join(this.dir, "runs", path.basename(runId));
    rmSync(base + ".json", { force: true });
    rmSync(base, { recursive: true, force: true });
  }

  stop() {
    if (!this.running) return;
    this.running.stop = true;
    this.runner?.stop(BENCH_AGENT);
    this.o.vms.shutdown(BENCH_AGENT).catch(() => {});
  }

  private runner: Runner | null = null;

  async run(opts: RunOptions): Promise<RunRecord> {
    if (this.running) throw new Error("A benchmark is already running.");
    const doc = this.tasksFile();
    let tasks = doc.tasks.filter((t) => !opts.taskIds?.length || opts.taskIds.includes(t.id));
    if (!tasks.length) throw new Error("No tasks selected.");
    const repeat = Math.max(1, Math.min(10, opts.repeat ?? 1));
    tasks = tasks.flatMap((t) => Array.from({ length: repeat }, () => t));
    const doc0 = this.o.vms.doctor();
    if (!doc0.ok) throw new Error(`Windows XP isn't ready: ${doc0.problems.join(" ")}`);
    if (!this.o.vms.sharedDir(BENCH_AGENT)) throw new Error("Y2Kbench needs shared folders turned on (Prefs → Windows XP machines).");

    const route = this.o.providers.resolve({ provider: opts.provider, model: opts.model }, { provider: opts.provider, model: opts.model });
    if (!route.provider.ready) throw new Error(`${route.provider.label} isn't set up.`);

    const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "_" + opts.model.replace(/[^\w.-]+/g, "_").slice(0, 40);
    const rec: RunRecord = {
      id, startedAt: new Date().toISOString(), label: opts.label || `${route.provider.label} · ${opts.model}${opts.cmd === false ? " · GUI only" : ""}${opts.skills ? " · skills" : ""}`,
      provider: opts.provider, model: opts.model, coords: opts.coords ?? "auto", cmd: opts.cmd !== false, skills: !!opts.skills, tasks: [],
      summary: { pass: 0, total: 0, byLevel: {} },
    };
    this.running = { id, stop: false, bootMs: (opts.bootTimeoutMin ?? 8) * 60000 };
    mkdirSync(path.join(this.dir, "runs", id), { recursive: true });

    // The benchmark agent lives in its own store so it never shows up in (or changes) your agent list.
    const store = new AgentStore(path.join(this.dir, "agent.json"));
    const agent: Agent = {
      screenName: BENCH_AGENT, group: "Bench", color: "#185fa5", profile: "", awayMessage: null,
      capabilities: { xp: true, imBuddies: false, memory: false, web: false, xpCmd: opts.cmd !== false, skills: !!opts.skills },
      persona: "You are an operator agent completing one task on a Windows XP machine. Work step by step, check the screen after each action, and verify the result before you say you're done.",
      provider: opts.provider, model: opts.model, coords: opts.coords ?? "auto", mcp: [], lockVm: true,
    };
    store.upsert(agent);

    try {
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const result = this.running.stop
          ? ({ id: task.id, title: task.title, level: task.level, status: "stopped", checks: [], ms: 0, toolCalls: 0, reply: "", log: [] } as TaskResult)
          : await this.runTask(task, doc, store, route.model, rec, i, tasks.length);
        rec.tasks.push(result);
        this.summarise(rec);
        this.save(rec);
        this.emit("progress", { runId: id, index: i, total: tasks.length, task: task.id, phase: "done", result, summary: rec.summary });
      }
    } finally {
      rec.finishedAt = new Date().toISOString();
      this.summarise(rec);
      this.save(rec);
      this.running = null;
      this.runner = null;
      await this.o.vms.shutdown(BENCH_AGENT).catch(() => {});
      this.emit("finished", rec);
    }
    return rec;
  }

  private summarise(rec: RunRecord) {
    const scored = rec.tasks.filter((t) => t.status === "pass" || t.status === "fail");
    const byLevel: RunRecord["summary"]["byLevel"] = {};
    for (const t of scored) {
      byLevel[t.level] ??= { pass: 0, total: 0 };
      byLevel[t.level].total++;
      if (t.status === "pass") byLevel[t.level].pass++;
    }
    rec.summary = { pass: scored.filter((t) => t.status === "pass").length, total: scored.length, byLevel };
  }

  private save(rec: RunRecord) {
    writeFileSync(path.join(this.dir, "runs", rec.id + ".json"), JSON.stringify(rec, null, 2));
  }

  /** Type a command into Start → Run inside XP (no agent involved). */
  private async runInXp(cmd: string) {
    const vms = this.o.vms;
    await vms.key(BENCH_AGENT, "win+r");
    await vms.settle(BENCH_AGENT, { maxMs: 8000 });
    await vms.key(BENCH_AGENT, "ctrl+a");
    await vms.type(BENCH_AGENT, cmd);
    await vms.key(BENCH_AGENT, "enter");
  }

  /** Find the batch file on whichever drive letter the shared folder got, and run it. */
  private runSharedBatch(name: string) {
    return this.runInXp(`cmd /c for %d in (D E F G H I J) do @if exist %d:\\${name} call %d:\\${name}`);
  }

  /** Wait for XP to finish booting: the screen stays the same for a while. */
  private async waitForDesktop(maxMs: number, stop: () => boolean) {
    const vms = this.o.vms;
    const start = Date.now();
    await sleep(20000);
    let still = 0;
    while (Date.now() - start < maxMs && !stop()) {
      const r = await vms.settle(BENCH_AGENT, { maxMs: 3000, intervalMs: 1000, minMs: 0 });
      still = r.settled ? still + 1 : 0;
      if (still >= 4) { await sleep(4000); return true; } // ~12s unchanged → booted
      await sleep(2000);
    }
    return false;
  }

  private async runTask(task: Task, doc: TaskFile, store: AgentStore, model: string, rec: RunRecord, index: number, total: number): Promise<TaskResult> {
    const vms = this.o.vms;
    const stopped = () => !!this.running?.stop;
    const started = Date.now();
    const log: string[] = [];
    const say = (phase: string) => { log.push(`${new Date().toISOString().slice(11, 19)} ${phase}`); this.emit("progress", { runId: rec.id, index, total, task: task.id, phase }); };
    const vars: Record<string, string> = { word: doc.words[Math.floor(Math.random() * doc.words.length)], share: "the shared drive" };
    const res: TaskResult = { id: task.id, title: task.title, level: task.level, status: "error", checks: [], ms: 0, toolCalls: 0, reply: "", log };

    try {
      // 1. fresh shared folder + fixtures + batch files
      const shared = vms.sharedDir(BENCH_AGENT)!;
      for (const f of readdirSync(shared)) rmSync(path.join(shared, f), { recursive: true, force: true });
      for (const [name, content] of Object.entries(task.setup?.shared ?? {})) {
        writeFileSync(path.join(shared, name), content.startsWith("@fixture:") ? fixture(content.slice(9)) : Buffer.from(fill(content, vars), "latin1"));
      }
      writeFileSync(path.join(shared, SETUP_BAT), setupBatch(task), "latin1");
      writeFileSync(path.join(shared, CHECK_BAT), checkBatch(task), "latin1");

      // 2. fresh XP
      await vms.shutdown(BENCH_AGENT).catch(() => {});
      for (let i = 0; i < 30 && vms.has(BENCH_AGENT); i++) await sleep(500);
      say("booting XP");
      await vms.boot(BENCH_AGENT);
      if (!(await this.waitForDesktop(this.running?.bootMs ?? 8 * 60000, stopped))) throw new Error(stopped() ? "stopped" : "XP didn't reach a steady desktop in time");

      // 3. setup inside XP (the setup script reports the shared drive's letter over COM1)
      say("setting up");
      const letter = vms.waitSerial(BENCH_AGENT, /y2kdrive ([A-Z]:)/i, 60_000);
      await this.runSharedBatch(SETUP_BAT);
      const drive = (await letter)?.[1]?.toUpperCase();
      (vars as Record<string, string>).share = drive ?? "the shared drive";
      log.push(drive ? `shared drive is ${drive}` : "the setup script didn't report the shared drive's letter (no COM1?)");
      await vms.settle(BENCH_AGENT, { maxMs: 15000 });
      await sleep(2000);
      if (stopped()) throw new Error("stopped");

      // 4. the agent's turn
      say("agent working");
      let toolCalls = 0;
      let agentError = "";
      const replies: string[] = [];
      const bus: Bus = {
        im: (_w, from, text) => { if (from === BENCH_AGENT) replies.push(text); },
        event: (_w, text) => { if (text.startsWith(`*** ${BENCH_AGENT} hit an error:`)) { agentError = text.replace(/^\*\*\* \S+ hit an error:\s*/, ""); log.push(text); return; } if (text.startsWith(BENCH_AGENT + " ")) { toolCalls++; log.push(`${new Date().toISOString().slice(11, 19)} ${text}`); this.emit("progress", { runId: rec.id, index, total, task: task.id, phase: "agent working", event: text, toolCalls }); } else log.push(text); },
        typing: () => {},
        status: () => {},
        presence: () => {},
      };
      this.runner = new Runner(store, vms, bus, this.o.providers, { provider: rec.provider, model }, this.o.memory, this.o.extras);
      const prompt = fill(task.prompt, vars) +
        "\n\nYour Windows XP machine is already switched on and logged in. Do not boot or shut it down. When the task is complete (and you've checked it), reply with a one-line summary.";
      const limit = (task.timeoutMin ?? (task.level === "hard" ? 15 : task.level === "medium" ? 10 : 6)) * 60000;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; this.runner?.stop(BENCH_AGENT); }, limit);
      try { await this.runner.send(BENCH_AGENT, prompt); } finally { clearTimeout(timer); }
      res.reply = replies.join("\n\n");
      res.toolCalls = toolCalls;
      if (timedOut) log.push(`time limit (${limit / 60000} min) reached`);
      if (stopped()) throw new Error("stopped");
      // the model provider failing (unreachable, bad key, out of credit) isn't the model's fault
      if (agentError && !timedOut) throw new Error(`the model provider failed: ${agentError}`);

      // final screenshot for the record
      try {
        const png = await vms.screenshot(BENCH_AGENT);
        const file = `${String(index + 1).padStart(2, "0")}-${task.id}.png`;
        writeFileSync(path.join(this.dir, "runs", rec.id, file), png);
        res.screenshot = file;
      } catch {}

      // 5. checks inside XP → result file on the shared drive
      const needsProbe = task.checks.some((c) => "probe" in c);
      let probeOut = new Map<number, string>();
      say("checking");
      if (needsProbe) {
        rmSync(path.join(shared, RESULT_FILE), { force: true });
        await vms.key(BENCH_AGENT, "esc").catch(() => {}); // close a stray menu if the agent left one open
        await this.runSharedBatch(CHECK_BAT);
        await vms.settle(BENCH_AGENT, { maxMs: 15000 });
        await sleep(6000); // let XP finish writing to the shared drive
      }
      await vms.shutdown(BENCH_AGENT, 3000);
      for (let i = 0; i < 30 && vms.has(BENCH_AGENT); i++) await sleep(500);
      if (needsProbe) {
        const f = path.join(shared, RESULT_FILE);
        if (!existsSync(f)) throw new Error("the check script's results never reached the shared folder (couldn't verify this task)");
        const raw = readFileSync(f, "latin1");
        if (!raw.includes("===Y2K END===")) throw new Error("the check script didn't finish (couldn't verify this task)");
        probeOut = parseProbeOutput(raw);
      }

      // 6. score
      task.checks.forEach((c, i) => {
        if ("reply" in c) {
          const e: Expect = JSON.parse(fill(JSON.stringify(c.reply), vars));
          res.checks.push({ label: c.label, ...evaluate(res.reply, e) });
        } else if ("sharedFile" in c) {
          const f = path.join(shared, path.basename(c.sharedFile));
          res.checks.push(existsSync(f) ? { label: c.label, ...evaluate(readFileSync(f, "latin1"), c.expect) } : { label: c.label, ok: false, detail: `${c.sharedFile} isn't in the shared folder` });
        } else {
          const out = probeOut.get(i) ?? "";
          if (c.matchReply) {
            const want = out.trim();
            res.checks.push(want && lc(res.reply).includes(lc(want)) ? { label: c.label, ok: true, detail: "ok" } : { label: c.label, ok: false, detail: `reply didn't include "${want}"` });
          } else res.checks.push({ label: c.label, ...evaluate(out, c.expect ?? {}) });
        }
      });
      res.status = res.checks.every((c) => c.ok) ? "pass" : "fail";
    } catch (e) {
      const msg = (e as Error).message;
      res.status = msg === "stopped" ? "stopped" : "error";
      if (msg !== "stopped") res.error = msg;
      await vms.shutdown(BENCH_AGENT).catch(() => {});
    } finally {
      res.ms = Date.now() - started;
    }
    return res;
  }
}

/** Markdown table of runs, for the README. */
export function toMarkdown(runs: RunRecord[], tasks?: Task[]): string {
  const pct = (p: number, t: number) => (t ? `${Math.round((p / t) * 100)}% (${p}/${t})` : "–");
  const lines = [
    "| Model | Tools | Easy | Medium | Hard | Overall | Date |",
    "|---|---|---|---|---|---|---|",
    ...runs.map((r) => {
      const b = r.summary.byLevel;
      const tools = [r.cmd ? "xp_cmd" : "GUI only", ...(r.skills ? ["skills"] : [])].join(" + ");
      return `| ${r.label} | ${tools} | ${pct(b.easy?.pass ?? 0, b.easy?.total ?? 0)} | ${pct(b.medium?.pass ?? 0, b.medium?.total ?? 0)} | ${pct(b.hard?.pass ?? 0, b.hard?.total ?? 0)} | **${pct(r.summary.pass, r.summary.total)}** | ${r.startedAt.slice(0, 10)} |`;
    }),
  ];
  if (tasks?.length && runs.length) {
    lines.push("", `| Task | ${runs.map((r) => r.label).join(" | ")} |`, `|---|${runs.map(() => "---").join("|")}|`);
    for (const t of tasks.filter((t) => runs.some((r) => r.tasks.some((x) => x.id === t.id)))) {
      lines.push(`| ${t.title} (${t.level}) | ${runs.map((r) => {
        const rs = r.tasks.filter((x) => x.id === t.id);
        if (!rs.length) return "";
        return rs.map((x) => (x.status === "pass" ? "✅" : x.status === "fail" ? "❌" : x.status === "error" ? "⚠️" : "–")).join("");
      }).join(" | ")} |`);
    }
  }
  return lines.join("\n");
}
