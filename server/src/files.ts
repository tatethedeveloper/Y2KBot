// Files you drop onto an IM or chat room window. Stored per window and handed to the model:
// text, PDFs and Word docs as extracted text; images as real images (for models that can see).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { pdfToText } from "./web.js";

export const MAX_FILE = 25 * 1024 * 1024;
const INLINE_CHARS = 20000; // how much text goes straight into the message; the rest via read_file
export const READ_CHARS = 20000;

const IMAGE: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const TEXTY = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|ps1|bat|cmd|ini|cfg|conf|toml|ya?ml|log|sql|tex|rtf|srt|vtt|env|gitignore|dockerfile)$/i;

export type FileKind = "image" | "text" | "pdf" | "docx" | "binary";
export interface FileInfo { name: string; size: number; kind: FileKind }

type Block = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;

export function kindOf(name: string, data?: Buffer): FileKind {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE[ext]) return "image";
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (TEXTY.test(name) || !ext) return data && data.subarray(0, 4000).includes(0) ? "binary" : "text";
  return data && !data.subarray(0, 4000).includes(0) ? "text" : "binary";
}

export class AttachmentStore {
  constructor(private root: string) { mkdirSync(root, { recursive: true }); }

  dir(window: string) {
    const d = path.join(this.root, window.replace(/[^\w.\- #]/g, "_").replace(/^#/, "room-"));
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** Save a dropped file; returns its (possibly de-duplicated) name. */
  save(window: string, rawName: string, data: Buffer): FileInfo {
    if (data.length > MAX_FILE) throw new Error("File is too big (max 25 MB).");
    let base = path.basename(rawName).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "file";
    if (base.startsWith(".")) base = "_" + base;
    const dir = this.dir(window);
    let name = base;
    for (let i = 2; existsSync(path.join(dir, name)); i++) {
      const ext = path.extname(base);
      name = `${path.basename(base, ext)} (${i})${ext}`;
    }
    writeFileSync(path.join(dir, name), data);
    return { name, size: data.length, kind: kindOf(name, data) };
  }

  list(window: string): FileInfo[] {
    const dir = this.dir(window);
    return readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isFile()).map((n) => ({ name: n, size: statSync(path.join(dir, n)).size, kind: kindOf(n) }));
  }

  path(window: string, name: string): string {
    const p = path.join(this.dir(window), path.basename(String(name)));
    if (!existsSync(p)) throw new Error(`No attached file called "${name}". Files here: ${this.list(window).map((f) => f.name).join(", ") || "(none)"}`);
    return p;
  }

  /** Whole-file text for text/PDF/Word files. */
  async text(window: string, name: string): Promise<string> {
    const p = this.path(window, name);
    const data = readFileSync(p);
    const kind = kindOf(name, data);
    if (kind === "pdf") return pdfToText(new Uint8Array(data));
    if (kind === "docx") {
      const mammoth = await import("mammoth");
      return (await mammoth.extractRawText({ buffer: data })).value;
    }
    if (kind === "text") return data.toString("utf8");
    throw new Error(`${name} is a ${kind} file and has no text to read.`);
  }

  /** Content blocks to put in the model's message for these attachments. */
  async blocks(window: string, names: string[]): Promise<Block[]> {
    const out: Block[] = [];
    for (const name of names) {
      try {
        const p = this.path(window, name);
        const data = readFileSync(p);
        const kind = kindOf(name, data);
        if (kind === "image") {
          if (data.length > 5 * 1024 * 1024) { out.push({ type: "text", text: `[Attached image ${name} is over 5 MB, too big to show the model.]` }); continue; }
          out.push({ type: "text", text: `[Attached image: ${name}]` });
          out.push({ type: "image", source: { type: "base64", media_type: IMAGE[path.extname(name).toLowerCase()], data: data.toString("base64") } });
        } else if (kind === "binary") {
          out.push({ type: "text", text: `[Attached file: ${name} (${data.length} bytes, binary, can't be read as text)]` });
        } else {
          const text = await this.text(window, name);
          const more = text.length > INLINE_CHARS ? `\n[...truncated: ${text.length} characters total. Use read_file with name "${name}" and offset ${INLINE_CHARS} to keep reading.]` : "";
          out.push({ type: "text", text: `[Attached file: ${name}]\n<file name="${name}">\n${text.slice(0, INLINE_CHARS)}${more}\n</file>` });
        }
      } catch (e) {
        out.push({ type: "text", text: `[Attachment ${name} couldn't be read: ${(e as Error).message}]` });
      }
    }
    return out;
  }
}
