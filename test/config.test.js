"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

let Config = null;
try {
  // Requires `npm install` (Ajv dependency).
  Config = require("../lib/config");
} catch (err) {
  Config = null;
}

if (!Config) {
  test("config tests skipped (run npm install first)", { skip: true }, () => {});
  return;
}

test("default config template validates", () => {
  const cfg = Config.defaultConfigTemplate(path.join(__dirname, ".."));
  const res = Config.validateConfigWithExtras(cfg);
  assert.equal(res.ok, true, res.errors.join("\n"));
});

test("LOGIN requires account", () => {
  const cfg = Config.defaultConfigTemplate(path.join(__dirname, ".."));
  cfg.tasks = [{ id: "t1", type: "LOGIN" }];
  const res = Config.validateConfigWithExtras(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => String(e).includes("/tasks/0")));
});

test("duplicate task ids are rejected", () => {
  const cfg = Config.defaultConfigTemplate(path.join(__dirname, ".."));
  cfg.tasks = [
    { id: "dup", type: "NAVIGATE", url: "https://example.com" },
    { id: "dup", type: "WAIT", seconds: 1 }
  ];
  const res = Config.validateConfigWithExtras(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => String(e).includes("duplicate id")));
});

test("LOOP_AUTOMATION must be last", () => {
  const cfg = Config.defaultConfigTemplate(path.join(__dirname, ".."));
  cfg.tasks = [
    { id: "loop", type: "LOOP_AUTOMATION", interval_ms: 1000 },
    { id: "t2", type: "WAIT", seconds: 1 }
  ];
  const res = Config.validateConfigWithExtras(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => String(e).includes("must be the last")));
});

test("FILL requires selector and text", () => {
  const cfg = Config.defaultConfigTemplate(path.join(__dirname, ".."));
  cfg.tasks = [
    { id: "t1", type: "FILL", selector: { css: "input" } },
  ];
  let res = Config.validateConfigWithExtras(cfg);
  assert.equal(res.ok, false);

  cfg.tasks = [
    { id: "t1", type: "FILL", text: "hello" },
  ];
  res = Config.validateConfigWithExtras(cfg);
  assert.equal(res.ok, false);

  cfg.tasks = [
    { id: "t1", type: "FILL", selector: { css: "input" }, text: "hello" },
  ];
  res = Config.validateConfigWithExtras(cfg);
  assert.equal(res.ok, true);
});

test("PRESS_KEY requires key", () => {
  const cfg = Config.defaultConfigTemplate(path.join(__dirname, ".."));
  cfg.tasks = [{ id: "k1", type: "PRESS_KEY" }];
  let res = Config.validateConfigWithExtras(cfg);
  assert.equal(res.ok, false);

  cfg.tasks = [{ id: "k1", type: "PRESS_KEY", key: "Enter", times: 2 }];
  res = Config.validateConfigWithExtras(cfg);
  assert.equal(res.ok, true);
});


test("migration v1 -> v2 adds url fields and screenshot_dir", () => {
  const v1 = {
    config_version: 1,
    accounts: [{ email: "a@b.com", password: "x" }],
    tasks: []
  };
  const mig = Config.migrateConfig(v1, { projectRootDir: "/tmp" });
  assert.equal(mig.migrated, true);
  assert.equal(mig.toVersion, 2);
  assert.ok(String(mig.data.base_url || "").includes("discord"));
  assert.ok(String(mig.data.login_url || "").includes("/login"));
  assert.ok(String(mig.data.logout_url || "").includes("/logout"));
  assert.ok(String(mig.data.screenshot_dir || "").length > 0);
});

test("sanitizeConfig blanks account passwords", () => {
  const cfg = Config.defaultConfigTemplate(path.join(__dirname, ".."));
  cfg.accounts[0].password = "secret";
  const sanitized = Config.sanitizeConfig(cfg);
  assert.equal(sanitized.accounts[0].password, "");
});
