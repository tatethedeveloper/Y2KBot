// Y2Kbot — client. Runs inside the desktop app only: each page is ONE native window,
// chosen by ?view=…&arg=…, and window.y2kNative (electron/preload.cjs) is its bridge to the app.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const timeStr = (t = Date.now()) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

  if (!window.y2kNative) {
    // Opened in an ordinary browser: there's no web version, so say so instead of half-working.
    document.body.innerHTML = `<div class="not-app"><img src="logo.svg" alt=""><p><b>Y2Kbot is a desktop app.</b></p><p>Open it from the Y2Kbot app (<code>npm run app</code>), not a web browser.</p></div>`;
    return;
  }
  const params = new URLSearchParams(location.search);
  const VIEW = params.get("view") || "signon";
  const ARG = params.get("arg") || "";
  document.body.classList.add("native", `view-${VIEW}`, `os-${window.y2kNative.platform}`);

  /** Is (view,arg) the window this page *is*? Anything else opens in its own native window. */
  const isMine = (view, arg = "") => VIEW === view && ARG === arg;
  const remote = (view, arg = "", focus = true) => window.y2kNative.open({ view, arg, focus });

  const state = {
    me: localStorage.getItem("y2k.sn") || "",
    ws: null,
    buddies: [],
    known: null,
    selected: null,
    model: "",
    provider: "",
    providers: [],
    demoMode: false,
    xp: null,
    ims: new Map(),
    viewers: new Map(),
    rooms: [],
    pendingRoom: null,   // clientId of a room this page asked to create
    uploads: new Map(),  // clientId -> window, for files being attached
    mcp: [],             // MCP server statuses
    web: null,           // web search status
    frames: new Map(),
    seen: new Set(),     // message seq numbers already drawn
    sent: new Set(),     // clientIds of messages this page sent (drawn optimistically)
    collapsed: new Set(JSON.parse(localStorage.getItem("y2k.collapsed") || "[]")),
  };

  // ================= window =================
  // The page is the window: the OS handles focus, stacking, moving and the taskbar.
  const windows = new Map();

  function createWindow({ id, title, cls = "", onClose, closable = true }) {
    if (windows.has(id)) return windows.get(id);
    const el = $("#tpl-window").content.firstElementChild.cloneNode(true);
    el.classList.add(...cls.split(" ").filter(Boolean));
    $(".title", el).textContent = title;
    if (!closable) $(".tb-close", el).style.display = "none";
    $("#app").appendChild(el);
    document.title = title;
    const api = {
      id, el, body: $(".window-body", el),
      setTitle(t) { $(".title", el).textContent = t; document.title = t; },
      focus() {}, minimize() { window.y2kNative.minimize(); },
      isFocused() { return document.hasFocus(); },
      flash() { if (!document.hasFocus()) window.y2kNative.flash(); },
      close() { onClose?.(); window.y2kNative.close(); },
    };
    windows.set(id, api);
    const sync = () => el.classList.toggle("inactive", !document.hasFocus());
    addEventListener("focus", sync); addEventListener("blur", sync); sync();
    $(".tb-close", el).onclick = () => api.close();
    $(".tb-min", el).onclick = () => api.minimize();
    return api;
  }

  /** Native dialogs size their OS window to their content. */
  function fitToContent(win) {
    // One measurement per frame, done in one go: overlapping calls used to read the window's
    // current height instead of the content's, so dialogs never grew (Prefs got cut off).
    cancelAnimationFrame(win.fitFrame);
    win.fitFrame = requestAnimationFrame(() => {
      win.el.classList.add("measuring");
      const h = win.el.offsetHeight;
      win.el.classList.remove("measuring");
      window.y2kNative.fit(h);
    });
  }

  // ================= sign on =================
  function showSignOn() {
    const win = createWindow({ id: "signon", title: "Sign On", cls: "signon" });
    win.body.innerHTML = `
      <div class="banner"><img src="logo.svg" alt=""><div class="wordmark">Y2K<b>bot</b></div><div class="sub">AGENTS FROM THE MILLENNIUM</div></div>
      <div class="form">
        <b>ScreenName</b>
        <input type="text" class="sn" maxlength="24" placeholder="Your screen name">
        <a class="getsn">Get a Screen Name</a>
        <b>Password</b>
        <input type="text" class="pw" disabled placeholder="(not needed — it's 2003 locally)">
        <label class="row"><input type="checkbox" checked disabled> Save password</label>
        <label class="row"><input type="checkbox" class="snd" checked> Play sounds</label>
        <div class="bottom">
          <button class="xp help">Setup</button>
          <button class="xp go"><b>Sign On</b></button>
        </div>
        <div class="status"></div>
      </div>`;
    const sn = $(".sn", win.body);
    sn.value = state.me;
    $(".snd", win.body).checked = localStorage.getItem("y2k.muted") !== "1";
    $(".getsn", win.body).onclick = () => { sn.value = ["xX_", "sk8r", "l33t", "ninja"][Math.floor(Math.random() * 4)] + Math.floor(Math.random() * 900 + 100); };
    $(".help", win.body).onclick = () => openPrefs();
    const go = () => {
      state.me = sn.value.trim() || "Me";
      localStorage.setItem("y2k.sn", state.me);
      localStorage.setItem("y2k.muted", $(".snd", win.body).checked ? "0" : "1");
      const status = $(".status", win.body);
      $(".go", win.body).disabled = true;
      const steps = ["1. Connecting...", "2. Verifying screen name...", "3. Starting agents..."];
      steps.forEach((s, i) => setTimeout(() => (status.textContent = s), i * 380));
      setTimeout(() => connect(() => window.y2kNative.signedOn()), steps.length * 380);
    };
    $(".go", win.body).onclick = go;
    sn.addEventListener("keydown", (e) => e.key === "Enter" && go());
    sn.focus();
    fitToContent(win);
  }

  // ================= socket =================
  function connect(onReady) {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    state.ws = ws;
    let ready = false;
    ws.onopen = () => {
      if (state.me) send({ type: "iam", name: state.me });
      for (const name of state.ims.keys()) send({ type: "history", window: name });
    };
    ws.onclose = () => {
      for (const im of state.ims.values()) addEvent(im, "*** Connection lost. Reconnecting...", true);
      setTimeout(() => connect(), 2000);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      handle(m);
      if (!ready && m.type === "buddies") { ready = true; onReady?.(); renderBuddyList(); }
    };
  }
  const send = (m) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(m));

  /** Send a message and wait for the reply that carries the same reqId. */
  const waiters = new Map();
  function request(m, timeoutMs = 30000) {
    const reqId = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      if (state.ws?.readyState !== 1) return reject(new Error("Not connected to Y2Kbot."));
      waiters.set(reqId, resolve);
      send({ ...m, reqId });
      setTimeout(() => { if (waiters.delete(reqId)) reject(new Error("Y2Kbot didn't answer in time.")); }, timeoutMs);
    });
  }

  // ================= buddy icons + presence =================
  const AVATARS = ["robot", "globe", "monitor", "floppy", "cat", "rocket", "bulb", "ghost", "alien", "sun", "note", "mug"];
  const hashName = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const iconOf = (b) => (AVATARS.includes(b?.icon) ? b.icon : AVATARS[hashName(b?.screenName || "") % AVATARS.length]);
  const avatarUrl = (b) => `avatars/${iconOf(b)}.svg`;
  const IDLE_MS = 5 * 60000;
  const fmtIdle = (min) => (min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`);
  /** online | busy | idle | away, and why. */
  function presenceOf(b) {
    if (!b) return { state: "away", why: "not on your list" };
    if (b.busy) return { state: "busy" };
    if (b.down) return { state: "away", why: `brain isn't answering (${b.down})`, crashed: true };
    if (b.route && !b.route.ready && !state.demoMode) return { state: "away", why: `${b.route.label} isn't set up`, crashed: true };
    if (b.awayMessage) return { state: "away", why: b.awayMessage };
    const idle = Math.floor((Date.now() - (b.idleSince || Date.now())) / 60000);
    if (idle * 60000 >= IDLE_MS) return { state: "idle", idle };
    return { state: "online" };
  }

  // ================= XP menus =================
  // menus: { "File": () => [ { label, key?, disabled?, action } | "-" ] }
  let openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.el.remove(); openMenu.span.classList.remove("open");
    openMenu = null;
  }
  addEventListener("mousedown", (e) => { if (openMenu && !e.target.closest(".xpmenu, .menubar span")) closeMenu(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  addEventListener("blur", closeMenu);
  function showMenu(span, items) {
    closeMenu();
    const el = document.createElement("div");
    el.className = "xpmenu";
    for (const it of items()) {
      if (it === "-") { el.appendChild(Object.assign(document.createElement("div"), { className: "sep" })); continue; }
      if (!it) continue;
      const row = document.createElement("div");
      row.className = "item" + (it.disabled ? " disabled" : "");
      row.innerHTML = `<span class="lbl"></span><span class="key"></span>`;
      $(".lbl", row).textContent = it.label;
      $(".key", row).textContent = it.key || "";
      if (!it.disabled) row.onclick = () => { closeMenu(); it.action(); };
      el.appendChild(row);
    }
    document.body.appendChild(el);
    const r = span.getBoundingClientRect();
    el.style.left = Math.max(0, Math.min(r.left, innerWidth - el.offsetWidth - 2)) + "px";
    el.style.top = r.bottom + "px";
    span.classList.add("open");
    openMenu = { el, span };
  }
  function attachMenus(bar, menus) {
    bar.querySelectorAll("span").forEach((span) => {
      const items = menus[span.textContent.trim()];
      if (!items) return;
      span.classList.add("has-menu");
      span.onmousedown = (e) => { e.preventDefault(); openMenu?.span === span ? closeMenu() : showMenu(span, items); };
      span.onmouseenter = () => { if (openMenu && openMenu.span !== span) showMenu(span, items); }; // slide across open menus
    });
  }

  /** An XP-style message box inside the current window. Resolves with the button pressed. */
  function xpAlert(title, html, { icon = "info", buttons = ["OK"] } = {}) {
    return new Promise((resolve) => {
      const veil = document.createElement("div");
      veil.className = "xpmsg-veil";
      veil.innerHTML = `<div class="xpmsg"><div class="titlebar"><span class="title"></span></div>
        <div class="xpmsg-body"><img src="icons/${icon}.svg" alt="" width="32" height="32"><div class="xpmsg-text">${html}</div></div>
        <div class="xpmsg-btns"></div></div>`;
      $(".title", veil).textContent = title;
      for (const [i, label] of buttons.entries()) {
        const b = Object.assign(document.createElement("button"), { className: "xp", textContent: label });
        b.onclick = () => { veil.remove(); resolve(label); };
        $(".xpmsg-btns", veil).appendChild(b);
        if (i === 0) setTimeout(() => b.focus(), 0);
      }
      document.body.appendChild(veil);
    });
  }

  /** Ask the app for a conversation log and save it where the user picks. */
  async function saveConversation(win, format) {
    try {
      const r = await request({ type: "log_get", window: win, format });
      const stamp = new Date().toISOString().slice(0, 10);
      const name = `${win.replace(/^#/, "room ")} ${stamp}.${format === "html" ? "html" : "txt"}`;
      const filters = format === "html" ? [{ name: "Web page", extensions: ["html"] }] : [{ name: "Text file", extensions: ["txt"] }];
      const saved = await window.y2kNative.saveText({ defaultName: name, filters, text: r.text });
      const im = state.ims.get(win);
      if (saved && im) addEvent(im, `Conversation saved to ${saved}`);
    } catch (e) { xpAlert("Save Conversation", esc(e.message), { icon: "warn" }); }
  }

  async function exportBuddy(name, withMemory = false) {
    try {
      const r = await request({ type: "buddy_export", who: name, withMemory });
      const saved = await window.y2kNative.saveText({ defaultName: r.name, filters: [{ name: "Y2Kbot buddy", extensions: ["y2kbuddy"] }], text: r.text });
      if (saved) xpAlert("Export Buddy", `Saved <b>${esc(name)}</b>${withMemory ? " with its memory notes" : ""} to<br><code>${esc(saved)}</code><br><br>Anyone with Y2Kbot can import it. It contains no API keys.`);
    } catch (e) { xpAlert("Export Buddy", esc(e.message), { icon: "warn" }); }
  }

  async function importBuddy() {
    try {
      const f = await window.y2kNative.openText({ title: "Import a buddy", filters: [{ name: "Y2Kbot buddy", extensions: ["y2kbuddy", "json"] }] });
      if (!f) return false;
      const r = await request({ type: "buddy_import", text: f.text });
      if (r.error) { await xpAlert("Import Buddy", esc(r.error), { icon: "warn" }); return false; }
      state.selected = r.screenName; localStorage.setItem("y2k.selected", r.screenName);
      Sounds.signOn();
      await xpAlert("Import Buddy", `<b>${esc(r.screenName)}</b> is on your agent list${r.withMemory ? ", with its memory notes" : ""}.` +
        (r.notes.length ? `<ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""), { icon: "add" });
      return true;
    } catch (e) { await xpAlert("Import Buddy", esc(e.message), { icon: "warn" }); return false; }
  }

  // ================= buddy gallery (ready-made buddies in the repo's buddies/ folder) =================
  async function openGallery() {
    if (!isMine("gallery")) return remote("gallery");
    const win = createWindow({ id: "gallery", title: "Buddy Gallery", cls: "dialog gallerywin" });
    win.body.innerHTML = `
      <div class="content">
        <div style="font-size:11px">Ready-made buddies. Add the ones you like; they use your default model until you pick another in Buddy Setup.</div>
        <div class="g-list inset"><i style="color:#777">Loading…</i></div>
      </div>
      <div class="buttons"><button class="xp g-imp" style="margin-right:auto" title="Add a buddy from a .y2kbuddy file">Import File…</button><button class="xp g-close"><b>Close</b></button></div>`;
    $(".g-close", win.body).onclick = () => win.close();
    $(".g-imp", win.body).onclick = () => importBuddy();
    let list = [];
    try { list = (await request({ type: "gallery_get" })).buddies || []; }
    catch (e) { $(".g-list", win.body).innerHTML = `<i style="color:#b00">${esc(e.message)}</i>`; return; }
    const render = () => {
      const box = $(".g-list", win.body);
      if (!list.length) { box.innerHTML = `<i style="color:#777">The gallery is empty.</i>`; return; }
      const cats = [...new Set(list.map((g) => g.category))];
      box.innerHTML = cats.map((c) => `<div class="g-cat">${esc(c)}</div>` + list.filter((g) => g.category === c).map((g) => {
        const have = !!getBuddy(g.screenName);
        return `<div class="g-item" data-file="${esc(g.file)}">
          <img src="${avatarUrl({ screenName: g.screenName, icon: g.icon })}" alt="" width="32" height="32">
          <div class="g-text"><b style="color:${esc(g.color)}">${esc(g.screenName)}</b> <span class="g-title">${esc(g.title)}</span>${g.xp ? ` <span class="tag">XP</span>` : ""}
            <div class="g-blurb">${esc(g.blurb)}</div><div class="g-profile">“${esc(g.profile)}”</div></div>
          <button class="xp g-add" style="min-width:0"${have ? " disabled" : ""}>${have ? "Added" : "Add"}</button>
        </div>`;
      }).join("")).join("");
      box.querySelectorAll(".g-add").forEach((btn) => (btn.onclick = async () => {
        const file = btn.closest(".g-item").dataset.file;
        btn.disabled = true; btn.textContent = "Adding…";
        try {
          const r = await request({ type: "gallery_add", file });
          if (r.error) throw new Error(r.error);
          btn.textContent = "Added";
          Sounds.signOn();
          if (r.notes.length) xpAlert("Buddy Gallery", `<b>${esc(r.screenName)}</b> is on your agent list.<ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`, { icon: "add" });
        } catch (e) { btn.disabled = false; btn.textContent = "Add"; xpAlert("Buddy Gallery", esc(e.message), { icon: "warn" }); }
      }));
      fitToContent(win);
    };
    state.onBuddies = render; // "Added" follows the agent list (e.g. after removing one)
    render();
  }

  const viewFor = (win) => (win.startsWith("#") ? "room" : "im");
  const openConvo = (win, opts) => (win.startsWith("#") ? openRoom(win, opts) : openIM(win, opts));

  /** The agent list window is the "router" that pops open IM windows. */
  const isRouter = () => VIEW === "buddylist";

  function handle(m) {
    if (m.reqId && waiters.has(m.reqId)) { waiters.get(m.reqId)(m); waiters.delete(m.reqId); return; }
    switch (m.type) {
      case "approve_request":
        if (VIEW === "approve" && ARG === m.id) renderApprove(m);
        else if (isRouter()) { Sounds.warn(); remote("approve", m.id); }
        break;
      case "approve_done":
        if (VIEW === "approve" && ARG === m.id) { state.approveDone = true; window.y2kNative.close(); }
        break;
      case "hello":
        if (VIEW === "viewer" && ARG) send({ type: "vm_watch", owner: ARG }); // (again after a reconnect)
        state.web = m.web || null;
        state.model = m.model; state.provider = m.provider; state.providers = m.providers || []; state.demoMode = m.demoMode; state.xp = m.xp;
        renderBanner();
        break;
      case "buddies": {
        const names = new Set(m.buddies.map((b) => b.screenName));
        // door sounds: a buddy arriving or recovering signs on; one leaving or crashing signs off
        const crashed = new Map(m.buddies.map((b) => [b.screenName, !!presenceOf(b).crashed]));
        if (state.known && isRouter()) {
          const arrived = [...names].some((n) => !state.known.has(n)) || [...crashed].some(([n, c]) => !c && state.crashed?.get(n));
          const left = [...state.known].some((n) => !names.has(n)) || [...crashed].some(([n, c]) => c && state.crashed?.has(n) && !state.crashed.get(n));
          if (left) Sounds.signOff(); else if (arrived) Sounds.signOn();
        }
        state.crashed = crashed;
        state.known = names;
        state.buddies = m.buddies;
        renderBuddyList();
        state.onBuddies?.();
        for (const [name, im] of state.ims) name.startsWith("#") ? renderRoomPeople(im) : updateImChrome(name, im);
        break;
      }
      case "im":
      case "event": {
        const incoming = m.type === "im" && m.from !== "You" && !m.relayTo;
        if (!isMine(viewFor(m.window), m.window)) {
          // Not this window's conversation: the router opens (or flashes) the right IM/room window.
          if (VIEW === "buddylist") { remote(viewFor(m.window), m.window, false); if (incoming) Sounds.imIn(); }
          break;
        }
        const im = openConvo(m.window, { noFocus: true });
        drawItem(im, m, { live: true });
        break;
      }
      case "history": {
        const im = state.ims.get(m.window);
        if (im) for (const item of m.items) drawItem(im, item, { live: false });
        break;
      }
      case "rooms":
        state.rooms = m.rooms || [];
        renderBuddyList();
        for (const r of state.rooms) { const im = state.ims.get(r.name); if (im) renderRoomPeople(im); }
        for (const [name, im] of state.ims) if (name.startsWith("#") && !state.rooms.some((r) => r.name === name)) addEvent(im, "This room has been closed.");
        break;
      case "room_created":
        if (m.clientId && m.clientId === state.pendingRoom) {
          state.pendingRoom = null;
          openRoom(m.room);
          if (VIEW === "invite") window.y2kNative.close();
          else windows.get("invite")?.close();
        }
        break;
      case "memory":
        for (const box of document.querySelectorAll(`.memory-box[data-who="${CSS.escape(m.who)}"]`)) { box.value = m.text; box.dataset.loaded = "1"; }
        break;
      case "error":
        alert(m.text);
        break;
      case "attached": {
        state.uploads.delete(m.clientId);
        const im = state.ims.get(m.window);
        if (im) { im.pending.push(m.file); renderChips(im); }
        break;
      }
      case "attach_failed": {
        state.uploads.delete(m.clientId);
        const im = state.ims.get(m.window);
        if (im) { addEvent(im, `couldn't attach ${m.name}: ${m.error}`, true); renderChips(im); }
        break;
      }
      case "models": {
        const r = { models: m.models || [], error: m.error || null, at: Date.now() };
        modelCache.set(m.provider, r);
        for (const fn of modelWaiters.get(m.provider) || []) fn(r);
        modelWaiters.delete(m.provider);
        break;
      }
      case "bench_tasks": case "bench_history": case "bench_progress": case "bench_finished": case "bench_error": case "bench_markdown":
        benchHandle(m);
        break;
      case "skills":
        state.skills = m.skills;
        state.onSkills?.();
        break;
      case "skill_error":
        state.onSkillError?.(m.error);
        break;
      case "vm_checkpoints": {
        const v = state.viewers.get(m.owner);
        if (!v) break;
        for (const c of [".cp", ".undo"]) $(c, v.win.body).disabled = false;
        const hint = $(".hint", v.win.body);
        const last = m.checkpoints.at(-1);
        hint.style.color = m.error ? "#b00" : "#3c9c2d";
        hint.textContent = m.error ? m.error : m.action === "vm_undo" ? `Went back to "${last?.label}"` : `Checkpoint saved (${m.checkpoints.length} kept)`;
        $(".undo", v.win.body).title = last ? `Go back to "${last.label}" (${new Date(last.at).toLocaleTimeString()})` : "No checkpoint yet";
        break;
      }
      case "xp_ready":
        state.xpReady = m.status;
        state.onXpReady?.(m.error);
        break;
      case "vm_pasted": {
        const v = state.viewers.get(m.owner);
        if (!v) break;
        $(".paste", v.win.body).disabled = false;
        const hint = $(".hint", v.win.body);
        hint.style.color = m.error ? "#b00" : "#3c9c2d";
        hint.textContent = m.error ? m.error : `Typed ${m.chars} characters into XP` + (m.skipped ? ` (skipped ${m.skipped})` : "");
        break;
      }
      case "chatgpt":
        state.chatgpt = m;
        if (!m.pending) state.chatgptUrl = "";
        state.onChatgpt?.();
        break;
      case "chatgpt_login_url":
        state.chatgptUrl = m.url;
        window.open(m.url, "_blank"); // the desktop app hands this to your real browser
        state.onChatgpt?.();
        break;
      case "providers":
        state.providers = m.providers || state.providers;
        if ("demoMode" in m) state.demoMode = m.demoMode;
        modelCache.delete("chatgpt");
        renderBanner();
        state.onChatgpt?.();
        break;
      case "mcp":
        state.mcp = m.servers || [];
        renderMcpStatus();
        break;
      case "mcp_config":
        for (const ta of document.querySelectorAll(".mcp-json")) if (!ta.dataset.loaded) {
          let t = m.text;
          try { t = JSON.stringify(JSON.parse(t), null, 2) + "\n"; } catch {} // keep invalid JSON as-is so it can be fixed
          ta.value = t; ta.dataset.loaded = "1";
        }
        break;
      case "mcp_saved": {
        const st = document.querySelector(".mcp-save-status");
        if (st) { st.textContent = m.error ? "✖ " + m.error : "✔ Saved. Connecting..."; st.style.color = m.error ? "#b00" : "#3c9c2d"; }
        break;
      }
      case "cleared": {
        const im = state.ims.get(m.window);
        if (im) im.convo.innerHTML = "";
        break;
      }
      case "typing": {
        const im = state.ims.get(m.window);
        if (!im) break;
        im.typing = m.on ? m.who : null;
        refreshStatus(im);
        break;
      }
      case "vm_started": {
        if (isRouter()) Sounds.boot();
        if (isMine("viewer", m.vm.owner)) {
          const v = openViewer(m.vm.owner, m.vm);
          v.win.setTitle(`${m.vm.id} — ${m.vm.owner}'s PC`);
          v.live.textContent = "● LIVE"; v.live.style.color = "";
        } else if (VIEW === "buddylist" && m.vm.owner !== "y2kbench") remote("viewer", m.vm.owner, false);
        break;
      }
      case "vm_stopped": {
        const v = state.viewers.get(m.vm.owner);
        if (v) { v.vm = null; v.img.style.display = "none"; v.ph.style.display = ""; v.ph.innerHTML = `*** ${esc(m.vm.id)} has been powered off ***<br>everything on it is gone. that's the point.`; v.live.textContent = "OFF"; v.live.style.color = "#b00"; }
        state.frames.delete(m.vm.owner);
        break;
      }
      case "vm_frame": {
        state.frames.set(m.owner, m.png);
        const v = state.viewers.get(m.owner);
        if (v) { v.img.src = "data:image/png;base64," + m.png; v.img.style.display = ""; v.ph.style.display = "none"; }
        break;
      }
    }
  }

  function drawItem(im, m, { live }) {
    if (m.seq != null) { if (state.seen.has(m.seq)) return; state.seen.add(m.seq); }
    if (m.type === "event") return addEvent(im, m.text, /error/i.test(m.text));
    if (m.from === "You") {
      if (m.clientId && state.sent.has(m.clientId)) return; // already drawn when we hit Send
      return addLine(im, m.me || state.me, withClips(m.text, m.attachments), true, false, m.at);
    }
    if (m.relayTo) return addRelay(im, m.from, m.relayTo, m.text, m.at);
    if (live) addIncoming(im, m.from, m.text, m.auto);
    else for (const c of splitIMs(m.text)) addLine(im, m.from, c, false, m.auto, m.at);
  }

  // ================= buddy list =================
  let blist;
  function showBuddyList() {
    blist = createWindow({ id: "buddylist", title: `${state.me}'s Agent List`, cls: "buddylist", closable: true });
    blist.body.innerHTML = `
      <div class="menubar"><span class="m-agents">My Agents</span><span class="m-prefs">Prefs</span><span class="m-mcp">MCP</span><span class="m-skills">Skills</span><span class="m-bench">Bench</span><span class="m-help">Help</span></div>
      <div class="banner"><img src="logo.svg" alt=""><div><div class="who"></div><div class="model"></div></div></div>
      <div class="tabs"><span class="on">Online</span><span class="setup-tab">List Setup</span></div>
      <div class="tree inset"></div>
      <div class="toolbar-bottom">
        <button class="iconbtn needs-sel" data-a="im" title="Send an instant message"><img src="icons/im.svg" alt="">IM</button>
        <button class="iconbtn" data-a="chat" title="Start a chat room"><img src="icons/chat.svg" alt="">Chat</button>
        <button class="iconbtn needs-sel" data-a="info" title="Get buddy info"><img src="icons/info.svg" alt="">Info</button>
        <button class="iconbtn" data-a="setup" title="Buddy setup"><img src="icons/setup.svg" alt="">Setup</button>
        <button class="iconbtn" data-a="add" title="Add a buddy"><img src="icons/add.svg" alt="">Add</button>
        <button class="iconbtn" data-a="sound" title="Sounds on/off"><img class="snd" src="icons/sound.svg" alt="">Sound</button>
      </div>`;
    const selBuddy = () => (state.selected && getBuddy(state.selected)) || null;
    attachMenus($(".menubar", blist.body), {
      "My Agents": () => [
        { label: "Add a Buddy…", action: () => openAgentEditor() },
        { label: "Buddy Gallery…", action: openGallery },
        { label: "Import a Buddy…", action: importBuddy },
        "-",
        { label: "Send Instant Message", disabled: !selBuddy(), action: () => openIM(state.selected) },
        { label: "Get Buddy Info", disabled: !selBuddy(), action: () => openInfo(state.selected) },
        { label: "Buddy Setup…", disabled: !selBuddy(), action: () => openAgentEditor(selBuddy()) },
        "-",
        { label: "Export Buddy…", disabled: !selBuddy(), action: () => exportBuddy(state.selected) },
        { label: "Export Buddy with Memory…", disabled: !selBuddy() || selBuddy().capabilities.memory === false, action: () => exportBuddy(state.selected, true) },
        "-",
        { label: "Start a Chat Room…", action: () => openInvite("") },
      ],
      "Help": () => [
        { label: "Help Topics", action: openHelp },
        { label: "Check for Updates…", action: () => window.y2kNative.updateAction("check") },
        "-",
        { label: "About Y2Kbot", action: openAbout },
      ],
    });
    clearInterval(state.idleTimer);
    state.idleTimer = setInterval(renderBuddyList, 60000); // idle times tick up
    $(".m-prefs", blist.body).onclick = openPrefs;
    $(".m-mcp", blist.body).onclick = openMcp;
    $(".m-skills", blist.body).onclick = openSkills;
    $(".m-bench", blist.body).onclick = openBench;
    $(".setup-tab", blist.body).onclick = () => openAgentEditor(state.selected && getBuddy(state.selected));
    $(".snd", blist.body).src = Sounds.muted ? "icons/sound-off.svg" : "icons/sound.svg";
    blist.body.querySelectorAll(".iconbtn").forEach((b) => (b.onclick = () => {
      const sel = state.selected;
      switch (b.dataset.a) {
        case "im": if (sel) openIM(sel); break;
        case "info": if (sel) openInfo(sel); break;
        case "chat": openInvite(""); break;
        case "setup": openAgentEditor(sel && getBuddy(sel)); break;
        case "add": openAgentEditor(); break;
        case "sound": {
          const on = Sounds.toggle();
          localStorage.setItem("y2k.muted", on ? "0" : "1");
          $(".snd", b).src = on ? "icons/sound.svg" : "icons/sound-off.svg";
          break;
        }
      }
    }));
    renderBanner();
    renderBuddyList();
  }

  function renderBanner() {
    if (!blist) return;
    $(".who", blist.body).textContent = state.me;
    $(".model", blist.body).textContent = state.demoMode ? `DEMO MODE — set up ${providerLabel(state.provider)}` : `${providerLabel(state.provider)} · ${state.model}`;
  }

  const getBuddy = (n) => state.buddies.find((b) => b.screenName === n);
  const providerLabel = (id) => state.providers.find((p) => p.id === id)?.label || id;
  const routeText = (b) => (b?.route ? `${b.route.label} · ${b.route.model}${b.route.ready ? "" : " (not set up)"}` : "");

  function renderBuddyList() {
    if (!blist) return;
    const tree = $(".tree", blist.body);
    $(".toolbar-bottom", blist.body)?.classList.toggle("no-sel", !(state.selected && getBuddy(state.selected)));
    const groups = new Map();
    for (const b of state.buddies) {
      if (!groups.has(b.group)) groups.set(b.group, []);
      groups.get(b.group).push(b);
    }
    groups.set("Offline", []);
    tree.innerHTML = "";
    if (state.rooms.length) {
      const hd = document.createElement("div");
      hd.className = "group-hd";
      hd.innerHTML = `<span class="tri">▼</span>Chat Rooms (${state.rooms.length})`;
      tree.appendChild(hd);
      for (const r of state.rooms) {
        const row = document.createElement("div");
        row.className = "buddy room-row" + (r.busy ? " busy" : "");
        row.title = `${r.members.length} buddies: ${r.members.join(", ")}`;
        row.innerHTML = `<span class="ico">${r.busy ? "⌛" : "#"}</span><span class="sn"></span><span class="tag">${r.members.length + 1}</span>`;
        $(".sn", row).textContent = r.name.slice(1);
        row.ondblclick = () => openRoom(r.name);
        tree.appendChild(row);
      }
    }
    for (const [g, list] of groups) {
      const open = !state.collapsed.has(g);
      const hd = document.createElement("div");
      hd.className = "group-hd";
      hd.innerHTML = `<span class="tri">${open ? "▼" : "▶"}</span>${esc(g)} (${list.length}/${g === "Offline" ? 0 : list.length})`;
      hd.onclick = () => {
        open ? state.collapsed.add(g) : state.collapsed.delete(g);
        localStorage.setItem("y2k.collapsed", JSON.stringify([...state.collapsed]));
        renderBuddyList();
      };
      tree.appendChild(hd);
      if (!open) continue;
      for (const b of list) {
        const row = document.createElement("div");
        const pr = presenceOf(b);
        row.className = "buddy" + (pr.state === "away" ? " away" : "") + (pr.state === "idle" ? " idle" : "") + (b.busy ? " busy" : "") + (state.selected === b.screenName ? " sel" : "");
        row.title = (pr.state === "away" ? `Away: ${pr.why}` : pr.state === "idle" ? `Idle for ${fmtIdle(pr.idle)}` : (b.profile || "").slice(0, 200)) + `\n${routeText(b)}`;
        row.innerHTML = `<img class="av" src="${avatarUrl(b)}" alt=""><span class="ico">${b.busy ? "⌛" : pr.state === "away" ? "✎" : ""}</span><span class="sn"></span>${pr.state === "idle" ? `<span class="idle-t">(${fmtIdle(pr.idle)})</span>` : ""}${b.capabilities.xp ? `<span class="tag ${b.vm ? "run" : ""}">${b.vm ? "XP ON" : "XP"}</span>` : ""}${b.capabilities.imBuddies ? `<span class="tag">LEAD</span>` : ""}`;
        $(".sn", row).textContent = b.screenName;
        row.onclick = () => { state.selected = b.screenName; localStorage.setItem("y2k.selected", b.screenName); renderBuddyList(); };
        row.ondblclick = () => openIM(b.screenName);
        tree.appendChild(row);
      }
    }
  }

  // ================= IM windows =================
  function openIM(name, { noFocus = false } = {}) {
    if (!isMine("im", name)) { remote("im", name, !noFocus); return null; }
    let im = state.ims.get(name);
    if (im) { if (!noFocus) im.win.focus(); return im; }
    const win = createWindow({ id: "im:" + name, title: `${name} - Instant Message`, cls: "im", onClose: () => state.ims.delete(name) });
    win.body.innerHTML = `
      <div class="menubar"><span>File</span><span>Edit</span><span>Insert</span><span>People</span></div>
      <div class="convo inset"></div>
      <div class="fmtbar">
        <button data-f="smaller" title="Smaller text">A<sup>-</sup></button>
        <button data-f="bigger" title="Bigger text">A<sup>+</sup></button>
        <span class="sep"></span>
        <button data-f="b" title="Bold"><b>B</b></button>
        <button data-f="i" title="Italic"><i>I</i></button>
        <button data-f="u" title="Underline"><u>U</u></button>
        <span class="sep"></span>
        <button data-f="code" title="Code">{ }</button>
        <button data-f="smile" title="Smiley"><img src="icons/smile.svg" alt="Smiley"></button>
        <span class="sep"></span>
        <button data-f="attach" title="Attach a file (or drop files on this window)"><img src="icons/clip.svg" alt="Attach"></button>
      </div>
      <div class="attach-bar"></div>
      <textarea class="input" placeholder="Type your message here..."></textarea>
      <div class="actions">
        <button class="iconbtn warn" title="Warn this buddy"><img src="icons/warn.svg" alt="">Warn</button>
        <button class="iconbtn stop" title="Stop whatever this agent is doing"><img src="icons/block.svg" alt="">Block</button>
        <button class="iconbtn reset" title="Clear this agent's memory of the conversation"><img src="icons/reset.svg" alt="">Reset</button>
        <button class="iconbtn info" title="Get Info"><img src="icons/info.svg" alt="">Info</button>
        <button class="iconbtn watch" title="Watch this buddy's Windows XP machine"><img src="icons/watch.svg" alt=""><span class="lbl">Watch</span></button>
        <button class="iconbtn share" title="Open the folder this buddy shares with its XP machine. Drop files on this window to send them."><img src="icons/files.svg" alt="">Files</button>
        <span class="spacer"></span>
        <button class="iconbtn send" title="Send (Enter)"><img src="icons/send.svg" alt=""><b>Send</b></button>
      </div>
      <div class="statusbar"></div>
      <div class="drop-hint">Drop files to attach them for ${esc(name)}</div>`;
    im = { win, name, convo: $(".convo", win.body), input: $(".input", win.body), status: $(".statusbar", win.body), typing: null, last: null, fontSize: 13, warn: 0, pending: [] };
    state.ims.set(name, im);

    const doSend = () => {
      const text = im.input.value.trim();
      const attachments = im.pending.map((f) => f.name);
      if (!text && !attachments.length) return;
      if ([...state.uploads.values()].includes(name)) { addEvent(im, "still attaching a file, one sec..."); return; }
      im.input.value = "";
      im.pending = []; renderChips(im);
      const clientId = Math.random().toString(36).slice(2);
      state.sent.add(clientId);
      addLine(im, state.me, withClips(text, attachments), true);
      Sounds.imOut();
      send({ type: "im", to: name, text, attachments, clientId });
    };
    $(".send", win.body).onclick = doSend;
    im.input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } });
    $(".warn", win.body).onclick = () => {
      im.warn = Math.min(100, im.warn + 10);
      Sounds.warn();
      addEvent(im, `${name} has been warned. Warning level: ${im.warn}%`);
      send({ type: "im", to: name, text: `*** You have been warned by ${state.me}. Your warning level is now ${im.warn}%. Rethink your last answer.` });
    };
    $(".stop", win.body).onclick = () => send({ type: "stop", who: name });
    $(".reset", win.body).onclick = () => send({ type: "reset", who: name });
    $(".info", win.body).onclick = () => openInfo(name);
    $(".watch", win.body).onclick = () => { const b = getBuddy(name); openViewer(name, b?.vm ?? null); };
    $(".share", win.body).onclick = () => {
      const dir = getBuddy(name)?.sharedDir;
      if (!dir) return;
      window.y2kNative.openPath(dir);
    };
    setupAttachments(im);
    win.body.querySelectorAll(".fmtbar button").forEach((b) => (b.onclick = () => fmt(im, b.dataset.f)));
    attachMenus($(".menubar", win.body), {
      File: () => convoFileMenu(im),
      Edit: () => convoEditMenu(im),
      Insert: () => [
        { label: "File Attachment…", action: () => pickFiles(im) },
        { label: "Smiley :-)", action: () => fmt(im, "smile") },
        { label: "Code", key: "`…`", action: () => fmt(im, "code") },
        { label: "Code Block", action: () => { im.input.setRangeText("\n```\n\n```\n", im.input.selectionStart, im.input.selectionEnd, "end"); im.input.focus(); } },
      ],
      People: () => {
        const b = getBuddy(name);
        return [
          { label: "Get Info", action: () => openInfo(name) },
          { label: "Buddy Setup…", disabled: !b, action: () => openAgentEditor(b) },
          b?.capabilities.xp ? { label: "Watch XP", action: () => openViewer(name, b?.vm ?? null) } : null,
          b?.sharedDir ? { label: "Open Shared Folder", action: () => window.y2kNative.openPath(b.sharedDir) } : null,
          "-",
          { label: "Warn", action: () => $(".warn", win.body).click() },
          { label: "Block (stop working)", action: () => send({ type: "stop", who: name }) },
          { label: "Reset Conversation", action: () => send({ type: "reset", who: name }) },
          "-",
          { label: "Export Buddy…", disabled: !b, action: () => exportBuddy(name) },
          { label: "Export Buddy with Memory…", disabled: !b || b.capabilities.memory === false, action: () => exportBuddy(name, true) },
        ];
      },
    });
    updateImChrome(name, im);
    refreshStatus(im);
    setInterval(() => { if (!im.typing) refreshStatus(im); }, 60000); // idle time ticks up
    send({ type: "history", window: name });
    if (!noFocus) im.input.focus();
    return im;
  }

  const convoFileMenu = (im) => [
    { label: "Save Conversation as Text…", action: () => saveConversation(im.name, "txt") },
    { label: "Save Conversation as Web Page…", action: () => saveConversation(im.name, "html") },
    "-",
    { label: "Open Chat Logs Folder", action: () => window.y2kNative.openDataFolder("logs") },
    "-",
    { label: "Close", key: "Alt+F4", action: () => im.win.close() },
  ];
  const convoEditMenu = (im) => [
    { label: "Copy", key: "Ctrl+C", disabled: !String(getSelection()).trim() && im.input.selectionStart === im.input.selectionEnd, action: () => document.execCommand("copy") },
    { label: "Select All of Conversation", action: () => { const r = document.createRange(); r.selectNodeContents(im.convo); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } },
    "-",
    { label: "Clear Window", action: () => { im.convo.innerHTML = ""; } },
    "-",
    { label: "Bigger Text", action: () => fmt(im, "bigger") },
    { label: "Smaller Text", action: () => fmt(im, "smaller") },
  ];

  function fmt(im, f) {
    const t = im.input;
    const [s, e] = [t.selectionStart, t.selectionEnd];
    const sel = t.value.slice(s, e);
    const wrap = { b: ["**", "**"], i: ["*", "*"], u: ["_", "_"], code: ["`", "`"] }[f];
    if (f === "smaller" || f === "bigger") {
      im.fontSize = Math.max(10, Math.min(20, im.fontSize + (f === "bigger" ? 2 : -2)));
      t.style.fontSize = im.convo.style.fontSize = im.fontSize + "px";
      return;
    }
    if (f === "attach") return pickFiles(im);
    const ins = f === "smile" ? " :-) " : wrap[0] + sel + wrap[1];
    t.setRangeText(ins, s, e, "end");
    t.focus();
  }

  // ---- attachments: drop or pick files → uploaded right away → shown as chips → sent with the next message
  const withClips = (text, names) => (names?.length ? `${text || ""}${text ? "\n" : ""}📎 ${names.join(", ")}` : text);

  function setupAttachments(im) {
    const el = im.win.el;
    el.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault(); el.classList.add("dropping");
    });
    el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove("dropping"); });
    el.addEventListener("drop", (e) => {
      el.classList.remove("dropping");
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      uploadFiles(im, e.dataTransfer.files);
    });
    // paste an image or file straight into the message box
    im.input.addEventListener("paste", (e) => {
      const fs = [...(e.clipboardData?.files || [])];
      if (fs.length) { e.preventDefault(); uploadFiles(im, fs); }
    });
    renderChips(im);
  }

  function pickFiles(im) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.multiple = true;
    inp.onchange = () => uploadFiles(im, inp.files);
    inp.click();
  }

  async function uploadFiles(im, list) {
    for (const file of list) {
      if (file.size > 25 * 1024 * 1024) { addEvent(im, `${file.name} is too big (max 25 MB)`, true); continue; }
      const clientId = Math.random().toString(36).slice(2);
      state.uploads.set(clientId, im.name);
      renderChips(im);
      const data = await fileToBase64(file);
      send({ type: "attach", window: im.name, name: file.name || "pasted.png", data, clientId });
    }
  }

  function renderChips(im) {
    const bar = $(".attach-bar", im.win.body);
    if (!bar) return;
    const uploading = [...state.uploads.values()].filter((w) => w === im.name).length;
    bar.innerHTML = "";
    bar.style.display = im.pending.length || uploading ? "" : "none";
    im.pending.forEach((f, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.title = `${f.kind}, ${Math.ceil(f.size / 1024)} KB`;
      chip.innerHTML = `${f.kind === "image" ? "🖼️" : "📄"} <span></span> <b title="Remove">✕</b>`;
      $("span", chip).textContent = f.name;
      $("b", chip).onclick = () => { im.pending.splice(i, 1); renderChips(im); };
      bar.appendChild(chip);
    });
    if (uploading) { const u = document.createElement("span"); u.className = "chip busy"; u.textContent = `attaching ${uploading}...`; bar.appendChild(u); }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function updateImChrome(name, im) {
    if (name.startsWith("#")) return;
    const b = getBuddy(name);
    $(".share", im.win.body).style.display = b?.sharedDir ? "" : "none";
    const watch = $(".watch", im.win.body);
    watch.style.display = b?.capabilities.xp ? "" : "none";
    $(".lbl", watch).textContent = b?.vm ? "Watch ●" : "Watch";
    if (!im.typing) refreshStatus(im); // working → idle/away shows up straight away
    if (!b && state.buddies.length) refreshStatus(im, `${name} is no longer on your agent list.`);
  }

  function refreshStatus(im, override) {
    if (im.room) {
      const r = state.rooms.find((x) => x.name === im.name);
      im.status.textContent = override ?? (im.typing ? `${im.typing} is typing...` : r?.busy ? "buddies are talking..." : r ? `${r.members.length + 1} people here` : "room closed");
      return;
    }
    const b = getBuddy(im.name);
    im.status.textContent = override
      ?? (im.typing ? `${im.typing} is typing...`
        : b?.busy ? `${im.name} is working...`
        : (() => {
          const pr = presenceOf(b);
          const tail = im.last ? `Last message received at ${timeStr(im.last)}` : "";
          if (pr.state === "away") return `${im.name} is away: ${pr.why}${tail ? ` · ${tail}` : ""}`;
          if (pr.state === "idle") return `${im.name} has been idle for ${fmtIdle(pr.idle)}${tail ? ` · ${tail}` : ""}`;
          return tail;
        })());
  }

  function renderText(text) {
    return text.split(/```(?:[\w+-]*\n)?/).map((chunk, i) => {
      if (i % 2) return `<pre>${esc(chunk.replace(/\n$/, ""))}</pre>`;
      return esc(chunk)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/(^|\s)\*([^*\n]+)\*/g, "$1<i>$2</i>")
        .replace(/(^|\s)_([^_\n]+)_/g, "$1<u>$2</u>")
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
        .replace(/\n/g, "<br>");
    }).join("");
  }

  function scrollDown(im) { im.convo.scrollTop = im.convo.scrollHeight; }

  function addLine(im, from, text, mine = false, auto = false, at = Date.now()) {
    const b = getBuddy(from);
    const div = document.createElement("div");
    div.className = "line";
    div.innerHTML = `<span class="from ${mine ? "me" : ""}" style="${mine ? "" : `color:${b?.color || "#c00000"}`}">${esc(from)}${auto ? " &lt;AUTO-RESPONSE&gt;" : ""}</span> <span class="ts">(${timeStr(at)})</span>: <span class="${auto ? "auto" : ""}">${renderText(text)}</span>`;
    im.convo.appendChild(div);
    scrollDown(im);
  }

  // Agents often send several thoughts at once; show them as separate IMs.
  const splitIMs = (text) => (text.includes("```") ? [text] : text.split(/\n\s*\n/).filter((c) => c.trim()));
  function addIncoming(im, from, text, auto) {
    splitIMs(text).forEach((c, i) => setTimeout(() => {
      addLine(im, from, c, false, auto);
      im.last = Date.now();
      refreshStatus(im);
      if (i === 0) im.win.flash();
    }, i * 450));
  }

  function addRelay(im, from, to, text, at = Date.now()) {
    const div = document.createElement("div");
    div.className = "relay";
    div.innerHTML = `<span class="from" style="color:${getBuddy(from)?.color || "#555"}">${esc(from)}</span> → <b>${esc(to)}</b> <span class="ts">(${timeStr(at)})</span>: ${renderText(text)}`;
    im.convo.appendChild(div);
    scrollDown(im);
  }

  function addEvent(im, text, err = false) {
    const div = document.createElement("div");
    div.className = "ev" + (err ? " err" : "");
    div.textContent = text.startsWith("***") ? text : `*** ${text}`;
    im.convo.appendChild(div);
    scrollDown(im);
  }

  // ================= chat rooms =================
  function openRoom(room, { noFocus = false } = {}) {
    if (!isMine("room", room)) { remote("room", room, !noFocus); return null; }
    let im = state.ims.get(room);
    if (im) { if (!noFocus) im.win.focus(); return im; }
    const win = createWindow({ id: "room:" + room, title: `${room} - Chat Room`, cls: "im room", onClose: () => state.ims.delete(room) });
    win.body.innerHTML = `
      <div class="menubar"><span>File</span><span>Edit</span><span>People</span></div>
      <div class="room-main">
        <div class="convo inset"></div>
        <div class="people">
          <div class="people-hd"></div>
          <div class="people-list inset"></div>
          <button class="xp invite">Invite...</button>
          <button class="xp kick" disabled>Remove</button>
        </div>
      </div>
      <div class="attach-bar"></div>
      <textarea class="input" placeholder="Say something to the room..."></textarea>
      <div class="actions">
        <button class="iconbtn clip" title="Attach a file (or drop files on this window)"><img src="icons/clip.svg" alt="">Attach</button>
        <button class="iconbtn stop" title="Stop the buddies mid-conversation"><img src="icons/block.svg" alt="">Block</button>
        <button class="iconbtn reset" title="Buddies forget this room's conversation"><img src="icons/reset.svg" alt="">Reset</button>
        <button class="iconbtn close-room" title="Close the room for everyone"><img src="icons/door.svg" alt="">Close</button>
        <span class="spacer"></span>
        <button class="iconbtn send" title="Send (Enter)"><img src="icons/send.svg" alt=""><b>Send</b></button>
      </div>
      <div class="statusbar"></div>
      <div class="drop-hint">Drop files to share them with the room</div>`;
    im = { win, name: room, room: true, convo: $(".convo", win.body), input: $(".input", win.body), status: $(".statusbar", win.body), typing: null, last: null, fontSize: 13, selected: null, pending: [] };
    state.ims.set(room, im);
    const doSend = () => {
      const text = im.input.value.trim();
      const attachments = im.pending.map((f) => f.name);
      if (!text && !attachments.length) return;
      if ([...state.uploads.values()].includes(room)) { addEvent(im, "still attaching a file, one sec..."); return; }
      im.input.value = "";
      im.pending = []; renderChips(im);
      const clientId = Math.random().toString(36).slice(2);
      state.sent.add(clientId);
      addLine(im, state.me, withClips(text, attachments), true);
      Sounds.imOut();
      send({ type: "room_say", room, text, attachments, me: state.me, clientId });
    };
    $(".clip", win.body).onclick = () => pickFiles(im);
    setupAttachments(im);
    $(".send", win.body).onclick = doSend;
    im.input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } });
    $(".stop", win.body).onclick = () => send({ type: "stop", who: room });
    $(".reset", win.body).onclick = () => send({ type: "reset", who: room });
    $(".close-room", win.body).onclick = () => { if (confirm(`Close ${room}? Everyone leaves and the conversation is cleared.`)) { send({ type: "room_close", room }); win.close(); } };
    $(".invite", win.body).onclick = () => openInvite(room);
    attachMenus($(".menubar", win.body), {
      File: () => convoFileMenu(im),
      Edit: () => convoEditMenu(im),
      People: () => [
        { label: "Invite Buddies…", action: () => openInvite(room) },
        { label: "Remove Selected Buddy", disabled: !im.selected || im.selected === state.me, action: () => $(".kick", win.body).click() },
        { label: "Get Info on Selected", disabled: !im.selected || !getBuddy(im.selected), action: () => openInfo(im.selected) },
        "-",
        { label: "Block (stop everyone)", action: () => send({ type: "stop", who: room }) },
        { label: "Reset Conversation", action: () => send({ type: "reset", who: room }) },
        { label: "Close Room…", action: () => $(".close-room", win.body).click() },
      ],
    });
    $(".kick", win.body).onclick = () => { if (im.selected) send({ type: "room_leave", room, who: im.selected }); im.selected = null; };
    renderRoomPeople(im);
    send({ type: "history", window: room });
    if (!noFocus) im.input.focus();
    return im;
  }

  function renderRoomPeople(im) {
    const r = state.rooms.find((x) => x.name === im.name);
    const list = $(".people-list", im.win.body);
    const members = r ? r.members : [];
    $(".people-hd", im.win.body).textContent = `${members.length + 1} in room`;
    list.innerHTML = "";
    for (const who of [state.me, ...members]) {
      const b = getBuddy(who);
      const row = document.createElement("div");
      row.className = "buddy" + (b?.busy ? " busy" : "") + (im.selected === who ? " sel" : "");
      row.innerHTML = `<span class="ico">${b?.busy ? "⌛" : ""}</span><span class="sn"></span>`;
      $(".sn", row).textContent = who;
      $(".sn", row).style.color = im.selected === who ? "#fff" : who === state.me ? "#0000ff" : b?.color || "#000";
      if (who !== state.me) {
        row.onclick = () => { im.selected = who; renderRoomPeople(im); };
        row.ondblclick = () => openIM(who);
      }
      list.appendChild(row);
    }
    $(".kick", im.win.body).disabled = !im.selected;
    refreshStatus(im);
  }

  /** Start a chat room (room = "") or invite more buddies to one. */
  function openInvite(room) {
    if (!isMine("invite", room)) return remote("invite", room);
    const existing = state.rooms.find((r) => r.name === room);
    const win = createWindow({ id: "invite", title: existing ? `Invite to ${room}` : "Buddy Chat Invitation", cls: "dialog" });
    const candidates = state.buddies.filter((b) => !existing?.members.includes(b.screenName));
    const preselect = state.selected || localStorage.getItem("y2k.selected"); // the agent list is another window in the app
    win.body.innerHTML = `
      <div class="content">
        ${existing ? `<div>Pick buddies to invite to <b>${esc(room)}</b>:</div>` : `<b>Chat room name</b><input type="text" class="f-room" maxlength="24" placeholder="e.g. dev-huddle">`}
        <b style="margin-top:6px">Buddies to invite</b>
        <div class="inset invite-list">${candidates.map((b) => `
          <label class="row"><input type="checkbox" value="${esc(b.screenName)}" ${b.screenName === preselect ? "checked" : ""}> <span style="color:${esc(b.color)}">${esc(b.screenName)}</span> <span style="color:#777;font-size:10px">${esc(b.route?.label || "")}</span></label>`).join("") || "<i>Everyone's already here.</i>"}
        </div>
        ${existing ? "" : `<div style="font-size:10px;color:#555">Each buddy reads what's said and chimes in only when it has something to add.</div>`}
      </div>
      <div class="buttons"><button class="xp cancel">Cancel</button><button class="xp go"><b>${existing ? "Invite" : "Go"}</b></button></div>`;
    if (!existing) $(".f-room", win.body).value = `chat-${Math.floor(Math.random() * 900 + 100)}`;
    $(".cancel", win.body).onclick = () => win.close();
    $(".go", win.body).onclick = () => {
      const picked = [...win.body.querySelectorAll(".invite-list input:checked")].map((i) => i.value);
      if (existing) { for (const who of picked) send({ type: "room_invite", room, who }); win.close(); return; }
      if (!picked.length) { alert("Pick at least one buddy."); return; }
      state.pendingRoom = Math.random().toString(36).slice(2);
      send({ type: "room_create", room: $(".f-room", win.body).value, members: picked, clientId: state.pendingRoom });
    };
    fitToContent(win);
  }

  // ================= model picker =================
  const modelCache = new Map();   // provider -> { models, error, at }
  const modelWaiters = new Map(); // provider -> [resolve]

  function fetchModels(provider, force = false) {
    const hit = modelCache.get(provider);
    if (hit && !force && Date.now() - hit.at < 60000) return Promise.resolve(hit);
    return new Promise((resolve) => {
      if (!modelWaiters.has(provider)) modelWaiters.set(provider, []);
      modelWaiters.get(provider).push(resolve);
      if (state.ws?.readyState !== 1) { modelWaiters.delete(provider); resolve({ models: [], error: "Not connected to Y2Kbot yet." }); return; }
      send({ type: "models_get", provider, force });
      setTimeout(() => { if (modelWaiters.has(provider)) { modelWaiters.get(provider).forEach((fn) => fn({ models: [], error: "Timed out asking for models." })); modelWaiters.delete(provider); } }, 30000);
    });
  }

  /**
   * A model chooser: a dropdown of the provider's real models once it's connected,
   * with "Other…" for typing any name. Falls back to a text box if the provider isn't reachable.
   *   getProvider() → provider id ("" = the default provider)
   *   allowDefault  → first option is "Default (…)" meaning "use the default model"
   */
  function modelPicker(root, { getProvider, value = "", allowDefault = false }) {
    root.innerHTML = `
      <div class="mp-row"><select class="mp-select"></select><button class="xp mp-refresh" title="Refresh the model list" aria-label="Refresh">↻</button></div>
      <input type="text" class="mp-custom" placeholder="type a model name">
      <div class="mp-status"></div>`;
    const sel = $(".mp-select", root), custom = $(".mp-custom", root), status = $(".mp-status", root);
    let want = value;
    let token = 0;
    const capsText = (m) => (m.caps?.length ? `  [${m.caps.join(", ")}]` : "");
    const showCustom = () => { custom.style.display = sel.value === "__custom__" || sel.style.display === "none" ? "" : "none"; };
    sel.onchange = () => { if (sel.value === "__custom__") { custom.value = custom.value || ""; custom.focus(); } showCustom(); };

    async function load(force = false) {
      const my = ++token;
      const chosen = getProvider();
      const id = chosen || state.provider;
      const info = state.providers.find((p) => p.id === id);
      sel.style.display = ""; sel.disabled = true;
      sel.innerHTML = `<option>Loading models…</option>`;
      status.textContent = ""; status.className = "mp-status";
      const notReady = id === "chatgpt"
        ? "Not signed in to ChatGPT yet. In Prefs, click Continue with ChatGPT (no restart needed)."
        : `${info?.label} isn't connected yet. Add its key/URL in Prefs (Save & Restart), or type a model name.`;
      const r = info?.ready === false ? { models: [], error: notReady } : await fetchModels(id, force);
      if (my !== token) return; // provider changed while loading
      sel.disabled = false;
      const opts = [];
      if (allowDefault && !chosen) opts.push(`<option value="">Default (${esc(state.model)})</option>`);
      for (const m of r.models) opts.push(`<option value="${esc(m.id)}">${esc((m.label || m.id) + capsText(m))}</option>`);
      if (r.error || !r.models.length) {
        // nothing to pick from: plain text box (plus "default" if allowed)
        if (allowDefault && !chosen) { sel.innerHTML = opts.join("") + `<option value="__custom__">Other (type a name)…</option>`; sel.value = want ? "__custom__" : ""; }
        else sel.style.display = "none";
        custom.value = want;
        status.textContent = r.error || "This provider didn't list any models. Type a name.";
        status.className = "mp-status warn";
      } else {
        opts.push(`<option value="__custom__">Other (type a name)…</option>`);
        sel.innerHTML = opts.join("");
        if (!want && allowDefault && !chosen) sel.value = "";
        else if (want && r.models.some((m) => m.id === want)) sel.value = want;
        else if (want) { sel.value = "__custom__"; custom.value = want; }
        else sel.selectedIndex = 0;
        const vt = r.models.filter((m) => m.caps?.includes("vision") && m.caps?.includes("tools")).length;
        status.textContent = `${r.models.length} model${r.models.length === 1 ? "" : "s"} available${vt ? ` · ${vt} can see and use tools (good for XP buddies)` : ""}`;
      }
      showCustom();
    }
    $(".mp-refresh", root).onclick = () => { want = picker.value; load(true); };
    const picker = {
      get value() { return sel.style.display === "none" || sel.value === "__custom__" ? custom.value.trim() : sel.value; },
      /** call after the provider changes */
      reload(keep = false) { want = keep ? picker.value : ""; custom.value = ""; return load(); },
    };
    load();
    return picker;
  }

  // ================= Y2Kbench =================
  const bench = { tasks: [], runs: [], busy: null, live: null, picker: null, open: new Set(), selected: new Set() };
  const pct = (p, t) => (t ? Math.round((p / t) * 100) + "%" : "–");
  const STATUS = { pass: ["✅", "pass"], fail: ["❌", "fail"], error: ["⚠️", "error: couldn't verify"], stopped: ["⏹", "stopped"], queued: ["·", "queued"], running: ["⏳", "running"] };

  function benchHandle(m) {
    if (m.type === "bench_tasks") { bench.tasks = m.tasks || []; bench.busy = m.busy; renderBenchTasks(); }
    if (m.type === "bench_history") { bench.runs = m.runs || []; bench.busy = m.busy; renderBenchHistory(); renderBenchButtons(); }
    if (m.type === "bench_progress") {
      bench.busy = m.runId;
      const live = (bench.live ??= { runId: m.runId, rows: {}, total: m.total });
      live.runId = m.runId; live.total = m.total;
      const key = `${m.index}`;
      const row = (live.rows[key] ??= { task: m.task, status: "running", phase: "", steps: 0 });
      if (m.phase === "done") { row.status = m.result.status; row.ms = m.result.ms; row.steps = m.result.toolCalls; row.detail = m.result.error || m.result.checks.filter((c) => !c.ok).map((c) => c.label + ": " + c.detail).join("; "); live.summary = m.summary; }
      else { row.status = "running"; row.phase = m.event ? `${m.phase} (${m.toolCalls} steps): ${m.event.replace(/^y2kbench /, "")}` : m.phase; if (m.toolCalls) row.steps = m.toolCalls; }
      renderBenchLive(); renderBenchButtons();
    }
    if (m.type === "bench_finished") { bench.busy = null; send({ type: "bench_history" }); renderBenchButtons(); }
    if (m.type === "bench_error") { bench.busy = null; const el = document.querySelector(".bench-msg"); if (el) { el.textContent = "✖ " + m.error; el.className = "bench-msg err"; } renderBenchButtons(); }
    if (m.type === "bench_markdown") {
      navigator.clipboard?.writeText(m.text).then(() => flashBenchMsg("Copied the results table. Paste it into your README.")).catch(() => { flashBenchMsg("Couldn't use the clipboard. Here's the table:"); const ta = document.querySelector(".bench-md"); if (ta) { ta.style.display = ""; ta.value = m.text; ta.select(); } });
    }
  }
  const flashBenchMsg = (t) => { const el = document.querySelector(".bench-msg"); if (el) { el.textContent = t; el.className = "bench-msg"; } };

  function openBench() {
    if (!isMine("bench")) return remote("bench");
    const win = createWindow({ id: "bench", title: "Y2Kbench: XP task benchmark", cls: "dialog benchwin" });
    win.body.innerHTML = `
      <div class="content bench">
        <fieldset class="groupbox"><legend>New run</legend>
          <div class="bench-row">
            <label>Provider<br><select class="b-provider"></select></label>
            <div style="flex:1.6">Model<div class="b-model"></div></div>
            <label>Clicks<br><select class="b-coords"><option value="auto">Auto</option><option value="pixels">Pixels</option><option value="norm1000">0–1000</option></select></label>
            <label>Repeat<br><input type="text" class="b-repeat" value="1" style="width:34px"></label>
          </div>
          <div class="bench-row" style="margin-top:4px"><label style="flex:1">Label (optional)<br><input type="text" class="b-label" placeholder="e.g. qwen3-vl:8b + xp_guide" style="width:100%"></label></div>
          <div class="bench-row" style="margin-top:4px;gap:14px">
            <label class="row"><input type="checkbox" class="b-cmd" checked> Allow the command line (xp_cmd)</label>
            <label class="row" title="Off keeps runs comparable: with it on, what one task teaches can help the next"><input type="checkbox" class="b-skills"> Use and save skills</label>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:6px"><b>Tasks</b><a class="b-all">all</a><a class="b-none">none</a><span class="b-count" style="color:#555"></span></div>
          <div class="bench-tasks inset"></div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
            <span style="font-size:10px;color:#555;flex:1">Each task boots a fresh XP machine. Under emulation, allow 2–5 minutes per task.</span>
            <button class="xp b-watch">Watch XP</button><button class="xp b-stop">Stop</button><button class="xp b-run"><b>Run</b></button>
          </div>
          <div class="bench-msg"></div>
          <textarea class="bench-md" style="display:none;width:100%;height:90px"></textarea>
        </fieldset>
        <fieldset class="groupbox bench-live-box"><legend>This run</legend><div class="bench-live"><i style="color:#777">Not running.</i></div></fieldset>
        <fieldset class="groupbox"><legend>History</legend>
          <div style="display:flex;gap:6px;margin-bottom:4px"><span style="flex:1;font-size:10px;color:#555">Tick runs to compare them, then copy a Markdown table for your README.</span><button class="xp b-md">Copy Markdown</button></div>
          <div class="bench-history"></div>
        </fieldset>
      </div>`;
    const f = (c) => $(c, win.body);
    f(".b-provider").innerHTML = state.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}${p.ready ? "" : " (not set up)"}</option>`).join("");
    f(".b-provider").value = state.provider;
    bench.picker = modelPicker(f(".b-model"), { getProvider: () => f(".b-provider").value, value: state.model });
    f(".b-provider").onchange = () => bench.picker.reload();
    f(".b-all").onclick = () => { win.body.querySelectorAll(".bench-tasks input").forEach((c) => (c.checked = true)); countTasks(); };
    f(".b-none").onclick = () => { win.body.querySelectorAll(".bench-tasks input").forEach((c) => (c.checked = false)); countTasks(); };
    f(".b-watch").onclick = () => openViewer("y2kbench", null);
    f(".b-stop").onclick = () => send({ type: "bench_stop" });
    f(".b-run").onclick = () => {
      const taskIds = [...win.body.querySelectorAll(".bench-tasks input:checked")].map((c) => c.value);
      const model = bench.picker.value;
      if (!taskIds.length) return flashBenchMsg("Pick at least one task.");
      if (!model) return flashBenchMsg("Pick a model.");
      bench.live = { runId: null, total: 0, rows: {} };
      renderBenchLive();
      flashBenchMsg("Starting…");
      send({ type: "bench_run", provider: f(".b-provider").value, model, coords: f(".b-coords").value, repeat: Number(f(".b-repeat").value) || 1, label: f(".b-label").value.trim(), taskIds, cmd: f(".b-cmd").checked, skills: f(".b-skills").checked });
    };
    f(".b-md").onclick = () => {
      const ids = [...bench.selected];
      if (!ids.length) return flashBenchMsg("Tick one or more runs in History first.");
      send({ type: "bench_markdown", runIds: ids });
    };
    send({ type: "bench_tasks" });
    send({ type: "bench_history" });
  }

  function countTasks() {
    const all = document.querySelectorAll(".bench-tasks input").length, on = document.querySelectorAll(".bench-tasks input:checked").length;
    const el = document.querySelector(".b-count"); if (el) el.textContent = `${on} of ${all} selected`;
  }

  function renderBenchTasks() {
    const box = document.querySelector(".bench-tasks");
    if (!box) return;
    box.innerHTML = ["easy", "medium", "hard"].map((lvl) => `
      <div class="bench-level"><b>${lvl}</b>${bench.tasks.filter((t) => t.level === lvl).map((t) => `
        <label class="row" title="${esc(t.prompt)}"><input type="checkbox" value="${esc(t.id)}" checked> ${esc(t.title)}</label>`).join("")}</div>`).join("");
    box.querySelectorAll("input").forEach((c) => (c.onchange = countTasks));
    countTasks();
  }

  function renderBenchButtons() {
    const run = document.querySelector(".b-run"), stop = document.querySelector(".b-stop");
    if (run) run.disabled = !!bench.busy;
    if (stop) stop.disabled = !bench.busy;
  }

  function renderBenchLive() {
    const box = document.querySelector(".bench-live");
    if (!box || !bench.live) return;
    const L = bench.live;
    const rows = Object.entries(L.rows).sort((a, b) => Number(a[0]) - Number(b[0]));
    const done = rows.filter(([, r]) => r.status !== "running").length;
    box.innerHTML = `
      <div style="margin-bottom:3px">${done}/${L.total || "?"} done${L.summary ? ` · <b>${L.summary.pass}/${L.summary.total} passed</b>` : ""}</div>
      <table class="bench-table">${rows.map(([, r]) => `
        <tr class="st-${r.status}"><td>${STATUS[r.status]?.[0] ?? ""}</td><td>${esc(r.task)}</td>
        <td class="ph">${esc(r.status === "running" ? r.phase : r.detail || STATUS[r.status]?.[1] || "")}</td>
        <td class="num">${r.steps ?? ""}</td><td class="num">${r.ms ? Math.round(r.ms / 1000) + "s" : ""}</td></tr>`).join("")}</table>`;
  }

  function renderBenchHistory() {
    const box = document.querySelector(".bench-history");
    if (!box) return;
    if (!bench.runs.length) { box.innerHTML = `<i style="color:#777">No runs yet.</i>`; return; }
    box.innerHTML = bench.runs.map((r) => {
      const b = r.summary.byLevel || {};
      const lvl = (k) => `<span class="lvl">${k} ${pct(b[k]?.pass || 0, b[k]?.total || 0)}</span>`;
      const errs = r.tasks.filter((t) => t.status === "error").length;
      const open = bench.open.has(r.id);
      return `
        <div class="bench-run" data-id="${esc(r.id)}">
          <div class="bench-run-hd">
            <input type="checkbox" class="sel" ${bench.selected.has(r.id) ? "checked" : ""}>
            <b class="tgl">${open ? "▼" : "▶"} ${esc(r.label)}</b>
            <span class="big">${pct(r.summary.pass, r.summary.total)}</span>
            ${lvl("easy")}${lvl("medium")}${lvl("hard")}
            <span class="when">${esc(r.startedAt.slice(0, 16).replace("T", " "))}${r.finishedAt ? "" : " (running)"}${errs ? ` · ${errs} couldn't be verified` : ""}</span>
            <a class="del" title="Delete this run">✕</a>
          </div>
          ${open ? `<table class="bench-table">${r.tasks.map((t) => `
            <tr class="st-${t.status}"><td>${STATUS[t.status]?.[0] ?? ""}</td><td title="${esc(t.reply || "")}">${esc(t.title)} <span style="color:#888">(${t.level})</span></td>
            <td class="ph">${esc(t.error || t.checks.filter((c) => !c.ok).map((c) => c.label + ": " + c.detail).join("; ") || (t.status === "pass" ? "" : ""))}</td>
            <td class="num">${t.toolCalls}</td><td class="num">${Math.round(t.ms / 1000)}s</td>
            <td>${t.screenshot ? `<a href="/bench/shot/${encodeURIComponent(r.id)}/${encodeURIComponent(t.screenshot)}" target="_blank" title="Final screen"><img class="thumb" src="/bench/shot/${encodeURIComponent(r.id)}/${encodeURIComponent(t.screenshot)}"></a>` : ""}</td></tr>`).join("")}</table>` : ""}
        </div>`;
    }).join("");
    box.querySelectorAll(".bench-run").forEach((el) => {
      const id = el.dataset.id;
      $(".tgl", el).onclick = () => { bench.open.has(id) ? bench.open.delete(id) : bench.open.add(id); renderBenchHistory(); };
      $(".sel", el).onchange = (e) => { e.target.checked ? bench.selected.add(id) : bench.selected.delete(id); };
      $(".del", el).onclick = () => { if (confirm("Delete this run and its screenshots?")) { bench.selected.delete(id); send({ type: "bench_delete", runId: id }); } };
    });
  }

  // ================= MCP servers =================
  const MCP_EXAMPLES = {
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\you\\Documents"] },
    fetch: { command: "uvx", args: ["mcp-server-fetch"] },
    "remote-example": { url: "https://example.com/mcp", headers: { Authorization: "Bearer YOUR_TOKEN" } },
  };

  // ================= approvals: "Are you sure?" before risky MCP actions =================
  function renderApprove(m) {
    if (state.approveShown) return;
    state.approveShown = true;
    const win = createWindow({ id: "approve", title: `Allow ${m.title}?`, cls: "dialog approvewin", onClose: () => { if (!state.approveDone) send({ type: "approve_reply", id: m.id, ok: false }); } });
    const b = getBuddy(m.who);
    win.body.innerHTML = `
      <div class="content">
        <div class="ap-top">
          <img src="icons/warn.svg" alt="" width="32" height="32">
          <div><b>${esc(m.who)}</b> wants to use <b>${esc(m.title)}</b> from the <b>${esc(m.server)}</b> MCP server.
          <div class="ap-why">Asking because ${esc(m.why)}.</div></div>
          ${b ? `<img class="ap-av" src="${avatarUrl(b)}" alt="" width="32" height="32">` : ""}
        </div>
        <details class="ap-details"${m.args.length < 300 ? " open" : ""}><summary>What it will send</summary><pre>${esc(m.args)}</pre></details>
        <label class="row"><input type="checkbox" class="ap-always"> Don't ask again when ${esc(m.who)} uses this tool</label>
      </div>
      <div class="buttons"><button class="xp ap-yes">Allow</button><button class="xp ap-no"><b>Don't Allow</b></button></div>`;
    const answer = (ok) => { state.approveDone = true; send({ type: "approve_reply", id: m.id, ok, always: ok && $(".ap-always", win.body).checked }); window.y2kNative.close(); };
    $(".ap-yes", win.body).onclick = () => answer(true);
    $(".ap-no", win.body).onclick = () => answer(false);
    addEventListener("keydown", (e) => { if (e.key === "Escape") answer(false); });
    $(".ap-no", win.body).focus(); // the safe choice is the default
    window.y2kNative.flash();
    fitToContent(win);
  }

  // ================= skills =================
  function openSkills() {
    if (!isMine("skills")) return remote("skills");
    const win = createWindow({ id: "skills", title: "Skill Library", cls: "dialog skillswin" });
    win.body.innerHTML = `
      <div class="content">
        <div style="font-size:11px">Recipes that worked, saved by your buddies after finishing tasks. Every buddy can use them, and the closest ones are handed to a buddy when it starts something similar. Edit or delete any that are wrong.</div>
        <div style="display:flex;gap:4px;margin-top:6px"><input type="text" class="sk-q" placeholder="Search skills" style="flex:1"><button class="xp sk-new" style="min-width:0">New…</button></div>
        <div class="sk-list inset"></div>
        <div class="sk-edit" style="display:none">
          <b>Title</b><input type="text" class="sk-title">
          <b>When to use it</b><input type="text" class="sk-when">
          <b>Steps</b><textarea class="sk-steps" spellcheck="false"></textarea>
          <div class="sk-status" style="font-size:10px;min-height:13px"></div>
          <div style="display:flex;gap:4px"><button class="xp sk-del" style="margin-right:auto">Delete</button><button class="xp sk-cancel">Cancel</button><button class="xp sk-save"><b>Save</b></button></div>
        </div>
      </div>
      <div class="buttons"><span class="sk-count" style="margin-right:auto;font-size:10px;color:#555;align-self:center"></span><button class="xp close">Close</button></div>`;
    const f = (c) => $(c, win.body);
    let editing = null; // skill id, "" = new, null = not editing
    const edit = (sk) => {
      editing = sk ? sk.id : "";
      f(".sk-edit").style.display = "";
      f(".sk-title").value = sk?.title || ""; f(".sk-when").value = sk?.when || ""; f(".sk-steps").value = sk?.steps || "";
      f(".sk-del").style.display = sk ? "" : "none";
      f(".sk-status").textContent = "";
      f(".sk-title").focus();
    };
    const stopEdit = () => { editing = null; f(".sk-edit").style.display = "none"; };
    const render = () => {
      if (!document.body.contains(win.body)) { state.onSkills = null; return; }
      const all = state.skills || [];
      const q = f(".sk-q").value.trim().toLowerCase();
      const shown = q ? all.filter((k) => `${k.title} ${k.when} ${k.steps}`.toLowerCase().includes(q)) : all;
      f(".sk-count").textContent = `${all.length} skill${all.length === 1 ? "" : "s"}`;
      f(".sk-list").innerHTML = shown.length ? shown.map((k) => `
        <div class="sk-row${editing === k.id ? " sel" : ""}" data-id="${esc(k.id)}">
          <div class="sk-t">${esc(k.title)}</div>
          <div class="sk-w">${esc(k.when || "")}</div>
          <div class="sk-m">by ${esc(k.by)} · ${esc(k.updated.slice(0, 10))}${k.uses ? ` · used ${k.uses}×` : ""}</div>
        </div>`).join("") : `<div class="sk-empty">${all.length ? "No skills match." : "No skills yet. Buddies save one after they finish a task that worked, or add your own with New…"}</div>`;
      f(".sk-list").querySelectorAll(".sk-row").forEach((row) => (row.onclick = () => { edit(all.find((k) => k.id === row.dataset.id)); render(); }));
    };
    state.onSkills = render;
    state.onSkillError = (msg) => { const st = f(".sk-status"); st.textContent = "✖ " + msg; st.style.color = "#b00"; };
    f(".sk-q").oninput = render;
    f(".sk-new").onclick = () => { edit(null); render(); };
    f(".sk-cancel").onclick = () => { stopEdit(); render(); };
    f(".sk-save").onclick = () => {
      send({ type: "skill_put", id: editing || undefined, title: f(".sk-title").value, when: f(".sk-when").value, steps: f(".sk-steps").value });
      const st = f(".sk-status"); st.textContent = "Saved."; st.style.color = "#3c9c2d";
    };
    f(".sk-del").onclick = () => { if (editing) send({ type: "skill_delete", id: editing }); stopEdit(); };
    f(".close").onclick = () => win.close();
    send({ type: "skills_get" });
    render();
  }

  function openMcp() {
    if (!isMine("mcp")) return remote("mcp");
    const win = createWindow({ id: "mcp", title: "MCP Servers", cls: "dialog mcpwin" });
    win.body.innerHTML = `
      <div class="content" style="flex:1;min-height:0">
        <div style="font-size:11px">Connect buddies to MCP servers. Same format as Claude Desktop's <code>claude_desktop_config.json</code>: local servers use <code>command</code>/<code>args</code>/<code>env</code>, remote ones use <code>url</code> (+ <code>headers</code>). Then tick servers per buddy in <b>Buddy Setup</b>.<br>Before a buddy uses a tool that could change, send or delete something, you're asked first. Add <code>"approve": "always"</code> or <code>"never"</code> to a server to change that.</div>
        <b style="margin-top:6px">Status</b>
        <div class="mcp-status inset"></div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:6px"><b>mcp.json</b><span style="flex:1"></span><button class="xp ex" style="min-width:0">Insert example</button></div>
        <textarea class="mcp-json" spellcheck="false"></textarea>
        <div class="mcp-save-status" style="font-size:10px;min-height:13px"></div>
      </div>
      <div class="buttons"><button class="xp rc">Reconnect</button><button class="xp ap-reset" style="margin-right:auto" title="Forget every 'Don't ask again' choice">Ask again for everything</button><button class="xp cancel">Close</button><button class="xp save"><b>Save &amp; Connect</b></button></div>`;
    const ta = $(".mcp-json", win.body);
    send({ type: "mcp_config_get" });
    $(".ex", win.body).onclick = () => {
      let j; try { j = JSON.parse(ta.value || "{}"); } catch { j = {}; }
      j.mcpServers = { ...(j.mcpServers || {}) };
      for (const [k, v] of Object.entries(MCP_EXAMPLES)) if (!j.mcpServers[k]) { j.mcpServers[k] = v; break; }
      ta.value = JSON.stringify(j, null, 2);
    };
    $(".rc", win.body).onclick = () => send({ type: "mcp_reconnect" });
    $(".ap-reset", win.body).onclick = () => { send({ type: "approvals_reset" }); const st = $(".mcp-save-status", win.body); st.textContent = "OK: you'll be asked again before every risky tool."; st.style.color = "#3c9c2d"; };
    $(".cancel", win.body).onclick = () => win.close();
    $(".save", win.body).onclick = () => {
      try { JSON.parse(ta.value); } catch (e) { const st = $(".mcp-save-status", win.body); st.textContent = "✖ Not valid JSON: " + e.message; st.style.color = "#b00"; return; }
      $(".mcp-save-status", win.body).textContent = "Saving...";
      send({ type: "mcp_config_set", text: ta.value });
    };
    renderMcpStatus();
  }

  function renderMcpStatus() {
    const box = document.querySelector(".mcp-status");
    if (!box) return;
    box.innerHTML = state.mcp.length ? "" : `<i style="color:#777">No servers yet.</i>`;
    for (const m of state.mcp) {
      const row = document.createElement("div");
      row.className = "mcp-row";
      const color = { connected: "#3c9c2d", connecting: "#c90", error: "#b00", disabled: "#888" }[m.state];
      row.innerHTML = `<span class="dot" style="background:${color}"></span><b></b> <span class="k"></span> <span class="d"></span>`;
      $("b", row).textContent = m.name;
      $(".k", row).textContent = `(${m.kind})`;
      $(".d", row).textContent = m.state === "connected" ? `${m.tools.length} tools: ${m.tools.slice(0, 8).join(", ")}${m.tools.length > 8 ? "…" : ""}` : m.state === "error" ? m.error : m.state;
      if (m.state === "error") $(".d", row).style.color = "#b00";
      box.appendChild(row);
    }
  }

  // ================= XP viewer =================
  function openViewer(owner, vm) {
    if (!isMine("viewer", owner)) { remote("viewer", owner); return null; }
    let v = state.viewers.get(owner);
    if (v) { v.vm = vm ?? v.vm; v.win.focus(); return v; }
    const win = createWindow({ id: "vm:" + owner, title: `${vm?.id ?? "XP"} — ${owner}'s PC`, cls: "viewer", onClose: () => state.viewers.delete(owner) });
    win.body.innerHTML = `
      <div class="screen"><img alt="Windows XP screen" style="display:none"><div class="placeholder"></div></div>
      <div class="bar">
        <span class="live">● LIVE</span>
        <span class="hint" style="font-size:10px;color:#555">click the screen to take the mouse</span>
        <span class="spacer"></span>
        <button class="xp paste" title="Type the text on your clipboard into XP, where the cursor is (or press Ctrl+V on this window)">Paste</button>
        <button class="xp cp" title="Save the machine as it is now, so you (or the buddy) can go back to it">Checkpoint</button>
        <button class="xp undo" title="Go back to the latest checkpoint">Undo</button>
        <button class="xp on">Power on</button>
        <button class="xp cad">Ctrl+Alt+Del</button>
        <button class="xp off">Pull the plug</button>
      </div>`;
    v = { win, vm, img: $("img", win.body), ph: $(".placeholder", win.body), live: $(".live", win.body) };
    send({ type: "vm_watch", owner }); // live frames for this machine
    state.viewers.set(owner, v);
    const frame = state.frames.get(owner);
    if (frame) { v.img.src = "data:image/png;base64," + frame; v.img.style.display = ""; v.ph.style.display = "none"; }
    else if (vm) v.ph.innerHTML = "Starting Windows...<br>▮▮▮▯▯▯";
    else {
      const doc = state.xp;
      v.ph.innerHTML = `No machine running.<br>Ask ${esc(owner)} to do something on XP and it'll boot one.` +
        (doc && !doc.ok ? `<br><br><span style="color:#f99">Not set up yet: ${esc(doc.problems.join(" "))}</span><br>(fix it in Prefs)` : "");
      v.live.textContent = "OFF"; v.live.style.color = "#b00";
    }
    const coords = (e) => {
      const r = v.img.getBoundingClientRect();
      return { x: Math.round(((e.clientX - r.left) / r.width) * v.img.naturalWidth), y: Math.round(((e.clientY - r.top) / r.height) * v.img.naturalHeight) };
    };
    v.img.addEventListener("click", (e) => send({ type: "vm_click", owner, ...coords(e) }));
    v.img.addEventListener("dblclick", (e) => send({ type: "vm_click", owner, ...coords(e), double: true }));
    v.img.addEventListener("contextmenu", (e) => { e.preventDefault(); send({ type: "vm_click", owner, ...coords(e), button: "right" }); });
    $(".cad", win.body).onclick = () => send({ type: "vm_key", owner, combo: "ctrl+alt+delete" });
    $(".on", win.body).onclick = () => { v.ph.innerHTML = "Starting Windows...<br>▮▮▮▯▯▯"; send({ type: "vm_boot", owner }); };
    $(".off", win.body).onclick = () => send({ type: "vm_shutdown", owner });
    for (const [c, type] of [[".cp", "vm_checkpoint"], [".undo", "vm_undo"]]) {
      const btn = $(c, win.body);
      btn.onclick = () => { btn.disabled = true; send({ type, owner }); setTimeout(() => (btn.disabled = false), 4000); };
    }
    // Clipboard → XP: typed in, key by key, at XP's cursor.
    const paste = async () => {
      const btn = $(".paste", win.body), hint = $(".hint", win.body);
      if (btn.disabled) return;
      const text = (await window.y2kNative.readClipboard()).replace(/\r\n?/g, "\n");
      hint.style.color = "#b00";
      if (!text) { hint.textContent = "Your clipboard has no text."; return; }
      if (text.length > 4000) { hint.textContent = "That's too much to type in (4,000 characters max). Put it in the shared folder instead."; return; }
      btn.disabled = true;
      hint.style.color = "#555";
      hint.textContent = `Typing ${text.length} characters into XP…` + (text.length > 200 ? ` (about ${Math.ceil(text.length / 12)} s)` : "");
      send({ type: "vm_paste", owner, text });
    };
    $(".paste", win.body).onclick = paste;
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && state.viewers.get(owner) === v) { e.preventDefault(); paste(); }
    });
    if (vm) { v.live.textContent = "● LIVE"; v.live.style.color = ""; }
    return v;
  }

  // ================= info / editor / help / prefs =================
  function openInfo(name) {
    if (!isMine("info", name)) return remote("info", name);
    const b = getBuddy(name);
    if (!b) return;
    const win = createWindow({ id: "info:" + name, title: `Buddy Info: ${name}`, cls: "dialog" });
    win.body.innerHTML = `
      <div class="content">
        <div class="info-head">
          <img src="${avatarUrl(b)}" alt="" width="48" height="48">
          <div><b style="font-size:13px;color:${esc(b.color)}">${esc(b.screenName)}</b>
          <div>${(() => { const pr = presenceOf(b); return pr.state === "busy" ? "Working on something right now" : pr.state === "away" ? `<i>Away: ${esc(pr.why)}</i>` : pr.state === "idle" ? `Idle for ${fmtIdle(pr.idle)}` : "Online"; })()}</div>
          <div>Group: ${esc(b.group)}</div></div>
        </div>
        <div>Brain: <b>${esc(routeText(b))}</b>${b.provider || b.model ? "" : " <i>(default)</i>"}</div>
        <div>Can use Windows XP: <b>${b.capabilities.xp ? "yes" : "no"}</b> &nbsp;·&nbsp; Can IM buddies: <b>${b.capabilities.imBuddies ? "yes" : "no"}</b> &nbsp;·&nbsp; Web: <b>${b.capabilities.web === false ? "no" : state.web?.ready ? "search + pages" : "pages only"}</b></div>
        <div>MCP: <b>${b.mcp === "all" ? "all servers" : Array.isArray(b.mcp) && b.mcp.length ? esc(b.mcp.join(", ")) : "none"}</b>${b.capabilities.xp ? ` &nbsp;·&nbsp; XP clicks: <b>${b.coords === "pixels" ? "pixels" : b.coords === "norm1000" ? "0–1000" : `auto (${/qwen[-_. ]?3(\.\d+)?[-_. ]?vl/i.test(b.route?.model || "") ? "0–1000" : "pixels"})`}</b>` : ""}</div>
        ${b.awayMessage ? `<div style="margin-top:6px"><b>Away message:</b> <i>${esc(b.awayMessage)}</i></div>` : ""}
        <div style="margin-top:6px"><b>Profile</b></div>
        <div class="profilebox">${renderText(b.profile || "")}</div>
        ${b.capabilities.memory === false ? `<div style="margin-top:6px;color:#777">Long-term memory is off for this buddy.</div>` : `
        <div style="margin-top:6px"><b>Long-term memory</b> <span style="font-size:10px;color:#555">notes ${esc(name)} keeps between chats (you can edit them)</span></div>
        <textarea class="memory-box" data-who="${esc(name)}" placeholder="(no notes yet)"></textarea>`}
        ${b.sharedDir ? `<div style="margin-top:6px;font-size:10px;color:#555">Shared folder: ${esc(b.sharedDir)}</div>` : ""}
      </div>
      <div class="buttons">
        ${b.capabilities.memory === false ? "" : `<button class="xp mem-clear" style="margin-right:auto">Forget all</button><button class="xp mem-save">Save notes</button>`}
        <button class="xp ok">OK</button>
      </div>`;
    $(".ok", win.body).onclick = () => win.close();
    if (b.capabilities.memory !== false) {
      send({ type: "memory_get", who: name });
      $(".mem-save", win.body).onclick = () => send({ type: "memory_set", who: name, text: $(".memory-box", win.body).value });
      $(".mem-clear", win.body).onclick = () => { if (confirm(`Make ${name} forget everything it has noted?`)) send({ type: "memory_set", who: name, text: "" }); };
    }
    fitToContent(win);
  }

  function openAgentEditor(existing) {
    if (!isMine("editor", existing?.screenName || "")) return remote("editor", existing?.screenName || "");
    const a = existing || { screenName: "", group: "Buddies", color: "#0000c0", profile: "", awayMessage: "", persona: "", capabilities: { xp: false, imBuddies: false }, model: "" };
    const groups = [...new Set(state.buddies.map((b) => b.group))];
    const win = createWindow({ id: "editor", title: existing ? `Buddy Setup: ${a.screenName}` : "Add Buddy", cls: "dialog" });
    win.body.innerHTML = `
      <div class="content">
        <b>Screen name</b><input type="text" class="f-sn" maxlength="24" ${existing ? "disabled" : ""}>
        <div style="display:flex;gap:8px">
          <div style="flex:1"><b>Group</b><input type="text" class="f-group" list="grp"><datalist id="grp">${groups.map((g) => `<option value="${esc(g)}">`).join("")}</datalist></div>
          <div><b>Name colour</b><br><input type="color" class="f-color"></div>
        </div>
        <b>Buddy icon</b>
        <div class="icon-pick">${AVATARS.map((n) => `<button type="button" data-icon="${n}" title="${n}"><img src="avatars/${n}.svg" alt="${n}"></button>`).join("")}</div>
        <b>Profile (shown in Get Info; the buddy can rewrite it)</b><textarea class="f-profile" rows="2" style="resize:vertical"></textarea>
        <b>Away message (blank = here)</b><input type="text" class="f-away">
        <b>Instructions / persona (system prompt)</b><textarea class="f-persona" placeholder="You are an agent who..."></textarea>
        <div style="display:flex;gap:8px">
          <div style="flex:1"><b>Provider</b><br><select class="f-provider" style="width:100%">
            <option value="">Default (${esc(providerLabel(state.provider))})</option>
            ${state.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}${p.ready ? "" : " — not set up"}</option>`).join("")}
          </select></div>
          <div style="flex:1.4"><b>Model</b><div class="f-model-wrap"></div></div>
        </div>
        <fieldset class="groupbox"><legend>Powers</legend>
          <label class="row"><input type="checkbox" class="f-xp"> Can boot and drive Windows XP machines</label>
          <label class="row f-coords-row" style="padding-left:20px">Click positions: <select class="f-coords">
            <option value="auto">Auto (by model)</option>
            <option value="pixels">Pixels (Claude, GPT, most models)</option>
            <option value="norm1000">0–1000 scale (Qwen3-VL)</option>
          </select></label>
          <label class="row f-cmd-row" style="padding-left:20px"><input type="checkbox" class="f-cmd"> Can run commands in XP (xp_cmd: fast, reliable file work)</label>
          <label class="row"><input type="checkbox" class="f-im"> Can IM other buddies (orchestrator)</label>
          <label class="row"><input type="checkbox" class="f-mem"> Has long-term memory (keeps notes between chats)</label>
          <label class="row"><input type="checkbox" class="f-skills"> Uses the shared skill library (learns recipes that worked)</label>
          <label class="row"><input type="checkbox" class="f-web"> Can use the web (search${state.web?.ready ? "" : " — not set up yet"} and read pages)</label>
          <div style="margin-top:4px"><b>MCP servers</b> <a class="f-mcp-setup" style="color:#00e;text-decoration:underline;cursor:pointer;font-size:10px">set up servers…</a></div>
          <div class="f-mcp inset">${state.mcp.length ? `<label class="row"><input type="checkbox" value="__all__"> <i>All servers (including ones added later)</i></label>` + state.mcp.map((m) => `<label class="row"><input type="checkbox" value="${esc(m.name)}"> ${esc(m.name)} <span style="font-size:10px;color:${m.state === "connected" ? "#3c9c2d" : "#b00"}">${m.state === "connected" ? `${m.tools.length} tools` : esc(m.state)}</span></label>`).join("") : `<i style="color:#777">No MCP servers configured.</i>`}</div>
        </fieldset>
      </div>
      <div class="buttons">
        ${existing ? `<button class="xp del" style="margin-right:auto">Remove Buddy</button>` : `<button class="xp gal" title="Pick a ready-made buddy">Gallery…</button><button class="xp imp" style="margin-right:auto" title="Add a buddy from a .y2kbuddy file">Import…</button>`}
        <button class="xp cancel">Cancel</button><button class="xp save"><b>${existing ? "Save" : "Add"}</b></button>
      </div>`;
    const f = (c) => $(c, win.body);
    f(".f-sn").value = a.screenName; f(".f-group").value = a.group; f(".f-color").value = a.color;
    f(".f-profile").value = a.profile; f(".f-away").value = a.awayMessage || ""; f(".f-persona").value = a.persona;
    f(".f-provider").value = a.provider || "";
    let icon = iconOf(a.screenName ? a : { screenName: "new" });
    const pickUi = () => win.body.querySelectorAll(".icon-pick button").forEach((b) => b.classList.toggle("on", b.dataset.icon === icon));
    win.body.querySelectorAll(".icon-pick button").forEach((b) => (b.onclick = () => { icon = b.dataset.icon; pickUi(); }));
    pickUi();
    if (!existing) {
      f(".imp").onclick = async () => { if (await importBuddy()) win.close(); };
      f(".gal").onclick = () => { remote("gallery"); win.close(); };
    }
    // a model written as "ollama:llama3.2" picks the provider too
    let startModel = a.model || "";
    const pm = /^([a-z0-9-]+):(.+)$/.exec(startModel);
    if (!a.provider && pm && state.providers.some((p) => p.id === pm[1])) { f(".f-provider").value = pm[1]; startModel = pm[2]; }
    const picker = modelPicker(f(".f-model-wrap"), { getProvider: () => f(".f-provider").value, value: startModel, allowDefault: true });
    f(".f-provider").onchange = () => picker.reload();
    f(".f-xp").checked = a.capabilities.xp; f(".f-coords").value = a.coords || "auto";
    const coordsUi = () => { for (const r of [".f-coords-row", ".f-cmd-row"]) f(r).style.display = f(".f-xp").checked ? "" : "none"; };
    f(".f-cmd").checked = a.capabilities.xpCmd !== false; f(".f-skills").checked = a.capabilities.skills !== false;
    f(".f-xp").addEventListener("change", coordsUi); coordsUi(); f(".f-im").checked = a.capabilities.imBuddies; f(".f-mem").checked = a.capabilities.memory !== false; f(".f-web").checked = a.capabilities.web !== false;
    for (const cb of win.body.querySelectorAll(".f-mcp input")) cb.checked = a.mcp === "all" ? cb.value === "__all__" : Array.isArray(a.mcp) && a.mcp.includes(cb.value);
    const allBox = win.body.querySelector('.f-mcp input[value="__all__"]');
    const syncAll = () => { for (const cb of win.body.querySelectorAll(".f-mcp input")) if (cb !== allBox) cb.disabled = !!allBox?.checked; };
    if (allBox) { allBox.onchange = syncAll; syncAll(); }
    f(".f-mcp-setup").onclick = openMcp;
    f(".cancel").onclick = () => win.close();
    if (existing) f(".del").onclick = () => { if (window.confirm(`Remove ${a.screenName} from your agent list?`)) { send({ type: "remove_agent", who: a.screenName }); win.close(); } };
    f(".save").onclick = () => {
      const sn = f(".f-sn").value.trim();
      if (!/^[\w.\- ]{2,24}$/.test(sn)) { f(".f-sn").style.borderColor = "red"; return; }
      send({ type: "upsert_agent", agent: {
        screenName: sn, group: f(".f-group").value.trim() || "Buddies", color: f(".f-color").value,
        profile: f(".f-profile").value, awayMessage: f(".f-away").value.trim() || null, persona: f(".f-persona").value.trim(),
        provider: f(".f-provider").value || undefined, model: picker.value || undefined, capabilities: { xp: f(".f-xp").checked, imBuddies: f(".f-im").checked, memory: f(".f-mem").checked, web: f(".f-web").checked, xpCmd: f(".f-cmd").checked, skills: f(".f-skills").checked },
        coords: f(".f-coords").value, icon,
        mcp: allBox?.checked ? "all" : [...win.body.querySelectorAll(".f-mcp input:checked")].map((cb) => cb.value).filter((v) => v !== "__all__"),
      } });
      setTimeout(() => win.close(), 50);
    };
    fitToContent(win);
  }

  async function openAbout() {
    const u = await window.y2kNative.getUpdate();
    xpAlert("About Y2Kbot", `<b>Y2Kbot</b> version ${esc(u.current)}<br>An agent harness that looks like a turn-of-the-millennium instant messenger.<br><br>
      <a href="https://github.com/tatethedeveloper/Y2KBot" target="_blank" rel="noopener">github.com/tatethedeveloper/Y2KBot</a>`, { icon: "info" });
  }

  // ================= updates (the main process talks to GitHub Releases) =================
  async function openUpdate() {
    const win = createWindow({ id: "update", title: "Y2Kbot Update", cls: "dialog updatewin" });
    const render = (u) => {
      const pct = Math.max(0, Math.min(100, u.percent || 0));
      let text = "", buttons = "";
      switch (u.state) {
        case "checking": text = "Looking for a newer version…"; buttons = `<button class="xp u-close">Close</button>`; break;
        case "none": text = `You have the latest version (${esc(u.current)}).`; buttons = `<button class="xp u-close"><b>OK</b></button>`; break;
        case "available":
          text = `<b>Y2Kbot ${esc(u.version)}</b> is available. You have ${esc(u.current)}.`
            + (u.manual ? `<div class="u-note">Download the new version from the releases page and install it over this one. Your buddies and settings are kept.</div>` : "");
          buttons = `<button class="xp u-skip" style="min-width:0">Skip This Version</button><span class="spacer"></span><button class="xp u-close">Later</button><button class="xp u-get"><b>${u.manual ? "Download…" : "Download"}</b></button>`;
          break;
        case "downloading":
          text = `Downloading Y2Kbot ${esc(u.version)}…<div class="u-bar"><div style="width:${pct}%"></div></div><div class="u-note">${pct}%</div>`;
          buttons = `<button class="xp u-close">Hide</button>`;
          break;
        case "ready":
          text = `Y2Kbot ${esc(u.version)} is downloaded. Restart to finish installing.<div class="u-note">Running buddies and XP machines will stop. Your chats, buddies and settings are kept.</div>`;
          buttons = `<button class="xp u-close">Later</button><button class="xp u-install"><b>Restart Now</b></button>`;
          break;
        case "error":
          text = `Couldn't check for updates.<div class="u-note">${esc(u.error)}</div>`;
          buttons = `<button class="xp u-rel" style="min-width:0">Releases Page</button><span class="spacer"></span><button class="xp u-close"><b>OK</b></button>`;
          break;
        default: text = "No update check yet."; buttons = `<button class="xp u-check">Check Now</button><button class="xp u-close">Close</button>`;
      }
      const notes = u.notes && ["available", "downloading", "ready"].includes(u.state) ? `<b>What's new</b><div class="u-notes inset">${esc(u.notes)}</div>` : "";
      win.body.innerHTML = `
        <div class="content">
          <div class="u-top"><img src="icons/update.svg" alt="" width="32" height="32"><div>${text}</div></div>
          ${notes}
        </div>
        <div class="buttons">${buttons}</div>`;
      const on = (c, fn) => { const b = $(c, win.body); if (b) b.onclick = fn; };
      on(".u-close", () => window.y2kNative.close());
      on(".u-get", () => { window.y2kNative.updateAction("download"); if (u.manual) window.y2kNative.close(); });
      on(".u-install", () => window.y2kNative.updateAction("install"));
      on(".u-skip", () => { window.y2kNative.updateAction("skip"); window.y2kNative.close(); });
      on(".u-rel", () => window.y2kNative.updateAction("releases"));
      on(".u-check", () => window.y2kNative.updateAction("check"));
      fitToContent(win);
    };
    window.y2kNative.onUpdate(render);
    render(await window.y2kNative.getUpdate());
  }

  function openHelp() {
    if (!isMine("help")) return remote("help");
    const win = createWindow({ id: "help", title: "Help", cls: "dialog" });
    win.body.innerHTML = `
      <div class="content" style="font-size:11px;line-height:1.5">
        <b style="font-size:13px">Y2Kbot</b>
        <div>Every buddy is its own AI agent with its own instructions, memory of your chat, and powers.</div>
        <ul style="margin:4px 0;padding-left:18px">
          <li><b>Double-click</b> a buddy to IM them.</li>
          <li>Buddies tagged <b>XP</b> can boot a disposable Windows XP VM. Hit <b>Watch XP</b> to see it live, and click the screen to take the mouse.</li>
          <li><b>LEAD</b> buddies can IM other buddies to split up work.</li>
          <li><b>Chat</b> starts a chat room with several buddies at once.</li>
          <li>Drop files on an XP buddy's IM window to put them in its <b>shared folder</b>, which shows up as a drive inside XP.</li>
          <li>Buddies keep <b>long-term notes</b> between chats. See and edit them in <b>Info</b>.</li>
          <li>Drop, paste or 📎 files into any IM or room. Buddies can read text, code, PDFs, Word docs and images.</li>
          <li>Buddies can <b>search and read the web</b>, and use any <b>MCP</b> servers you connect (menu: MCP).</li>
          <li><b>Bench</b> runs Y2Kbench, a set of Windows XP tasks that measures how well a model drives XP.</li>
          <li><b>Block</b> stops an agent mid-task. <b>Reset</b> wipes its memory of the chat.</li>
          <li><b>Add</b>/<b>Setup</b> to create or edit agents, and pick each one's buddy icon. <b>My Agents</b> → <b>Import / Export</b> shares a buddy as a <code>.y2kbuddy</code> file (no keys inside).</li>
          <li>Grey names are <b>idle</b>; ✎ means <b>away</b> (an away message, or its model isn't answering). You hear the door when a buddy drops out or comes back.</li>
          <li>Before a buddy uses an MCP tool that could change, send or delete something, you're asked first.</li>
          <li><b>File</b> → <b>Save Conversation</b> in any IM saves it as text or a web page. Prefs can keep a log of every chat.</li>
          <li><b>Prefs</b> holds your model providers (your ChatGPT Plus/Pro plan via Sign in with ChatGPT, Anthropic, OpenAI, Ollama, OpenRouter, Gemini, Groq, LM Studio, or any OpenAI-compatible server) and Windows XP settings.</li>
        </ul>
        ${state.xp && !state.xp.ok ? `<div style="color:#b00">Windows XP isn't set up yet: ${esc(state.xp.problems.join(" "))}</div>` : ""}
      </div>
      <div class="buttons"><button class="xp ok">OK</button></div>`;
    $(".ok", win.body).onclick = () => win.close();
    fitToContent(win);
  }

  // What the Prefs table shows. key = placeholder for an API key field; url = default base URL (undefined = fixed).
  const PROVIDERS = [
    { id: "chatgpt", label: "ChatGPT plan", signin: true, example: "auto" },
    { id: "anthropic", label: "Anthropic", key: "sk-ant-...", example: "claude-sonnet-5-5" },
    { id: "openai", label: "OpenAI", key: "sk-...", url: "https://api.openai.com/v1", example: "gpt-5" },
    { id: "ollama", label: "Ollama", url: "http://localhost:11434/v1", example: "qwen2.5vl:7b" },
    { id: "openrouter", label: "OpenRouter", key: "sk-or-...", example: "anthropic/claude-sonnet-5.5" },
    { id: "gemini", label: "Gemini", key: "AIza...", example: "gemini-2.5-flash" },
    { id: "groq", label: "Groq", key: "gsk_...", example: "llama-3.3-70b-versatile" },
    { id: "lmstudio", label: "LM Studio", url: "http://localhost:1234/v1", example: "local-model" },
    { id: "custom", label: "Custom", key: "API key (optional)", url: "", example: "model name" },
  ];

  async function openPrefs() {
    if (!isMine("prefs")) return remote("prefs");
    const s = await window.y2kNative.getSettings();
    const win = createWindow({ id: "prefs", title: "Preferences", cls: "dialog" });
    const h = s.health;
    win.body.innerHTML = `
      <div class="content">
        <fieldset class="groupbox"><legend>Brains (model providers)</legend>
          <div style="display:flex;gap:8px">
            <label style="flex:1"><b>Default provider</b><br><select class="p-provider" style="width:100%">${PROVIDERS.map((p) => `<option value="${p.id}">${p.label}</option>`).join("")}</select></label>
            <div style="flex:1.3"><b>Default model</b><div class="p-model-wrap"></div></div>
          </div>
          <div style="font-size:10px;color:#555;margin:3px 0 6px">Each buddy can use a different provider and model in Buddy Setup. Keys are stored in your OS keychain where available, and blank fields keep what's saved.</div>
          <table class="ptable">${PROVIDERS.map((p) => `
            <tr data-id="${p.id}">
              <td class="pname"><span class="dot"></span>${p.label}</td>
              <td>${p.signin ? `<div class="p-cgpt"></div>` : ""}${p.key ? `<input type="password" class="p-key" placeholder="${p.key}">` : ""}${p.url !== undefined ? `<input type="text" class="p-url" placeholder="${p.url || "https://your-server/v1"}">` : ""}</td>
            </tr>`).join("")}
          </table>
        </fieldset>
        <fieldset class="groupbox"><legend>Web</legend>
          <div style="display:flex;gap:8px">
            <label style="flex:1"><b>Search provider</b><br><select class="p-search" style="width:100%">
              <option value="">None (buddies can still read pages)</option>
              <option value="brave">Brave Search API</option>
              <option value="tavily">Tavily</option>
              <option value="searxng">SearXNG (self-hosted)</option>
            </select></label>
            <label style="flex:1"><b class="p-search-label">Key / URL</b><br><input type="password" class="p-search-key" style="width:100%"><input type="text" class="p-searx" style="width:100%" placeholder="http://192.168.1.10:8080"></label>
          </div>
          <label class="row"><input type="checkbox" class="p-private"> Let buddies fetch pages on my local network <span style="font-size:10px;color:#555">(off = safer)</span></label>
        </fieldset>
        <fieldset class="groupbox"><legend>General</legend>
          <div style="display:flex;align-items:center;gap:6px">
            <label class="row" style="flex:1"><input type="checkbox" class="p-logs"> Keep a log of every conversation <span style="font-size:10px;color:#555">(one web page per buddy per day)</span></label>
            <button class="xp p-logs-open" style="min-width:0">Open logs…</button>
          </div>
          <label class="row"><input type="checkbox" class="p-updates"> Check for new versions when Y2Kbot starts</label>
        </fieldset>
        <fieldset class="groupbox"><legend>Windows XP machines</legend>
          <b>XP base disk image (.qcow2)</b>
          <div style="display:flex;gap:4px"><input type="text" class="p-img" style="flex:1"><button class="xp b-img" style="min-width:0">Browse…</button></div>
          <b>QEMU program</b>
          <div style="display:flex;gap:4px"><input type="text" class="p-qemu" style="flex:1"><button class="xp b-qemu" style="min-width:0">Browse…</button></div>
          <div style="display:flex;gap:8px;margin-top:4px">
            <label>RAM (MB)<br><input type="text" class="p-mem" style="width:70px"></label>
            <label>Max machines<br><input type="text" class="p-max" style="width:60px"></label>
            <label style="flex:1">Network<br><select class="p-net" style="width:100%">
              <option value="none">None (safest)</option>
              <option value="restricted">Host only</option>
              <option value="user">Internet (unpatched XP!)</option>
            </select></label>
          </div>
          <div style="display:flex;gap:8px;margin-top:4px">
            <label style="flex:1">Acceleration<br><select class="p-accel" style="width:100%">
              <option value="">Auto (safe)</option>
              <option value="tcg">Emulation only (tcg)</option>
              <option value="whpx">Windows Hypervisor (whpx)</option>
              <option value="kvm">KVM (Linux)</option>
              <option value="hvf">HVF (Intel Mac)</option>
            </select></label>
            <label style="flex:1">CPU model<br><select class="p-cpu" style="width:100%">
              <option value="pentium3">Pentium III (most compatible)</option>
              <option value="coreduo">Core Duo</option>
              <option value="qemu32">QEMU generic 32-bit</option>
              <option value="max">Newest (may blue-screen)</option>
            </select></label>
          </div>
          <label class="row"><input type="checkbox" class="p-acpi"> ACPI on <span style="font-size:10px;color:#555">(match how XP was installed: you used <code>acpi=off</code> → leave unticked)</span></label>
          <label class="row"><input type="checkbox" class="p-share"> Give each XP buddy a shared folder (appears as a drive in XP)</label>
          <label class="row p-bus-row">Shared drive connects as&nbsp;<select class="p-bus">
            <option value="usb">USB drive (allows checkpoints / undo)</option>
            <option value="ide">Hard disk (older; no undo)</option>
          </select></label>
          <label class="row"><input type="checkbox" class="p-instant"> Instant boot: start machines from a saved desktop</label>
          <div class="p-ib" style="font-size:10px;margin:0 0 0 20px"></div>
          <div class="p-status" style="font-size:10px;margin-top:6px"></div>
        </fieldset>
      </div>
      <div class="buttons"><button class="xp cancel">Cancel</button><button class="xp save"><b>Save &amp; Restart</b></button></div>`;
    const f = (c) => $(c, win.body);
    f(".p-provider").value = s.provider || "anthropic";
    // The model list comes from the running app, so it reflects keys saved at the last restart.
    const picker = modelPicker(f(".p-model-wrap"), { getProvider: () => f(".p-provider").value, value: s.model || "" });
    const ready = Object.fromEntries((h?.providers || []).map((p) => [p.id, p.ready]));
    for (const row of win.body.querySelectorAll(".ptable tr")) {
      const id = row.dataset.id;
      const key = $(".p-key", row), url = $(".p-url", row);
      if (key && s.keysSet?.[id]) key.placeholder = "•••••••• saved";
      if (url) url.value = s.baseUrls?.[id] || "";
      $(".dot", row).classList.toggle("on", !!ready[id]);
      $(".dot", row).title = ready[id] ? "ready" : "not set up";
    }
    f(".p-provider").onchange = () => picker.reload();

    // Sign in with ChatGPT: happens live, no Save & Restart needed.
    const cgBox = f(".p-cgpt");
    const renderChatgpt = () => {
      if (!document.body.contains(cgBox)) { state.onChatgpt = null; return; }
      const c = state.chatgpt || {};
      let html;
      if (c.pending) {
        html = `<span>Waiting for your browser…</span> <button class="xp cg-cancel">Cancel</button>`
          + (state.chatgptUrl ? ` <a href="${esc(state.chatgptUrl)}" target="_blank" rel="noopener">open it again</a>` : "");
      } else if (c.signedIn) {
        html = `<span>Signed in${c.email ? ` as <b>${esc(c.email)}</b>` : ""}</span> <button class="xp cg-out">Sign out</button>`;
      } else {
        html = `<button class="xp cg-in">Continue with ChatGPT</button>` + (c.known ? ` <a href="#" class="cg-fresh">Use another account</a>` : "");
      }
      if (c.error) html += `<div class="cg-err">${esc(c.error)}</div>`;
      else if (!c.signedIn && !c.pending) html += `<div class="cg-note">ChatGPT Plus or Pro. Buddies use your plan's allowance instead of an API key.</div>`;
      cgBox.innerHTML = html;
      const on = !!state.providers.find((p) => p.id === "chatgpt")?.ready;
      const dot = $(".dot", cgBox.closest("tr"));
      dot.classList.toggle("on", on); dot.title = on ? "ready" : "not signed in";
      const btn = (c) => $(c, cgBox);
      if (btn(".cg-in")) btn(".cg-in").onclick = () => { btn(".cg-in").disabled = true; send({ type: "chatgpt_login" }); };
      if (btn(".cg-fresh")) btn(".cg-fresh").onclick = (e) => { e.preventDefault(); send({ type: "chatgpt_login", fresh: true }); };
      if (btn(".cg-cancel")) btn(".cg-cancel").onclick = () => send({ type: "chatgpt_cancel" });
      if (btn(".cg-out")) btn(".cg-out").onclick = () => { btn(".cg-out").disabled = true; btn(".cg-out").textContent = "Signing out…"; send({ type: "chatgpt_logout" }); };
      if (f(".p-provider").value === "chatgpt") picker.reload();
      fitToContent(win);
    };
    state.onChatgpt = renderChatgpt;
    renderChatgpt();
    f(".p-img").value = s.xpBaseImage; f(".p-qemu").value = s.qemuBin;
    f(".p-mem").value = s.xpMemoryMb; f(".p-max").value = s.xpMaxVms; f(".p-net").value = s.xpNetwork;
    f(".p-search").value = s.searchProvider || ""; f(".p-searx").value = s.searxngUrl || ""; f(".p-private").checked = !!s.webAllowPrivate;
    f(".p-logs").checked = !!s.chatLogs;
    f(".p-updates").checked = s.checkUpdates !== false;
    f(".p-logs-open").onclick = () => window.y2kNative.openDataFolder("logs");
    const searchUi = () => {
      const p = f(".p-search").value;
      f(".p-search-key").style.display = p === "brave" || p === "tavily" ? "" : "none";
      f(".p-searx").style.display = p === "searxng" ? "" : "none";
      f(".p-search-label").textContent = p === "searxng" ? "SearXNG URL" : p ? "API key" : "";
      f(".p-search-key").value = "";
      f(".p-search-key").placeholder = s.keysSet?.[p] ? "•••••••• saved" : p === "brave" ? "BSA..." : "tvly-...";
    };
    f(".p-search").onchange = searchUi; searchUi();
    f(".p-accel").value = s.xpAccel || ""; f(".p-cpu").value = s.xpCpu || "pentium3"; f(".p-acpi").checked = !!s.xpAcpi; f(".p-share").checked = s.xpShare !== false;
    f(".p-bus").value = s.xpShareBus === "ide" ? "ide" : "usb";
    f(".p-instant").checked = s.xpInstantBoot !== false;
    // Instant boot: saved live, using the settings the app is running with now.
    const ibBox = f(".p-ib");
    const renderReady = (error) => {
      if (!document.body.contains(ibBox)) { state.onXpReady = null; return; }
      const r = state.xpReady;
      if (!f(".p-instant").checked || !r) { ibBox.innerHTML = ""; fitToContent(win); return; }
      const when = r.at ? ` Saved ${new Date(r.at).toLocaleDateString()}${r.sizeMb ? `, ${r.sizeMb} MB` : ""}.` : "";
      const color = r.state === "ready" ? "#3c9c2d" : r.state === "outdated" || r.state === "unsupported" ? "#b00" : "#555";
      let html = `<span style="color:${color}">${esc(r.detail)}${r.state === "ready" ? esc(when) : ""}</span>`;
      if (r.state === "none" || r.state === "outdated" || r.state === "ready")
        html += `<div style="margin-top:3px"><button class="xp ib-prep" style="min-width:0">${r.state === "ready" ? "Save again" : "Prepare instant boot"}</button>`
          + (r.state !== "none" ? ` <button class="xp ib-del" style="min-width:0">Delete</button>` : "") + `</div>`;
      if (r.state === "none") html += `<div style="color:#555;margin-top:2px">Boots XP once in the background (a few minutes), waits for the desktop and saves it. Uses the settings you've saved.</div>`;
      if (error) html += `<div style="color:#b00">${esc(error)}</div>`;
      ibBox.innerHTML = html;
      const prep = $(".ib-prep", ibBox), del = $(".ib-del", ibBox);
      if (prep) prep.onclick = () => { prep.disabled = true; send({ type: "xp_ready_prepare" }); };
      if (del) del.onclick = () => { del.disabled = true; send({ type: "xp_ready_discard" }); };
      fitToContent(win);
    };
    state.onXpReady = renderReady;
    f(".p-instant").addEventListener("change", () => renderReady());
    send({ type: "xp_ready_get" });
    const busUi = () => { f(".p-bus-row").style.display = f(".p-share").checked ? "" : "none"; };
    f(".p-share").addEventListener("change", busUi); busUi();
    const st = f(".p-status");
    if (h?.xp?.ok) { st.style.color = "#3c9c2d"; st.textContent = `✔ Ready to boot XP (acceleration: ${h.xp.accel}, CPU: ${h.xp.cpu}, ACPI ${h.xp.acpi ? "on" : "off"})`; }
    else if (h) { st.style.color = "#b00"; st.textContent = "✖ " + h.xp.problems.join(" "); }
    f(".b-img").onclick = async () => { const p = await window.y2kNative.pickFile({ title: "Choose your XP disk image", filters: [{ name: "QEMU disk", extensions: ["qcow2", "img"] }, { name: "All files", extensions: ["*"] }] }); if (p) f(".p-img").value = p; };
    f(".b-qemu").onclick = async () => { const p = await window.y2kNative.pickFile({ title: "Find qemu-system-i386" }); if (p) f(".p-qemu").value = p; };
    f(".cancel").onclick = () => win.close();
    f(".save").onclick = async () => {
      await window.y2kNative.saveSettings({
        provider: f(".p-provider").value, model: picker.value,
        keys: { ...Object.fromEntries([...win.body.querySelectorAll(".ptable tr")].filter((r) => $(".p-key", r)).map((r) => [r.dataset.id, $(".p-key", r).value])),
          ...(["brave", "tavily"].includes(f(".p-search").value) ? { [f(".p-search").value]: f(".p-search-key").value } : {}) },
        searchProvider: f(".p-search").value, searxngUrl: f(".p-searx").value.trim(), webAllowPrivate: f(".p-private").checked, chatLogs: f(".p-logs").checked, checkUpdates: f(".p-updates").checked,
        baseUrls: Object.fromEntries([...win.body.querySelectorAll(".ptable tr")].filter((r) => $(".p-url", r)).map((r) => [r.dataset.id, $(".p-url", r).value])),
        xpBaseImage: f(".p-img").value.trim(),
        qemuBin: f(".p-qemu").value.trim(), xpMemoryMb: f(".p-mem").value, xpMaxVms: f(".p-max").value, xpNetwork: f(".p-net").value,
        xpAccel: f(".p-accel").value, xpCpu: f(".p-cpu").value, xpAcpi: f(".p-acpi").checked, xpShare: f(".p-share").checked, xpShareBus: f(".p-bus").value,
        xpInstantBoot: f(".p-instant").checked,
      });
      window.y2kNative.relaunch();
    };
    fitToContent(win);
  }

  // ================= boot =================
  if (localStorage.getItem("y2k.muted") === "1" && !Sounds.muted) Sounds.toggle();

  if (VIEW === "signon") showSignOn();
  else if (VIEW === "update") openUpdate();
  else if (VIEW === "prefs") connect(() => openPrefs());
  else connect(() => {
    switch (VIEW) {
      case "buddylist": showBuddyList(); break;
      case "im": openIM(ARG); break;
      case "room": openRoom(ARG); break;
      case "invite": openInvite(ARG); break;
      case "mcp": openMcp(); break;
      case "skills": openSkills(); break;
      case "bench": openBench(); break;
      case "viewer": openViewer(ARG, getBuddy(ARG)?.vm ?? null); break;
      case "info": openInfo(ARG); break;
      case "editor": openAgentEditor(ARG ? getBuddy(ARG) : null); break;
      case "help": openHelp(); break;
      case "gallery": openGallery(); break;
      case "approve": // the request itself arrives right after the buddy list
        setTimeout(() => {
          if (state.approveShown) return;
          const w = createWindow({ id: "approve", title: "Y2Kbot", cls: "dialog" });
          w.body.innerHTML = `<div class="content">That request has already been answered.</div>`;
          setTimeout(() => window.y2kNative.close(), 1500);
        }, 1500);
        break;
    }
  });
})();
