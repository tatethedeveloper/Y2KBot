// "Sign in with ChatGPT": lets buddies run on your ChatGPT Plus / Pro plan instead of an API key.
//
// This is OpenAI's official flow for open-source, locally run apps (developers.openai.com/siwc):
//   1. OAuth 2 + PKCE in your browser. The first sign-in registers Y2Kbot through
//      client_id=dynamic_agent_client; OpenAI hands back an issued client ID (oaiapp_…) that
//      every later sign-in and refresh reuses.
//   2. You approve "ChatGPT plan usage" (scope chatgpt.tokens.use.direct). Without it the
//      sign-in is identity only and the provider stays off.
//   3. Requests go to the public Responses API at api.openai.com/v1 with the access token,
//      store:false and stream:true. Usage counts against your plan (and any per-app cap you set
//      at chatgpt.com/settings/usage).
// No client secret, no API key, and it doesn't touch the Codex CLI's own login.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID, createHash, createPublicKey, verify as verifySig, type JsonWebKey } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { MODEL_TIMEOUT_MS, type Block, type CompleteArgs, type CompleteResult, type ModelInfo, type Msg, type Provider } from "./providers.js";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const OIDC_CONFIG_URL = `${ISSUER}/.well-known/openid-configuration`;
const API = "https://api.openai.com/v1";
const RESOURCE = API;
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const DYNAMIC_CLIENT = "dynamic_agent_client"; // first-time registration only: never saved or exchanged
const APP_NAME = "Y2Kbot";
const CALLBACK_PATH = "/auth/callback";
const PREFERRED_PORT = 1455;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 3 * 60_000; // refresh this early so a request never starts on a dying token
const USAGE_URL = "https://chatgpt.com/settings/usage";
const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused",
]);

/** Encrypts tokens at rest. The desktop app passes one backed by the OS keychain (Electron safeStorage). */
export interface SecretBox { encrypt(plain: string): string; decrypt(enc: string): string }

interface Tokens { idToken?: string; access?: string; refresh?: string; expiresAt?: number; scopes?: string[]; savedAt?: string }

interface Saved {
  /** This install's stable, opaque host ID (not a credential). */
  hostId: string;
  /** Issued for this ChatGPT account on first sign-in; reused afterwards. */
  clientId?: string;
  subject?: string;
  email?: string;
  /** Tokens: encrypted when a SecretBox is available, else plain (file is owner-only). */
  secret?: { enc?: string; plain?: string };
}

export interface ChatGPTStatus {
  signedIn: boolean;
  email?: string;
  /** A sign-in has been started and we're waiting for the browser. */
  pending: boolean;
  /** Signed in before on this machine (Continue reuses that account). */
  known: boolean;
  error?: string;
}

interface PendingLogin {
  server: Server;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string; // DYNAMIC_CLIENT on first registration
  expectSubject?: string;
  timer: NodeJS.Timeout;
  busy?: boolean;
}

const b64url = (b: Buffer) => b.toString("base64url");
const randomValue = () => b64url(randomBytes(32));

export class ChatGPTAuth extends EventEmitter {
  private saved: Saved;
  private tokens: Tokens = {};
  private pending: PendingLogin | null = null;
  private refreshing: Promise<string> | null = null;
  private lastError?: string;

  constructor(private file: string, private box?: SecretBox) {
    super();
    this.saved = { hostId: `urn:uuid:${randomUUID()}` };
    this.load();
  }

  // ------------------------------------------------------------------ storage
  private load() {
    let raw: Saved;
    try { raw = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.save(); return; }
    if (raw.hostId) this.saved = raw;
    const sec = raw.secret;
    try {
      if (sec?.enc) {
        if (!this.box) { this.lastError = "You signed in from the Y2Kbot app, and only the app can unlock that sign-in. Run this from the app instead."; return; }
        this.tokens = JSON.parse(this.box.decrypt(sec.enc));
      } else if (sec?.plain) this.tokens = JSON.parse(sec.plain);
    } catch { this.tokens = {}; this.lastError = "Couldn't unlock the saved ChatGPT sign-in. Sign in again."; }
  }

  private save() {
    const out: Saved = { ...this.saved };
    delete out.secret;
    if (this.tokens.refresh || this.tokens.access || this.tokens.idToken) {
      const json = JSON.stringify(this.tokens);
      out.secret = this.box ? { enc: this.box.encrypt(json) } : { plain: json };
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private changed() { this.emit("changed", this.status()); }

  // ------------------------------------------------------------------ state
  /** Signed in AND allowed to use the plan. A sign-in without the plan scope doesn't count. */
  get ready() { return !!this.tokens.refresh && !!this.tokens.scopes?.includes(PLAN_SCOPE); }

  status(): ChatGPTStatus {
    return { signedIn: this.ready, email: this.saved.email, pending: !!this.pending, known: !!this.saved.clientId, error: this.lastError };
  }

  // ------------------------------------------------------------------ sign in
  /**
   * Start a browser sign-in and return the URL to open.
   * fresh=true registers again from scratch (to use a different ChatGPT account).
   */
  async startLogin(fresh = false): Promise<string> {
    this.cancelLogin(false);
    if (fresh) { delete this.saved.clientId; delete this.saved.subject; delete this.saved.email; this.tokens = {}; this.save(); }

    const verifier = randomValue();
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = randomValue();
    const nonce = randomValue();
    const reauth = !!this.saved.clientId;
    const clientId = this.saved.clientId || DYNAMIC_CLIENT;

    // Callback server on 127.0.0.1 (OpenAI won't accept "localhost"). 1455 is the usual port;
    // if something else holds it (often the Codex CLI mid-login) any free port works.
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      const tryListen = (p: number) => {
        server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" && p !== 0 ? tryListen(0) : reject(e)));
        server.listen(p, "127.0.0.1", () => { server.removeAllListeners("error"); resolve((server.address() as AddressInfo).port); });
      };
      tryListen(PREFERRED_PORT);
    });
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

    const q = new URLSearchParams({
      client_id: clientId,
      ext_agent_host_id: this.saved.hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    if (!reauth) q.set("agent_name_hint", APP_NAME);
    else {
      if (this.tokens.idToken) q.set("id_token_hint", this.tokens.idToken);
      if (this.saved.email) q.set("login_hint", this.saved.email);
    }

    const timer = setTimeout(() => {
      if (this.pending?.state !== state) return;
      this.lastError = "Sign-in timed out. Click Continue with ChatGPT to try again.";
      this.cancelLogin();
    }, LOGIN_TIMEOUT_MS);
    this.pending = { server, state, nonce, verifier, redirectUri, clientId, expectSubject: reauth ? this.saved.subject : undefined, timer };
    this.lastError = undefined;

    server.on("request", (req, res) => {
      const url = new URL(req.url || "/", redirectUri);
      if (url.pathname !== CALLBACK_PATH) { res.writeHead(404).end(); return; }
      // Answer the browser first, then shut the callback server once the page has gone out.
      const finish = () => res.once("close", () => { if (this.pending?.state === state) this.cancelLogin(); });
      this.onCallback(url, state).then(
        () => { finish(); page(res, 200, "You're signed in", "Y2Kbot can now use your ChatGPT plan. You can close this tab."); },
        (e: Error & { stale?: boolean }) => { if (!e.stale) finish(); page(res, 400, "ChatGPT wasn't connected", e.message); },
      );
    });

    this.changed();
    return `${AUTHORIZE_URL}?${q.toString()}`;
  }

  cancelLogin(notify = true) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.server.close();
    p.server.closeAllConnections?.();
    if (notify) this.changed();
  }

  private async onCallback(url: URL, expectedState: string) {
    const p = this.pending;
    // a stale tab from an earlier attempt: don't let it end the current one
    if (!p || url.searchParams.get("state") !== expectedState || p.state !== expectedState) {
      throw Object.assign(new Error("This sign-in link is out of date. Start again from Y2Kbot."), { stale: true });
    }
    if (p.busy) throw Object.assign(new Error("Already finishing this sign-in."), { stale: true });
    p.busy = true; // browsers sometimes repeat the callback request
    try {
      const err = url.searchParams.get("error");
      if (err) throw new Error(err === "access_denied" ? "You cancelled the sign-in." : `ChatGPT said: ${url.searchParams.get("error_description") || err}`);
      const code = url.searchParams.get("code");
      if (!code) throw new Error("The callback had no authorization code.");

      // The issued client ID arrives in the callback (not the token response).
      const issued = url.searchParams.get("client_id")?.trim() || "";
      let clientId: string;
      if (p.clientId === DYNAMIC_CLIENT) {
        if (!issued) throw new Error("OpenAI didn't finish registering Y2Kbot (no client ID came back). Try again.");
        clientId = issued;
      } else {
        if (issued && issued !== p.clientId) throw new Error("OpenAI returned a different app registration than expected, so the sign-in was refused. Try 'Use another account'.");
        clientId = p.clientId;
      }

      const tok = await tokenRequest({
        grant_type: "authorization_code", client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: RESOURCE,
      });
      if (typeof tok.id_token !== "string") throw new Error("OpenAI's token response had no ID token.");
      const claims = await verifyIdToken(tok.id_token, clientId, p.nonce);
      if (p.expectSubject && claims.sub !== p.expectSubject) {
        throw new Error("That's a different ChatGPT account from the one Y2Kbot knows. Use 'Use another account' to switch.");
      }
      const tokens = tokensFrom(tok);
      if (!tokens.scopes!.includes(PLAN_SCOPE)) {
        throw new Error("You signed in but didn't allow ChatGPT plan usage, so Y2Kbot can't send requests. Sign in again and keep that permission ticked.");
      }

      this.saved.clientId = clientId;
      this.saved.subject = String(claims.sub);
      if (typeof claims.email === "string") this.saved.email = claims.email;
      this.tokens = { ...tokens, idToken: tok.id_token };
      this.lastError = undefined;
      this.save();
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  // ------------------------------------------------------------------ tokens
  /** A usable access token, refreshing it first if it's about to expire. */
  async accessToken(force = false): Promise<string> {
    if (!this.ready) throw new Error(this.lastError || "Not signed in to ChatGPT. Open Prefs and click Continue with ChatGPT.");
    if (!force && this.tokens.access && (this.tokens.expiresAt ?? 0) > Date.now()) return this.tokens.access;
    // One refresh at a time: refresh tokens rotate, so two racing refreshes would burn the session.
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const clientId = this.saved.clientId;
    if (!clientId || !this.tokens.refresh) throw new Error("Not signed in to ChatGPT.");
    let tok: any;
    try {
      tok = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: this.tokens.refresh, resource: RESOURCE });
    } catch (e) {
      const code = (e as TokenError).code;
      if (code && TERMINAL_REFRESH_ERRORS.has(code)) {
        // The session is over: drop the tokens, keep the registration so signing in again is one click.
        this.tokens = { idToken: this.tokens.idToken };
        this.lastError = "Your ChatGPT sign-in expired. Open Prefs and click Continue with ChatGPT.";
        this.save();
        this.changed();
        throw new Error(this.lastError);
      }
      if (code === "invalid_client") throw new Error("OpenAI no longer recognises Y2Kbot's registration. In Prefs, click 'Use another account' to register again.");
      throw e;
    }
    const next = tokensFrom(tok);
    this.tokens = { ...this.tokens, ...next, refresh: next.refresh || this.tokens.refresh };
    this.save();
    return this.tokens.access!;
  }

  /** Sign out: revoke the refresh token with OpenAI, forget the tokens, keep the registration. */
  async signOut(): Promise<{ revoked: boolean }> {
    this.cancelLogin(false);
    let revoked = !this.tokens.refresh;
    if (this.tokens.refresh && this.saved.clientId) {
      const endpoint = await fetch(OIDC_CONFIG_URL, { signal: AbortSignal.timeout(10_000) })
        .then((r) => r.json()).then((j: any) => j.revocation_endpoint as string).catch(() => `${ISSUER}/api/accounts/oauth/revoke`);
      for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
        try {
          const r = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: this.tokens.refresh, token_type_hint: "refresh_token", client_id: this.saved.clientId }),
            signal: AbortSignal.timeout(10_000),
          });
          if (r.ok) revoked = true;
          else if (r.status < 500) break;
        } catch { /* network: retry */ }
        if (!revoked) await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      }
    }
    this.tokens = {}; // also drops the ID token: no id_token_hint after signing out
    this.lastError = revoked ? undefined : `Signed out here, but OpenAI didn't confirm it. You can also disconnect Y2Kbot in ChatGPT settings.`;
    this.save();
    this.changed();
    return { revoked };
  }
}

// ------------------------------------------------------------------ OAuth helpers
class TokenError extends Error { constructor(msg: string, public code?: string) { super(msg); } }

async function tokenRequest(fields: Record<string, string>): Promise<any> {
  let r: Response;
  try {
    r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) { throw new TokenError(`Couldn't reach OpenAI to sign in (${(e as Error).message}).`); }
  const text = await r.text();
  let j: any = {};
  try { j = JSON.parse(text); } catch {}
  if (!r.ok) {
    const code = typeof j.error === "string" ? j.error : j.error?.code;
    throw new TokenError(`OpenAI sign-in failed (${r.status}): ${j.error_description || j.error?.message || code || text.slice(0, 200)}`, code);
  }
  return j;
}

function tokensFrom(tok: any): Tokens {
  if (typeof tok.access_token !== "string" || !tok.access_token) throw new Error("OpenAI's token response had no access token.");
  const expiresIn = Number(tok.expires_in) > 0 ? Number(tok.expires_in) : 3600;
  return {
    access: tok.access_token,
    refresh: typeof tok.refresh_token === "string" && tok.refresh_token ? tok.refresh_token : undefined,
    expiresAt: Date.now() + expiresIn * 1000 - REFRESH_MARGIN_MS,
    scopes: String(tok.scope || "").split(/\s+/).filter(Boolean),
    savedAt: new Date().toISOString(),
  };
}

let jwksCache: { at: number; keys: (JsonWebKey & { kid?: string })[] } | null = null;
async function jwks(force = false) {
  if (!force && jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetch(JWKS_URL, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Couldn't fetch OpenAI's signing keys (${r.status}).`);
  const j: any = await r.json();
  jwksCache = { at: Date.now(), keys: j.keys ?? [] };
  return jwksCache.keys;
}

/** Check the ID token's signature (OpenAI's published keys), issuer, audience, expiry and nonce. */
async function verifyIdToken(idToken: string, clientId: string, nonce: string): Promise<Record<string, any>> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("The ID token is malformed.");
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));

  let jwk = (await jwks()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await jwks(true)).find((k) => k.kid === header.kid); // keys may have rotated
  if (!jwk) throw new Error("The ID token was signed with an unknown key.");
  const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, "base64url");
  const alg = String(header.alg);
  const ok =
    alg === "RS256" ? verifySig("sha256", data, key, sig) :
    alg === "PS256" ? verifySig("sha256", data, { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 }, sig) :
    alg === "ES256" ? verifySig("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig) :
    false;
  if (!ok) throw new Error(`The ID token's signature didn't check out (${alg}).`);

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER) throw new Error("The ID token came from the wrong issuer.");
  if (!aud.includes(clientId)) throw new Error("The ID token was issued for a different app.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 60_000) throw new Error("The ID token has expired.");
  if (claims.nonce !== nonce) throw new Error("The ID token's nonce didn't match this sign-in.");
  if (!claims.sub) throw new Error("The ID token has no subject.");
  return claims;
}

function page(res: import("node:http").ServerResponse, status: number, title: string, text: string) {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Y2Kbot · ${esc(title)}</title>
<body style="margin:0;font-family:Tahoma,Verdana,sans-serif;background:#0a2a57;display:grid;place-items:center;height:100vh">
<div style="background:#eef3fa;border:3px solid #2f6fd0;border-radius:8px 8px 2px 2px;width:380px">
<div style="background:#2f6fd0;color:#fff;font-weight:bold;padding:5px 8px;font-size:13px">Y2Kbot</div>
<div style="padding:16px 18px;font-size:13px;color:#14213d"><p style="margin:0 0 8px;font-weight:bold">${esc(title)}</p><p style="margin:0">${esc(text)}</p></div>
</div></body>`);
}

// ------------------------------------------------------------------ the provider
export class ChatGPTProvider implements Provider {
  id = "chatgpt";
  label = "ChatGPT (Plus/Pro plan)";
  /** Keep OpenAI's own order (it lists the recommended models first). */
  keepOrder = true;
  private firstModel?: string;
  constructor(private auth: ChatGPTAuth) {}
  get ready() { return this.auth.ready; }

  async listModels(): Promise<ModelInfo[]> {
    const j = await this.api("GET", "/models");
    const list: any[] = Array.isArray(j.models) ? j.models : Array.isArray(j.data) ? j.data : [];
    const out = list
      .filter((m) => m.visibility === undefined || m.visibility === "list")
      .map((m) => {
        const id = String(m.slug ?? m.id ?? "");
        const label = m.display_name && m.display_name !== id ? `${m.display_name} (${id})` : undefined;
        // GPT-5-family models take images; only drop "vision" if OpenAI says text-only.
        const mods: string[] | undefined = m.input_modalities ?? m.modalities;
        const caps = Array.isArray(mods) && !mods.includes("image") ? ["tools"] : ["vision", "tools"];
        return { id, label, caps };
      })
      .filter((m) => m.id);
    this.firstModel = out[0]?.id;
    return out;
  }

  async complete(a: CompleteArgs): Promise<CompleteResult> {
    let model = a.model;
    if (!model || model === "auto") {
      if (!this.firstModel) await this.listModels();
      if (!this.firstModel) throw new Error("Your ChatGPT plan didn't list any models.");
      model = this.firstModel;
    }
    const body: Record<string, unknown> = {
      model,
      instructions: a.system, // system-role items are rejected on this route
      input: toResponses(a.messages),
      store: false, // required
      stream: true, // required
    };
    if (a.tools.length) {
      body.tools = a.tools.map((t: Anthropic.Tool) => ({ type: "function", name: t.name, description: t.description ?? "", parameters: t.input_schema, strict: false }));
      body.tool_choice = "auto";
    }
    // (temperature, max_output_tokens, previous_response_id etc. aren't allowed on plan usage)
    return this.stream(body, AbortSignal.any([a.signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]));
  }

  // -------------------------------------------------- HTTP
  private async send(method: string, pathName: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let forced = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.accessToken();
      let r: Response;
      try {
        r = await fetch(API + pathName, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { "content-type": "application/json", accept: "text/event-stream" } : {}),
            "user-agent": "Y2Kbot",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: signal ?? AbortSignal.timeout(20_000),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new Error(`ChatGPT: couldn't reach api.openai.com (${(e as Error).message}).`);
      }
      if (r.ok) return r;
      const text = await r.text();
      const err = parseError(text);
      // A stale access token: refresh once and try again.
      if (r.status === 401 && !forced && !err.code?.startsWith("subscription_sharing_user")) {
        forced = true;
        await this.auth.accessToken(true);
        continue;
      }
      // Temporarily unavailable: a short, bounded backoff.
      if (r.status === 503 && attempt < 2 && !signal?.aborted) {
        await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
        continue;
      }
      throw new Error(friendly(r.status, err));
    }
  }

  private async api(method: string, pathName: string): Promise<any> {
    const r = await this.send(method, pathName, undefined);
    return r.json();
  }

  private async stream(body: unknown, signal: AbortSignal): Promise<CompleteResult> {
    const r = await this.send("POST", "/responses", body, signal);
    if (!r.body) throw new Error("ChatGPT sent an empty response.");
    const items: any[] = [];
    let finalOutput: any[] | null = null;
    let done = false;
    let incomplete: string | null = null;

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const handle = (raw: string) => {
      const data = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") return;
      let ev: any;
      try { ev = JSON.parse(data); } catch { return; }
      switch (ev.type) {
        case "response.output_item.done": items.push(ev.item); break;
        case "response.completed": done = true; finalOutput = ev.response?.output ?? null; break;
        case "response.incomplete":
          done = true; finalOutput = ev.response?.output ?? null;
          incomplete = ev.response?.incomplete_details?.reason || "unknown reason";
          break;
        case "response.failed": throw new Error(friendly(0, { code: ev.response?.error?.code, message: ev.response?.error?.message }));
        case "error": throw new Error(friendly(0, { code: ev.code ?? ev.error?.code, message: ev.message ?? ev.error?.message, param: ev.param ?? ev.error?.param }));
      }
    };
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
          handle(chunk);
        }
      }
      if (buf.trim()) handle(buf);
    } finally {
      reader.releaseLock();
    }
    if (!done) throw new Error("ChatGPT's reply was cut off before it finished. Try again.");

    // Items streamed one by one are the reliable record; the final summary can be empty.
    const output = items.length ? items : finalOutput ?? [];
    const content: Block[] = [];
    for (const it of output) {
      if (it?.type === "message") {
        const text = (it.content ?? []).map((c: any) => (c.type === "output_text" ? c.text : c.type === "refusal" ? c.refusal : "")).join("").trim();
        if (text) content.push({ type: "text", text });
      } else if (it?.type === "function_call") {
        let input: unknown = {};
        try { input = JSON.parse(it.arguments || "{}"); } catch { input = { _unparseable_arguments: it.arguments }; }
        content.push({ type: "tool_use", id: it.call_id || it.id || `call_${Math.random().toString(36).slice(2)}`, name: it.name, input });
      }
    }
    if (incomplete && !content.some((b) => b.type === "tool_use")) {
      content.push({ type: "text", text: `(my reply was cut short: ${incomplete})` });
    }
    return { content, stop: content.some((b) => b.type === "tool_use") ? "tool_use" : "end" };
  }
}

interface ApiError { code?: string; message?: string; param?: string }

function parseError(text: string): ApiError {
  try {
    const j = JSON.parse(text);
    if (j.error && typeof j.error === "object") return { code: j.error.code ?? j.error.type, message: j.error.message, param: j.error.param };
    if (typeof j.detail === "string") return { message: j.detail };
    if (typeof j.error === "string") return { code: j.error, message: j.message };
  } catch {}
  return { message: text.slice(0, 300) };
}

/** What each documented error means, in words the user can act on. */
function friendly(status: number, e: ApiError): string {
  switch (e.code) {
    case "subscription_sharing_usage_limit_exceeded":
      return `ChatGPT: you've reached the usage limit your plan allows for other apps (or the cap you set for Y2Kbot). Check ${USAGE_URL}. Y2Kbot won't retry until you ask again.`;
    case "subscription_sharing_workplace_individual_usage_limit_exceeded":
      return "ChatGPT: you've reached your workspace's per-person usage limit. Your workspace admin can raise it.";
    case "subscription_sharing_user_not_eligible":
      return "ChatGPT: this account can't use its plan in other apps (it needs ChatGPT Plus or Pro).";
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return "ChatGPT plan usage is temporarily unavailable. Try again in a little while.";
    case "subscription_sharing_unsupported_capability":
      return `ChatGPT refused part of the request${e.param ? ` (${e.param})` : ""}: ${e.message ?? "not supported on plan usage"}.`;
    case "subscription_sharing_invalid_user":
      return "ChatGPT didn't accept the sign-in. If this keeps happening, sign out and back in from Prefs.";
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return "ChatGPT: plan usage isn't authorised for this sign-in. Sign in again and allow ChatGPT plan usage.";
  }
  const where = status ? ` ${status}` : "";
  return `ChatGPT${where}: ${e.message || e.code || "request failed"}`;
}

/** Canonical (Anthropic-shaped) history → Responses API input items. */
export function toResponses(messages: Msg[]): any[] {
  const out: any[] = [];
  const userText = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(m.role === "assistant"
        ? { type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] }
        : userText(m.content));
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n\n");
      if (text) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const b of m.content as any[]) {
        if (b.type === "tool_use") out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
      continue;
    }
    // user turn: tool results become function_call_output items; screenshots follow as a user message
    const images: any[] = [];
    const parts: any[] = [];
    for (const b of m.content as any[]) {
      if (b.type === "tool_result") {
        const ps = typeof b.content === "string" ? [{ type: "text", text: b.content }] : b.content ?? [];
        const text = ps.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
        const imgs = ps.filter((x: any) => x.type === "image");
        out.push({ type: "function_call_output", call_id: b.tool_use_id, output: (b.is_error ? "ERROR: " : "") + (text || "(done)") + (imgs.length ? " [screenshot attached in the next message]" : "") });
        images.push(...imgs);
      } else if (b.type === "text") parts.push({ type: "input_text", text: b.text });
      else if (b.type === "image") images.push(b);
    }
    if (images.length) {
      parts.push({ type: "input_text", text: images.length > 1 ? "Screenshots:" : "Screenshot:" });
      for (const img of images) parts.push({ type: "input_image", image_url: `data:${img.source.media_type};base64,${img.source.data}`, detail: "auto" });
    }
    if (parts.length) out.push({ type: "message", role: "user", content: parts });
  }
  return out;
}
