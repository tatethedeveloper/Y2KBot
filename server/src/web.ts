// Web tools: fetch a page as readable text, and search via a provider you configure.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

const UA = "Mozilla/5.0 (compatible; Y2Kbot/0.1; +https://github.com/)";
const MAX_BYTES = 3 * 1024 * 1024;
export const PAGE_CHARS = 12000;

// ---------------------------------------------------------------- safety
// Addresses on your own machine or network (and the special ranges that can reach them).
// BlockList also matches IPv4-mapped IPv6 (::ffff:7f00:1 is 127.0.0.1) against the IPv4 rules.
const PRIVATE = new net.BlockList();
for (const [a, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) PRIVATE.addSubnet(a, bits, "ipv4");
for (const [a, bits] of [
  ["::", 96],          // unspecified, loopback and IPv4-compatible (::7f00:1)
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], // NAT64: a v4 address in disguise
  ["100::", 64], ["2002::", 16], // discard, 6to4 (also wraps v4 addresses)
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) PRIVATE.addSubnet(a, bits, "ipv6");

/** Is this an address on your own machine or network? Agents shouldn't poke those via web_fetch
 *  (a web page could talk a buddy into hitting your router admin page or a local service). */
export function isPrivateIp(ip: string): boolean {
  const type = net.isIP(ip);
  return type === 0 || PRIVATE.check(ip, type === 4 ? "ipv4" : "ipv6");
}

const blocked = (host: string) => new Error(`${host} points at a private/local address, which buddies aren't allowed to fetch (see Prefs).`);

function assertPublic(url: URL, allowPrivate: boolean) {
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https URLs can be fetched.");
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error(`${host} is on your local network, which buddies aren't allowed to fetch (see Prefs).`);
  if (net.isIP(host) && isPrivateIp(host)) throw blocked(host);
  // names are checked as they're resolved, in publicLookup
}

/**
 * DNS lookup for the actual connection that refuses private addresses. Checking here (not in a
 * separate lookup beforehand) means a name can't resolve to a public address for the check and
 * a private one for the connection (DNS rebinding).
 */
const publicLookup = ((host: string, opts: dns.LookupOptions, cb: (...a: any[]) => void) => {
  dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs as unknown as dns.LookupAddress[];
    if (!list.length) return cb(new Error(`${host} has no addresses`));
    if (list.some((a) => isPrivateIp(a.address))) return cb(blocked(host));
    opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
  });
}) as unknown as net.LookupFunction;

/** One GET, no redirects followed, through publicLookup unless private addresses are allowed. */
function get(url: URL, allowPrivate: boolean, signal: AbortSignal): Promise<Response> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
      signal,
      ...(allowPrivate ? {} : { lookup: publicLookup }),
    }, (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const x of [v ?? []].flat()) headers.append(k, x);
      const status = res.statusCode ?? 502;
      const noBody = status === 204 || status === 205 || status === 304;
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------- fetch
export interface FetchResult { url: string; title: string; text: string; total: number; offset: number; contentType: string }

export async function webFetch(rawUrl: string, opts: { offset?: number; allowPrivate?: boolean; signal?: AbortSignal } = {}): Promise<FetchResult> {
  let url = new URL(rawUrl);
  // follow redirects ourselves so every hop gets the private-address check
  let res: Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    assertPublic(url, !!opts.allowPrivate);
    res = await get(url, !!opts.allowPrivate, opts.signal ?? AbortSignal.timeout(20000));
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { await res.body?.cancel().catch(() => {}); url = new URL(loc, url); continue; }
    break;
  }
  if (!res) throw new Error("No response");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const contentType = res.headers.get("content-type") || "";
  const buf = await readCapped(res, MAX_BYTES);
  let title = "";
  let text: string;
  if (/pdf/i.test(contentType)) {
    text = await pdfToText(new Uint8Array(buf));
  } else if (/html|xml/i.test(contentType) || /^\s*</.test(buf.subarray(0, 200).toString())) {
    const html = buf.toString("utf8");
    title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "");
    text = htmlToText(html);
  } else if (/^(text\/|application\/(json|javascript|xml))/i.test(contentType) || !contentType) {
    text = buf.toString("utf8");
  } else {
    throw new Error(`Can't read ${contentType} content (${buf.length} bytes).`);
  }
  const offset = Math.max(0, opts.offset ?? 0);
  return { url: url.toString(), title, text: text.slice(offset, offset + PAGE_CHARS), total: text.length, offset, contentType };
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size > max) { await reader.cancel(); break; }
  }
  return Buffer.concat(chunks).subarray(0, max);
}

export async function pdfToText(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).map((t, i) => `--- page ${i + 1} ---\n${t.trim()}`).join("\n\n");
}

/** Small, dependency-free HTML → readable text. Keeps headings, list items, links and paragraphs. */
export function htmlToText(html: string): string {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|canvas|iframe|template|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, "\n"); // usually menus and boilerplate
  // prefer the main article if the page marks one up
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(h);
  if (main && main[2].length > 500) h = main[2];
  h = h
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l, t) => `\n\n${"#".repeat(Number(l))} ${t}\n\n`)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
      const label = t.replace(/<[^>]+>/g, "").trim();
      return label && /^https?:/.test(href) && label.length < 120 ? `${label} (${href})` : label;
    })
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|tr|table|ul|ol|blockquote|pre|h[1-6])>/gi, "\n\n")
    .replace(/<t[dh][^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(h)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™" };
function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

// ---------------------------------------------------------------- search
export interface SearchHit { title: string; url: string; snippet: string }
export interface SearchConfig { provider: "" | "brave" | "tavily" | "searxng"; braveKey?: string; tavilyKey?: string; searxngUrl?: string }

export function searchReady(c: SearchConfig): boolean {
  return (c.provider === "brave" && !!c.braveKey) || (c.provider === "tavily" && !!c.tavilyKey) || (c.provider === "searxng" && !!c.searxngUrl);
}

export async function webSearch(query: string, c: SearchConfig, count = 8): Promise<SearchHit[]> {
  const signal = AbortSignal.timeout(20000);
  const strip = (s: string) => (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (c.provider === "brave") {
    const u = new URL("https://api.search.brave.com/res/v1/web/search");
    u.searchParams.set("q", query);
    u.searchParams.set("count", String(count));
    const r = await fetch(u, { headers: { accept: "application/json", "x-subscription-token": c.braveKey! }, signal });
    if (!r.ok) throw new Error(`Brave Search ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    return (j.web?.results ?? []).map((x: any) => ({ title: strip(x.title), url: x.url, snippet: strip(x.description) }));
  }
  if (c.provider === "tavily") {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.tavilyKey}` },
      body: JSON.stringify({ query, max_results: count, api_key: c.tavilyKey }),
      signal,
    });
    if (!r.ok) throw new Error(`Tavily ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    return (j.results ?? []).map((x: any) => ({ title: strip(x.title), url: x.url, snippet: strip(x.content).slice(0, 400) }));
  }
  if (c.provider === "searxng") {
    const u = new URL(c.searxngUrl!.replace(/\/+$/, "") + "/search");
    u.searchParams.set("q", query);
    u.searchParams.set("format", "json");
    const r = await fetch(u, { headers: { accept: "application/json" }, signal });
    if (r.status === 403) throw new Error("SearXNG refused JSON output. Add `json` to search.formats in its settings.yml.");
    if (!r.ok) throw new Error(`SearXNG ${r.status}`);
    const j: any = await r.json();
    return (j.results ?? []).slice(0, count).map((x: any) => ({ title: strip(x.title), url: x.url, snippet: strip(x.content) }));
  }
  throw new Error("Web search isn't set up (Prefs → Web search).");
}
