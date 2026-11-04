// Chat logs, the way old messengers kept them: one file per buddy (or room) per day,
// as plain text or a small web page. Also used for File → Save Conversation.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface LogItem {
  type: string; // "im" | "event"
  window?: string;
  from?: string;
  text?: string;
  at?: number;
  auto?: boolean;
  relayTo?: string;
  attachments?: string[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const time = (t?: number) => new Date(t ?? Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const day = (t?: number) => new Date(t ?? Date.now()).toISOString().slice(0, 10);
const who = (it: LogItem, me: string) => (it.from === "You" ? me : it.from ?? "?");
const body = (it: LogItem) => `${it.text ?? ""}${it.attachments?.length ? `${it.text ? "\n" : ""}[attached: ${it.attachments.join(", ")}]` : ""}`;

export function toText(window: string, items: LogItem[], me: string): string {
  const head = `Conversation with ${window}, saved by Y2Kbot on ${new Date().toLocaleString()}\r\n${"=".repeat(60)}\r\n\r\n`;
  return head + items.map((it) => {
    if (it.type === "event") return `[${time(it.at)}] ${it.text}`;
    const name = who(it, me) + (it.auto ? " (auto-reply)" : "") + (it.relayTo ? ` → ${it.relayTo}` : "");
    return `[${time(it.at)}] ${name}: ${body(it)}`;
  }).join("\r\n").replace(/\r?\n/g, "\r\n") + "\r\n";
}

const STYLE = `body{font:13px Arial,sans-serif;background:#fff;color:#000;margin:16px}
h1{font:bold 15px Tahoma,Arial,sans-serif;color:#fff;background:linear-gradient(#0a5fdc,#0831d9);padding:6px 10px;margin:0 0 10px;border-radius:6px 6px 0 0}
p{margin:2px 0}.ts{color:#808080;font-size:11px}.me{color:#0000ff;font-weight:bold}.them{color:#c00000;font-weight:bold}
.ev{color:#707070;font-style:italic;font-size:12px}.auto{color:#808080;font-style:italic}.day{margin:12px 0 4px;color:#555;font:bold 11px Tahoma,sans-serif}`;

function htmlLine(it: LogItem, me: string): string {
  if (it.type === "event") return `<p class="ev"><span class="ts">(${time(it.at)})</span> ${esc(it.text ?? "")}</p>`;
  const mine = it.from === "You";
  return `<p${it.auto ? ' class="auto"' : ""}><span class="ts">(${time(it.at)})</span> <span class="${mine ? "me" : "them"}">${esc(who(it, me))}${it.auto ? " (auto-reply)" : ""}${it.relayTo ? ` → ${esc(it.relayTo)}` : ""}:</span> ${esc(body(it)).replace(/\r?\n/g, "<br>")}</p>`;
}

const htmlHead = (title: string) => `<!doctype html>\n<html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head><body>\n<h1>${esc(title)}</h1>\n`;

export function toHtml(window: string, items: LogItem[], me: string): string {
  return htmlHead(`Conversation with ${window}`) + `<p class="day">Saved ${esc(new Date().toLocaleString())}</p>\n` + items.map((it) => htmlLine(it, me)).join("\n") + "\n</body></html>\n";
}

/** Appends every message to <dir>/<window>/<date>.html as it happens (when logging is on in Prefs). */
export class ChatLogger {
  constructor(private dir: string, public enabled: boolean) {}

  fileFor(window: string, at?: number) {
    const folder = window.startsWith("#") ? `room-${window.slice(1)}` : window;
    return path.join(this.dir, folder.replace(/[^\w.\- ]/g, "_"), `${day(at)}.html`);
  }

  append(window: string, it: LogItem, me: string) {
    if (!this.enabled || (it.type !== "im" && it.type !== "event")) return;
    try {
      const f = this.fileFor(window, it.at);
      if (!existsSync(f)) {
        mkdirSync(path.dirname(f), { recursive: true });
        appendFileSync(f, htmlHead(`${window.startsWith("#") ? "Chat room" : "Conversation with"} ${window} · ${day(it.at)}`)); // no closing tags: browsers don't mind
      }
      appendFileSync(f, htmlLine(it, me) + "\n");
    } catch { /* logging must never break chatting */ }
  }
}
