// Y2Kbot — client.
// Two modes:
//  • desktop app (window.ramNative exists): each page is ONE native window, chosen by ?view=…&arg=…
//  • browser: everything lives on a fake XP desktop in one tab.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const timeStr = (t = Date.now()) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

  const NATIVE = !!window.ramNative;
  const params = new URLSearchParams(location.search);
  const VIEW = NATIVE ? params.get("view") || "signon" : null;
  const ARG = params.get("arg") || "";
  if (NATIVE) document.body.classList.add("native", `view-${VIEW}`, `os-${window.ramNative.platform}`);

  /** In the desktop app, is (view,arg) the window this page *is*? In the browser, everything is local. */
  const isMine = (view, arg = "") => !NATIVE || (VIEW === view && ARG === arg);
  const remote = (view, arg = "", focus = true) => window.ramNative.open({ view, arg, focus });

  const state = {
    me: localStorage.getItem("ram.sn") || "",
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
    collapsed: new Set(JSON.parse(localStorage.getItem("ram.collapsed") || "[]")),
  };

  // ================= window manager =================
  let z = 10;
  let cascade = 0;
  const windows = new Map();

  function createWindow({ id, title, x, y, w, h, cls = "", onClose, closable = true }) {
    if (windows.has(id)) { windows.get(id).focus(); return windows.get(id); }
    const el = $("#tpl-window").content.firstElementChild.cloneNode(true);
    el.classList.add(...cls.split(" ").filter(Boolean));
    $(".title", el).textContent = title;
    if (!closable) $(".tb-close", el).style.display = "none";
    $("#desktop").appendChild(el);

    if (NATIVE) {
      // The page is the window. The OS handles focus, stacking and the taskbar.
      document.title = title;
      const api = {
        id, el, body: $(".window-body", el), tbtn: null,
        setTitle(t) { $(".title", el).textContent = t; document.title = t; },
        focus() {}, minimize() { window.ramNative.minimize(); },
        isFocused() { return document.hasFocus(); },
        flash() { if (!document.hasFocus()) window.ramNative.flash(); },
        close() { onClose?.(); window.ramNative.close(); },
      };
      windows.set(id, api);
      const sync = () => el.classList.toggle("inactive", !document.hasFocus());
      addEventListener("focus", sync); addEventListener("blur", sync); sync();
      $(".tb-close", el).onclick = () => api.close();
      $(".tb-min", el).onclick = () => api.minimize();
      return api;
    }

    Object.assign(el.style, { left: x + "px", top: y + "px", width: w + "px", height: h ? h + "px" : "auto" });
    const tbtn = document.createElement("button");
    tbtn.className = "taskbtn";
    tbtn.innerHTML = `<img src="logo.svg" alt=""><span></span>`;
    $("span", tbtn).textContent = title;
    $("#task-buttons").appendChild(tbtn);

    const api = {
      id, el, body: $(".window-body", el), tbtn,
      setTitle(t) { $(".title", el).textContent = t; $("span", tbtn).textContent = t; },
      focus() {
        el.classList.remove("minimized");
        el.style.zIndex = ++z;
        for (const o of windows.values()) {
          const on = o === api;
          o.el.classList.toggle("inactive", !on);
          o.tbtn.classList.toggle("active", on);
        }
        tbtn.classList.remove("flash");
      },
      isFocused() { return !el.classList.contains("inactive") && !el.classList.contains("minimized"); },
      minimize() { el.classList.add("minimized"); tbtn.classList.remove("active"); },
      flash() { if (!api.isFocused()) tbtn.classList.add("flash"); },
      close() { el.remove(); tbtn.remove(); windows.delete(id); onClose?.(); },
    };
    windows.set(id, api);

    $(".tb-close", el).onclick = (e) => { e.stopPropagation(); api.close(); };
    $(".tb-min", el).onclick = (e) => { e.stopPropagation(); api.minimize(); };
    tbtn.onclick = () => (api.isFocused() ? api.minimize() : api.focus());
    el.addEventListener("mousedown", () => api.focus());

    $(".titlebar", el).addEventListener("mousedown", (e) => {
      if (e.target.closest(".tb")) return;
      const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
      const move = (ev) => {
        el.style.left = Math.max(-el.offsetWidth + 60, Math.min(innerWidth - 60, ev.clientX - sx)) + "px";
        el.style.top = Math.max(0, Math.min(innerHeight - 60, ev.clientY - sy)) + "px";
      };
      const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
    });

    api.focus();
    return api;
  }

  /** Native dialogs size their OS window to their content. */
  function fitToContent(win) {
    if (!NATIVE) return;
    win.el.classList.add("measuring");
    requestAnimationFrame(() => {
      const h = win.el.offsetHeight;
      win.el.classList.remove("measuring");
      window.ramNative.fit(h);
    });
  }

  function nextPos(w, h) {
    const n = cascade++ % 8;
    return { x: Math.max(10, Math.min(innerWidth - w - 280, 40 + n * 26)), y: Math.max(10, Math.min(innerHeight - h - 50, 30 + n * 24)) };
  }

  // ================= sign on =================
  function showSignOn() {
    const win = createWindow({ id: "signon", title: "Sign On", x: innerWidth / 2 - 120, y: Math.max(20, innerHeight / 2 - 230), w: 240, cls: "signon" });
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
          <button class="xp help">${NATIVE ? "Setup" : "Help"}</button>
          <button class="xp go"><b>Sign On</b></button>
        </div>
        <div class="status"></div>
      </div>`;
    const sn = $(".sn", win.body);
    sn.value = state.me;
    $(".snd", win.body).checked = localStorage.getItem("ram.muted") !== "1";
    $(".getsn", win.body).onclick = () => { sn.value = ["xX_", "sk8r", "l33t", "ninja"][Math.floor(Math.random() * 4)] + Math.floor(Math.random() * 900 + 100); };
    $(".help", win.body).onclick = () => (NATIVE ? openPrefs() : openHelp());
    const go = () => {
      state.me = sn.value.trim() || "Me";
      localStorage.setItem("ram.sn", state.me);
      localStorage.setItem("ram.muted", $(".snd", win.body).checked ? "0" : "1");
      const status = $(".status", win.body);
      $(".go", win.body).disabled = true;
      const steps = ["1. Connecting...", "2. Verifying screen name...", "3. Starting agents..."];
      steps.forEach((s, i) => setTimeout(() => (status.textContent = s), i * 380));
      setTimeout(() => connect(() => {
        if (NATIVE) window.ramNative.signedOn();
        else { win.close(); showBuddyList(); }
      }), steps.length * 380);
    };
    $(".go", win.body).onclick = go;
    sn.addEventListener("keydown", (e) => e.key === "Enter" && go());
    sn.focus();
    fitToContent(win);
  }

  // ================= socket =================
  function connect(onReady) {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    state.ws = ws;
    let ready = false;
    ws.onopen = () => {
      $("#tray-conn").classList.add("on");
      for (const name of state.ims.keys()) send({ type: "history", window: name });
    };
    ws.onclose = () => {
      $("#tray-conn").classList.remove("on");
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

  const viewFor = (win) => (win.startsWith("#") ? "room" : "im");
  const openConvo = (win, opts) => (win.startsWith("#") ? openRoom(win, opts) : openIM(win, opts));

  /** In the desktop app, the agent list window is the "router" that pops open IM windows. */
  const isRouter = () => !NATIVE || VIEW === "buddylist";

  function handle(m) {
    switch (m.type) {
      case "hello":
        state.web = m.web || null;
        state.model = m.model; state.provider = m.provider; state.providers = m.providers || []; state.demoMode = m.demoMode; state.xp = m.xp;
        renderBanner();
        break;
      case "buddies": {
        const names = new Set(m.buddies.map((b) => b.screenName));
        if (state.known && isRouter()) {
          if ([...names].some((n) => !state.known.has(n))) Sounds.signOn();
          if ([...state.known].some((n) => !names.has(n))) Sounds.signOff();
        }
        state.known = names;
        state.buddies = m.buddies;
        renderBuddyList();
        for (const [name, im] of state.ims) name.startsWith("#") ? renderRoomPeople(im) : updateImChrome(name, im);
        break;
      }
      case "im":
      case "event": {
        const incoming = m.type === "im" && m.from !== "You" && !m.relayTo;
        if (!isMine(viewFor(m.window), m.window)) {
          // Not this window's conversation: the router opens (or flashes) the right IM/room window.
          if (NATIVE && VIEW === "buddylist") { remote(viewFor(m.window), m.window, false); if (incoming) Sounds.imIn(); }
          break;
        }
        const im = openConvo(m.window, { noFocus: true });
        drawItem(im, m, { live: true });
        if (incoming && !NATIVE) Sounds.imIn();
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
          if (NATIVE && VIEW === "invite") window.ramNative.close();
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
        } else if (NATIVE && VIEW === "buddylist") remote("viewer", m.vm.owner, false);
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
    blist = createWindow({ id: "buddylist", title: `${state.me}'s Agent List`, x: innerWidth - 250, y: 16, w: 226, h: Math.min(560, innerHeight - 70), cls: "buddylist", closable: NATIVE });
    blist.body.innerHTML = `
      <div class="menubar"><span class="m-agents">My Agents</span><span class="m-people">People</span>${NATIVE ? `<span class="m-prefs">Prefs</span>` : ""}<span class="m-mcp">MCP</span><span class="m-help">Help</span></div>
      <div class="banner"><img src="logo.svg" alt=""><div><div class="who"></div><div class="model"></div></div></div>
      <div class="tabs"><span class="on">Online</span><span class="setup-tab">List Setup</span></div>
      <div class="tree inset"></div>
      <div class="toolbar-bottom">
        <button class="iconbtn" data-a="im"><span class="gl">💬</span>IM</button>
        <button class="iconbtn" data-a="chat"><span class="gl">👥</span>Chat</button>
        <button class="iconbtn" data-a="info"><span class="gl">ℹ️</span>Info</button>
        <button class="iconbtn" data-a="setup"><span class="gl">🛠️</span>Setup</button>
        <button class="iconbtn" data-a="add"><span class="gl">➕</span>Add</button>
        <button class="iconbtn" data-a="sound"><span class="gl snd">🔊</span>Sound</button>
      </div>`;
    $(".m-help", blist.body).onclick = openHelp;
    $(".m-agents", blist.body).onclick = () => openAgentEditor();
    $(".m-people", blist.body).onclick = () => state.selected && openInfo(state.selected);
    if (NATIVE) $(".m-prefs", blist.body).onclick = openPrefs;
    $(".m-mcp", blist.body).onclick = openMcp;
    $(".setup-tab", blist.body).onclick = () => openAgentEditor(state.selected && getBuddy(state.selected));
    $(".snd", blist.body).textContent = Sounds.muted ? "🔇" : "🔊";
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
          localStorage.setItem("ram.muted", on ? "0" : "1");
          $(".snd", b).textContent = on ? "🔊" : "🔇";
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
        localStorage.setItem("ram.collapsed", JSON.stringify([...state.collapsed]));
        renderBuddyList();
      };
      tree.appendChild(hd);
      if (!open) continue;
      for (const b of list) {
        const row = document.createElement("div");
        row.className = "buddy" + (b.awayMessage ? " away" : "") + (b.busy ? " busy" : "") + (state.selected === b.screenName ? " sel" : "");
        row.title = (b.awayMessage ? `Away: ${b.awayMessage}` : b.profile) + `\n${routeText(b)}`;
        row.innerHTML = `<span class="ico">${b.busy ? "⌛" : b.awayMessage ? "✎" : ""}</span><span class="sn" style="${b.awayMessage ? "" : `color:${state.selected === b.screenName ? "#fff" : "#000"}`}"></span>${b.capabilities.xp ? `<span class="tag ${b.vm ? "run" : ""}">${b.vm ? "XP ON" : "XP"}</span>` : ""}${b.capabilities.imBuddies ? `<span class="tag">LEAD</span>` : ""}`;
        $(".sn", row).textContent = b.screenName;
        row.onclick = () => { state.selected = b.screenName; localStorage.setItem("ram.selected", b.screenName); renderBuddyList(); };
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
    const pos = nextPos(430, 400);
    const win = createWindow({ id: "im:" + name, title: `${name} - Instant Message`, ...pos, w: 430, h: 400, cls: "im", onClose: () => state.ims.delete(name) });
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
        <button data-f="smile" title="Smiley">☺</button>
        <span class="sep"></span>
        <button data-f="attach" title="Attach a file (or drop files on this window)">📎</button>
      </div>
      <div class="attach-bar"></div>
      <textarea class="input" placeholder="Type your message here..."></textarea>
      <div class="actions">
        <button class="xp warn" title="Warn this buddy">Warn</button>
        <button class="xp stop" title="Stop whatever this agent is doing">Block</button>
        <button class="xp reset" title="Clear this agent's memory of the conversation">Reset</button>
        <button class="xp info">Get Info</button>
        <button class="xp watch" title="Watch this buddy's Windows XP machine">Watch XP</button>
        <button class="xp share" title="Open the folder this buddy shares with its XP machine. Drop files on this window to send them.">Files</button>
        <span class="spacer"></span>
        <button class="xp send">Send</button>
      </div>
      <div class="statusbar"></div>
      <div class="drop-hint">Drop files to attach them for ${esc(name)}</div>`;
    im = { win, name, convo: $(".convo", win.body), input: $(".input", win.body), status: $(".statusbar", win.body), typing: null, last: null, fontSize: 13, warn: 0, pending: [] };
    state.ims.set(name, im);
    if (noFocus && !NATIVE) { win.el.classList.add("inactive"); win.tbtn.classList.remove("active"); win.flash(); }

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
      if (NATIVE) window.ramNative.openPath(dir);
      else addEvent(im, `${name}'s shared folder is ${dir}`);
    };
    setupAttachments(im);
    win.body.querySelectorAll(".fmtbar button").forEach((b) => (b.onclick = () => fmt(im, b.dataset.f)));
    updateImChrome(name, im);
    refreshStatus(im);
    send({ type: "history", window: name });
    if (!noFocus) im.input.focus();
    return im;
  }

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
    watch.textContent = b?.vm ? "Watch XP ●" : "Watch XP";
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
        : im.last ? `Last message received at ${timeStr(im.last)}`
        : b?.awayMessage ? `${im.name} is away.` : "");
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
    const pos = nextPos(560, 420);
    const win = createWindow({ id: "room:" + room, title: `${room} - Chat Room`, ...pos, w: 560, h: 420, cls: "im room", onClose: () => state.ims.delete(room) });
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
        <button class="xp clip" title="Attach a file (or drop files on this window)">📎</button>
        <button class="xp stop" title="Stop the buddies mid-conversation">Block</button>
        <button class="xp reset" title="Buddies forget this room's conversation">Reset</button>
        <button class="xp close-room" title="Close the room for everyone">Close Room</button>
        <span class="spacer"></span>
        <button class="xp send">Send</button>
      </div>
      <div class="statusbar"></div>
      <div class="drop-hint">Drop files to share them with the room</div>`;
    im = { win, name: room, room: true, convo: $(".convo", win.body), input: $(".input", win.body), status: $(".statusbar", win.body), typing: null, last: null, fontSize: 13, selected: null, pending: [] };
    state.ims.set(room, im);
    if (noFocus && !NATIVE) { win.el.classList.add("inactive"); win.tbtn.classList.remove("active"); win.flash(); }
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
    const win = createWindow({ id: "invite", title: existing ? `Invite to ${room}` : "Buddy Chat Invitation", x: innerWidth / 2 - 160, y: 80, w: 320, cls: "dialog" });
    const candidates = state.buddies.filter((b) => !existing?.members.includes(b.screenName));
    const preselect = state.selected || localStorage.getItem("ram.selected"); // the agent list is another window in the app
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
      const r = info?.ready === false ? { models: [], error: `${info.label} isn't connected yet. Add its key/URL in Prefs (Save & Restart), or type a model name.` } : await fetchModels(id, force);
      if (my !== token) return; // provider changed while loading
      sel.disabled = false;
      const opts = [];
      if (allowDefault && !chosen) opts.push(`<option value="">Default (${esc(state.model)})</option>`);
      for (const m of r.models) opts.push(`<option value="${esc(m.id)}">${esc(m.id + capsText(m))}</option>`);
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

  // ================= MCP servers =================
  const MCP_EXAMPLES = {
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\you\\Documents"] },
    fetch: { command: "uvx", args: ["mcp-server-fetch"] },
    "remote-example": { url: "https://example.com/mcp", headers: { Authorization: "Bearer YOUR_TOKEN" } },
  };

  function openMcp() {
    if (!isMine("mcp")) return remote("mcp");
    const win = createWindow({ id: "mcp", title: "MCP Servers", x: innerWidth / 2 - 240, y: 40, w: 480, h: 560, cls: "dialog mcpwin" });
    win.body.innerHTML = `
      <div class="content" style="flex:1;min-height:0">
        <div style="font-size:11px">Connect buddies to MCP servers. Same format as Claude Desktop's <code>claude_desktop_config.json</code>: local servers use <code>command</code>/<code>args</code>/<code>env</code>, remote ones use <code>url</code> (+ <code>headers</code>). Then tick servers per buddy in <b>Buddy Setup</b>.</div>
        <b style="margin-top:6px">Status</b>
        <div class="mcp-status inset"></div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:6px"><b>mcp.json</b><span style="flex:1"></span><button class="xp ex" style="min-width:0">Insert example</button></div>
        <textarea class="mcp-json" spellcheck="false"></textarea>
        <div class="mcp-save-status" style="font-size:10px;min-height:13px"></div>
      </div>
      <div class="buttons"><button class="xp rc" style="margin-right:auto">Reconnect</button><button class="xp cancel">Close</button><button class="xp save"><b>Save &amp; Connect</b></button></div>`;
    const ta = $(".mcp-json", win.body);
    send({ type: "mcp_config_get" });
    $(".ex", win.body).onclick = () => {
      let j; try { j = JSON.parse(ta.value || "{}"); } catch { j = {}; }
      j.mcpServers = { ...(j.mcpServers || {}) };
      for (const [k, v] of Object.entries(MCP_EXAMPLES)) if (!j.mcpServers[k]) { j.mcpServers[k] = v; break; }
      ta.value = JSON.stringify(j, null, 2);
    };
    $(".rc", win.body).onclick = () => send({ type: "mcp_reconnect" });
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
    const w = Math.min(680, innerWidth - 300), h = Math.round(w * 0.75) + 70;
    const win = createWindow({ id: "vm:" + owner, title: `${vm?.id ?? "XP"} — ${owner}'s PC`, x: Math.max(10, innerWidth - w - 270), y: 30, w, h, cls: "viewer", onClose: () => state.viewers.delete(owner) });
    win.body.innerHTML = `
      <div class="screen"><img alt="Windows XP screen" style="display:none"><div class="placeholder"></div></div>
      <div class="bar">
        <span class="live">● LIVE</span>
        <span class="hint" style="font-size:10px;color:#555">click the screen to take the mouse</span>
        <span class="spacer"></span>
        <button class="xp on">Power on</button>
        <button class="xp cad">Ctrl+Alt+Del</button>
        <button class="xp off">Pull the plug</button>
      </div>`;
    v = { win, vm, img: $("img", win.body), ph: $(".placeholder", win.body), live: $(".live", win.body) };
    state.viewers.set(owner, v);
    const frame = state.frames.get(owner);
    if (frame) { v.img.src = "data:image/png;base64," + frame; v.img.style.display = ""; v.ph.style.display = "none"; }
    else if (vm) v.ph.innerHTML = "Starting Windows...<br>▮▮▮▯▯▯";
    else {
      const doc = state.xp;
      v.ph.innerHTML = `No machine running.<br>Ask ${esc(owner)} to do something on XP and it'll boot one.` +
        (doc && !doc.ok ? `<br><br><span style="color:#f99">Not set up yet: ${esc(doc.problems.join(" "))}</span>${NATIVE ? "<br>(fix it in Prefs)" : ""}` : "");
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
    if (vm) { v.live.textContent = "● LIVE"; v.live.style.color = ""; }
    return v;
  }

  // ================= info / editor / help / prefs =================
  function openInfo(name) {
    if (!isMine("info", name)) return remote("info", name);
    const b = getBuddy(name);
    if (!b) return;
    const win = createWindow({ id: "info:" + name, title: `Buddy Info: ${name}`, x: innerWidth / 2 - 160, y: 90, w: 320, cls: "dialog" });
    win.body.innerHTML = `
      <div class="content">
        <b style="font-size:13px;color:${esc(b.color)}">${esc(b.screenName)}</b>
        <div>Group: ${esc(b.group)}</div>
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
    const win = createWindow({ id: "editor", title: existing ? `Buddy Setup: ${a.screenName}` : "Add Buddy", x: innerWidth / 2 - 200, y: 50, w: 400, cls: "dialog" });
    win.body.innerHTML = `
      <div class="content">
        <b>Screen name</b><input type="text" class="f-sn" maxlength="24" ${existing ? "disabled" : ""}>
        <div style="display:flex;gap:8px">
          <div style="flex:1"><b>Group</b><input type="text" class="f-group" list="grp"><datalist id="grp">${groups.map((g) => `<option value="${esc(g)}">`).join("")}</datalist></div>
          <div><b>Name colour</b><br><input type="color" class="f-color"></div>
        </div>
        <b>Profile (shown in Get Info)</b><input type="text" class="f-profile">
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
          <label class="row"><input type="checkbox" class="f-im"> Can IM other buddies (orchestrator)</label>
          <label class="row"><input type="checkbox" class="f-mem"> Has long-term memory (keeps notes between chats)</label>
          <label class="row"><input type="checkbox" class="f-web"> Can use the web (search${state.web?.ready ? "" : " — not set up yet"} and read pages)</label>
          <div style="margin-top:4px"><b>MCP servers</b> <a class="f-mcp-setup" style="color:#00e;text-decoration:underline;cursor:pointer;font-size:10px">set up servers…</a></div>
          <div class="f-mcp inset">${state.mcp.length ? `<label class="row"><input type="checkbox" value="__all__"> <i>All servers (including ones added later)</i></label>` + state.mcp.map((m) => `<label class="row"><input type="checkbox" value="${esc(m.name)}"> ${esc(m.name)} <span style="font-size:10px;color:${m.state === "connected" ? "#3c9c2d" : "#b00"}">${m.state === "connected" ? `${m.tools.length} tools` : esc(m.state)}</span></label>`).join("") : `<i style="color:#777">No MCP servers configured.</i>`}</div>
        </fieldset>
      </div>
      <div class="buttons">
        ${existing ? `<button class="xp del" style="margin-right:auto">Remove Buddy</button>` : ""}
        <button class="xp cancel">Cancel</button><button class="xp save"><b>${existing ? "Save" : "Add"}</b></button>
      </div>`;
    const f = (c) => $(c, win.body);
    f(".f-sn").value = a.screenName; f(".f-group").value = a.group; f(".f-color").value = a.color;
    f(".f-profile").value = a.profile; f(".f-away").value = a.awayMessage || ""; f(".f-persona").value = a.persona;
    f(".f-provider").value = a.provider || "";
    // a model written as "ollama:llama3.2" picks the provider too
    let startModel = a.model || "";
    const pm = /^([a-z0-9-]+):(.+)$/.exec(startModel);
    if (!a.provider && pm && state.providers.some((p) => p.id === pm[1])) { f(".f-provider").value = pm[1]; startModel = pm[2]; }
    const picker = modelPicker(f(".f-model-wrap"), { getProvider: () => f(".f-provider").value, value: startModel, allowDefault: true });
    f(".f-provider").onchange = () => picker.reload();
    f(".f-xp").checked = a.capabilities.xp; f(".f-coords").value = a.coords || "auto";
    const coordsUi = () => { f(".f-coords-row").style.display = f(".f-xp").checked ? "" : "none"; };
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
        provider: f(".f-provider").value || undefined, model: picker.value || undefined, capabilities: { xp: f(".f-xp").checked, imBuddies: f(".f-im").checked, memory: f(".f-mem").checked, web: f(".f-web").checked },
        coords: f(".f-coords").value,
        mcp: allBox?.checked ? "all" : [...win.body.querySelectorAll(".f-mcp input:checked")].map((cb) => cb.value).filter((v) => v !== "__all__"),
      } });
      setTimeout(() => win.close(), 50);
    };
    fitToContent(win);
  }

  function openHelp() {
    if (!isMine("help")) return remote("help");
    const win = createWindow({ id: "help", title: "Help", x: 60, y: 60, w: 380, cls: "dialog" });
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
          <li><b>Block</b> stops an agent mid-task. <b>Reset</b> wipes its memory of the chat.</li>
          <li><b>Add</b>/<b>Setup</b> to create or edit agents.</li>
          ${NATIVE ? "<li><b>Prefs</b> holds your model providers (Anthropic, OpenAI, Ollama, OpenRouter, Gemini, Groq, LM Studio, or any OpenAI-compatible server) and Windows XP settings.</li>" : ""}
        </ul>
        ${state.xp && !state.xp.ok ? `<div style="color:#b00">Windows XP isn't set up yet: ${esc(state.xp.problems.join(" "))}</div>` : ""}
      </div>
      <div class="buttons"><button class="xp ok">OK</button></div>`;
    $(".ok", win.body).onclick = () => win.close();
    fitToContent(win);
  }

  // What the Prefs table shows. key = placeholder for an API key field; url = default base URL (undefined = fixed).
  const PROVIDERS = [
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
    const s = await window.ramNative.getSettings();
    const win = createWindow({ id: "prefs", title: "Preferences", x: 0, y: 0, w: 420, cls: "dialog" });
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
              <td>${p.key ? `<input type="password" class="p-key" placeholder="${p.key}">` : ""}${p.url !== undefined ? `<input type="text" class="p-url" placeholder="${p.url || "https://your-server/v1"}">` : ""}</td>
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
    f(".p-img").value = s.xpBaseImage; f(".p-qemu").value = s.qemuBin;
    f(".p-mem").value = s.xpMemoryMb; f(".p-max").value = s.xpMaxVms; f(".p-net").value = s.xpNetwork;
    f(".p-search").value = s.searchProvider || ""; f(".p-searx").value = s.searxngUrl || ""; f(".p-private").checked = !!s.webAllowPrivate;
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
    const st = f(".p-status");
    if (h?.xp?.ok) { st.style.color = "#3c9c2d"; st.textContent = `✔ Ready to boot XP (acceleration: ${h.xp.accel}, CPU: ${h.xp.cpu}, ACPI ${h.xp.acpi ? "on" : "off"})`; }
    else if (h) { st.style.color = "#b00"; st.textContent = "✖ " + h.xp.problems.join(" "); }
    f(".b-img").onclick = async () => { const p = await window.ramNative.pickFile({ title: "Choose your XP disk image", filters: [{ name: "QEMU disk", extensions: ["qcow2", "img"] }, { name: "All files", extensions: ["*"] }] }); if (p) f(".p-img").value = p; };
    f(".b-qemu").onclick = async () => { const p = await window.ramNative.pickFile({ title: "Find qemu-system-i386" }); if (p) f(".p-qemu").value = p; };
    f(".cancel").onclick = () => win.close();
    f(".save").onclick = async () => {
      await window.ramNative.saveSettings({
        provider: f(".p-provider").value, model: picker.value,
        keys: { ...Object.fromEntries([...win.body.querySelectorAll(".ptable tr")].filter((r) => $(".p-key", r)).map((r) => [r.dataset.id, $(".p-key", r).value])),
          ...(["brave", "tavily"].includes(f(".p-search").value) ? { [f(".p-search").value]: f(".p-search-key").value } : {}) },
        searchProvider: f(".p-search").value, searxngUrl: f(".p-searx").value.trim(), webAllowPrivate: f(".p-private").checked,
        baseUrls: Object.fromEntries([...win.body.querySelectorAll(".ptable tr")].filter((r) => $(".p-url", r)).map((r) => [r.dataset.id, $(".p-url", r).value])),
        xpBaseImage: f(".p-img").value.trim(),
        qemuBin: f(".p-qemu").value.trim(), xpMemoryMb: f(".p-mem").value, xpMaxVms: f(".p-max").value, xpNetwork: f(".p-net").value,
        xpAccel: f(".p-accel").value, xpCpu: f(".p-cpu").value, xpAcpi: f(".p-acpi").checked, xpShare: f(".p-share").checked,
      });
      window.ramNative.relaunch();
    };
    fitToContent(win);
  }

  // ================= boot =================
  const tick = () => ($("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  tick(); setInterval(tick, 10000);
  $("#start-btn").onclick = () => (blist ? blist.focus() : null);
  if (localStorage.getItem("ram.muted") === "1" && !Sounds.muted) Sounds.toggle();

  if (!NATIVE) showSignOn();
  else if (VIEW === "signon") showSignOn();
  else if (VIEW === "prefs") connect(() => openPrefs());
  else connect(() => {
    switch (VIEW) {
      case "buddylist": showBuddyList(); break;
      case "im": openIM(ARG); break;
      case "room": openRoom(ARG); break;
      case "invite": openInvite(ARG); break;
      case "mcp": openMcp(); break;
      case "viewer": openViewer(ARG, getBuddy(ARG)?.vm ?? null); break;
      case "info": openInfo(ARG); break;
      case "editor": openAgentEditor(ARG ? getBuddy(ARG) : null); break;
      case "help": openHelp(); break;
    }
  });
})();
