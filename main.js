// This file must be executed by Electron, not plain Node.
// If you run `node main.js`, `require("electron")` resolves to the Electron executable
// path (a string) instead of the Electron API, which makes `app` undefined.
const electron = require("electron");

if (!electron || typeof electron === "string" || !electron.app) {
  // Keep this message short and actionable.
  console.error("This app must be started with Electron, not Node.");
  console.error("Run: npm install");
  console.error("Then: npm start");
  process.exit(1);
}

const { app, BrowserWindow, dialog, ipcMain, Tray, Menu, nativeImage, shell, clipboard, nativeTheme } = electron;
const path = require("path");
<<<<<<< HEAD

// ---------------------------------------------------------------------------
// Chromium cache hardening (Windows "Access is denied" cache errors)
// ---------------------------------------------------------------------------
// In some Windows environments (AV, Controlled Folder Access, stale permissions),
// Chromium can fail to create or move its disk caches under the default profile.
// This is usually non-fatal, but can prevent the app from starting cleanly.
// Point caches to a writable temp directory.
try {
  const os = require("os");
  const fsSync = require("fs");
  const cacheRoot = path.join(os.tmpdir(), "dab-electron-cache");
  fsSync.mkdirSync(cacheRoot, { recursive: true });
  app.commandLine.appendSwitch("disk-cache-dir", cacheRoot);
  app.commandLine.appendSwitch("gpu-shader-cache-dir", path.join(cacheRoot, "shader-cache"));
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
} catch {
  // ignore
}
=======
>>>>>>> c9af4a5 (Animation fixes)
const fs = require("fs/promises");
const History = require("./lib/history");
const { spawn } = require("child_process");

const Config = require("./lib/config");

const ASSETS_DIR = path.join(__dirname, "assets");
const APP_NAME = "Dab";

// Window/tray fallback icon. Linux desktop environments expect PNG.
const APP_ICON_PATH = process.platform === "win32"
  ? path.join(ASSETS_DIR, "DAB.ico")
  : path.join(ASSETS_DIR, "DABwhiteON.png");

// Schema + defaults live in lib/config.js.

let mainWindow;
let automationProc = null;
let automationPaused = false;
let automationStopRequested = false;
let tray = null;

// Prevent multiple Dab instances. Multiple windows can race on the same config/history.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    try {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } catch {
      // ignore
    }
  });
}

const HISTORY_MAX_SNAPSHOTS = 25;

let historyStore = null;
function getHistoryStore() {
  if (historyStore) return historyStore;
  historyStore = History.createHistoryStore({
    userDataDir: app.getPath("userData"),
    maxSnapshots: HISTORY_MAX_SNAPSHOTS
  });
  return historyStore;
}


function defaultConfigTemplate(configDir) {
  return Config.defaultConfigTemplate(configDir || __dirname);
}

async function ensureDefaultConfigFile() {
  // Store an editable default in the app userData directory.
  // This works cross-platform and does not require admin permissions.
  const configPath = path.join(app.getPath("userData"), "config.json");

  try {
    await fs.access(configPath);
    return { path: configPath, created: false };
  } catch {
    // Ensure the directory exists (should, but keep it robust for packaged apps).
    await fs.mkdir(path.dirname(configPath), { recursive: true }).catch(() => {});
    const data = defaultConfigTemplate(path.dirname(configPath));
    const out = JSON.stringify(data, null, 4) + "\n";
    await fs.writeFile(configPath, out, "utf8");
    return { path: configPath, created: true };
  }
}

// ---------------------------------------------------------------------------
// Config history (stored in app.getPath('userData'))
// ---------------------------------------------------------------------------

function trayIconPath(running) {
  // Prefer the white PNGs the user will replace with their own assets.
  const onPath = path.join(ASSETS_DIR, "DABwhiteON.png");
  const offPath = path.join(ASSETS_DIR, "DABwhiteOFF.png");
  return running ? onPath : offPath;
}

function updateTrayIcon(running) {
  if (!tray) return;

  const p = trayIconPath(Boolean(running));
  const img = nativeImage.createFromPath(p);

  if (!img.isEmpty()) {
    tray.setImage(img);
    return;
  }

  // Fallback.
  const fallback = nativeImage.createFromPath(APP_ICON_PATH);
  if (!fallback.isEmpty()) tray.setImage(fallback);
}


function createTray() {
  const p = trayIconPath(false);
  const img = nativeImage.createFromPath(p);

  const fallback = nativeImage.createFromPath(APP_ICON_PATH);
  const trayImg = !img.isEmpty() ? img : (!fallback.isEmpty() ? fallback : nativeImage.createEmpty());

  tray = new Tray(trayImg);
  tray.setToolTip(APP_NAME);

  const menu = Menu.buildFromTemplate([
    {
      label: `Show ${APP_NAME}`,
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.show();
        mainWindow.focus();
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit()
    }
  ]);

  tray.setContextMenu(menu);

  tray.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow() {

  mainWindow = new BrowserWindow({
    title: APP_NAME,
    icon: APP_ICON_PATH,
    width: 1120,
    height: 760,
    // Hide the native application menu bar (File/Edit/View...).
    // On Windows/Linux this removes the "top bar" menu strip.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Remove menu completely (prevents Alt from showing it on Windows).
  // Note: macOS always has a system menu bar; setting the application menu to
  // null removes the default Electron menus.
  try {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.removeMenu();
  } catch {
    // Non-fatal, keep going.
  }

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Basic hardening.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

app.whenReady().then(() => {
  app.setName(APP_NAME);
  // Remove Electron's default application menu (File/Edit/View...).
  // - Windows/Linux: removes the menu bar entirely.
  // - macOS: removes the default menu items from the system menu bar.
  try {
    Menu.setApplicationMenu(null);
  } catch {
    // Non-fatal.
  }
  createWindow();

  // Forward OS theme changes to the renderer for "system" theme mode.
  try {
    if (nativeTheme) {
      nativeTheme.on("updated", () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send("ui:systemTheme", {
          shouldUseDarkColors: Boolean(nativeTheme.shouldUseDarkColors),
          shouldUseDarkColorsForSystemIntegratedUI: Boolean(nativeTheme.shouldUseDarkColorsForSystemIntegratedUI)
        });
      });
    }
  } catch {
    // ignore
  }
  createTray();
  updateTrayIcon(false);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function validateConfigWithExtras(data) {
  return Config.validateConfigWithExtras(data);
}

ipcMain.handle("config:meta", async () => {
  try {
    return { ok: true, ...Config.getMeta() };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});


ipcMain.handle("app:info", async () => {
  try {
    // Use appPath so this works in dev and packaged builds (asar).
    const appPath = app.getAppPath();
    let pkg = null;
    try {
      pkg = require(path.join(appPath, "package.json"));
    } catch {
      // Fallback: try relative to main.js.
      pkg = require(path.join(__dirname, "package.json"));
    }

    const name = String(pkg?.productName || pkg?.name || app.getName() || "Dab");
    const version = String(pkg?.version || app.getVersion() || "");
    const description = String(pkg?.description || "");
    const author = String(pkg?.author || "");
    const license = String(pkg?.license || "");

    return { ok: true, name, version, description, author, license };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});


function sendAutomationState(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  // When automation stops, clear pause state.
  if (p.running === false) automationPaused = false;
  if (p.paused !== undefined) automationPaused = Boolean(p.paused);

  const merged = { ...p, paused: Boolean(p.paused ?? automationPaused) };
  updateTrayIcon(Boolean(merged && merged.running));
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("automation:state", merged);
}

function sendAutomationLog(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("automation:log", payload);
}

ipcMain.handle("dialog:openConfig", async () => {
  const res = await dialog.showOpenDialog({
    title: "Import configuration",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (res.canceled || !res.filePaths?.[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle("dialog:pickFiles", async () => {
  const res = await dialog.showOpenDialog({
    title: "Select file(s)",
    properties: ["openFile", "multiSelections"],
  });
  if (res.canceled) return [];
  return Array.isArray(res.filePaths) ? res.filePaths : [];
});


ipcMain.handle("clipboard:writeText", async (_evt, text) => {
  try {
    clipboard.writeText(String(text ?? ""));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("shell:showItemInFolder", async (_evt, fullPath) => {
  try {
    const p = String(fullPath ?? "");
    if (!p) return { ok: false, error: "No path." };
    shell.showItemInFolder(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// UI theme control (renderer controls which CSS theme is used).
// We also set Electron's themeSource so built-in widgets follow.
ipcMain.handle("ui:setThemeMode", async (_evt, mode) => {
  try {
    const m = String(mode || "system").toLowerCase();
    const src = (m === "light") ? "light" : (m === "system") ? "system" : "dark";
    if (nativeTheme && nativeTheme.themeSource !== src) {
      nativeTheme.themeSource = src;
    }
    return {
      ok: true,
      themeSource: nativeTheme ? nativeTheme.themeSource : src,
      shouldUseDarkColors: nativeTheme ? Boolean(nativeTheme.shouldUseDarkColors) : (src === "dark")
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});



// If the user doesn't have a config yet, automatically create one.
ipcMain.handle("config:ensureDefault", async () => {
  try {
    const r = await ensureDefaultConfigFile();
    return { ok: true, path: r.path, created: Boolean(r.created) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("fs:readJson", async (_evt, filePath) => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);

    // Migrate in-memory. Let the UI decide whether to save.
    const mig = Config.migrateConfig(parsed, { projectRootDir: path.dirname(filePath) });
    const v = validateConfigWithExtras(mig.data);

    return {
      ok: Boolean(v.ok),
      errors: v.errors,
      warnings: v.warnings,
      data: mig.data,
      migrated: Boolean(mig.migrated),
      migration: mig.migrated ? { from: mig.fromVersion, to: mig.toVersion, notes: mig.notes } : null
    };
  } catch (err) {
    return {
      ok: false,
      errors: [String(err?.message || err)],
      data: null
    };
  }
});

ipcMain.handle("config:validate", async (_evt, data) => {
  try {
    const v = validateConfigWithExtras(data);
    return { ok: Boolean(v.ok), errors: v.errors, warnings: v.warnings };
  } catch (err) {
    return { ok: false, errors: [String(err?.message || err)] };
  }
});

ipcMain.handle("fs:writeJson", async (_evt, filePath, data) => {
  try {
    const v = validateConfigWithExtras(data);
    if (!v.ok) {
      return {
        ok: false,
        errors: v.errors
      };
    }

    // Snapshot the current on-disk config before overwriting.
    await getHistoryStore().createSnapshotFromCurrentConfig(filePath, "save").catch(() => {});

    const out = JSON.stringify(data, null, 4) + "\n";
    await fs.writeFile(filePath, out, "utf8");
    return { ok: true, errors: [] };
  } catch (err) {
    return { ok: false, errors: [String(err?.message || err)] };
  }
});

ipcMain.handle("config:exportSanitized", async (_evt, filePath, data) => {
  try {
    const sanitized = Config.sanitizeConfig(data);

    const target = await dialog.showSaveDialog({
      title: "Export sanitized config",
      defaultPath: path.join(path.dirname(filePath), "config.sanitized.json"),
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (target.canceled || !target.filePath) return { ok: false, canceled: true };

    const v = validateConfigWithExtras(sanitized);
    if (!v.ok) return { ok: false, errors: v.errors, canceled: false };

    await fs.writeFile(target.filePath, JSON.stringify(sanitized, null, 4) + "\n", "utf8");
    return { ok: true, canceled: false, outPath: target.filePath };
  } catch (err) {
    return { ok: false, canceled: false, errors: [String(err?.message || err)] };
  }
});

ipcMain.handle("config:exportFull", async (_evt, filePath, data) => {
  try {
    const target = await dialog.showSaveDialog({
      title: "Export config (full)",
      defaultPath: path.join(path.dirname(filePath), "config.full.json"),
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (target.canceled || !target.filePath) return { ok: false, canceled: true };

    const v = validateConfigWithExtras(data);
    if (!v.ok) return { ok: false, errors: v.errors, canceled: false };

    await fs.writeFile(target.filePath, JSON.stringify(data, null, 4) + "\n", "utf8");
    return { ok: true, canceled: false, outPath: target.filePath };
  } catch (err) {
    return { ok: false, canceled: false, errors: [String(err?.message || err)] };
  }
});

ipcMain.handle("config:history:list", async (_evt, configPath) => {
  try {
    return await getHistoryStore().listHistory(configPath);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("config:history:restore", async (_evt, configPath, snapshotId) => {
  try {
    return await getHistoryStore().restoreHistory(configPath, snapshotId);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/**
 * Run index.js as a separate process.
 * Uses Electron's embedded Node runtime by setting ELECTRON_RUN_AS_NODE=1.
 */
ipcMain.handle("automation:run", async (_evt, configPath) => {
  if (automationProc) return { ok: false, error: "Automation is already running." };

  const entry = path.join(__dirname, "index.js");

  try {
    await fs.access(entry);
  } catch {
    return { ok: false, error: "index.js not found in the project root." };
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    DAB_CONFIG_PATH: String(configPath || "")
  };

  // Selenium Manager is bundled inside selenium-webdriver, but executables cannot run from app.asar.
  // When packaged, electron-builder will place unpacked binaries in app.asar.unpacked. Point Selenium
  // at that real on-disk path.
  if (app.isPackaged) {
    const smName = process.platform === "win32" ? "selenium-manager.exe" : "selenium-manager";
    const smPlatDir =
      process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
    const smUnpacked = path.join(
      process.resourcesPath || "",
      "app.asar.unpacked",
      "node_modules",
      "selenium-webdriver",
      "bin",
      smPlatDir,
      smName
    );
    try {
      await fs.access(smUnpacked);
      await fs.chmod(smUnpacked, 0o755).catch(() => {});
      env.SE_MANAGER_PATH = smUnpacked;
      // Put Selenium Manager cache in userData to avoid permission/policy issues.
      const cacheDir = path.join(app.getPath("userData"), "selenium-cache");
      await fs.mkdir(cacheDir, { recursive: true }).catch(() => {});
      env.SE_CACHE_PATH = cacheDir;
    } catch {
      // If Selenium Manager is unavailable, the user may supply a driver on PATH.
    }
  }

<<<<<<< HEAD
// Ensure bundled geckodriver is executable and discoverable, if present.
  const driverName = process.platform === "win32" ? "geckodriver.exe" : "geckodriver";
  const baseDir = app.isPackaged ? (process.resourcesPath || "") : __dirname;

  const candidates = [
    // New layout: resources/drivers/<platform>-<arch>/geckodriver[.exe]
    path.join(baseDir, "drivers", `${process.platform}-${process.arch}`, driverName),

    // If you build universal on macOS, both are shipped and the runtime picks by process.arch.
    // Backward compatibility: old layout at resources root.
    path.join(baseDir, driverName),
  ];

  let gecko = null;
  for (const p of candidates) {
    try {
      await fs.access(p);
      gecko = p;
      break;
    } catch {}
  }

  if (gecko) {
    // Zipped repos and some unpack flows can lose execute bits. Best-effort fix.
    await fs.chmod(gecko, 0o755).catch(() => {});
    env.PATH = `${path.dirname(gecko)}${path.delimiter}${env.PATH || ""}`;
    env.GECKODRIVER_PATH = gecko;
  }
=======
// Ensure local geckodriver is executable and discoverable, if present.
const geckoName = process.platform === "win32" ? "geckodriver.exe" : "geckodriver";
const gecko = app.isPackaged
  ? path.join(process.resourcesPath || "", geckoName)
  : path.join(__dirname, geckoName);
try {
  await fs.access(gecko);
  // Zipped repos often lose execute bits. Best-effort fix.
  await fs.chmod(gecko, 0o755).catch(() => {});
  env.PATH = `${path.dirname(gecko)}${path.delimiter}${env.PATH || ""}`;
  env.GECKODRIVER_PATH = gecko;
} catch {
  // No bundled driver, or not accessible. The user may have geckodriver on PATH.
}


>>>>>>> c9af4a5 (Animation fixes)
  automationPaused = false;
  automationStopRequested = false;

  automationProc = spawn(process.execPath, [entry], {
    cwd: app.getPath("userData"),
    env,
    // Include an IPC channel so we can pause/resume without relying on OS signals (Windows-safe).
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });

  sendAutomationState({ running: true, paused: false, pid: automationProc.pid });

  const onData = (buf, stream) => {
    const s = String(buf || "");
    s.split(/\r?\n/).forEach((line) => {
      if (!line || !line.trim()) return;
      sendAutomationLog({ line, stream: stream || "stdout" });
    });
  };

  automationProc.stdout.on("data", (buf) => onData(buf, "stdout"));
  automationProc.stderr.on("data", (buf) => onData(buf, "stderr"));

  // Child -> parent control plane.
  automationProc.on("message", (msg) => {
    try {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "paused") {
        automationPaused = Boolean(msg.paused);
        sendAutomationState({ running: true, paused: automationPaused, pid: automationProc?.pid });
      }
    } catch {
      // ignore
    }
  });

  automationProc.on("exit", (code, signal) => {
    const pid = automationProc?.pid;
    automationProc = null;
    automationPaused = false;
    const stopped = automationStopRequested;
    automationStopRequested = false;

    let reason = "exited";
    if (stopped) {
      reason = "stopped";
    } else if ((code === 0 || code === null) && !signal) {
      reason = "completed";
    } else {
      reason = "error";
    }

    sendAutomationState({ running: false, paused: false, pid, code, signal, reason });
  });

  automationProc.on("error", (err) => {
    sendAutomationLog(`Process error: ${String(err?.message || err)}`);
  });

  return { ok: true, pid: automationProc.pid };
});

ipcMain.handle("automation:stop", async () => {
  if (!automationProc) return { ok: false, error: "Automation is not running." };
  try {
    automationStopRequested = true;
    // Request a graceful stop (also unpauses).
    try {
      if (typeof automationProc.send === "function") automationProc.send({ type: "stop" });
    } catch {
      // ignore
    }

    automationPaused = false;
    sendAutomationState({ running: true, paused: false, pid: automationProc.pid });

    // Best-effort: allow graceful shutdown, but ensure the process ends.
    setTimeout(() => {
      try {
        if (automationProc) automationProc.kill();
      } catch {
        // ignore
      }
    }, 1200);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("automation:pause", async () => {
  if (!automationProc) return { ok: false, error: "Automation is not running." };
  if (automationPaused) return { ok: true, paused: true };
  try {
    if (typeof automationProc.send !== "function") return { ok: false, error: "Pause is unavailable (no IPC channel)." };
    automationProc.send({ type: "pause" });
    automationPaused = true;
    sendAutomationState({ running: true, paused: true, pid: automationProc.pid });
    return { ok: true, paused: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("automation:resume", async () => {
  if (!automationProc) return { ok: false, error: "Automation is not running." };
  if (!automationPaused) return { ok: true, paused: false };
  try {
    if (typeof automationProc.send !== "function") return { ok: false, error: "Resume is unavailable (no IPC channel)." };
    automationProc.send({ type: "resume" });
    automationPaused = false;
    sendAutomationState({ running: true, paused: false, pid: automationProc.pid });
    return { ok: true, paused: false };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});
