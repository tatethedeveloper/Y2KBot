// Minimal QEMU Machine Protocol (QMP) client over a unix socket.
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class QMP {
  private sock!: net.Socket;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private greeted!: Promise<void>;

  /** Connect over TCP (works on Windows, macOS and Linux). */
  static async connect(port: number, timeoutMs = 20000, host = "127.0.0.1"): Promise<QMP> {
    const q = new QMP();
    const deadline = Date.now() + timeoutMs;
    // QEMU opens the port shortly after launch; retry until it's there.
    for (;;) {
      try {
        await q.open(port, host);
        break;
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`QMP connect timed out: ${(e as Error).message}`);
        await sleep(200);
      }
    }
    await q.greeted;
    await q.cmd("qmp_capabilities");
    return q;
  }

  private open(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ port, host });
      let greet!: () => void;
      this.greeted = new Promise((r) => (greet = r));
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.off("error", reject);
        sock.on("error", (e) => this.failAll(e));
        sock.on("close", () => this.failAll(new Error("QMP socket closed")));
        this.sock = sock;
        resolve();
      });
      sock.on("data", (chunk) => {
        this.buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.QMP) { greet(); continue; }
          if (msg.event) continue; // async events are ignored for now
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${msg.error.class}: ${msg.error.desc}`));
          else p.resolve(msg.return);
        }
      });
    });
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  /** Long-running work (snapshots) runs as QEMU jobs, so no single command should take this long. */
  cmd<T = any>(execute: string, args?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (!this.sock || this.sock.destroyed) return Promise.reject(new Error("QMP socket closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`QEMU didn't answer ${execute} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const done = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => { clearTimeout(t); f(...a); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.sock.write(JSON.stringify({ execute, arguments: args, id }) + "\n");
    });
  }

  close() {
    try { this.sock?.destroy(); } catch {}
  }
}
