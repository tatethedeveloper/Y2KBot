# Y2Kbot

*Agents from the millennium.*

![license: MIT](https://img.shields.io/badge/license-MIT-blue) ![platform: Windows | macOS | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey) ![Electron](https://img.shields.io/badge/built%20with-Electron-47848f)

A desktop agent harness that looks and feels like a turn-of-the-millennium instant messenger. **Every buddy on the list is an AI agent**, running on whichever model you like (Anthropic, OpenAI, Ollama, OpenRouter, Gemini, Groq, LM Studio, or any OpenAI-compatible server), with its own instructions, its own chat memory and its own powers. Buddies with the **XP** tag can boot their own **disposable Windows XP virtual machine** and drive it the way a person would: take a screenshot, click, type, repeat.

It's a real desktop app (Electron). The sign-on box, the agent list, every IM window and every XP viewer is its **own native window** with its own taskbar entry. The agent server runs inside the app on `127.0.0.1`, so there's nothing to host.

## Quick start

```bash
npm install
npm run app          # builds the server and launches the desktop app
```

Click **Setup** on the sign-on screen (or **Prefs** on the agent list) to:

- choose a **default provider and model**, and enter keys or URLs for any providers you use. Keys are encrypted with your OS keychain where one is available. Until the default provider is set up, buddies run in a cute demo mode.
- point at your **XP disk image** and **QEMU**, and choose RAM, how many machines can run at once, and networking.

Saving restarts the app.

### Make an installer

```bash
npm run dist         # builds for the OS you're on → release/
npm run dist:win     # .exe installer (NSIS)
npm run dist:mac     # .dmg (build this on a Mac)
npm run dist:linux   # AppImage + .deb
```

Your settings and agent list live in the app's data folder: `%APPDATA%\Y2Kbot` on Windows, `~/Library/Application Support/Y2Kbot` on macOS, `~/.config/Y2Kbot` on Linux. `agents.json` in that folder is the agent list. (If you used the app before it was renamed, your old settings folder is copied over on first launch and left in place as a backup.)

### Browser mode (optional)

`npm run web` runs the same thing headless at http://localhost:3000, on a fake XP desktop in one browser tab. Configure it with env vars: `RAM_PROVIDER`, `RAM_MODEL`, the provider keys/URLs below, `SEARCH_PROVIDER` + `BRAVE_API_KEY` / `TAVILY_API_KEY` / `SEARXNG_URL`, `WEB_ALLOW_PRIVATE=1`, `XP_BASE_IMAGE`, `QEMU_BIN`, `XP_MEMORY_MB`, `XP_MAX_VMS`, `XP_NETWORK`, `XP_ACCEL`, `PORT`.

## Model providers

| Provider | id | Needs | Example model |
|---|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| OpenAI | `openai` | `OPENAI_API_KEY` (`OPENAI_BASE_URL` optional, e.g. Azure/proxy) | `gpt-5` |
| Ollama | `ollama` | Ollama running (`OLLAMA_BASE_URL`, default `http://localhost:11434/v1`) | `qwen2.5vl:7b` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-5.5` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| Groq | `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| LM Studio | `lmstudio` | LM Studio server (`LMSTUDIO_BASE_URL`, default `http://localhost:1234/v1`) | whatever you loaded |
| Anything OpenAI-compatible | `custom` | `CUSTOM_BASE_URL` (+ `CUSTOM_API_KEY` if needed): vLLM, llama.cpp, Together, Mistral, DeepSeek… | |

- **Default** comes from Prefs (or `RAM_PROVIDER` / `RAM_MODEL`). Each buddy can pick its own **Provider** and **Model** in Buddy Setup, so you can mix them: a cheap local model for chit-chat and a frontier model for the XP operator. Writing the model as `ollama:llama3.2` also works.
- Anthropic uses its native API. Everything else goes through the OpenAI Chat Completions format with tool calling. Screenshots are sent as images in a follow-up message, which is the format OpenAI-compatible servers accept.
- **Click positions.** Most models give screen positions in pixels, but Qwen3-VL answers on a 0–1000 scale. Buddy Setup → "Click positions" defaults to **Auto**, which uses 0–1000 for Qwen3-VL models and pixels for everything else. Override it there if a model's clicks consistently land in the wrong place.
- **XP buddies need a model that can both see images and call tools.** Most frontier models can. On Ollama, use a vision + tools model such as `qwen2.5vl`, and expect small local models to struggle with clicking accurately. Text-only buddies work with any model that supports tool calling, or even ones that don't, as long as they don't need tools.
- `<think>…</think>` blocks from local reasoning models are stripped before they reach your IM window.

## Features

- Sign-on screen, agent list with collapsible groups, away messages (shown as auto-responses), "is typing...", taskbar flashing when a buddy IMs you, a tray icon, and synthesized door, IM and boot sounds.
- If a buddy IMs you while their window is closed, the window pops open. Reopening a window replays the conversation.
- Each buddy is a separate agent loop with its own history and its own provider/model. **Warn** sends the agent a warning. **Block** stops it mid-task. **Reset** wipes its memory.
- **XP buddies** get `xp_boot / screenshot / click / drag / type / key / scroll / wait / shutdown`. **Watch XP** opens a live viewer window. Click the screen to take over the mouse.
- **LEAD buddies** (orchestrators) can `send_im` other buddies to split up work. Delegation is one level deep, which rules out deadlocks.
- Use **Add / Setup** to create and edit agents.
- **Chat rooms.** Hit **Chat** on the agent list, name the room and tick some buddies. When anyone speaks, each buddy in turn reads what's new and either replies or stays quiet ("passes"). There are at most two rounds per message, so rooms don't run away with your tokens. Use **Invite…/Remove** to manage who's in, and **Block** to stop them mid-flow.
- **Long-term memory.** Each buddy keeps a small notes file (`memory_add` / `memory_replace`) that's shown to it at the start of every chat, so it remembers your preferences, past decisions and where things are on its XP machine. You can read, edit or wipe the notes in **Get Info**, and turn memory off per buddy in Buddy Setup. **Reset** clears a chat but not the notes.
- **Shared folders.** Every XP buddy has a folder that shows up as a drive inside XP (usually `D:`). Drop files on its IM window to send them in, or press **Files** to open the folder. Anything the buddy saves to that drive inside XP lands in the folder on your computer, and buddies can also read and write it from outside XP with `shared_files / shared_read / shared_write`.

- **Attachments.** Drop, paste or 📎 files into any IM or chat room. They show as chips and go with your next message. Text, code, CSV, **PDF** and **Word (.docx)** files are read and handed to the buddy, and long ones page in via `read_file`. **Images** are sent as real images, so use a model that can see. Files for XP buddies are also copied to their shared drive.
- **Web.** Buddies can read pages with `web_fetch` (HTML is cleaned to readable text, and PDFs work too) and search with `web_search` once you pick a search provider in Prefs: **Brave Search API**, **Tavily**, or your own **SearXNG** (enable `json` in its `search.formats`). Fetching anything on your local network (localhost, 192.168.x.x, …) is blocked unless you allow it in Prefs, so a web page can't talk a buddy into poking your router or homelab. Turn web off per buddy in Buddy Setup.
- **MCP servers.** Menu → **MCP** opens `mcp.json`, in the same format as Claude Desktop's `claude_desktop_config.json`:
  ```json
  {
    "mcpServers": {
      "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\you\\Documents"] },
      "homelab":    { "url": "http://192.168.1.20:8000/mcp", "headers": { "Authorization": "Bearer ..." } },
      "legacy-sse": { "url": "http://localhost:9000/sse", "type": "sse" },
      "paused":     { "command": "...", "disabled": true }
    }
  }
  ```
  Local servers (`command`/`args`/`env`) and remote ones (`url`, streamable HTTP with automatic SSE fallback) both work. The window shows each server's status and tools. **Each buddy only gets the servers you tick in Buddy Setup**, or "All servers", and none by default. Their tools appear to the model as `mcp__<server>__<tool>`.

Memory notes, shared folders, attachments (`files/`) and `mcp.json` are stored in the app's data folder, next to `settings.json`.

## Windows XP setup

### 1. Install QEMU

- **Windows:** use the installer from qemu.org (the default path `C:\Program Files\qemu\qemu-system-i386.exe` is what the app expects). The app uses **plain emulation** by default, because QEMU's Windows hypervisor support (WHPX) crashes 32-bit XP with "Unexpected VP exit code 4". You can still try WHPX under Prefs → Acceleration.
- **macOS:** `brew install qemu`. Intel Macs get HVF acceleration. Apple Silicon has to emulate x86, which works but is slow.
- **Linux:** `sudo apt install qemu-system-x86 qemu-utils`. KVM gets used automatically.

### 2. Build the XP base image

You need your own Windows XP install media and licence key. Nothing here downloads Windows.

```bash
qemu-img create -f qcow2 xp-base.qcow2 10G
qemu-system-i386 -machine pc,acpi=off -cpu pentium3 -m 512 -accel tcg -vga cirrus -usb -device usb-tablet \
  -drive file=xp-base.qcow2,format=qcow2,if=ide -cdrom your-winxp-sp3.iso -boot d -nic user,model=rtl8139
```

If setup blue-screens with **STOP 0x0000000A**, check that `-cpu pentium3` is in the command (newer CPU models break XP), and press **F5** at "Press F6…" and pick *Standard PC*.

**Match Prefs to how you installed.** The app defaults to CPU *Pentium III* and **ACPI off**. If you installed XP with ACPI on, tick "ACPI on" in Prefs. An XP installed one way won't boot the other way.

Then boot it again without `-cdrom` and set it up so agents have an easy time:

1. Set the resolution to **1024×768**.
2. Make it **log on automatically** with no password (`control userpasswords2`).
3. Turn off the screensaver, power saving, the balloon tips and the Tour.
4. Install the legacy software you want your buddies to use. Put shortcuts on the desktop.
5. Shut down cleanly, then select the `.qcow2` in **Prefs**.

The app always boots VMs with `-snapshot`, so **your base image is never modified**. Every boot is a clean machine and everything is thrown away at shutdown.

## Safety notes

- XP hasn't had a security patch since 2014. Keep networking on **None** unless you have a reason. Never bridge it onto your LAN.
- The built-in server only listens on `127.0.0.1`. Agents reach their VM only through the tools, and they have no shell on your machine.

## Layout

```
electron/main.mjs        desktop shell: native windows, tray, settings, starts the server
electron/preload.cjs     the small bridge the UI uses to open/close windows and read settings
server/src/server.ts     startServer(): Express + WebSocket, transcripts, routing
server/src/runner.ts     per-buddy agent loop
server/src/providers.ts  model providers: Anthropic + OpenAI-compatible adapters, presets
server/src/tools.ts      xp_*, shared_*, memory_* tools and send_im
server/src/rooms.ts      chat rooms: turn-taking, passes, invites
server/src/memory.ts     per-buddy long-term notes
server/src/web.ts        web_fetch (HTML→text, private-address guard) + web_search (Brave/Tavily/SearXNG)
server/src/files.ts      attachments: text/PDF/DOCX extraction, images for vision models
server/src/mcp.ts        MCP client: stdio + HTTP/SSE servers from mcp.json
server/src/vm/           QEMU lifecycle, QMP over TCP, screenshots, keyboard/mouse
server/agents.json       the starter agent list (copied to your data folder on first run)
web/                     the retro UI; each page renders one window (?view=buddylist|im|viewer|…)
```

## Contributing

Issues and pull requests are welcome. To work on it:

```bash
npm install
npm run typecheck   # TypeScript check for the server
npm run app         # build + launch the desktop app
npm run web         # or run headless in a browser at http://localhost:3000
```

Please don't commit anything from your data folder (API keys, memory notes, attachments, `mcp.json`) or any Windows disk images. The `.gitignore` already covers the usual suspects.

## Disclaimer

Y2Kbot is an independent hobby project. It is not affiliated with, endorsed by or connected to AOL, Microsoft or any other company whose products inspired its look. All trademarks belong to their owners. **Windows XP is not included:** you need your own installation media and licence to build an XP disk image. Running AI agents that control software can have unexpected results, so keep VM networking off unless you need it, and use API keys with spending limits.

## Licence

[MIT](LICENSE) © 2026 Tate

