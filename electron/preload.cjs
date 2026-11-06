// Bridge between the retro UI pages and the desktop shell.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("y2kNative", {
  platform: process.platform,
  open: (opts) => ipcRenderer.send("y2k:open", opts),          // { view, arg, focus }
  close: () => ipcRenderer.send("y2k:close"),
  minimize: () => ipcRenderer.send("y2k:minimize"),
  flash: () => ipcRenderer.send("y2k:flash"),
  fit: (height) => ipcRenderer.send("y2k:fit", height),
  signedOn: () => ipcRenderer.send("y2k:signedOn"),
  signOff: () => ipcRenderer.send("y2k:signOff"),
  getSettings: () => ipcRenderer.invoke("y2k:getSettings"),
  saveSettings: (s) => ipcRenderer.invoke("y2k:saveSettings", s),
  pickFile: (opts) => ipcRenderer.invoke("y2k:pickFile", opts),
  relaunch: () => ipcRenderer.send("y2k:relaunch"),
  openPath: (p) => ipcRenderer.send("y2k:openPath", p),
  openDataFolder: (sub) => ipcRenderer.send("y2k:openDataFolder", sub),          // e.g. "logs"
  saveText: (opts) => ipcRenderer.invoke("y2k:saveText", opts),                  // { defaultName, filters, text } → saved path or null
  openText: (opts) => ipcRenderer.invoke("y2k:openText", opts),                  // { filters, title } → { name, text } or null
  readClipboard: () => ipcRenderer.invoke("y2k:readClipboard"),                  // text on the clipboard ("" if none)
  // updates (from GitHub Releases)
  getUpdate: () => ipcRenderer.invoke("y2k:update:get"),
  onUpdate: (cb) => ipcRenderer.on("y2k:update", (_e, u) => cb(u)),
  updateAction: (what) => { if (["check", "download", "install", "skip", "releases"].includes(what)) ipcRenderer.send(`y2k:update:${what}`); },
});
