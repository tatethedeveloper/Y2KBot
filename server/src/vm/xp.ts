// Boots and drives disposable Windows XP VMs with QEMU.
// Every VM runs the base image in -snapshot mode, so nothing an agent does
// is ever written back to the base disk: shut down = factory reset.
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
}

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

    const net =
      this.cfg.network === "none" ? ["-nic", "none"]
      : this.cfg.network === "restricted" ? ["-nic", "user,model=rtl8139,restrict=on"]
      : ["-nic", "user,model=rtl8139"];

    // QEMU's -drive uses commas as separators; a literal comma in a path is written ",,".
    const q = (p: string) => p.replace(/,/g, ",,");
    const shared = this.sharedDir(owner);
    const args = [
      "-name", `${id} (${owner})`,
      "-machine", `pc,acpi=${this.cfg.acpi ? "on" : "off"}`,
      "-cpu", this.cfg.cpu || "pentium3",
      "-m", String(this.cfg.memoryMb),
      "-smp", "1",
      ...this.accelChain().flatMap((a) => ["-accel", a]),
      // Base disk: snapshot=on means writes go to a throwaway overlay, never the base image.
      "-drive", `file=${q(this.cfg.baseImage)},format=qcow2,if=ide,index=0,snapshot=on`,
      // Shared folder: a virtual FAT disk backed by a real folder (usually D: in XP). Writes land in the folder.
      ...(shared ? ["-drive", `file=fat:rw:${q(shared)},format=raw,if=ide,index=1,snapshot=off`] : []),
      "-vga", this.cfg.vga,
      "-usb", "-device", "usb-tablet", // absolute pointer: clicks land exactly where asked
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

    const vm: VM = { id, owner, proc, qmp, dir, startedAt: Date.now(), width: 1024, height: 768, mouse: null };
    this.vms.set(owner, vm);
    proc.on("exit", () => {
      qmp.close();
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
