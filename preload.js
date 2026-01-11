const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getConfigMeta: () => ipcRenderer.invoke("config:meta"),
  getAppInfo: () => ipcRenderer.invoke("app:info"),
  ensureDefaultConfig: () => ipcRenderer.invoke("config:ensureDefault"),
  openConfig: () => ipcRenderer.invoke("dialog:openConfig"),
  pickFiles: () => ipcRenderer.invoke("dialog:pickFiles"),
  readJson: (filePath) => ipcRenderer.invoke("fs:readJson", filePath),
  validateConfig: (data) => ipcRenderer.invoke("config:validate", data),
  writeJson: (filePath, data) => ipcRenderer.invoke("fs:writeJson", filePath, data),
  exportSanitized: (filePath, data) => ipcRenderer.invoke("config:exportSanitized", filePath, data),
  exportFull: (filePath, data) => ipcRenderer.invoke("config:exportFull", filePath, data),

  copyText: (text) => ipcRenderer.invoke("clipboard:writeText", String(text ?? "")),
  showInFolder: (fullPath) => ipcRenderer.invoke("shell:showItemInFolder", String(fullPath ?? "")),

  setThemeMode: (mode) => ipcRenderer.invoke("ui:setThemeMode", String(mode ?? "system")),
  onSystemTheme: (cb) => {
    if (typeof cb !== "function") return;
    ipcRenderer.on("ui:systemTheme", (_evt, payload) => cb(payload));
  },

  listHistory: (filePath) => ipcRenderer.invoke("config:history:list", filePath),
  restoreHistory: (filePath, snapshotId) => ipcRenderer.invoke("config:history:restore", filePath, snapshotId),

  runAutomation: (configPath) => ipcRenderer.invoke("automation:run", configPath),
  stopAutomation: () => ipcRenderer.invoke("automation:stop"),
  pauseAutomation: () => ipcRenderer.invoke("automation:pause"),
  resumeAutomation: () => ipcRenderer.invoke("automation:resume"),

  onAutomationLog: (cb) => {
    if (typeof cb !== "function") return;
    ipcRenderer.removeAllListeners("automation:log");
    ipcRenderer.on("automation:log", (_evt, line) => cb(line));
  },

  onAutomationState: (cb) => {
    if (typeof cb !== "function") return;
    ipcRenderer.removeAllListeners("automation:state");
    ipcRenderer.on("automation:state", (_evt, payload) => cb(payload));
  }
});
