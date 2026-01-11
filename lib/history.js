"use strict";

const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

function safeSnapshotId(id) {
  const base = path.basename(String(id || ""));
  // Only allow simple file names.
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null;
  return base;
}

function tsName(now = new Date()) {
  const d = now;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  // YYYYMMDD_HHMMSS_mmm
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}`;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function readJsonFileOrNull(p) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function historyKeyForConfigPath(filePath) {
  const p = path.resolve(String(filePath || ""));
  return crypto.createHash("sha256").update(p).digest("hex");
}

function createHistoryStore({ userDataDir, maxSnapshots = 25 } = {}) {
  if (!userDataDir) throw new Error("createHistoryStore requires userDataDir");

  const baseDir = () => path.join(userDataDir, "config_history");
  const dirForConfigPath = (configPath) => path.join(baseDir(), historyKeyForConfigPath(configPath));

  async function pruneHistory(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = [];

      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!String(e.name).toLowerCase().endsWith(".json")) continue;
        const p = path.join(dir, e.name);
        const st = await fs.stat(p).catch(() => null);
        if (!st) continue;
        files.push({ name: e.name, mtimeMs: st.mtimeMs });
      }

      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const drop = files.slice(maxSnapshots);
      await Promise.all(drop.map((f) => fs.unlink(path.join(dir, f.name)).catch(() => {})));
      return { ok: true, removed: drop.length };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async function createSnapshotFromCurrentConfig(configPath, reason) {
    if (!configPath) return { ok: true, skipped: true };

    const current = await readJsonFileOrNull(configPath);
    if (!current || typeof current !== "object") return { ok: true, skipped: true };

    const dir = dirForConfigPath(configPath);
    await ensureDir(dir);

    const name = `${tsName()}_${String(reason || "save")}.json`;
    const outPath = path.join(dir, name);
    await fs.writeFile(outPath, JSON.stringify(current, null, 4) + "\n", "utf8");
    await pruneHistory(dir);

    return { ok: true, skipped: false, dir, id: name };
  }

  async function listHistory(configPath) {
    if (!configPath) return { ok: false, error: "No config path." };
    const dir = dirForConfigPath(configPath);

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const items = [];

      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!String(e.name).toLowerCase().endsWith(".json")) continue;

        const p = path.join(dir, e.name);
        const st = await fs.stat(p).catch(() => null);
        if (!st) continue;

        const label = e.name.replace(/\.json$/i, "").replace(/_/g, " ");
        items.push({
          id: e.name,
          label,
          createdAt: st.mtimeMs,
          sizeBytes: st.size
        });
      }

      items.sort((a, b) => b.createdAt - a.createdAt);
      return { ok: true, dir, items };
    } catch {
      // Directory may not exist yet.
      return { ok: true, dir, items: [] };
    }
  }

  async function restoreHistory(configPath, snapshotId) {
    if (!configPath) return { ok: false, error: "No config path." };

    const id = safeSnapshotId(snapshotId);
    if (!id) return { ok: false, error: "Invalid snapshot id." };

    const dir = dirForConfigPath(configPath);
    const snapPath = path.join(dir, id);

    // Block path escapes.
    const snapResolved = path.resolve(snapPath);
    const dirResolved = path.resolve(dir);
    if (!snapResolved.startsWith(dirResolved + path.sep)) return { ok: false, error: "Snapshot path escape blocked." };

    const data = await readJsonFileOrNull(snapPath);
    if (!data || typeof data !== "object") return { ok: false, error: "Snapshot is not valid JSON." };

    // Safety snapshot of current config before overwrite.
    await createSnapshotFromCurrentConfig(configPath, "safety").catch(() => {});
    await fs.writeFile(configPath, JSON.stringify(data, null, 4) + "\n", "utf8");

    return { ok: true };
  }

  return Object.freeze({
    baseDir,
    dirForConfigPath,
    safeSnapshotId,
    createSnapshotFromCurrentConfig,
    listHistory,
    restoreHistory,
    _pruneHistory: pruneHistory,
    _historyKeyForConfigPath: historyKeyForConfigPath,
    _tsName: tsName
  });
}

module.exports = {
  createHistoryStore,
  safeSnapshotId,
  tsName,
  historyKeyForConfigPath
};
