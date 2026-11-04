// Boots and drives disposable Windows XP VMs with QEMU.
// Every VM runs the base image in -snapshot mode, so nothing an agent does
// is ever written back to the base disk: shut down = factory reset.
//
// Two side channels besides screen/keyboard/mouse:
//  • COM1 is wired to a TCP socket here, so xp_cmd can send a command's output straight back.
//  • The shared folder is a virtual FAT drive, normally plugged in as a USB stick. USB can be
//    unplugged while running, which is what makes checkpoints (live snapshots) possible: QEMU
//    refuses to snapshot a machine with a writable virtual FAT drive attached.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import net, { type AddressInfo } from "node:net";
import { PNG } from "pngjs";
import { QMP } from "./qmp.js";
import { charToQcodes, comboToQcodes } from "./keys.js";

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
  /** one checkpoint/undo/eject at a time */
  busy: Promise<unknown>;
}

export interface SettleResult { png: Buffer; settled: boolean; ms: number }

export interface VMSummary { id: string; owner: string; startedAt: number; width: number; height: number }

export class XPManager extends EventEmitter {
  private vms = new Map<string, VM>(); // keyed by owner screen name
  private counter = 0;
  private runRoot = path.join(os.tmpdir(), "ram-vms");

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
    const dir = path.join(this.cfg.sharedRoot, owner.replace(/[^\w.\- ]/g, "_"));
    mkdirSync(dir, { recursive: true });
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

  async boot(owner: string): Promise<VMSummary> {
    const existing = this.vms.get(owner);
    if (existing) return this.summary(existing);
    const doc = this.doctor();
    if (!doc.ok) throw new Error(doc.problems.join(" "));
    if (this.vms.size >= this.cfg.maxVms) throw new Error(`VM limit reached (${this.cfg.maxVms}). Another buddy must shut theirs down first.`);

    const id = `XP-${++this.counter}`;
    const dir = path.join(this.runRoot, `${id}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const qmpPort = await freePort();
    const serialPort = await freePort();

    const net =
      this.cfg.network === "none" ? ["-nic", "none"]
      : this.cfg.network === "restricted" ? ["-nic", "user,model=rtl8139,restrict=on"]
      : ["-nic", "user,model=rtl8139"];

    // QEMU's -drive uses commas as separators; a literal comma in a path is written ",,".
    const q = (p: string) => p.replace(/,/g, ",,");
    const shared = this.sharedDir(owner);
    const bus = this.cfg.shareBus === "ide" ? "ide" : "usb";
    const sharedArgs = !shared ? []
      // Shared folder: a virtual FAT disk backed by a real folder. Writes land in the folder.
      : bus === "ide" ? ["-drive", `file=fat:rw:${q(shared)},format=raw,if=ide,index=1,snapshot=off`]
      // As a USB stick on a fixed port (same port + serial = same drive letter every time it's replugged).
      : ["-drive", `file=fat:rw:${q(shared)},format=raw,if=none,id=${SHARE_ID}`,
         "-device", `usb-storage,drive=${SHARE_ID},id=${SHARE_DEV},removable=on,serial=Y2KSHARE,bus=usb-bus.0,port=2`];
    const args = [
      "-name", `${id} (${owner})`,
      "-machine", `pc,acpi=${this.cfg.acpi ? "on" : "off"}`,
      "-cpu", this.cfg.cpu || "pentium3",
      "-m", String(this.cfg.memoryMb),
      "-smp", "1",
      ...this.accelChain().flatMap((a) => ["-accel", a]),
      // Base disk: snapshot=on means writes go to a throwaway overlay, never the base image.
      "-drive", `file=${q(this.cfg.baseImage)},format=qcow2,if=ide,index=0,snapshot=on`,
      "-vga", this.cfg.vga,
      "-usb", "-device", "usb-tablet,bus=usb-bus.0,port=1", // absolute pointer: clicks land exactly where asked
      ...sharedArgs,
      // COM1 → a socket here: xp_cmd sends command output back this way, instantly.
      "-serial", `tcp:127.0.0.1:${serialPort},server=on,wait=off`,
      "-rtc", "base=localtime",
      ...net,
      "-display", "none",
      "-qmp", `tcp:127.0.0.1:${qmpPort},server=on,wait=off`,
    ];

    const proc = spawn(this.cfg.qemuBin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    proc.stderr!.on("data", (d) => (stderr += d.toString()));

    let qmp: QMP;
    try {
      qmp = await QMP.connect(qmpPort);
    } catch (e) {
      proc.kill("SIGKILL");
      throw new Error(`QEMU failed to start: ${stderr.trim() || (e as Error).message}`);
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
      this.vms.delete(owner);
      rmSync(dir, { recursive: true, force: true });
      this.emit("stopped", { id, owner });
    });
    this.emit("started", this.summary(vm));
    return this.summary(vm);
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
      if (!codes) { skipped.push(ch); continue; }
      await this.press(vm, codes);
    }
    return skipped;
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
  async cmd(owner: string, command: string, timeoutMs = 60_000): Promise<CmdResult> {
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
    const wait = (pred: () => boolean, ms: number) => new Promise<boolean>((resolve) => {
      if (pred()) return resolve(true);
      const done = (v: boolean) => { clearTimeout(t); vm.serial.waiters.delete(check); resolve(v); };
      const check = () => { if (pred()) done(true); };
      const t = setTimeout(() => done(pred()), ms);
      vm.serial.waiters.add(check);
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
    const q = (p: string) => p.replace(/,/g, ",,");
    const r = await vm.qmp.cmd("human-monitor-command", { "command-line": `drive_add 0 if=none,id=${SHARE_ID},file=fat:rw:${q(vm.share.dir)},format=raw` });
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
