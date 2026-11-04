// Bridge between the retro UI pages and the desktop shell.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ramNative", {
  platform: process.platform,
  open: (opts) => ipcRenderer.send("ram:open", opts),          // { view, arg, focus }
  close: () => ipcRenderer.send("ram:close"),
  minimize: () => ipcRenderer.send("ram:minimize"),
  flash: () => ipcRenderer.send("ram:flash"),
  fit: (height) => ipcRenderer.send("ram:fit", height),
  signedOn: () => ipcRenderer.send("ram:signedOn"),
  signOff: () => ipcRenderer.send("ram:signOff"),
  getSettings: () => ipcRenderer.invoke("ram:getSettings"),
  saveSettings: (s) => ipcRenderer.invoke("ram:saveSettings", s),
  pickFile: (opts) => ipcRenderer.invoke("ram:pickFile", opts),
  relaunch: () => ipcRenderer.send("ram:relaunch"),
  openPath: (p) => ipcRenderer.send("ram:openPath", p),
  openDataFolder: (sub) => ipcRenderer.send("ram:openDataFolder", sub),          // e.g. "logs"
  saveText: (opts) => ipcRenderer.invoke("ram:saveText", opts),                  // { defaultName, filters, text } → saved path or null
  openText: (opts) => ipcRenderer.invoke("ram:openText", opts),                  // { filters, title } → { name, text } or null
});
