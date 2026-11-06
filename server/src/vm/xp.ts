// Boots and drives disposable Windows XP VMs with QEMU.
// Every VM runs the base image in -snapshot mode, so nothing an agent does
// is ever written back to the base disk: shut down = factory reset.
//
// Instant boot: XP is booted once to the desktop and saved (memory → a file, disk → an overlay on
// the base image). Machines then start by loading that memory file instead of booting Windows.
//
// Two side channels besides screen/keyboard/mouse:
//  • COM1 is wired to a TCP socket here, so xp_cmd can send a command's output straight back.
//  • The shared folder is a virtual FAT drive, normally plugged in as a USB stick. USB can be
//    unplugged while running, which is what makes checkpoints (live snapshots) possible: QEMU
//    refuses to snapshot a machine with a writable virtual FAT drive attached.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import net, { type AddressInfo } from "node:net";
import { PNG } from "pngjs";
import { QMP } from "./qmp.js";
import { charToQcodes, comboToQcodes } from "./keys.js";
import { safeSegment } from "../agents.js";

const SHARE_ID = "y2kshare";
const SHARE_DEV = "y2kshare-dev";
const MAX_CHECKPOINTS = 3;

export interface XPConfig {
  qemuBin: string;
  baseImage: string;
  memoryMb: number;
  maxVms: number;
  network: "none" | "restricted" | "user";
  vga: string;
  /** Accelerator: "" = auto, or "kvm", "hvf", "whpx", "tcg". */
  accel?: string;
  /** CPU model shown to XP. Newer models make XP blue-screen (STOP 0xA). */
  cpu: string;
  /** ACPI on/off. Must match how XP was installed: an XP installed with ACPI off won't boot with it on, and vice versa. */
  acpi: boolean;
  /** Root folder for per-buddy shared folders ("" = disabled). Each buddy gets <root>/<screenName>, attached as a FAT drive. */
  sharedRoot: string;
  /** How the shared drive is attached: "usb" (default; allows checkpoints) or "ide" (an extra hard disk, the old way). */
  shareBus?: "usb" | "ide";
  /** Where the instant-boot snapshot lives ("" = instant boot off). */
  readyDir?: string;
}

/** Instant boot: XP saved once at the desktop, every machine starts from there. */
export interface ReadyStatus {
  state: "off" | "none" | "ready" | "outdated" | "preparing" | "unsupported";
  detail: string;
  at?: number;
  sizeMb?: number;
}

export interface Checkpoint { tag: string; label: string; at: number }
export interface CmdResult { ok: boolean; output: string; ms: number; finished: boolean }

interface VM {
  id: string;
  owner: string;
  proc: ChildProcess;
  qmp: QMP;
  dir: string;
  startedAt: number;
  width: number;
  height: number;
  /** last place we put the mouse (XP's own pointer often isn't in screendumps) */
  mouse: { x: number; y: number } | null;
  /** host folder attached as the shared drive, and how */
  share: { dir: string; bus: "usb" | "ide" } | null;
  /** everything XP has written to COM1 (trimmed), plus who's waiting for it */
  serial: { sock: net.Socket | null; text: string; waiters: Set<() => void> };
  checkpoints: Checkpoint[];
  /** last frame sent to the live viewer, to skip sending unchanged ones */
  lastLive?: PNG;
  /** one checkpoint/undo/eject at a time */
  busy: Promise<unknown>;
}

export interface SettleResult { png: Buffer; settled: boolean; ms: number }

export interface VMSummary { id: string; owner: string; startedAt: number; width: number; height: number }

export class XPManager extends EventEmitter {
  private vms = new Map<string, VM>(); // keyed by owner screen name
  private counter = 0;
  private runRoot = path.join(os.tmpdir(), "y2kbot-vms");
  /** boots in progress, so a second xp_boot (or the Boot button) waits for the same machine */
  private booting = new Map<string, Promise<VMSummary & { instant: boolean }>>();
  private madeDirs = new Set<string>();

  constructor(public cfg: XPConfig) {
    super();
    mkdirSync(this.runRoot, { recursive: true });
  }

  /** Is this host able to run XP VMs at all? */
  /** Accelerators to try, best first. QEMU falls back down the list automatically. */
  accelChain(): string[] {
    if (this.cfg.accel && this.cfg.accel !== "tcg") return [this.cfg.accel, "tcg"];
    if (this.cfg.accel === "tcg") return ["tcg"];
    if (process.platform === "linux" && existsSync("/dev/kvm")) return ["kvm", "tcg"];
    if (process.platform === "darwin" && process.arch === "x64") return ["hvf", "tcg"];
    // Windows: WHPX crashes 32-bit XP ("Unexpected VP exit code 4") and QEMU only falls back
    // if it fails to *start*, so plain emulation is the safe default. Opt in to whpx in Prefs.
    return ["tcg"];
  }

  /** Host folder that shows up inside this buddy's XP as a drive (created on demand). */
  sharedDir(owner: string): string | null {
    if (!this.cfg.sharedRoot) return null;
    const dir = path.join(this.cfg.sharedRoot, safeSegment(owner));
    // created once per run; boot() re-creates it in case it was deleted since
    if (!this.madeDirs.has(dir)) { mkdirSync(dir, { recursive: true }); this.madeDirs.add(dir); }
    return dir;
  }

  doctor(): { ok: boolean; problems: string[]; accel: string; cpu: string; acpi: boolean; shared: boolean } {
    const problems: string[] = [];
    try { execFileSync(this.cfg.qemuBin, ["--version"], { stdio: "ignore" }); }
    catch { problems.push(`QEMU not found (${this.cfg.qemuBin}). Install qemu-system-x86.`); }
    if (!this.cfg.baseImage) problems.push("XP_BASE_IMAGE is not set (see README: 'Building the XP base image').");
    else if (!existsSync(this.cfg.baseImage)) problems.push(`Base image not found: ${this.cfg.baseImage}`);
    return { ok: problems.length === 0, problems, accel: this.accelChain()[0], cpu: this.cfg.cpu, acpi: this.cfg.acpi, shared: !!this.cfg.sharedRoot };
  }

  list(): VMSummary[] {
    return [...this.vms.values()].map(({ id, owner, startedAt, width, height }) => ({ id, owner, startedAt, width, height }));
  }

  has(owner: string) { return this.vms.has(owner); }
  mouseAt(owner: string) { return this.vms.get(owner)?.mouse ?? null; }
  size(owner: string) { const v = this.need(owner); return { width: v.width, height: v.height }; }

  /** QEMU arguments every machine shares. Instant boot needs these identical between saving and restoring. */
  private machineArgs(name: string, drive: string, qmpPort: number, serialPort: number): string[] {
    const net =
      this.cfg.network === "none" ? ["-nic", "none"]
      : this.cfg.network === "restricted" ? ["-nic", "user,model=rtl8139,restrict=on"]
      : ["-nic", "user,model=rtl8139"];
    return [
      "-name", name,
      "-machine", `pc,acpi=${this.cfg.acpi ? "on" : "off"}`,
      "-cpu", this.cfg.cpu || "pentium3",
      "-m", String(this.cfg.memoryMb),
      "-smp", "1",
      ...this.accelChain().flatMap((a) => ["-accel", a]),
      "-drive", drive,
      "-vga", this.cfg.vga,
      "-usb", "-device", "usb-tablet,bus=usb-bus.0,port=1", // absolute pointer: clicks land exactly where asked
      // COM1 → a socket here: xp_cmd sends command output back this way, instantly.
      "-serial", `tcp:127.0.0.1:${serialPort},server=on,wait=off`,
      "-rtc", "base=localtime",
      ...net,
      "-display", "none",
      "-qmp", `tcp:127.0.0.1:${qmpPort},server=on,wait=off`,
    ];
  }

  boot(owner: string, opts: { cold?: boolean } = {}): Promise<VMSummary & { instant: boolean }> {
    const existing = this.vms.get(owner);
    if (existing) return Promise.resolve({ ...this.summary(existing), instant: false });
    let p = this.booting.get(owner);
    if (!p) {
      p = this.bootOnce(owner, !!opts.cold).finally(() => this.booting.delete(owner));
      this.booting.set(owner, p);
    }
    return p;
  }

  private async bootOnce(owner: string, cold: boolean): Promise<VMSummary & { instant: boolean }> {
    const doc = this.doctor();
    if (!doc.ok) throw new Error(doc.problems.join(" "));
    // (this boot isn't in `booting` yet when this runs, so the count is everyone else's)
    if (this.vms.size + this.booting.size >= this.cfg.maxVms) throw new Error(`VM limit reached (${this.cfg.maxVms}). Another buddy must shut theirs down first.`);
    if (!cold && this.readyStatus().state === "ready") {
      try { return { ...(await this.start(owner, true)), instant: true }; }
      catch (e) { this.emit("log", `Instant boot failed, starting XP the slow way: ${(e as Error).message}`); }
    }
    return { ...(await this.start(owner, false)), instant: false };
  }

  private async start(owner: string, instant: boolean): Promise<VMSummary> {
    const id = `XP-${++this.counter}`;
    const dir = path.join(this.runRoot, `${id}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const qmpPort = await freePort();
    const serialPort = await freePort();

    const shared = this.sharedDir(owner);
    if (shared) mkdirSync(shared, { recursive: true });
    const bus = this.cfg.shareBus === "ide" ? "ide" : "usb";
    // An instant boot restores a machine saved without the shared drive; it's plugged in afterwards.
    const sharedArgs = !shared || instant ? []
      // Shared folder: a virtual FAT disk backed by a real folder. Writes land in the folder.
      : bus === "ide" ? ["-drive", `file=fat:rw:${q(shared)},format=raw,if=ide,index=1,snapshot=off`]
      // As a USB stick on a fixed port (same port + serial = same drive letter every time it's replugged).
      : ["-drive", `file=fat:rw:${q(shared)},format=raw,if=none,id=${SHARE_ID}`,
         "-device", `usb-storage,drive=${SHARE_ID},id=${SHARE_DEV},removable=on,serial=Y2KSHARE,bus=usb-bus.0,port=2`];
    // snapshot=on: writes go to a throwaway overlay, never the base image (or the saved desktop).
    const disk = instant ? this.readyFiles().disk : this.cfg.baseImage;
    const args = [
      ...this.machineArgs(`${id} (${owner})`, `file=${q(disk)},format=qcow2,if=ide,index=0,snapshot=on`, qmpPort, serialPort),
      ...sharedArgs,
      ...(instant ? ["-incoming", "defer"] : []),
    ];

    const proc = spawn(this.cfg.qemuBin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    proc.stderr!.on("data", (d) => (stderr += d.toString()));

    let qmp: QMP;
    try {
      qmp = await QMP.connect(qmpPort);
    } catch (e) {
      proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`QEMU failed to start: ${stderr.trim() || (e as Error).message}`);
    }

    if (instant) {
      try {
        await qmp.cmd("migrate-incoming", { uri: `file:${this.readyFiles().ram}` });
        let status = "inmigrate";
        for (let i = 0; i < 600 && status === "inmigrate"; i++) { // up to a minute for a big memory file
          await sleep(100);
          status = (await qmp.cmd("query-status"))?.status;
          if (proc.exitCode !== null) break;
        }
        if (status !== "paused" && status !== "running") throw new Error(stderr.trim() || `machine is ${status}`);
        await qmp.cmd("cont");
      } catch (e) {
        qmp.close(); proc.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
        throw e;
      }
    }

    const vm: VM = {
      id, owner, proc, qmp, dir, startedAt: Date.now(), width: 1024, height: 768, mouse: null,
      share: shared ? { dir: shared, bus } : null,
      serial: { sock: null, text: "", waiters: new Set() },
      checkpoints: [], busy: Promise.resolve(),
    };
    this.vms.set(owner, vm);
    this.attachSerial(vm, serialPort);
    proc.on("exit", () => {
      qmp.close();
      vm.serial.sock?.destroy();
      if (this.vms.get(owner) === vm) this.vms.delete(owner);
      rmSync(dir, { recursive: true, force: true });
      this.emit("stopped", { id, owner });
    });
    if (instant && vm.share?.bus === "usb") await this.plugShare(vm).catch((e) => this.emit("log", (e as Error).message));
    this.emit("started", this.summary(vm));
    return this.summary(vm);
  }

  // ------------------------------------------------------------------ instant boot
  private preparing: { promise: Promise<void>; step: string } | null = null;

  private readyFiles() {
    const dir = this.cfg.readyDir || "";
    return { dir, disk: path.join(dir, "desktop.qcow2"), ram: path.join(dir, "desktop.ram"), meta: path.join(dir, "ready.json") };
  }

  /** Everything that has to match for a saved desktop to be restorable. */
  private readyKey(): string {
    let base = "";
    try { const st = statSync(this.cfg.baseImage); base = `${path.resolve(this.cfg.baseImage)}|${st.size}|${Math.round(st.mtimeMs)}`; } catch {}
    const c = this.cfg;
    return JSON.stringify({ base, mem: c.memoryMb, cpu: c.cpu, acpi: c.acpi, vga: c.vga, net: c.network, accel: this.accelChain(), qemu: qemuVersion(c.qemuBin)?.join("."), share: !!c.sharedRoot });
  }

  readyStatus(): ReadyStatus {
    const f = this.readyFiles();
    if (!f.dir) return { state: "off", detail: "Instant boot is off." };
    if (this.preparing) return { state: "preparing", detail: this.preparing.step };
    if (this.cfg.sharedRoot && this.cfg.shareBus === "ide") return { state: "unsupported", detail: "Instant boot needs the shared drive attached as USB (or shared folders off)." };
    let meta: { key?: string; at?: number } = {};
    try { meta = JSON.parse(readFileSync(f.meta, "utf8")); } catch {}
    if (!meta.key || !existsSync(f.disk) || !existsSync(f.ram)) return { state: "none", detail: "Not set up. Machines start from a cold boot." };
    let sizeMb = 0;
    try { sizeMb = Math.round((statSync(f.disk).size + statSync(f.ram).size) / 1048576); } catch {}
    if (meta.key !== this.readyKey()) return { state: "outdated", detail: "Your XP settings or image changed since the desktop was saved. Prepare it again.", at: meta.at, sizeMb };
    return { state: "ready", detail: "Machines start straight at the desktop.", at: meta.at, sizeMb };
  }

  discardReady() {
    if (this.preparing) throw new Error("Wait for the desktop to finish saving first.");
    const f = this.readyFiles();
    for (const p of [f.meta, f.disk, f.ram]) rmSync(p, { force: true });
  }

  /**
   * Boot XP once, wait for the desktop, and save the whole machine (memory to a file, disk to an overlay
   * on top of the base image). Later boots restore that instead of going through XP's boot.
   */
  prepareReady(): Promise<void> {
    if (this.preparing) return this.preparing.promise;
    const doc = this.doctor();
    if (!doc.ok) return Promise.reject(new Error(doc.problems.join(" ")));
    const status = this.readyStatus();
    if (status.state === "off" || status.state === "unsupported") return Promise.reject(new Error(status.detail));
    const job = { step: "Starting XP…", promise: Promise.resolve() };
    const step = (s: string) => { job.step = s; this.emit("ready", this.readyStatus()); };
    job.promise = this.prepare(step).finally(() => { this.preparing = null; this.emit("ready", this.readyStatus()); });
    this.preparing = job;
    this.emit("ready", this.readyStatus());
    return job.promise;
  }

  private async prepare(step: (s: string) => void) {
    const f = this.readyFiles();
    mkdirSync(f.dir, { recursive: true });
    const v = qemuVersion(this.cfg.qemuBin);
    if (v && (v[0] < 8 || (v[0] === 8 && v[1] < 2))) throw new Error(`Instant boot needs QEMU 8.2 or newer (you have ${v.join(".")}).`);
    const tmpDisk = f.disk + ".tmp", tmpRam = f.ram + ".tmp";
    rmSync(tmpDisk, { force: true }); rmSync(tmpRam, { force: true });
    // A small overlay on top of the base image holds whatever XP writes while booting.
    try {
      execFileSync(qemuImg(this.cfg.qemuBin), ["create", "-f", "qcow2", "-b", path.resolve(this.cfg.baseImage), "-F", "qcow2", tmpDisk], { stdio: "pipe", windowsHide: true });
    } catch (e: any) { throw new Error(`Couldn't run qemu-img (it comes with QEMU): ${String(e.stderr || e.message).trim()}`); }

    const qmpPort = await freePort(), serialPort = await freePort();
    const proc = spawn(this.cfg.qemuBin, this.machineArgs("Y2Kbot instant boot", `file=${q(tmpDisk)},format=qcow2,if=ide,index=0`, qmpPort, serialPort),
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    proc.stderr!.on("data", (d) => (stderr += d.toString()));
    let qmp: QMP | null = null;
    const vm = { qmp: null as any, dir: f.dir, share: null as VM["share"] } as VM;
    try {
      qmp = await QMP.connect(qmpPort);
      vm.qmp = qmp;
      const t0 = Date.now();
      // Wait for a desktop with a taskbar that stops changing.
      step("Waiting for the XP desktop…");
      let last: PNG | null = null, still = 0;
      for (;;) {
        if (proc.exitCode !== null) throw new Error(`QEMU stopped: ${stderr.trim() || "no reason given"}`);
        if (Date.now() - t0 > 20 * 60_000) throw new Error("XP didn't reach the desktop within 20 minutes.");
        await sleep(2000);
        const png = await this.grab(vm).catch(() => null);
        if (!png) continue;
        const quiet = last ? changedPixels(last, png) >= 0 && changedPixels(last, png) < png.width * png.height * 0.002 : false;
        last = png;
        still = quiet && looksLikeDesktop(png) ? still + 1 : 0;
        step(still ? "Desktop found, letting XP finish starting up…" : `Waiting for the XP desktop… (${Math.round((Date.now() - t0) / 1000)} s)`);
        if (still >= 8 && Date.now() - t0 > 20_000) break; // 16 s with nothing moving
      }
      if (this.cfg.sharedRoot && this.cfg.shareBus !== "ide") {
        // Plug the shared stick in once so XP sets up its USB driver now, not on every boot.
        step("Setting up the shared drive…");
        const share = path.join(f.dir, "share-setup");
        mkdirSync(share, { recursive: true });
        vm.share = { dir: share, bus: "usb" };
        await this.plugShare(vm);
        await sleep(20_000);
        await this.press(vm, ["esc"]).catch(() => {}); // close an AutoPlay window if one opened
        await sleep(2000);
        await this.unplugShare(vm);
        await sleep(3000);
      }
      step("Saving the desktop…");
      await qmp.cmd("stop");
      await qmp.cmd("migrate", { uri: `file:${tmpRam}` });
      for (let i = 0; ; i++) {
        const m = await qmp.cmd("query-migrate");
        if (m?.status === "completed") break;
        if (m?.status === "failed" || m?.status === "cancelled") throw new Error(`Saving memory failed: ${m["error-desc"] || m.status}`);
        if (i > 1200) throw new Error("Saving memory took too long.");
        await sleep(100);
      }
      await qmp.cmd("quit").catch(() => {});
      for (let i = 0; i < 100 && proc.exitCode === null; i++) await sleep(100);
      // swap the new files in
      rmSync(f.meta, { force: true });
      for (const [from, to] of [[tmpDisk, f.disk], [tmpRam, f.ram]]) { rmSync(to, { force: true }); renameSync(from, to); }
      writeFileSync(f.meta, JSON.stringify({ key: this.readyKey(), at: Date.now() }, null, 2));
    } finally {
      qmp?.close();
      if (proc.exitCode === null) proc.kill("SIGKILL");
      for (let i = 0; i < 30 && proc.exitCode === null; i++) await sleep(100);
      rmSync(tmpDisk, { force: true }); rmSync(tmpRam, { force: true });
      rmSync(path.join(f.dir, "share-setup"), { recursive: true, force: true });
    }
  }

  private summary(vm: VM): VMSummary {
    return { id: vm.id, owner: vm.owner, startedAt: vm.startedAt, width: vm.width, height: vm.height };
  }

  private need(owner: string): VM {
    const vm = this.vms.get(owner);
    if (!vm) throw new Error("No XP machine is running for you. Call xp_boot first.");
    return vm;
  }

  /** Grab the raw framebuffer. Uses PPM (works on every QEMU version). */
  private async grab(vm: VM): Promise<PNG> {
    const file = path.join(vm.dir, `shot-${Date.now()}-${Math.random().toString(36).slice(2)}.ppm`);
    await vm.qmp.cmd("screendump", { filename: file });
    const png = ppmToPng(readFileSync(file));
    rmSync(file, { force: true });
    vm.width = png.width;
    vm.height = png.height;
    return png;
  }

  /** The raw current frame (no pointer overlay), e.g. for OCR. */
  async frame(owner: string): Promise<PNG> { return this.grab(this.need(owner)); }

  /** Screenshot for the live viewer (and anything else that just wants the screen as-is). */
  /** For the live viewer: grab the screen and send it only if it changed since the last one sent. */
  async liveFrame(owner: string): Promise<boolean> {
    const vm = this.vms.get(owner);
    if (!vm) return false;
    const png = await this.grab(vm);
    if (vm.lastLive && changedPixels(vm.lastLive, png) === 0) return false;
    vm.lastLive = png;
    this.emit("frame", { owner, id: vm.id, png: PNG.sync.write(png) });
    return true;
  }

  async screenshot(owner: string): Promise<Buffer> {
    const vm = this.need(owner);
    const buf = PNG.sync.write(await this.grab(vm));
    this.emit("frame", { owner, id: vm.id, png: buf });
    return buf;
  }

  /**
   * Wait until the screen stops changing, then return a screenshot for the model.
   * Emulated XP is slow: a window can take seconds to appear, and an agent that looks too early
   * sees "nothing happened" and repeats itself. A blinking caret or ticking clock changes a few
   * hundred pixels, so "stable" means under ~0.1% of the screen differs between frames.
   */
  async settle(owner: string, opts: { maxMs?: number; intervalMs?: number; minMs?: number } = {}): Promise<SettleResult> {
    const vm = this.need(owner);
    const maxMs = opts.maxMs ?? 8000, interval = opts.intervalMs ?? 450, minMs = opts.minMs ?? 300;
    const start = Date.now();
    await sleep(minMs);
    let prev = await this.grab(vm);
    let settled = false;
    while (Date.now() - start < maxMs) {
      await sleep(interval);
      const cur = await this.grab(vm);
      const changed = changedPixels(prev, cur);
      prev = cur;
      if (changed >= 0 && changed < (cur.width * cur.height) / 1000) { settled = true; break; }
    }
    const raw = PNG.sync.write(prev);
    this.emit("frame", { owner, id: vm.id, png: raw });
    return { png: vm.mouse ? PNG.sync.write(drawPointer(prev, vm.mouse.x, vm.mouse.y)) : raw, settled, ms: Date.now() - start };
  }

  private abs(vm: VM, x: number, y: number) {
    const ax = Math.round((Math.max(0, Math.min(x, vm.width - 1)) * 32767) / Math.max(1, vm.width - 1));
    const ay = Math.round((Math.max(0, Math.min(y, vm.height - 1)) * 32767) / Math.max(1, vm.height - 1));
    return [
      { type: "abs", data: { axis: "x", value: ax } },
      { type: "abs", data: { axis: "y", value: ay } },
    ];
  }

  async move(owner: string, x: number, y: number) {
    const vm = this.need(owner);
    vm.mouse = { x, y };
    await vm.qmp.cmd("input-send-event", { events: this.abs(vm, x, y) });
  }

  async click(owner: string, x: number, y: number, button: "left" | "right" | "middle" = "left", double = false) {
    const vm = this.need(owner);
    vm.mouse = { x, y };
    await vm.qmp.cmd("input-send-event", { events: this.abs(vm, x, y) });
    await sleep(40);
    for (let i = 0; i < (double ? 2 : 1); i++) {
      await vm.qmp.cmd("input-send-event", { events: [{ type: "btn", data: { down: true, button } }] });
      await sleep(40);
      await vm.qmp.cmd("input-send-event", { events: [{ type: "btn", data: { down: false, button } }] });
      if (double) await sleep(80);
    }
  }

  async drag(owner: string, x1: number, y1: number, x2: number, y2: number) {
    const vm = this.need(owner);
    vm.mouse = { x: x2, y: y2 };
    await vm.qmp.cmd("input-send-event", { events: this.abs(vm, x1, y1) });
    await vm.qmp.cmd("input-send-event", { events: [{ type: "btn", data: { down: true, button: "left" } }] });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await sleep(20);
      await vm.qmp.cmd("input-send-event", {
        events: this.abs(vm, x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps),
      });
    }
    await vm.qmp.cmd("input-send-event", { events: [{ type: "btn", data: { down: false, button: "left" } }] });
  }

  async scroll(owner: string, x: number, y: number, direction: "up" | "down", amount = 3) {
    const vm = this.need(owner);
    vm.mouse = { x, y };
    await vm.qmp.cmd("input-send-event", { events: this.abs(vm, x, y) });
    const button = direction === "up" ? "wheel-up" : "wheel-down";
    for (let i = 0; i < amount; i++) {
      await vm.qmp.cmd("input-send-event", { events: [{ type: "btn", data: { down: true, button } }] });
      await vm.qmp.cmd("input-send-event", { events: [{ type: "btn", data: { down: false, button } }] });
      await sleep(30);
    }
  }

  private async press(vm: VM, qcodes: string[]) {
    const ev = (down: boolean, k: string) => ({ type: "key", data: { down, key: { type: "qcode", data: k } } });
    await vm.qmp.cmd("input-send-event", { events: qcodes.map((k) => ev(true, k)) });
    await sleep(45);
    await vm.qmp.cmd("input-send-event", { events: [...qcodes].reverse().map((k) => ev(false, k)) });
    await sleep(40); // emulated XP drops keys if they come too fast
  }

  async key(owner: string, combo: string) {
    await this.press(this.need(owner), comboToQcodes(combo));
  }

  async type(owner: string, text: string): Promise<string[]> {
    const vm = this.need(owner);
    const skipped: string[] = [];
    for (const ch of text) {
      const codes = charToQcodes(ch);
      if (codes) { await this.press(vm, codes); continue; }
      const ansi = ansiCode(ch);
      if (ansi) { await this.altCode(vm, ansi); continue; }
      skipped.push(ch);
    }
    return skipped;
  }

  /** Accented letters, curly quotes, dashes…: hold Alt and type 0 + the Windows-1252 code on the keypad. */
  private async altCode(vm: VM, code: number) {
    const ev = (down: boolean, k: string) => ({ type: "key", data: { down, key: { type: "qcode", data: k } } });
    await vm.qmp.cmd("input-send-event", { events: [ev(true, "alt")] });
    await sleep(30);
    for (const d of `0${code}`) {
      await vm.qmp.cmd("input-send-event", { events: [ev(true, `kp_${d}`)] });
      await sleep(30);
      await vm.qmp.cmd("input-send-event", { events: [ev(false, `kp_${d}`)] });
      await sleep(30);
    }
    await vm.qmp.cmd("input-send-event", { events: [ev(false, "alt")] });
    await sleep(40);
  }

  // ------------------------------------------------------------------ COM1 (xp_cmd)
  private attachSerial(vm: VM, port: number) {
    const connect = (tries: number) => {
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.on("connect", () => { vm.serial.sock = sock; });
      sock.on("data", (d) => {
        vm.serial.text = (vm.serial.text + d.toString("latin1")).slice(-400_000);
        for (const w of vm.serial.waiters) w();
      });
      sock.on("error", () => {});
      sock.on("close", () => {
        if (vm.serial.sock === sock) vm.serial.sock = null;
        if (this.vms.get(vm.owner) === vm && tries < 50) setTimeout(() => connect(tries + 1), 300);
      });
    };
    connect(0);
  }

  /**
   * Run a command line in XP and get its output back over COM1.
   * Opens a console through Start → Run, types the command wrapped in markers, and reads COM1 until
   * the end marker arrives. The console closes itself when the command finishes.
   */
  async cmd(owner: string, command: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<CmdResult> {
    const vm = this.need(owner);
    if (!vm.serial.sock) throw new Error("XP's COM1 link isn't connected yet. Wait for the machine to finish booting and try again.");
    // letters only: a digit right before ">" would turn into a file-handle redirect in cmd
    const id = Array.from({ length: 5 }, () => "abcdefghjkmnpqrstuvwxyz"[Math.floor(Math.random() * 23)]).join("");
    const S = `y2ks${id}`, O = `y2ko${id}`, E = `y2ke${id}`;
    const line = `echo ${S}>COM1&(${command})>COM1 2>&1&&echo ${O}>COM1&echo ${E}>COM1&exit`;
    const bad = [...new Set([...line].filter((c) => !charToQcodes(c)))];
    if (bad.length) throw new Error(`Can't type these characters into XP: ${bad.join(" ")}. Use plain ASCII.`);

    const startLen = vm.serial.text.length;
    const started = Date.now();
    // 1. a console window, with COM1 set to a fast speed (QEMU paces the port at the baud rate)
    await this.key(owner, "win+r");
    await this.settle(owner, { maxMs: 6000 });
    await this.key(owner, "ctrl+a");
    await this.type(owner, "cmd /k mode COM1 BAUD=115200 >nul");
    await this.key(owner, "enter");
    await this.settle(owner, { maxMs: 8000, minMs: 600 });
    // 2. the command, wrapped in start/end markers
    await this.type(owner, line);
    await this.key(owner, "enter");

    const out = () => vm.serial.text.slice(startLen);
    // stops waiting (not the command itself) when the buddy is stopped
    const wait = (pred: () => boolean, ms: number) => new Promise<boolean>((resolve) => {
      if (pred() || signal?.aborted) return resolve(pred());
      const done = (v: boolean) => { clearTimeout(t); vm.serial.waiters.delete(check); signal?.removeEventListener("abort", onAbort); resolve(v); };
      const check = () => { if (pred()) done(true); };
      const onAbort = () => done(pred());
      const t = setTimeout(() => done(pred()), ms);
      vm.serial.waiters.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (!(await wait(() => out().includes(S), 20_000))) {
      if (!this.vms.has(owner)) throw new Error("The XP machine stopped.");
      throw new Error("Nothing came back from XP's COM1 port, so the command may not have run. Take a screenshot: a console window should show what happened. (If this XP install has no COM1 port, xp_cmd can't work; use xp_run and the GUI instead.)");
    }
    const finished = await wait(() => out().includes(E), Math.max(1000, timeoutMs - (Date.now() - started)));
    const raw = out();
    let body = raw.slice(raw.indexOf(S) + S.length);
    const end = body.search(new RegExp(`${O}|${E}`));
    if (end >= 0) body = body.slice(0, end);
    body = body.replace(/\r/g, "").replace(/^\s*\n/, "").replace(/\s+$/, "");
    return { ok: finished && raw.includes(O), output: body, ms: Date.now() - started, finished };
  }

  /** Wait for XP to write something matching `re` to COM1 (from now on), e.g. a script reporting back. */
  waitSerial(owner: string, re: RegExp, ms: number): Promise<RegExpMatchArray | null> {
    const vm = this.need(owner);
    const from = vm.serial.text.length;
    return new Promise((resolve) => {
      const check = () => { const m = vm.serial.text.slice(from).match(re); if (m) done(m); };
      const done = (m: RegExpMatchArray | null) => { clearTimeout(t); vm.serial.waiters.delete(check); resolve(m); };
      const t = setTimeout(() => done(null), ms);
      vm.serial.waiters.add(check);
    });
  }

  // ------------------------------------------------------------------ shared drive hot-plug
  /** Can this machine take checkpoints? (Not with the shared drive attached as a hard disk.) */
  canCheckpoint(owner: string) {
    const vm = this.need(owner);
    return !vm.share || vm.share.bus === "usb";
  }

  private serialise<T>(vm: VM, fn: () => Promise<T>): Promise<T> {
    const p = vm.busy.then(fn, fn);
    vm.busy = p.catch(() => {});
    return p;
  }

  private async unplugShare(vm: VM) {
    if (!vm.share || vm.share.bus !== "usb") return;
    const present = async () => ((await vm.qmp.cmd("query-block")) as any[]).some((b) => b.device === SHARE_ID);
    if (!(await present())) return;
    await vm.qmp.cmd("device_del", { id: SHARE_DEV });
    for (let i = 0; i < 50 && (await present()); i++) await sleep(100); // the drive goes with the device
  }

  private async plugShare(vm: VM) {
    if (!vm.share || vm.share.bus !== "usb") return;
    // Quoted: the monitor splits on spaces, and folders like "Application Support" have them.
    const opts = `if=none,id=${SHARE_ID},file=fat:rw:${q(vm.share.dir)},format=raw`;
    const r = await vm.qmp.cmd("human-monitor-command", { "command-line": `drive_add 0 "${opts.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` });
    if (!/^OK/.test(String(r).trim())) throw new Error(`Couldn't reattach the shared drive: ${String(r).trim()}`);
    await vm.qmp.cmd("device_add", { driver: "usb-storage", drive: SHARE_ID, id: SHARE_DEV, removable: true, serial: "Y2KSHARE", bus: "usb-bus.0", port: "2" });
  }

  /**
   * Eject the shared USB drive, run fn (e.g. write a file into the folder), plug it back in.
   * XP sees the stick removed and reinserted, and reads the folder afresh.
   */
  withShareEjected<T>(owner: string, fn: () => T | Promise<T>): Promise<T> {
    const vm = this.need(owner);
    if (!vm.share || vm.share.bus !== "usb") return Promise.reject(new Error("The shared drive is attached as a hard disk, so it can't be ejected while XP runs."));
    return this.serialise(vm, async () => {
      await this.unplugShare(vm);
      try { return await fn(); } finally { await this.plugShare(vm); }
    });
  }

  private sysNode(vm: VM): Promise<string> {
    return vm.qmp.cmd("query-block").then((blocks: any[]) => {
      const node = blocks.find((b) => b.device === "ide0-hd0")?.inserted?.["node-name"];
      if (!node) throw new Error("Couldn't find the XP system disk.");
      return node;
    });
  }

  private async job(vm: VM, command: string, args: Record<string, unknown>) {
    const id = `${command}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await vm.qmp.cmd(command, { "job-id": id, ...args });
    for (let i = 0; i < 1200; i++) { // up to 2 minutes
      const j = ((await vm.qmp.cmd("query-jobs")) as any[]).find((x) => x.id === id);
      if (j?.status === "concluded") {
        await vm.qmp.cmd("job-dismiss", { id }).catch(() => {});
        if (j.error) throw new Error(j.error);
        return;
      }
      await sleep(100);
    }
    throw new Error(`${command} took too long`);
  }

  /** Save the whole running machine (memory + disk) so it can be restored with undo(). Keeps the last 3. */
  checkpoint(owner: string, label = ""): Promise<Checkpoint> {
    const vm = this.need(owner);
    if (!this.canCheckpoint(owner)) return Promise.reject(new Error("Checkpoints need the shared drive attached as USB (Prefs → Windows XP machines → Shared drive), or shared folders off."));
    return this.serialise(vm, async () => {
      const sys = await this.sysNode(vm);
      const cp: Checkpoint = { tag: `y2k-${Date.now()}`, label: label.trim().slice(0, 80) || `checkpoint ${vm.checkpoints.length + 1}`, at: Date.now() };
      await vm.qmp.cmd("stop"); // XP is frozen from here until cont: it never sees the drive missing
      try {
        await this.unplugShare(vm);
        try { await this.job(vm, "snapshot-save", { tag: cp.tag, vmstate: sys, devices: [sys] }); }
        finally { await this.plugShare(vm); }
      } finally {
        await vm.qmp.cmd("cont").catch(() => {});
      }
      vm.checkpoints.push(cp);
      while (vm.checkpoints.length > MAX_CHECKPOINTS) {
        const old = vm.checkpoints.shift()!; // each one holds a copy of XP's memory, so don't keep many
        await this.job(vm, "snapshot-delete", { tag: old.tag, devices: [sys] }).catch(() => {});
      }
      return cp;
    });
  }

  checkpoints(owner: string): Checkpoint[] { return [...(this.vms.get(owner)?.checkpoints ?? [])]; }

  /** Put the machine back exactly as it was at a checkpoint (the latest if none named). */
  undo(owner: string, which?: string): Promise<Checkpoint> {
    const vm = this.need(owner);
    return this.serialise(vm, async () => {
      if (!vm.checkpoints.length) throw new Error("There's no checkpoint to go back to. Take one with xp_checkpoint before risky steps.");
      const w = (which ?? "").trim().toLowerCase();
      const cp = w ? vm.checkpoints.find((c) => c.tag === w || c.label.toLowerCase() === w) ?? vm.checkpoints.find((c) => c.label.toLowerCase().includes(w)) : vm.checkpoints.at(-1);
      if (!cp) throw new Error(`No checkpoint called "${which}". Checkpoints: ${vm.checkpoints.map((c) => `"${c.label}"`).join(", ")}`);
      const sys = await this.sysNode(vm);
      await vm.qmp.cmd("stop");
      try {
        // the snapshot was taken with the drive unplugged, so restore it the same way
        await this.unplugShare(vm);
        try { await this.job(vm, "snapshot-load", { tag: cp.tag, vmstate: sys, devices: [sys] }); }
        finally { await this.plugShare(vm); }
      } finally {
        await vm.qmp.cmd("cont").catch(() => {});
      }
      vm.mouse = null;
      // later checkpoints describe a future that no longer happened
      const i = vm.checkpoints.indexOf(cp);
      for (const later of vm.checkpoints.splice(i + 1)) await this.job(vm, "snapshot-delete", { tag: later.tag, devices: [sys] }).catch(() => {});
      return cp;
    });
  }

  async shutdown(owner: string, graceMs = 0) {
    const vm = this.vms.get(owner);
    if (!vm) return false;
    // give XP a moment to flush writes to the shared drive before pulling the plug
    if (graceMs) await sleep(graceMs);
    try { await vm.qmp.cmd("quit"); } catch {}
    setTimeout(() => { if (vm.proc.exitCode === null) vm.proc.kill("SIGKILL"); }, 3000);
    return true;
  }

  shutdownAll() {
    for (const vm of this.vms.values()) vm.proc.kill("SIGKILL");
  }
}

/** Windows-1252 code for a character XP can type with Alt+0nnn (null if it has none). */
const CP1252_EXTRA: Record<string, number> = {
  "€": 128, "‚": 130, "ƒ": 131, "„": 132, "…": 133, "†": 134, "‡": 135, "ˆ": 136, "‰": 137, "Š": 138, "‹": 139, "Œ": 140, "Ž": 142,
  "‘": 145, "’": 146, "“": 147, "”": 148, "•": 149, "–": 150, "—": 151, "˜": 152, "™": 153, "š": 154, "›": 155, "œ": 156, "ž": 158, "Ÿ": 159,
};
export function ansiCode(ch: string): number | null {
  const c = ch.codePointAt(0)!;
  if (c >= 0xa0 && c <= 0xff) return c;
  return CP1252_EXTRA[ch] ?? null;
}

/** QEMU's -drive uses commas as separators; a literal comma in a path is written ",,". */
const q = (p: string) => p.replace(/,/g, ",,");

/** qemu-img lives next to qemu-system-*. */
function qemuImg(qemuBin: string): string {
  const dir = path.dirname(qemuBin);
  const exe = process.platform === "win32" ? "qemu-img.exe" : "qemu-img";
  return dir && dir !== "." ? path.join(dir, exe) : exe;
}

const versions = new Map<string, number[] | null>();
function qemuVersion(qemuBin: string): number[] | null {
  if (versions.has(qemuBin)) return versions.get(qemuBin)!;
  let v: number[] | null = null;
  try {
    const out = execFileSync(qemuBin, ["--version"], { encoding: "utf8", windowsHide: true });
    const m = out.match(/version (\d+)\.(\d+)\.?(\d*)/);
    if (m) v = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  } catch {}
  if (v) versions.set(qemuBin, v);
  return v;
}

/**
 * Is this XP's desktop? Looks for the taskbar along the bottom: one colour across most of it,
 * blue (XP look) or grey (classic look), with a Start button at the left. The blue Welcome
 * screen has a band too, but no green or grey Start button.
 */
export function looksLikeDesktop(png: PNG): boolean {
  const { width: w, height: h, data } = png;
  if (w < 320 || h < 200) return false;
  const px = (x: number, y: number) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const y = h - 8;
  const counts = new Map<string, number>();
  for (let x = Math.round(w * 0.3); x < Math.round(w * 0.7); x += 2) {
    const [r, g, b] = px(x, y);
    const k = `${r >> 4},${g >> 4},${b >> 4}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (n < (w * 0.4) / 2 * 0.5) return false; // the band isn't one colour
  const [r, g, b] = top.split(",").map((v) => Number(v) * 16 + 8);
  const blue = b > 150 && b > r + 60;
  const grey = Math.abs(r - g) < 24 && Math.abs(g - b) < 24 && r > 150;
  if (!blue && !grey) return false;
  // Start button in the bottom-left corner
  let green = 0, greyBtn = 0;
  for (let x = 4; x < Math.min(90, w); x += 2) {
    const [r2, g2, b2] = px(x, y);
    if (g2 > r2 + 30 && g2 > b2 + 20) green++;
    if (Math.abs(r2 - g2) < 24 && Math.abs(g2 - b2) < 24 && r2 > 150) greyBtn++;
  }
  return blue ? green > 6 : greyBtn > 10;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** How many pixels differ between two frames (-1 if the size changed). Samples every 2nd pixel. */
function changedPixels(a: PNG, b: PNG): number {
  if (a.width !== b.width || a.height !== b.height) return -1;
  let n = 0;
  const d1 = a.data, d2 = b.data;
  for (let i = 0; i < d1.length; i += 8) if (d1[i] !== d2[i] || d1[i + 1] !== d2[i + 1] || d1[i + 2] !== d2[i + 2]) n++;
  return n * 2;
}

/** Draw a small red crosshair where the mouse is, on a copy of the frame. */
function drawPointer(src: PNG, x: number, y: number): PNG {
  const out = new PNG({ width: src.width, height: src.height });
  src.data.copy(out.data);
  const put = (px: number, py: number, r: number, g: number, b: number) => {
    if (px < 0 || py < 0 || px >= out.width || py >= out.height) return;
    const i = (py * out.width + px) * 4;
    out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255;
  };
  for (let d = -9; d <= 9; d++) {
    if (Math.abs(d) < 3) continue; // leave the exact target pixel visible
    for (const o of [-1, 1]) { put(x + d, y + o, 255, 255, 255); put(x + o, y + d, 255, 255, 255); } // white outline
  }
  for (let d = -9; d <= 9; d++) { if (Math.abs(d) < 3) continue; put(x + d, y, 230, 0, 0); put(x, y + d, 230, 0, 0); }
  return out;
}

/** Parse a binary PPM (P6) into a PNG object. */
export function ppmToPng(buf: Buffer): PNG {
  let pos = 0;
  const tokens: string[] = [];
  while (tokens.length < 4) {
    while (/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    if (buf[pos] === 0x23) { while (buf[pos] !== 0x0a) pos++; continue; } // comment
    let t = "";
    while (!/\s/.test(String.fromCharCode(buf[pos]))) t += String.fromCharCode(buf[pos++]);
    tokens.push(t);
  }
  pos++; // single whitespace after maxval
  const [magic, w, h] = tokens;
  if (magic !== "P6") throw new Error(`Unsupported screendump format ${magic}`);
  const width = Number(w), height = Number(h);
  const png = new PNG({ width, height });
  for (let i = 0, j = pos; i < width * height; i++, j += 3) {
    png.data[i * 4] = buf[j];
    png.data[i * 4 + 1] = buf[j + 1];
    png.data[i * 4 + 2] = buf[j + 2];
    png.data[i * 4 + 3] = 255;
  }
  return png;
}
