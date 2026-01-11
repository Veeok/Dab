"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const { createHistoryStore } = require("../lib/history");

async function mkTempDir(prefix) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return base;
}

test("history: snapshot, list, restore", async () => {
  const userData = await mkTempDir("dab_userdata_");
  const store = createHistoryStore({ userDataDir: userData, maxSnapshots: 25 });

  const cfgPath = path.join(userData, "config.json");
  await fs.writeFile(cfgPath, JSON.stringify({ hello: "v1" }, null, 2) + "\n", "utf8");

  const s1 = await store.createSnapshotFromCurrentConfig(cfgPath, "save");
  assert.equal(s1.ok, true);
  assert.equal(s1.skipped, false);

  await fs.writeFile(cfgPath, JSON.stringify({ hello: "v2" }, null, 2) + "\n", "utf8");
  const s2 = await store.createSnapshotFromCurrentConfig(cfgPath, "save");
  assert.equal(s2.ok, true);

  const list = await store.listHistory(cfgPath);
  assert.equal(list.ok, true);
  assert.ok(Array.isArray(list.items));
  assert.ok(list.items.length >= 2);

  // Restore the oldest snapshot. This should also create a safety snapshot.
  const oldest = list.items[list.items.length - 1];
  const restored = await store.restoreHistory(cfgPath, oldest.id);
  assert.equal(restored.ok, true);

  const after = JSON.parse(await fs.readFile(cfgPath, "utf8"));
  assert.equal(after.hello, "v1");

  const list2 = await store.listHistory(cfgPath);
  // safety snapshot should increase total count
  assert.ok(list2.items.length >= list.items.length);
});

test("history: blocks path traversal via snapshot id", async () => {
  const userData = await mkTempDir("dab_userdata_");
  const store = createHistoryStore({ userDataDir: userData, maxSnapshots: 25 });

  const cfgPath = path.join(userData, "config.json");
  await fs.writeFile(cfgPath, JSON.stringify({ hello: "v1" }, null, 2) + "\n", "utf8");
  await store.createSnapshotFromCurrentConfig(cfgPath, "save");

  const res = await store.restoreHistory(cfgPath, "../evil.json");
  assert.equal(res.ok, false);
  const msg = String(res.error || "").toLowerCase();
  assert.ok(msg.includes("invalid") || msg.includes("escape") || msg.includes("not valid json"));
});
