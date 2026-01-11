/*
  Advanced tasking core.
  - Works in the renderer (as window.AdvancedTasking)
  - Works in Node tests (as module.exports)
*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AdvancedTasking = factory();
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.round(n);
    return Math.min(max, Math.max(min, i));
  }

  function tokenizeLine(line) {
    const s = String(line || "");
    const out = [];
    let i = 0;

    const isSpace = (c) => c === " " || c === "\t";
    const readQuoted = (quote) => {
      i++; // skip quote
      let buf = "";
      while (i < s.length) {
        const c = s[i];
        if (c === "\\") {
          const n = s[i + 1];
          if (n === undefined) break;
          buf += n;
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        buf += c;
        i++;
      }
      return buf;
    };

    while (i < s.length) {
      while (i < s.length && isSpace(s[i])) i++;
      if (i >= s.length) break;

      const c = s[i];
      if (c === '"' || c === "'") {
        out.push(readQuoted(c));
        continue;
      }

      let buf = "";
      while (i < s.length && !isSpace(s[i])) {
        if (s[i] === '"' || s[i] === "'") {
          buf += readQuoted(s[i]);
          continue;
        }
        if (s[i] === "\\" && s[i + 1] !== undefined) {
          buf += s[i + 1];
          i += 2;
          continue;
        }
        buf += s[i];
        i++;
      }
      if (buf) out.push(buf);
    }

    return out;
  }

  function quoteIfNeeded(v) {
    const s = String(v ?? "");
    if (!s) return '""';
    if (/\s|"|'/g.test(s)) {
      return '"' + s.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"") + '"';
    }
    return s;
  }

  function parseAdvancedScript(text, opts = {}) {
    const src = String(text ?? "");
    const lines = src.split(/\r?\n/);

    const taskTypes = Array.isArray(opts.taskTypes) ? opts.taskTypes : [];
    const pri = opts.priority || {};
    const priMin = Number.isFinite(pri.min) ? pri.min : 0;
    const priMax = Number.isFinite(pri.max) ? pri.max : 5;
    const priDefault = Number.isFinite(pri.default) ? pri.default : 3;
    const ensureTaskDefaults = typeof opts.ensureTaskDefaults === "function"
      ? opts.ensureTaskDefaults
      : (t) => {
        const task = t || {};
        if (!task.id) task.id = `task_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        if (task.priority === undefined) task.priority = priDefault;
        if (task.oneshot === undefined) task.oneshot = false;
        if (task.instant === undefined) task.instant = false;
        return task;
      };

    const tasks = [];
    const errors = [];

    const pickType = (t) => String(t || "").trim().toUpperCase();
    const parseKV = (tok) => {
      const m = String(tok).match(/^([^=]+)=(.*)$/);
      if (!m) return null;
      return { key: String(m[1]).trim(), value: String(m[2]) };
    };

    for (let li = 0; li < lines.length; li++) {
      const raw = String(lines[li] ?? "");
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

      const toks = tokenizeLine(trimmed);
      if (!toks.length) continue;

      const type = pickType(toks[0]);
      if (!taskTypes.includes(type)) {
        errors.push(`Line ${li + 1}: unknown task type '${toks[0]}'`);
        continue;
      }

      const task = ensureTaskDefaults({ type });
      task.id = `line_${li + 1}`;

      for (let ti = 1; ti < toks.length; ti++) {
        const kv = parseKV(toks[ti]);
        if (!kv) {
          errors.push(`Line ${li + 1}: expected key=value, got '${toks[ti]}'`);
          continue;
        }

        const k = kv.key;
        const v = kv.value;

        if (k === "id") task.id = String(v).trim();
        else if (k === "priority") task.priority = clampInt(v, priMin, priMax, priDefault);
        else if (k === "url") task.url = String(v);
        else if (k === "account") task.account = String(v);
        else if (k === "accounts") {
          task.accounts = String(v)
            .split(/[;,|]/)
            .map((x) => String(x).trim())
            .filter(Boolean);
        }
        else if (k === "message") task.message = String(v);
        else if (k === "file") task.file = String(v);
        else if (k === "files") {
          task.files = String(v)
            .split(/[;,|]/)
            .map((x) => String(x).trim())
            .filter(Boolean);
        }
        else if (k === "files") {
          task.files = String(v)
            .split(/[;,|]/)
            .map((x) => String(x).trim())
            .filter(Boolean);
        }
        else if (k === "command") task.command = String(v);
        else if (k === "index") task.index = String(v).match(/^\d+(\.\d+)?$/) ? Number(v) : v;
        else if (k === "emoji") task.emoji = String(v);
        else if (k === "text") task.text = String(v);
else if (k === "clear") task.clear = String(v).toLowerCase() === "true" || String(v) === "1";
else if (k === "key") task.key = String(v);
else if (k === "times") task.times = Number(v);
else if (k === "timeout_ms") task.timeout_ms = Number(v);
else if (k === "state") task.state = String(v).toLowerCase();
else if (k === "url_contains") task.url_contains = String(v);
else if (k === "label") task.label = String(v);
else if (k === "path") task.path = String(v);
else if (k === "full_page") task.full_page = String(v).toLowerCase() === "true" || String(v) === "1";
        else if (k === "seconds") task.seconds = Number(v);
        else if (k === "interval_ms") task.interval_ms = Number(v);
        else if (k === "css" || k === "selector.css") {
          if (!task.selector || typeof task.selector !== "object") task.selector = {};
          task.selector.css = String(v);
        } else if (k === "selector.id") {
          if (!task.selector || typeof task.selector !== "object") task.selector = {};
          task.selector.id = String(v);
        } else {
          // Keep unknown keys for forward compatibility.
          task[k] = v;
        }
      }

      // Lightweight operator feedback.
      if (type === "CLICK") {
        const hasCss = Boolean(task.selector && String(task.selector.css || "").trim());
        const hasId = Boolean(task.selector && String(task.selector.id || "").trim());
        if (!hasCss && !hasId) errors.push(`Line ${li + 1}: CLICK requires css=... or selector.id=...`);
      }
      if (type === "WAIT") {
        if (!Number.isFinite(Number(task.seconds))) errors.push(`Line ${li + 1}: WAIT requires seconds=...`);
      }
if (type === "FILL") {
  const hasCss = Boolean(task.selector && String(task.selector.css || "").trim());
  const hasId = Boolean(task.selector && String(task.selector.id || "").trim());
  if (!hasCss && !hasId) errors.push(`Line ${li + 1}: FILL requires css=... or selector.id=...`);
  if (!String(task.text || "").trim()) errors.push(`Line ${li + 1}: FILL requires text=...`);
}
if (type === "PRESS_KEY") {
  if (!String(task.key || "").trim()) errors.push(`Line ${li + 1}: PRESS_KEY requires key=...`);
}
if (type === "WAIT_FOR_SELECTOR") {
  const hasCss = Boolean(task.selector && String(task.selector.css || "").trim());
  const hasId = Boolean(task.selector && String(task.selector.id || "").trim());
  if (!hasCss && !hasId) errors.push(`Line ${li + 1}: WAIT_FOR_SELECTOR requires css=... or selector.id=...`);
}
      if (type === "LOGIN") {
        if (!String(task.account || "").trim()) errors.push(`Line ${li + 1}: LOGIN requires account=...`);
      }

      tasks.push(task);
    }

    return { ok: errors.length === 0, tasks, errors };
  }

  function scriptFromTasksList(tasks, opts = {}) {
    const list = Array.isArray(tasks) ? tasks : [];
    const lines = [];

    for (const t of list) {
      const type = String(t?.type || "").toUpperCase();
      if (!type) continue;
      const parts = [type];

      if (t?.id) parts.push(`id=${quoteIfNeeded(t.id)}`);
      if (t?.priority !== undefined) parts.push(`priority=${quoteIfNeeded(t.priority)}`);

      if (Array.isArray(t?.accounts) && t.accounts.length) {
        parts.push(`accounts=${quoteIfNeeded(t.accounts.join(","))}`);
      }

      if (t?.account) parts.push(`account=${quoteIfNeeded(t.account)}`);
      if (t?.url) parts.push(`url=${quoteIfNeeded(t.url)}`);
      if (t?.message) parts.push(`message=${quoteIfNeeded(t.message)}`);
      if (Array.isArray(t?.files) && t.files.length) {
        parts.push(`files=${quoteIfNeeded(t.files.join(","))}`);
      } else if (t?.file) {
        parts.push(`file=${quoteIfNeeded(t.file)}`);
      }
      if (t?.command) parts.push(`command=${quoteIfNeeded(t.command)}`);
      if (t?.index !== undefined && t?.index !== null && t?.index !== "") parts.push(`index=${quoteIfNeeded(t.index)}`);
      if (t?.emoji) parts.push(`emoji=${quoteIfNeeded(t.emoji)}`);
      if (t?.text) parts.push(`text=${quoteIfNeeded(t.text)}`);
if (t?.clear !== undefined) parts.push(`clear=${quoteIfNeeded(Boolean(t.clear))}`);
if (t?.key) parts.push(`key=${quoteIfNeeded(t.key)}`);
if (t?.times !== undefined) parts.push(`times=${quoteIfNeeded(t.times)}`);
if (t?.timeout_ms !== undefined) parts.push(`timeout_ms=${quoteIfNeeded(t.timeout_ms)}`);
if (t?.state) parts.push(`state=${quoteIfNeeded(t.state)}`);
if (t?.url_contains) parts.push(`url_contains=${quoteIfNeeded(t.url_contains)}`);
if (t?.label) parts.push(`label=${quoteIfNeeded(t.label)}`);
if (t?.path) parts.push(`path=${quoteIfNeeded(t.path)}`);
if (t?.full_page !== undefined) parts.push(`full_page=${quoteIfNeeded(Boolean(t.full_page))}`);
      if (t?.seconds !== undefined && t?.seconds !== null && t?.seconds !== "") parts.push(`seconds=${quoteIfNeeded(t.seconds)}`);
      if (t?.interval_ms !== undefined && t?.interval_ms !== null && t?.interval_ms !== "") parts.push(`interval_ms=${quoteIfNeeded(t.interval_ms)}`);

      if (t?.selector?.css) parts.push(`css=${quoteIfNeeded(t.selector.css)}`);
      if (t?.selector?.id) parts.push(`selector.id=${quoteIfNeeded(t.selector.id)}`);

      lines.push(parts.join(" "));
    }

    return lines.join("\n") + (lines.length ? "\n" : "");
  }

  return Object.freeze({
    tokenizeLine,
    quoteIfNeeded,
    parseAdvancedScript,
    scriptFromTasksList
  });
});
