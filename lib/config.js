"use strict";

const path = require("path");
const Ajv = require("ajv");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRIORITY = Object.freeze({ MIN: 0, MAX: 5, DEFAULT: 3 });

// Keep this list in sync with the runner's task switch (index.js).
const TASK_TYPES = Object.freeze([
  "LOGIN",
  "LOGOUT",
  "SWITCH_ACCOUNT",
  "UPLOAD_FILE",
  "SEND_MESSAGE",
  "SLASH_COMMAND",
  "SEND_EMOJI",
  "NAVIGATE",
  "CLICK",
  "FILL",
  "PRESS_KEY",
  "WAIT",
  "WAIT_FOR_SELECTOR",
  "WAIT_FOR_NAVIGATION",
  "SCREENSHOT",
  "LOOP_AUTOMATION"
]);

const CONFIG_VERSION = 4;

function humanizeTaskType(type) {
  const s = String(type || "").trim();
  if (!s) return "";
  const words = s.split("_").filter(Boolean).map((w) => w.toLowerCase());
  return words
    .map((w) => {
      if (w === "url") return "URL";
      if (w === "id") return "ID";
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

const TASK_TYPE_LABELS = Object.freeze(
  Object.fromEntries(TASK_TYPES.map((t) => [t, humanizeTaskType(t)]))
);

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultConfigTemplate(projectRootDir) {
  // Keep the template VALID per schema, but safe and obviously placeholder.
  // projectRootDir lets packaged apps keep defaults stable.
  const root = projectRootDir || __dirname;
  return {
    config_version: CONFIG_VERSION,

    // Human-facing app version (not used for schema migrations).
    version: "1.5.3",

    // Automation controls.
    run_enabled: true,
    headless: false,
    jitter_ms: 0,
    log_level: "info",
    screenshot_on_error: false,
    screenshot_dir: path.join(root, "screenshots"),
    element_wait_timeout_ms: 30000,

    // Session hygiene.
    // For Discord, the most reliable way to fully clear auth state is to restart the
    // browser session (new temporary Firefox profile).
    restart_browser_on_logout: true,
    restart_browser_on_switch_account: true,

    // Optional: start Firefox in private browsing mode.
    firefox_private_browsing: false,

    // Multi session mode. When enabled, the runner creates one Firefox session
    // per selected account and runs each task on all sessions in sync.
    multi_sessions_enabled: false,
    multi_sessions_accounts: [],
    multi_sessions_auto_login: true,

    // Optional. Limits how many sessions may execute a task concurrently.
    // 0 means unlimited.
    multi_sessions_max_parallel: 0,

    // Human typing (applies when task.instant=false for text tasks).
    // Also used for credentials in LOGIN/SWITCH_ACCOUNT.
    human_typing_enabled: true,
    typing_delay_ms_min: 70,
    typing_delay_ms_max: 160,

    // Discord base URLs (advanced).
    base_url: "https://discord.com",
    login_url: "https://discord.com/login",
    logout_url: "https://discord.com/logout",

    // UI theming.
    // system = follow OS. dark/light = force. amoled = pure black variant.
    ui_theme: "system",

    // Legacy / compatibility.
    server_id: "",
    channel_id: "",
    no_login_delay: false,
    tasks_interval: 1000,
    account_switch_interval: 0,

    accounts: [
      {
        name: "Main",
        email: "user@example.com",
        password: "",
        priority: PRIORITY.DEFAULT,
        enabled: true,
        cooldown_after_use_ms: 0,
        max_tasks_per_session: 0,
        notes: ""
      }
    ],
    tasks: [],

    // UI-only. Optional line-based editor source.
    advanced_tasking_script: ""
  };
}

// ---------------------------------------------------------------------------
// Schema + validation
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

const taskBase = {
  type: "object",
  additionalProperties: true,
  required: ["id", "type"],
  properties: {
    id: { type: "string", minLength: 1 },
    type: { type: "string", enum: TASK_TYPES },

    // Optional operator controls.
    // If enabled=false, the runner skips this task.
    enabled: { type: "boolean" },

    // Optional ordering metadata used by the UI.
    priority: { type: "integer", minimum: PRIORITY.MIN, maximum: PRIORITY.MAX },

    // Common optional fields.
    // IMPORTANT: do NOT enforce minLength in the base task schema.
    // Operators frequently change task types in the UI.
    // Type-specific validation is enforced in the conditional "then" blocks below.
    url: { type: "string" },
    account: { type: "string" },
    accounts: { type: "array", items: { type: "string", minLength: 1 } },
    oneshot: { type: "boolean" },
    instant: { type: "boolean" },
    check_handler: { type: "string" },

    // WAIT
    seconds: { type: "number", minimum: 0 },

    // Type specific.
    file: { type: "string" },
    files: { type: "array", items: { type: "string", minLength: 1 } },
    message: { type: "string" },
    command: { type: "string" },
    index: { type: ["string", "number"] },
    emoji: { type: "string" },


// FILL
text: { type: "string" },
clear: { type: "boolean" },

// PRESS_KEY
key: { type: "string" },
times: { type: "integer", minimum: 1 },

// WAIT_FOR_SELECTOR / WAIT_FOR_NAVIGATION
timeout_ms: { type: "number", minimum: 0 },
state: { type: "string", enum: ["attached", "visible", "hidden"] },
url_contains: { type: "string" },

// SCREENSHOT
label: { type: "string" },
path: { type: "string" },
full_page: { type: "boolean" },

    // CLICK
    selector: {
      type: "object",
      additionalProperties: true,
      properties: {
        // Do not enforce minLength here, see note above.
        css: { type: "string" },
        id: { type: "string" }
      }
    },

    // LOOP_AUTOMATION
    interval_ms: { type: "number", minimum: 50 }
  }
};

const schema = {
  type: "object",
  additionalProperties: true,
  required: ["accounts", "tasks"],
  properties: {
    config_version: { type: "integer", minimum: 1 },
    version: { type: "string" },

    // Runner settings.
    run_enabled: { type: "boolean" },
    headless: { type: "boolean" },
    jitter_ms: { type: "number", minimum: 0 },
    log_level: { type: "string", enum: ["error", "warn", "info", "debug"] },
    screenshot_on_error: { type: "boolean" },
    screenshot_dir: { type: "string", minLength: 1 },
    element_wait_timeout_ms: { type: "number", minimum: 100 },

    // Session hygiene.
    restart_browser_on_logout: { type: "boolean" },
    restart_browser_on_switch_account: { type: "boolean" },
    firefox_private_browsing: { type: "boolean" },

    // Multi sessions.
    multi_sessions_enabled: { type: "boolean" },
    multi_sessions_accounts: { type: "array", items: { type: "string", minLength: 1 } },
    multi_sessions_max_parallel: { type: "integer", minimum: 0 },
    multi_sessions_auto_login: { type: "boolean" },
    multi_sessions_max_parallel: { type: "integer", minimum: 0 },

    // Human typing.
    human_typing_enabled: { type: "boolean" },
    typing_delay_ms_min: { type: "number", minimum: 0 },
    typing_delay_ms_max: { type: "number", minimum: 0 },

    // Advanced URLs.
    base_url: { type: "string", minLength: 1 },
    login_url: { type: "string", minLength: 1 },
    logout_url: { type: "string", minLength: 1 },

    // UI theming.
    ui_theme: { type: "string", enum: ["system","dark","light","amoled"] },

    // General UI legacy.
    server_id: { type: ["string", "number"] },
    channel_id: { type: ["string", "number"] },
    no_login_delay: { type: "boolean" },
    tasks_interval: { type: "number", minimum: 50 },
    account_switch_interval: { type: "number", minimum: 0 },

    // UI-only.
    advanced_tasking_script: { type: "string" },

    accounts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: true,
        required: ["email", "password"],
        properties: {
          name: { type: "string" },
          email: { type: "string", minLength: 3 },
          password: { type: "string" },
          priority: { type: "integer", minimum: PRIORITY.MIN, maximum: PRIORITY.MAX },

          enabled: { type: "boolean" },
          cooldown_after_use_ms: { type: "number", minimum: 0 },
          max_tasks_per_session: { type: "integer", minimum: 0 },
          notes: { type: "string" }
        }
      }
    },

    tasks: {
      type: "array",
      items: {
        allOf: [
          taskBase,

          // LOGIN
          {
            if: { type: "object", properties: { type: { const: "LOGIN" } }, required: ["type"] },
            then: {
              type: "object",
              required: ["account"],
              properties: {
                account: { type: "string", minLength: 1 }
              }
            }
          },

          // UPLOAD_FILE
          {
            if: { type: "object", properties: { type: { const: "UPLOAD_FILE" } }, required: ["type"] },
            then: {
              type: "object",
              required: ["url"],
              anyOf: [
                { required: ["file"] },
                { required: ["files"] }
              ],
              properties: {
                url: { type: "string", minLength: 1 },
                file: { type: "string", minLength: 1 },
                files: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }
              }
            }
          },

          // SEND_MESSAGE
          {
            if: { type: "object", properties: { type: { const: "SEND_MESSAGE" } }, required: ["type"] },
            then: {
              type: "object",
              required: ["url", "message"],
              properties: {
                url: { type: "string", minLength: 1 },
                message: { type: "string", minLength: 1 }
              }
            }
          },

          // SLASH_COMMAND
          {
            if: { type: "object", properties: { type: { const: "SLASH_COMMAND" } }, required: ["type"] },
            then: {
              type: "object",
              required: ["url", "command"],
              properties: {
                url: { type: "string", minLength: 1 },
                command: { type: "string", minLength: 1 }
              }
            }
          },

          // SEND_EMOJI
          {
            if: { type: "object", properties: { type: { const: "SEND_EMOJI" } }, required: ["type"] },
            then: {
              type: "object",
              required: ["url", "emoji"],
              properties: {
                url: { type: "string", minLength: 1 },
                emoji: { type: "string", minLength: 1 }
              }
            }
          },

          // NAVIGATE
          {
            if: { type: "object", properties: { type: { const: "NAVIGATE" } }, required: ["type"] },
            then: { type: "object", required: ["url"], properties: { url: { type: "string", minLength: 1 } } }
          },

          // CLICK
          {
            if: { type: "object", properties: { type: { const: "CLICK" } }, required: ["type"] },
            then: {
              type: "object",
              required: ["selector"],
              properties: {
                selector: {
                  type: "object",
                  properties: {
                    css: { type: "string", minLength: 1 },
                    id: { type: "string", minLength: 1 }
                  },
                  anyOf: [{ required: ["css"] }, { required: ["id"] }]
                }
              }
            }
          },

// FILL
{
  if: { type: "object", properties: { type: { const: "FILL" } }, required: ["type"] },
  then: {
    type: "object",
    required: ["selector", "text"],
    properties: {
      selector: {
        type: "object",
        properties: {
          css: { type: "string", minLength: 1 },
          id: { type: "string", minLength: 1 }
        },
        anyOf: [{ required: ["css"] }, { required: ["id"] }]
      },
      text: { type: "string", minLength: 1 }
    }
  }
},

// PRESS_KEY
{
  if: { type: "object", properties: { type: { const: "PRESS_KEY" } }, required: ["type"] },
  then: { type: "object", required: ["key"], properties: { key: { type: "string", minLength: 1 } } }
},

// WAIT_FOR_SELECTOR
{
  if: { type: "object", properties: { type: { const: "WAIT_FOR_SELECTOR" } }, required: ["type"] },
  then: {
    type: "object",
    required: ["selector"],
    properties: {
      selector: {
        type: "object",
        properties: {
          css: { type: "string", minLength: 1 },
          id: { type: "string", minLength: 1 }
        },
        anyOf: [{ required: ["css"] }, { required: ["id"] }]
      }
    }
  }
},

// WAIT_FOR_NAVIGATION
{
  if: { type: "object", properties: { type: { const: "WAIT_FOR_NAVIGATION" } }, required: ["type"] },
  then: { type: "object" }
},

// SCREENSHOT
{
  if: { type: "object", properties: { type: { const: "SCREENSHOT" } }, required: ["type"] },
  then: { type: "object" }
},

          // WAIT
          {
            if: { type: "object", properties: { type: { const: "WAIT" } }, required: ["type"] },
            then: { type: "object", required: ["seconds"] }
          }

          // SWITCH_ACCOUNT and LOOP_AUTOMATION have no additional required fields.
        ]
      }
    }
  }
};

const validate = ajv.compile(schema);

function describeTask(cfg, idx) {
  const tasks = Array.isArray(cfg?.tasks) ? cfg.tasks : [];
  const i = Number(idx);
  const t = Number.isFinite(i) ? tasks[i] : null;
  const id = String(t?.id || "").trim();
  const type = String(t?.type || "").trim().toUpperCase();
  const label = TASK_TYPE_LABELS[type] || humanizeTaskType(type) || type || "Task";
  const name = id ? `Task ${i + 1} (${id})` : `Task ${i + 1}`;
  return `Tasks → ${name} (${label})`;
}

function describeAccount(cfg, idx) {
  const accounts = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
  const i = Number(idx);
  const a = Number.isFinite(i) ? accounts[i] : null;
  const email = String(a?.email || "").trim();
  const name = email ? `Account ${i + 1} (${email})` : `Account ${i + 1}`;
  return `Accounts → ${name}`;
}

function stripLeadingSlash(s) {
  const t = String(s || "");
  return t.startsWith("/") ? t.slice(1) : t;
}

function pathToDot(instancePath, missingProperty) {
  const segs = String(instancePath || "").split("/").filter(Boolean);
  let out = "";
  for (const seg of segs) {
    if (/^\d+$/.test(seg)) {
      out += `[${seg}]`;
      continue;
    }
    out += out ? `.${seg}` : seg;
  }
  if (missingProperty) out = out ? `${out}.${missingProperty}` : String(missingProperty);
  return out || "(root)";
}

function formatAjvErrors(errors, data) {
  if (!errors || !errors.length) return [];

  const list = Array.isArray(errors) ? errors : [];

  // Ajv often emits an extra "if" error like "must match then schema" in
  // addition to concrete "required" errors. That "if" line is not actionable.
  const hasConcreteAt = new Set(
    list
      .filter((e) => e && e.instancePath !== undefined && e.keyword !== "if")
      .map((e) => String(e.instancePath || ""))
  );

  const filtered = list.filter((e) => {
    if (!e) return false;
    if (e.keyword !== "if") return true;
    const p = String(e.instancePath || "");
    return !hasConcreteAt.has(p);
  });

  return filtered.map((e) => {
    const instancePath = String(e.instancePath || "");
    const segs = instancePath.split("/").filter(Boolean);

    let scope = "Config";
    let taskIdx = null;
    let accIdx = null;
    if (segs[0] === "tasks" && segs.length >= 2) {
      taskIdx = Number(segs[1]);
      if (Number.isFinite(taskIdx)) scope = describeTask(data, taskIdx);
    } else if (segs[0] === "accounts" && segs.length >= 2) {
      accIdx = Number(segs[1]);
      if (Number.isFinite(accIdx)) scope = describeAccount(data, accIdx);
    } else if (segs[0]) {
      scope = `Config → ${segs[0]}`;
    }

    const missing = e.keyword === "required" ? String(e.params?.missingProperty || "") : "";
    const dotPath = pathToDot(stripLeadingSlash(instancePath), missing);

    // Human messages + fix hints.
    let msg = "Invalid value.";
    let fix = "";

    if (e.keyword === "required" && missing) {
      msg = `Missing required field "${missing}".`;
      if (scope.startsWith("Tasks →") && Number.isFinite(taskIdx)) {
        fix = `Open Tasks. Find Task ${taskIdx + 1}. Fill "${missing}".`;
      } else if (scope.startsWith("Accounts →") && Number.isFinite(accIdx)) {
        fix = `Open Accounts. Find Account ${accIdx + 1}. Fill "${missing}".`;
      } else {
        fix = `Set "${missing}" in the relevant tab.`;
      }
    } else if (e.keyword === "type") {
      msg = `Wrong type. ${String(e.message || "")}`.trim();
      fix = `Check the field value at ${dotPath}.`;
    } else if (e.keyword === "enum") {
      msg = `Invalid option. ${String(e.message || "")}`.trim();
      fix = `Pick one of the allowed values for ${dotPath}.`;
    } else if (e.keyword === "minLength") {
      const n = Number(e.params?.limit);
      const lim = Number.isFinite(n) ? n : 1;
      const field = missing || dotPath;
      msg = `Field cannot be empty. Minimum length is ${lim}.`;
      if (scope.startsWith("Tasks →") && Number.isFinite(taskIdx)) {
        fix = `Open Tasks. Find Task ${taskIdx + 1}. Fill "${field}".`;
      } else {
        fix = `Provide a non-empty value for ${dotPath}.`;
      }
    } else if (e.keyword === "minimum" || e.keyword === "maximum") {
      msg = String(e.message || "Invalid numeric value.");
      fix = dotPath && dotPath !== "(root)" ? `Adjust ${dotPath} to be within the allowed range.` : "Adjust the value to be within the allowed range.";
    } else if (e.keyword === "additionalProperties") {
      const p = String(e.params?.additionalProperty || "");
      msg = p ? `Unknown field "${p}".` : `Unknown field.`;
      fix = "Remove it, or rename it to a supported field.";
    } else if (e.keyword === "if") {
      // Only shown if there was no concrete error at the same path.
      msg = "Task fields do not match the selected task type.";
      if (scope.startsWith("Tasks →") && Number.isFinite(taskIdx)) {
        fix = `Open Tasks. Find Task ${taskIdx + 1}. Fill the required fields for this type.`;
      }
    } else {
      msg = String(e.message || "Invalid value.");
      if (dotPath && dotPath !== "(root)") fix = `Check ${dotPath}.`;
    }

    const where = dotPath && dotPath !== "(root)" ? ` Path: ${dotPath}.` : "";
    const fixPart = fix ? ` Fix: ${fix}` : "";
    return `${scope}: ${msg}${where}${fixPart}`;
  });
}

function extraConfigErrors(data) {
  const errs = [];
  const cfg = data && typeof data === "object" ? data : {};

  const tasks = Array.isArray(cfg.tasks) ? cfg.tasks : [];

  // Enforce task id uniqueness.
  const seen = new Map();
  for (let i = 0; i < tasks.length; i++) {
    const id = String(tasks[i]?.id || "").trim();
    if (!id) continue;
    if (seen.has(id)) {
      const first = seen.get(id);
      errs.push(`Tasks: Duplicate task id "${id}". Path: tasks[${i}].id. Fix: Give Task ${i + 1} a unique id (first seen in Task ${first + 1}).`);
    } else {
      seen.set(id, i);
    }
  }

  // Enforce LOOP_AUTOMATION placement.
  const loopIdx = [];
  for (let i = 0; i < tasks.length; i++) {
    if (String(tasks[i]?.type || "").trim().toUpperCase() === "LOOP_AUTOMATION") loopIdx.push(i);
  }
  if (loopIdx.length > 1) {
    errs.push(`Tasks: Only one LOOP_AUTOMATION task is allowed. Fix: Remove extra LOOP_AUTOMATION tasks.`);
  }
  if (loopIdx.length === 1 && loopIdx[0] !== tasks.length - 1) {
    errs.push(`Tasks: LOOP_AUTOMATION must be the last task. Fix: Move LOOP_AUTOMATION to the bottom of the task list.`);
  }

  // Per-task field sanity checks (schema cannot express some of these cleanly).
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const type = String(t?.type || "").trim().toUpperCase();
    const scope = describeTask(cfg, i);

    const sel = t && typeof t === "object" ? t.selector : null;
    const selCss = sel && typeof sel === "object" ? String(sel.css || "").trim() : "";
    const selId = sel && typeof sel === "object" ? String(sel.id || "").trim() : "";

    if (["CLICK", "FILL", "WAIT_FOR_SELECTOR"].includes(type)) {
      if (!selCss && !selId) {
        errs.push(`${scope}: Missing selector. Path: tasks[${i}].selector. Fix: Set selector.css or selector.id.`);
      }
    }

    if (type === "PRESS_KEY") {
      const key = String(t?.key || "").trim();
      if (!key) errs.push(`${scope}: Missing required field "key". Path: tasks[${i}].key. Fix: Set key, for example Enter, Tab, Escape.`);
    }

    if (type === "FILL") {
      const text = String(t?.text ?? "").trim();
      if (!text) errs.push(`${scope}: Missing required field "text". Path: tasks[${i}].text. Fix: Set the text to type.`);
    }
  }

  return errs;
}

function extraConfigWarnings(data) {
  const cfg = (data && typeof data === "object") ? data : {};
  const warnings = [];

  // Legacy fields that are ignored by the runner.
  const asi = Number(cfg.account_switch_interval ?? 0);
  if (Number.isFinite(asi) && asi > 0) {
    warnings.push(`Legacy setting is ignored: account_switch_interval=${asi}. Path: account_switch_interval. Fix: Set to 0 or remove.`);
  }

  // Multi sessions conflicts with SWITCH_ACCOUNT.
  if (cfg.multi_sessions_enabled === true && Array.isArray(cfg.tasks)) {
    cfg.tasks.forEach((t, i) => {
      const type = String(t?.type || "").trim().toUpperCase();
      if (type === "SWITCH_ACCOUNT") {
        warnings.push(`Multi sessions is enabled. SWITCH_ACCOUNT is redundant and will be skipped. Path: tasks[${i}].type. Fix: Remove the task or disable multi_sessions_enabled.`);
      }
    });
  }

  // Empty passwords will fail LOGIN/SWITCH_ACCOUNT tasks.
  if (Array.isArray(cfg.accounts)) {
    cfg.accounts.forEach((a, i) => {
      const email = String(a?.email || "").trim();
      if (!email) return;
      const pw = String(a?.password || "");
      if (!pw) {
        warnings.push(`Account has no password. LOGIN will fail for this account. Path: accounts[${i}].password. Fix: Set a password or disable the account.`);
      }
    });
  }

  return warnings;
}

function validateConfigWithExtras(data) {
  const okSchema = validate(data);
  const errors = [...formatAjvErrors(validate.errors, data), ...extraConfigErrors(data)];
  const warnings = extraConfigWarnings(data);
  return { ok: Boolean(okSchema) && errors.length === 0, errors, warnings };
}


// ---------------------------------------------------------------------------
// Migration + normalization
// ---------------------------------------------------------------------------

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  return Math.min(max, Math.max(min, i));
}

function normalizeConfig(cfg, { projectRootDir } = {}) {
  const c = (cfg && typeof cfg === "object") ? cfg : {};

  c.config_version = clampInt(c.config_version ?? CONFIG_VERSION, 1, 9999, CONFIG_VERSION);

  c.run_enabled = Boolean(c.run_enabled ?? true);
  c.headless = Boolean(c.headless ?? false);

  c.log_level = String(c.log_level || "info").toLowerCase();
  if (!["error", "warn", "info", "debug"].includes(c.log_level)) c.log_level = "info";

  c.base_url = String(c.base_url || "https://discord.com");
  c.login_url = String(c.login_url || `${c.base_url}/login`);
  c.logout_url = String(c.logout_url || `${c.base_url}/logout`);

  c.no_login_delay = Boolean(c.no_login_delay ?? false);

  c.tasks_interval = Number(c.tasks_interval ?? 1000);
  if (!Number.isFinite(c.tasks_interval) || c.tasks_interval < 50) c.tasks_interval = 1000;

  c.jitter_ms = Number(c.jitter_ms ?? 0);
  if (!Number.isFinite(c.jitter_ms) || c.jitter_ms < 0) c.jitter_ms = 0;

  c.element_wait_timeout_ms = Number(c.element_wait_timeout_ms ?? 30_000);
  if (!Number.isFinite(c.element_wait_timeout_ms) || c.element_wait_timeout_ms < 100) c.element_wait_timeout_ms = 30_000;

  c.human_typing_enabled = c.human_typing_enabled === undefined ? true : Boolean(c.human_typing_enabled);

  c.typing_delay_ms_min = Number(c.typing_delay_ms_min ?? 70);
  if (!Number.isFinite(c.typing_delay_ms_min) || c.typing_delay_ms_min < 0) c.typing_delay_ms_min = 70;

  c.typing_delay_ms_max = Number(c.typing_delay_ms_max ?? 160);
  if (!Number.isFinite(c.typing_delay_ms_max) || c.typing_delay_ms_max < 0) c.typing_delay_ms_max = 160;

  // Ensure min <= max.
  if (c.typing_delay_ms_min > c.typing_delay_ms_max) {
    const tmp = c.typing_delay_ms_min;
    c.typing_delay_ms_min = c.typing_delay_ms_max;
    c.typing_delay_ms_max = tmp;
  }

  c.screenshot_on_error = Boolean(c.screenshot_on_error ?? false);
  const root = projectRootDir || __dirname;
  c.screenshot_dir = String(c.screenshot_dir || path.join(root, "screenshots"));

  // Human-facing app version (do not enforce upgrades based on this field).
  c.version = String(c.version || "1.5.3");

  // Session hygiene defaults.
  c.restart_browser_on_logout = c.restart_browser_on_logout === undefined ? true : Boolean(c.restart_browser_on_logout);
  c.restart_browser_on_switch_account = c.restart_browser_on_switch_account === undefined ? true : Boolean(c.restart_browser_on_switch_account);
  c.firefox_private_browsing = Boolean(c.firefox_private_browsing ?? false);

  // Multi sessions.
  c.multi_sessions_enabled = Boolean(c.multi_sessions_enabled ?? false);
  c.multi_sessions_accounts = Array.isArray(c.multi_sessions_accounts) ? c.multi_sessions_accounts : [];
  c.multi_sessions_accounts = Array.from(new Set(c.multi_sessions_accounts
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)));

  // Keep ids as strings unless user explicitly uses numbers.
  if (c.server_id === undefined || c.server_id === null) c.server_id = "";
  if (c.channel_id === undefined || c.channel_id === null) c.channel_id = "";

  c.accounts = Array.isArray(c.accounts) ? c.accounts : [];
  c.accounts = c.accounts.map((a) => {
    const acc = (a && typeof a === "object") ? a : {};
    acc.email = String(acc.email || "").trim();
    acc.password = String(acc.password || "");
    acc.name = String(acc.name || "");
    acc.enabled = acc.enabled === undefined ? true : Boolean(acc.enabled);
    acc.priority = clampInt(acc.priority, PRIORITY.MIN, PRIORITY.MAX, PRIORITY.DEFAULT);
    acc.cooldown_after_use_ms = Number(acc.cooldown_after_use_ms ?? 0);
    if (!Number.isFinite(acc.cooldown_after_use_ms) || acc.cooldown_after_use_ms < 0) acc.cooldown_after_use_ms = 0;
    acc.max_tasks_per_session = Number(acc.max_tasks_per_session ?? 0);
    if (!Number.isFinite(acc.max_tasks_per_session) || acc.max_tasks_per_session < 0) acc.max_tasks_per_session = 0;
    acc.max_tasks_per_session = Math.round(acc.max_tasks_per_session);
    acc.notes = acc.notes === undefined || acc.notes === null ? "" : String(acc.notes);
    return acc;
  });

  c.tasks = Array.isArray(c.tasks) ? c.tasks : [];
  c.tasks = c.tasks.map((t) => {
    const task = (t && typeof t === "object") ? t : {};
    task.id = String(task.id || "").trim();
    task.type = String(task.type || "").trim();
    if (!TASK_TYPES.includes(task.type)) task.type = "SEND_MESSAGE";
    task.priority = clampInt(task.priority, PRIORITY.MIN, PRIORITY.MAX, PRIORITY.DEFAULT);
    task.enabled = task.enabled === undefined ? true : Boolean(task.enabled);
    task.oneshot = Boolean(task.oneshot ?? false);
    task.instant = Boolean(task.instant ?? false);

    // Optional multi-account targeting.
    task.accounts = Array.isArray(task.accounts) ? task.accounts : [];
    task.accounts = task.accounts.map((v) => String(v ?? "").trim()).filter(Boolean);

    // UPLOAD_FILE: support multiple files.
    if (task.type === "UPLOAD_FILE") {
      task.files = Array.isArray(task.files) ? task.files : [];
      task.files = task.files.map((v) => String(v ?? "").trim()).filter(Boolean);
      if (!task.files.length && String(task.file || "").trim()) task.files = [String(task.file).trim()];
    }
    return task;
  });

  c.advanced_tasking_script = c.advanced_tasking_script === undefined || c.advanced_tasking_script === null
    ? ""
    : String(c.advanced_tasking_script);

  return c;
}

function migrateConfig(cfg, { projectRootDir } = {}) {
  const c = (cfg && typeof cfg === "object") ? cfg : {};
  const from = clampInt(c.config_version ?? 1, 1, 9999, 1);
  let migrated = false;
  const notes = [];

  // v1 -> v2: introduce explicit advanced URL fields + screenshot_dir.
  if (from < 2) {
    if (c.base_url === undefined) {
      c.base_url = "https://discord.com";
      notes.push("Added base_url default.");
    }
    if (c.login_url === undefined) {
      c.login_url = `${String(c.base_url || "https://discord.com")}/login`;
      notes.push("Added login_url default.");
    }
    if (c.logout_url === undefined) {
      c.logout_url = `${String(c.base_url || "https://discord.com")}/logout`;
      notes.push("Added logout_url default.");
    }
    if (c.screenshot_dir === undefined) {
      const root = projectRootDir || __dirname;
      c.screenshot_dir = path.join(root, "screenshots");
      notes.push("Added screenshot_dir default.");
    }
    c.config_version = 2;
    migrated = true;
  }

  // v2 -> v3: multi sessions + multi-file uploads + human-facing version.
  if (from < 3) {
    if (c.version === undefined) {
      c.version = "1.5.3";
      notes.push("Added version field.");
    }
    if (c.multi_sessions_enabled === undefined) {
      c.multi_sessions_enabled = false;
      notes.push("Added multi_sessions_enabled default.");
    }
    if (c.multi_sessions_accounts === undefined) {
      c.multi_sessions_accounts = [];
      notes.push("Added multi_sessions_accounts default.");
    }

    // UPLOAD_FILE: migrate legacy file -> files.
    if (Array.isArray(c.tasks)) {
      c.tasks = c.tasks.map((t) => {
        const task = (t && typeof t === "object") ? t : {};
        if (String(task.type || "").toUpperCase() === "UPLOAD_FILE") {
          if (!Array.isArray(task.files)) task.files = [];
          if (!task.files.length && String(task.file || "").trim()) task.files = [String(task.file).trim()];
        }
        if (!Array.isArray(task.accounts)) task.accounts = [];
        return task;
      });
    }

    c.config_version = 3;
    migrated = true;
  }


  // v3 -> v4: UI theme setting.
  if (from < 4) {
    if (c.ui_theme === undefined) {
      c.ui_theme = "system";
      notes.push("Added ui_theme default.");
    }
    c.config_version = 4;
    migrated = true;
  }

  // Normalize after migration so we do not leak undefined / invalid types.
  normalizeConfig(c, { projectRootDir });

  return { data: c, migrated, fromVersion: from, toVersion: c.config_version, notes };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sanitizeConfig(cfg) {
  const sanitized = JSON.parse(JSON.stringify(cfg || {}));
  if (Array.isArray(sanitized.accounts)) {
    sanitized.accounts = sanitized.accounts.map((a) => ({
      ...a,
      password: ""
    }));
  }
  delete sanitized.__config_path;
  return sanitized;
}

function getMeta() {
  return {
    taskTypes: TASK_TYPES,
    taskTypeLabels: TASK_TYPE_LABELS,
    priority: PRIORITY,
    configVersion: CONFIG_VERSION
  };
}

module.exports = {
  TASK_TYPES,
  PRIORITY,
  CONFIG_VERSION,
  schema,
  defaultConfigTemplate,
  validateConfigWithExtras,
  normalizeConfig,
  migrateConfig,
  sanitizeConfig,
  getMeta
};
