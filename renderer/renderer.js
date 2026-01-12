let filePath = null;
let config = null;

let isDirty = false;
let isRunning = false;
let isPaused = false;

// App metadata (package.json). Loaded once.
let appInfo = null;


// UI theme mode. Stored in config as `ui_theme`.
let uiThemeMode = "system";
let __systemThemeMql = null;
let __systemThemeListener = null;

function __setDomTheme(theme) {
  const t = String(theme || "dark");
  document.documentElement.dataset.theme = t;
}

function __applySystemThemeNow() {
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  __setDomTheme(dark ? "dark" : "light");
}

function applyThemeMode(mode) {
  const m = String(mode || "system").toLowerCase();
  uiThemeMode = m;

  // Cancel previous listener if any.
  try {
    if (__systemThemeMql && __systemThemeListener) {
      if (__systemThemeMql.removeEventListener) __systemThemeMql.removeEventListener("change", __systemThemeListener);
      else if (__systemThemeMql.removeListener) __systemThemeMql.removeListener(__systemThemeListener);
    }
  } catch {
    // ignore
  }
  __systemThemeMql = null;
  __systemThemeListener = null;

  // Tell Electron which base theme to use for native integrations.
  try {
    if (window.api && typeof window.api.setThemeMode === "function") {
      // amoled is still a dark base theme.
      const base = (m === "light") ? "light" : (m === "system") ? "system" : "dark";
      window.api.setThemeMode(base);
    }
  } catch {
    // ignore
  }

  if (m === "system") {
    __applySystemThemeNow();
    try {
      __systemThemeMql = window.matchMedia("(prefers-color-scheme: dark)");
      __systemThemeListener = () => __applySystemThemeNow();
      if (__systemThemeMql.addEventListener) __systemThemeMql.addEventListener("change", __systemThemeListener);
      else if (__systemThemeMql.addListener) __systemThemeMql.addListener(__systemThemeListener);
    } catch {
      // ignore
    }
    return;
  }

  if (m === "amoled") {
    __setDomTheme("amoled");
    return;
  }

  if (m === "light") {
    __setDomTheme("light");
    return;
  }

  __setDomTheme("dark");
}

// Optional: accept system theme updates from main (nativeTheme changes).
try {
  if (window.api && typeof window.api.onSystemTheme === "function") {
    window.api.onSystemTheme((_payload) => {
      if (uiThemeMode === "system") __applySystemThemeNow();
    });
  }
} catch {
  // ignore
}

// Validation state (latest result).
let lastValidation = { ok: false, errors: [], warnings: [] };
let lastValidatedAt = null;
let SCHEMA_VERSION = null;
let issueIndex = { errors: new Map(), warnings: new Map() };

function countIssuesForPrefix(prefix) {
  const pre = String(prefix || "");
  if (!pre) return { errors: 0, warnings: 0 };
  let errors = 0;
  let warnings = 0;
  try {
    for (const k of (issueIndex?.errors?.keys ? issueIndex.errors.keys() : [])) {
      if (String(k).startsWith(pre)) errors++;
    }
    for (const k of (issueIndex?.warnings?.keys ? issueIndex.warnings.keys() : [])) {
      if (String(k).startsWith(pre)) warnings++;
    }
  } catch {}
  return { errors, warnings };
}

// UI filter state (not persisted).
const uiFilters = {
  accountsSearch: "",
  accountsFilter: "all",
  tasksSearch: "",
  tasksFilterType: "all",
  tasksFilterAccount: "all",
  tasksFilterState: "all"
};

// Log viewer state.
let logEntries = [];
let logSearch = "";
let logViewerLevel = "info";
let logAutoScroll = true;

// Small inline SVGs for toolbar buttons.
// These are simple geometric shapes and safe to inline.
const ICON_PLAY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M11.596 8.697 5.233 12.39A.75.75 0 0 1 4 11.692V4.308a.75.75 0 0 1 1.233-.697l6.363 3.692a.75.75 0 0 1 0 1.302"/></svg>';
const ICON_PAUSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5.5 3.5A1.5 1.5 0 0 0 4 5v6a1.5 1.5 0 0 0 3 0V5a1.5 1.5 0 0 0-1.5-1.5m5 0A1.5 1.5 0 0 0 9 5v6a1.5 1.5 0 0 0 3 0V5a1.5 1.5 0 0 0-1.5-1.5"/></svg>';



let dragCtx = { kind: null, from: null };

// UI-only collapse state. Not persisted to config.
const uiCollapse = {
  tasks: new Set(),
  accounts: new Set()
};

// Collapse / expand animation.
const COLLAPSE_ANIM_MS = 180;
const COLLAPSE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

function cancelCollapseAnim(el) {
  try {
    // Cancel any prior Dab-owned collapse animations that may still be applying
    // styles (e.g., fill-mode effects). This prevents "works once" failures.
    if (el && typeof el.getAnimations === "function") {
      for (const a of el.getAnimations()) {
        try {
          if (a && a.__dabCollapse === true) a.cancel();
        } catch {}
      }
    }
    if (el && el.__collapseAnim) el.__collapseAnim.cancel();
  } catch {}
  if (el) el.__collapseAnim = null;
}

function setItemCollapsed(item, collapsed, body, { key, store } = {}) {
  if (!item || !body) {
    if (item) item.classList.toggle("is-collapsed", Boolean(collapsed));
    if (store && key) {
      if (collapsed) store.add(key);
      else store.delete(key);
    }
    return;
  }

  const wantCollapsed = Boolean(collapsed);
  const hasCollapsed = item.classList.contains("is-collapsed");
  if (wantCollapsed === hasCollapsed) {
    if (store && key) {
      if (wantCollapsed) store.add(key);
      else store.delete(key);
    }
    return;
  }

  if (store && key) {
    if (wantCollapsed) store.add(key);
    else store.delete(key);
  }

  cancelCollapseAnim(body);

  const cs = getComputedStyle(body);
  const startH = body.getBoundingClientRect().height;
  const startPT = parseFloat(cs.paddingTop) || 0;
  const startPB = parseFloat(cs.paddingBottom) || 0;

  const applyStartInline = ({ h, pt, pb, op }) => {
    body.style.height = `${Math.max(0, h)}px`;
    body.style.paddingTop = `${Math.max(0, pt)}px`;
    body.style.paddingBottom = `${Math.max(0, pb)}px`;
    body.style.opacity = String(op);
    body.style.overflow = "hidden";
  };

  const clearInline = () => {
    body.style.height = "";
    body.style.paddingTop = "";
    body.style.paddingBottom = "";
    body.style.opacity = "";
    body.style.overflow = "";
  };

  if (wantCollapsed) {
    // Add class first so UI (button label, borders) updates immediately.
    item.classList.add("is-collapsed");

    // Override collapsed CSS with explicit start values, then animate to 0.
    applyStartInline({ h: startH, pt: startPT, pb: startPB, op: 1 });
    body.getBoundingClientRect();

    const anim = body.animate(
      [
        { height: `${startH}px`, paddingTop: `${startPT}px`, paddingBottom: `${startPB}px`, opacity: 1 },
        { height: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0 }
      ],
      // Do not use fill:"forwards". The final state is already represented by
      // the .is-collapsed class, and forwards fill can override subsequent style
      // changes and break future toggles.
      { duration: COLLAPSE_ANIM_MS, easing: COLLAPSE_EASING }
    );
    anim.__dabCollapse = true;
    body.__collapseAnim = anim;
    let didEnd = false;
    const done = () => {
      if (didEnd) return;
      didEnd = true;
      body.__collapseAnim = null;
      clearInline();
    };
    anim.onfinish = done;
    anim.oncancel = done;
    return;
  }

  // Expanding.
  item.classList.remove("is-collapsed");

  // Measure end state after expanding styles apply.
  const ecs = getComputedStyle(body);
  const endPT = parseFloat(ecs.paddingTop) || 0;
  const endPB = parseFloat(ecs.paddingBottom) || 0;
  const endH = body.getBoundingClientRect().height;

  // Start from 0 and animate to the measured height.
  applyStartInline({ h: 0, pt: 0, pb: 0, op: 0 });
  body.getBoundingClientRect();

  const anim = body.animate(
    [
      { height: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0 },
      { height: `${Math.max(0, endH)}px`, paddingTop: `${endPT}px`, paddingBottom: `${endPB}px`, opacity: 1 }
    ],
    // Underlying expanded state is represented by the absence of .is-collapsed.
    // Avoid fill-forwards to prevent stale animation styles from overriding.
    { duration: COLLAPSE_ANIM_MS, easing: COLLAPSE_EASING }
  );
  anim.__dabCollapse = true;
  body.__collapseAnim = anim;
  let didEnd = false;
  const done = () => {
    if (didEnd) return;
    didEnd = true;
    body.__collapseAnim = null;
    clearInline();
  };
  anim.onfinish = done;
  anim.oncancel = done;
}

function updateToggleAllBtn(kind) {
  const btn = $(kind === "accounts" ? "accountsToggleAllBtn" : "tasksToggleAllBtn");
  if (!btn || !config) return;

  const list = kind === "accounts" ? (Array.isArray(config.accounts) ? config.accounts : []) : (Array.isArray(config.tasks) ? config.tasks : []);
  const store = kind === "accounts" ? uiCollapse.accounts : uiCollapse.tasks;
  const keyFn = kind === "accounts" ? accountUiKey : taskUiKey;

  if (!list.length) {
    btn.textContent = "Collapse all";
    return;
  }

  const allCollapsed = list.every((x, i) => store.has(keyFn(x, i)));
  btn.textContent = allCollapsed ? "Expand all" : "Collapse all";
}

function taskUiKey(t, idx) {
  const id = t && typeof t === "object" ? String(t.id || "").trim() : "";
  return id || `idx:${idx}`;
}

function accountUiKey(a, idx) {
  const email = a && typeof a === "object" ? String(a.email || "").trim().toLowerCase() : "";
  return email || `idx:${idx}`;
}

const $ = (id) => document.getElementById(id);

function uniq(arr) {
  const a = Array.isArray(arr) ? arr : [];
  return Array.from(new Set(a));
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function getEnabledAccounts(cfg) {
  const list = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
  return list.filter((a) => a && a.enabled !== false && String(a.email || "").trim());
}

function getSelectedMultiSessionAccountsUi(cfg) {
  const enabled = getEnabledAccounts(cfg);
  if (!enabled.length) return [];

  const selected = Array.isArray(cfg?.multi_sessions_accounts) ? cfg.multi_sessions_accounts : [];
  const keys = selected.map((v) => String(v ?? "").trim()).filter(Boolean);
  if (!keys.length) return enabled;

  const out = [];
  const seen = new Set();
  for (const k of keys) {
    const low = normalizeEmail(k);
    if (!low || seen.has(low)) continue;
    const acc = enabled.find((a) => normalizeEmail(a.email) === low);
    if (!acc) continue;
    seen.add(low);
    out.push(acc);
  }

  return out.length ? out : enabled;
}

// Themed modal confirmation (replaces native window.confirm).
let __modal = {
  overlay: null,
  title: null,
  message: null,
  ok: null,
  cancel: null,
  close: null,
  resolve: null,
  keyHandler: null,
  lastFocus: null
};

function initModal() {
  __modal.overlay = $("modalOverlay");
  __modal.title = $("modalTitle");
  __modal.message = $("modalMessage");
  __modal.ok = $("modalOk");
  __modal.cancel = $("modalCancel");
  __modal.close = $("modalClose");

  if (!__modal.overlay || !__modal.title || !__modal.message || !__modal.ok || !__modal.cancel || !__modal.close) {
    return;
  }

  const cancel = () => closeModal(false);

  __modal.overlay.addEventListener("click", (ev) => {
    if (ev.target === __modal.overlay) cancel();
  });
  __modal.close.addEventListener("click", cancel);
  __modal.cancel.addEventListener("click", cancel);
  __modal.ok.addEventListener("click", () => closeModal(true));
}

function openModal({ title, message, confirmText, cancelText, danger }) {
  if (!__modal.overlay) return Promise.resolve(false);

  __modal.lastFocus = document.activeElement;

  __modal.title.textContent = String(title || "Confirm");
  __modal.message.textContent = String(message || "");
  __modal.ok.textContent = String(confirmText || "Confirm");
  __modal.cancel.textContent = String(cancelText || "Cancel");

  __modal.ok.className = danger ? "btn btn-danger" : "btn btn-primary";
  __modal.cancel.className = "btn btn-secondary";

  __modal.overlay.classList.remove("is-hidden");
  __modal.overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");

  // Keyboard.
  __modal.keyHandler = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeModal(false);
      return;
    }
    if (ev.key === "Enter") {
      // Only treat Enter as confirm when focus is within the modal.
      const a = document.activeElement;
      if (a && __modal.overlay.contains(a) && a !== __modal.cancel) {
        ev.preventDefault();
        closeModal(true);
      }
    }
  };
  document.addEventListener("keydown", __modal.keyHandler, true);

  // Focus.
  setTimeout(() => {
    try { __modal.ok.focus(); } catch {}
  }, 0);

  return new Promise((resolve) => {
    __modal.resolve = resolve;
  });
}

function closeModal(result) {
  if (!__modal.overlay) return;

  __modal.overlay.classList.add("is-hidden");
  __modal.overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");

  if (__modal.keyHandler) {
    document.removeEventListener("keydown", __modal.keyHandler, true);
    __modal.keyHandler = null;
  }

  const r = __modal.resolve;
  __modal.resolve = null;
  if (typeof r === "function") r(Boolean(result));

  try {
    const lf = __modal.lastFocus;
    __modal.lastFocus = null;
    if (lf && typeof lf.focus === "function") lf.focus();
  } catch {}
}

async function uiConfirm({ title, message, confirmText, cancelText, danger } = {}) {
  return openModal({ title, message, confirmText, cancelText, danger });
}

// Populated at runtime from the main process so task types stay in sync.
// A fallback is kept so the UI still works if the IPC call fails.
let TASK_TYPES = [
  "LOGIN",
  "LOGOUT",
  "SWITCH_ACCOUNT",
  "UPLOAD_FILE",
  "SEND_MESSAGE",
  "SLASH_COMMAND",
  "SEND_EMOJI",
  "NAVIGATE",
  "CLICK",
  "WAIT",
  "LOOP_AUTOMATION"
];

let TASK_TYPE_LABELS = {};

function humanizeTaskType(type) {
  const s = String(type || "").trim();
  if (!s) return "";
  return s
    .split("_")
    .filter(Boolean)
    .map((w) => {
      const lw = w.toLowerCase();
      if (lw === "url") return "URL";
      if (lw === "id") return "ID";
      return lw.charAt(0).toUpperCase() + lw.slice(1);
    })
    .join(" ");
}

function taskTypeLabel(type) {
  const key = String(type || "").trim();
  return TASK_TYPE_LABELS && TASK_TYPE_LABELS[key] ? String(TASK_TYPE_LABELS[key]) : humanizeTaskType(key);
}

let PRIORITY_MIN = 0;
let PRIORITY_MAX = 5;
let PRIORITY_DEFAULT = 3;

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  return Math.min(max, Math.max(min, i));
}

function moveItem(arr, fromIndex, toIndex) {
  const a = Array.isArray(arr) ? arr : [];
  const from = clampInt(fromIndex, 0, a.length - 1, -1);
  const to = clampInt(toIndex, 0, a.length - 1, -1);
  if (from < 0 || to < 0 || from === to) return a;
  const copy = a.slice();
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

function clearDropMarkers(root) {
  if (!root) return;
  root.querySelectorAll(".item").forEach((el) => {
    el.classList.remove("is-drop-before", "is-drop-after");
  });
}

function setDirty(next) {
  isDirty = Boolean(next);
  updateFileHeader();
  updateConfigStatePill();
  updateRunGating();
}

function basename(p) {
  const s = String(p || "");
  const parts = s.split(/\\|\//g).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

function updateFileHeader() {
  const nameEl = $("fileName");
  const pathEl = $("filePath");
  const copyBtn = $("copyPathBtn");
  const openBtn = $("openFolderBtn");

  if (nameEl) nameEl.textContent = filePath ? basename(filePath) : "(no file)";
  if (pathEl) pathEl.textContent = filePath ? String(filePath) : "(no file opened)";

  const hasFile = Boolean(filePath);
  if (copyBtn) copyBtn.disabled = !hasFile;
  if (openBtn) openBtn.disabled = !hasFile;
}

function updateConfigStatePill() {
  const pill = $("configStatePill");
  if (!pill) return;

  if (!filePath) {
    pill.className = "pill pill-muted";
    pill.textContent = "Not loaded";
    return;
  }

  const validated = Boolean(lastValidatedAt);
  const ok = Boolean(lastValidation && lastValidation.ok);
  const dirty = Boolean(isDirty);

  if (!validated) {
    pill.className = dirty ? "pill pill-warn" : "pill pill-muted";
    pill.textContent = dirty ? "Unsaved" : "Not validated";
    return;
  }

  if (ok && !dirty) {
    pill.className = "pill pill-ok";
    pill.textContent = "Valid, saved";
    return;
  }

  if (ok && dirty) {
    pill.className = "pill pill-warn";
    pill.textContent = "Valid, unsaved";
    return;
  }

  pill.className = "pill pill-bad";
  pill.textContent = dirty ? "Invalid, unsaved" : "Invalid";
}

function updateRunGating() {
  // Run is gated by readiness. It is start-only.
  const runBtn = $("runBtn");
  if (!runBtn) return;

  const readiness = $("runReadiness");
  const showReadiness = ({ text, actions } = {}) => {
    if (!readiness) return;
    readiness.classList.add("is-visible");
    readiness.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "readiness-text";
    msg.textContent = String(text || "");
    readiness.appendChild(msg);
    const act = document.createElement("div");
    act.style.display = "flex";
    act.style.gap = "8px";
    (Array.isArray(actions) ? actions : []).forEach((a) => {
      if (!a || typeof a !== "object") return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = a.primary ? "btn btn-mini btn-primary" : "btn btn-mini";
      b.textContent = String(a.label || "Action");
      b.addEventListener("click", () => { try { a.onClick && a.onClick(); } catch {} });
      act.appendChild(b);
    });
    readiness.appendChild(act);
  };
  const hideReadiness = () => {
    if (!readiness) return;
    readiness.classList.remove("is-visible");
    readiness.innerHTML = "";
  };

  if (!filePath || !config) {
    runBtn.disabled = true;
    hideReadiness();
    return;
  }

  // While running, Run is disabled. Pause/Stop are handled separately.
  if (isRunning) {
    runBtn.disabled = true;
    hideReadiness();
    return;
  }

  // Runner master switch.
  if (config.run_enabled === false) {
    runBtn.disabled = true;
    showReadiness({
      text: "Run enabled is off. Turn it on in General before running.",
      actions: [
        { label: "Go to General", onClick: () => goToSettingPath("run_enabled"), primary: true }
      ]
    });
    return;
  }

  const validated = Boolean(lastValidatedAt);
  const ok = Boolean(lastValidation && lastValidation.ok);

  if (!validated) {
    runBtn.disabled = true;
    showReadiness({
      text: "Not validated. Validate and fix any issues before running.",
      actions: [
        { label: "Validate", onClick: () => validateNow({ quiet: false }).catch(() => {}), primary: true },
        { label: "Go to Validation", onClick: () => setView("validation") }
      ]
    });
    return;
  }

  if (!ok) {
    runBtn.disabled = true;
    showReadiness({
      text: "Validation errors. Fix them in the Validation tab.",
      actions: [
        { label: "Go to Validation", onClick: () => setView("validation"), primary: true }
      ]
    });
    return;
  }

  if (isDirty) {
    runBtn.disabled = true;
    showReadiness({
      text: "Valid but unsaved. Save before running.",
      actions: [
        { label: "Save", onClick: () => saveNow({ quiet: false }).catch(() => {}), primary: true }
      ]
    });
    return;
  }

  runBtn.disabled = false;
  hideReadiness();
}



function setRunning(next) {
  isRunning = Boolean(next);
  if (!isRunning) isPaused = false;
  updateAutomationIndicators();
}

function setPaused(next) {
  isPaused = Boolean(next) && isRunning;
  updateAutomationIndicators();
}

function updateAutomationIndicators() {
  // Sidebar pill.
  const pill = $("runningPill");
  if (pill) {
    if (isRunning && isPaused) {
      pill.className = "pill pill-warn";
      pill.textContent = "Paused";
    } else if (isRunning) {
      pill.className = "pill pill-ok";
      pill.textContent = "Running";
    } else {
      pill.className = "pill pill-muted";
      pill.textContent = "Idle";
    }
  }

  // Buttons.
  const runBtn = $("runBtn");
  if (runBtn) {
    // Run is start-only. While running, keep it disabled.
    runBtn.className = "btn btn-primary";
    const t = runBtn.querySelector(".btn-text");
    if (t) t.textContent = "Run";
    if (isRunning) runBtn.disabled = true;
  }

  const pauseBtn = $("pauseBtn");
  if (pauseBtn) {
    pauseBtn.disabled = !filePath || !isRunning;

    const t = pauseBtn.querySelector(".btn-text");
    const icon = pauseBtn.querySelector(".icon");

    if (isPaused) {
      if (t) t.textContent = "Resume";
      if (icon) icon.innerHTML = ICON_PLAY_SVG;
      pauseBtn.className = "btn btn-secondary";
    } else {
      if (t) t.textContent = "Pause";
      if (icon) icon.innerHTML = ICON_PAUSE_SVG;
      pauseBtn.className = "btn btn-secondary";
    }
  }

  const stopBtn = $("stopBtn");
  if (stopBtn) stopBtn.disabled = !filePath || !isRunning;

  // Automation status pill.
  if (isRunning && isPaused) {
    setRunStatus("warn", "Paused");
  } else if (isRunning) {
    setRunStatus("ok", "Running");
  }

  updateRunGating();
}

function setBanner(kind, text) {
  const banner = $("banner");
  if (!banner) return;

  banner.className = "banner " + (kind ? `banner-${kind}` : "banner-muted");
  banner.textContent = String(text || "");
}

function prefersReducedMotion() {
  try {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// Toasts are used for low-friction actions like Undo. They are UI-only.
let __toastTimer = null;
let __toastDismissTimer = null;
function dismissToast({ immediate = false } = {}) {
  const host = $("toastHost");
  if (!host) return;

  const toast = host.querySelector(".toast");
  if (!toast) {
    host.innerHTML = "";
    return;
  }

  if (immediate) {
    if (__toastDismissTimer) {
      clearTimeout(__toastDismissTimer);
      __toastDismissTimer = null;
    }
    host.innerHTML = "";
    return;
  }

  if (prefersReducedMotion()) {
    dismissToast({ immediate: true });
    return;
  }

  if (toast.classList.contains("is-leaving")) return;
  toast.classList.add("is-leaving");

  const finish = () => {
    if (__toastDismissTimer) {
      clearTimeout(__toastDismissTimer);
      __toastDismissTimer = null;
    }
    if (toast.parentElement) toast.parentElement.innerHTML = "";
  };

  toast.addEventListener("animationend", finish, { once: true });
  if (__toastDismissTimer) clearTimeout(__toastDismissTimer);
  __toastDismissTimer = setTimeout(finish, 200);
}

function showToast({ text, actionText, onAction, timeoutMs = 6000 } = {}) {
  const host = $("toastHost");
  if (!host) return;

  // Clear existing toasts to avoid stacking Undo flows.
  dismissToast({ immediate: true });
  if (__toastTimer) {
    clearTimeout(__toastTimer);
    __toastTimer = null;
  }

  const toast = document.createElement("div");
  toast.className = "toast";

  const msg = document.createElement("div");
  msg.className = "toast-text";
  msg.textContent = String(text || "");

  toast.appendChild(msg);

  const actions = document.createElement("div");
  actions.className = "toast-actions";

  if (actionText && typeof onAction === "function") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-mini";
    btn.textContent = String(actionText);
    btn.addEventListener("click", () => {
      try { onAction(); } catch {}
      dismissToast();
    });
    actions.appendChild(btn);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-mini";
  close.textContent = "Dismiss";
  close.addEventListener("click", () => { dismissToast(); });
  actions.appendChild(close);

  toast.appendChild(actions);
  host.appendChild(toast);

  __toastTimer = setTimeout(() => {
    dismissToast();
    __toastTimer = null;
  }, Math.max(1500, Number(timeoutMs) || 6000));
}

function setEnabled(enabled) {
  const on = Boolean(enabled);

  [
    "validateBtn",
    "exportBtn",
    "exportFullBtn",
    "saveBtn",
    "actionsBtn",
    "copyPathBtn",
    "openFolderBtn",
    "copyServerIdBtn",
    "copyChannelIdBtn",
    "logCopyBtn",
    "logClearBtn",
    "accountsToggleAllBtn",
    "addAccountBtn",
    "tasksToggleAllBtn",
    "addTaskBtn",
    "scriptFromTasksBtn",
    "applyScriptBtn",
    "historyRefreshBtn",
    "runBtn",
    "pauseBtn",
    "stopBtn"
  ].forEach((id) => {
    const e = $(id);
    if (e) e.disabled = !on;
  });

  // Run is disabled when the master kill switch is off (only when not already running).
  const runBtn = $("runBtn");
  if (runBtn && on && !isRunning && config && config.run_enabled === false) runBtn.disabled = true;

  // Stop stays enabled only when running.
  const stopBtn = $("stopBtn");
  if (stopBtn) stopBtn.disabled = !on || !isRunning;
  const pauseBtn = $("pauseBtn");
  if (pauseBtn) pauseBtn.disabled = !on || !isRunning;
}

function setView(viewName) {
  // If App.js is present, delegate to the animation-aware view switcher.
  if (window.App && typeof window.App.animateViewChange === "function") {
    window.App.animateViewChange(viewName);
    return;
  }

  document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
  const view = document.getElementById(`view-${viewName}`);
  if (view) view.classList.add("is-active");

  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("is-active"));
  document.querySelectorAll(`.nav-item[data-view="${viewName}"]`).forEach((b) => b.classList.add("is-active"));
}

function normalizeConfig() {
  if (!config || typeof config !== "object") return;

  if (!Array.isArray(config.accounts)) config.accounts = [];
  if (!Array.isArray(config.tasks)) config.tasks = [];

  // Ensure account defaults exist and types are stable.
  config.accounts = config.accounts.map((a) => {
    const acc = typeof a === "object" && a ? a : {};
    acc.priority = clampInt(acc.priority, PRIORITY_MIN, PRIORITY_MAX, PRIORITY_DEFAULT);

    acc.enabled = acc.enabled === undefined ? true : Boolean(acc.enabled);

    acc.cooldown_after_use_ms = Number(acc.cooldown_after_use_ms ?? 0);
    if (!Number.isFinite(acc.cooldown_after_use_ms) || acc.cooldown_after_use_ms < 0) acc.cooldown_after_use_ms = 0;

    acc.max_tasks_per_session = Number(acc.max_tasks_per_session ?? 0);
    if (!Number.isFinite(acc.max_tasks_per_session) || acc.max_tasks_per_session < 0) acc.max_tasks_per_session = 0;
    acc.max_tasks_per_session = Math.round(acc.max_tasks_per_session);

    acc.notes = acc.notes === undefined || acc.notes === null ? "" : String(acc.notes);

    return acc;
  });

  // Numbers that should always be numbers.
  config.tasks_interval = Number(config.tasks_interval ?? 1000);
  config.account_switch_interval = Number(config.account_switch_interval ?? 0);
  config.no_login_delay = Boolean(config.no_login_delay);


  // Global automation controls.
  config.run_enabled = config.run_enabled === undefined ? true : Boolean(config.run_enabled);
  config.headless = Boolean(config.headless);

  config.jitter_ms = Number(config.jitter_ms ?? 0);
  if (!Number.isFinite(config.jitter_ms) || config.jitter_ms < 0) config.jitter_ms = 0;

  const ll = String(config.log_level ?? "info").toLowerCase();
  config.log_level = ["error", "warn", "info", "debug"].includes(ll) ? ll : "info";

  config.screenshot_on_error = Boolean(config.screenshot_on_error);

  config.element_wait_timeout_ms = Number(config.element_wait_timeout_ms ?? 30000);
  if (!Number.isFinite(config.element_wait_timeout_ms) || config.element_wait_timeout_ms < 100) {
    config.element_wait_timeout_ms = 30000;
  }

  config.human_typing_enabled = config.human_typing_enabled === undefined ? true : Boolean(config.human_typing_enabled);

  config.typing_delay_ms_min = Number(config.typing_delay_ms_min ?? 70);
  if (!Number.isFinite(config.typing_delay_ms_min) || config.typing_delay_ms_min < 0) config.typing_delay_ms_min = 70;

  config.typing_delay_ms_max = Number(config.typing_delay_ms_max ?? 160);
  if (!Number.isFinite(config.typing_delay_ms_max) || config.typing_delay_ms_max < 0) config.typing_delay_ms_max = 160;

  if (config.typing_delay_ms_min > config.typing_delay_ms_max) {
    const tmp = config.typing_delay_ms_min;
    config.typing_delay_ms_min = config.typing_delay_ms_max;
    config.typing_delay_ms_max = tmp;
  }


  // Keep ids as strings unless user explicitly uses numbers.
  if (config.server_id === undefined || config.server_id === null) config.server_id = "";
  if (config.channel_id === undefined || config.channel_id === null) config.channel_id = "";

  // Optional advanced tasking script (UI only).
  if (config.advanced_tasking_script === undefined || config.advanced_tasking_script === null) {
    config.advanced_tasking_script = "";
  } else {
    config.advanced_tasking_script = String(config.advanced_tasking_script);
  }

  // Ensure task types are valid.
  config.tasks = config.tasks.map((t) => {
    const task = typeof t === "object" && t ? t : {};
    if (!TASK_TYPES.includes(task.type)) task.type = "SEND_MESSAGE";
    if (!task.id) task.id = `task_${Date.now()}`;
    task.enabled = task.enabled === undefined ? true : Boolean(task.enabled);
    task.priority = clampInt(task.priority, PRIORITY_MIN, PRIORITY_MAX, PRIORITY_DEFAULT);

    // Optional multi-account targeting (runner filters sessions by these values).
    if (!Array.isArray(task.accounts)) task.accounts = [];
    task.accounts = task.accounts
      .map((v) => String(v ?? "").trim())
      .filter(Boolean);

    // UPLOAD_FILE now supports multiple files.
    if (task.type === "UPLOAD_FILE") {
      if (!Array.isArray(task.files)) task.files = [];
      task.files = task.files
        .map((v) => String(v ?? "").trim())
        .filter(Boolean);

      if (!task.files.length && String(task.file || "").trim()) {
        task.files = [String(task.file).trim()];
      }
    }
    return task;
  });

  // Multi sessions (global selection). Used by the runner.
  config.multi_sessions_enabled = Boolean(config.multi_sessions_enabled ?? false);
  if (!Array.isArray(config.multi_sessions_accounts)) config.multi_sessions_accounts = [];
  config.multi_sessions_accounts = uniq(config.multi_sessions_accounts
    .map((v) => String(v ?? "").trim())
    .filter(Boolean));

  // Optional: cap how many sessions execute a task concurrently.
  // 0 means unlimited.
  config.multi_sessions_max_parallel = clampInt(config.multi_sessions_max_parallel, 0, 100, 0);
}

function parseIssueString(raw, severity) {
  const s = String(raw ?? "");
  const parts = s.split(" Fix: ");
  const head = parts[0] || "";
  const fix = parts.length > 1 ? parts.slice(1).join(" Fix: ").trim() : "";

  let path = "";
  let msg = head;

  const pm = head.match(/\bPath:\s*([A-Za-z0-9_\[\]\.]+)\.?/);
  if (pm) {
    path = String(pm[1] || "").trim();
    msg = head.replace(pm[0], "").trim();
  }

  msg = msg.replace(/\s+/g, " ").trim();
  if (!msg) msg = s.trim();

  return { severity, path, message: msg, fix };
}

function buildIssueIndex(errors, warnings) {
  issueIndex = { errors: new Map(), warnings: new Map() };

  (Array.isArray(errors) ? errors : []).forEach((e) => {
    const it = parseIssueString(e, "error");
    if (it.path) issueIndex.errors.set(it.path, it);
  });

  (Array.isArray(warnings) ? warnings : []).forEach((w) => {
    const it = parseIssueString(w, "warn");
    if (it.path && !issueIndex.errors.has(it.path)) issueIndex.warnings.set(it.path, it);
  });
}

function renderIssues(errors, warnings) {
  const listEl = $("issuesList");
  const emptyEl = $("issuesEmpty");
  const metaEl = $("issuesMeta");

  if (!listEl || !emptyEl) return;

  listEl.innerHTML = "";
  const es = Array.isArray(errors) ? errors : [];
  const ws = Array.isArray(warnings) ? warnings : [];

  const total = es.length + ws.length;
  emptyEl.style.display = total ? "none" : "block";

  if (metaEl) {
    const eN = es.length;
    const wN = ws.length;
    metaEl.textContent = total ? `${eN} error${eN === 1 ? "" : "s"}, ${wN} warning${wN === 1 ? "" : "s"}` : "";
  }

  const mkRow = (raw, sev) => {
    const it = parseIssueString(raw, sev);

    const row = document.createElement("div");
    row.className = "issue-item";
    row.setAttribute("role", "listitem");

    const sevPill = document.createElement("span");
    sevPill.className = "pill issue-sev " + (sev === "error" ? "pill-bad" : "pill-warn");
    sevPill.textContent = sev === "error" ? "Error" : "Warning";

    const main = document.createElement("div");
    main.className = "issue-main";

    const path = document.createElement("div");
    path.className = "issue-path";
    path.textContent = it.path || "(unknown path)";

    const msg = document.createElement("div");
    msg.className = "issue-msg";
    msg.textContent = it.message || String(raw || "");

    main.appendChild(path);
    main.appendChild(msg);

    if (it.fix) {
      const fix = document.createElement("div");
      fix.className = "issue-fix";
      fix.textContent = `Fix: ${it.fix}`;
      main.appendChild(fix);
    }

    const actions = document.createElement("div");
    actions.className = "issue-actions";

    const go = document.createElement("button");
    go.className = "btn btn-mini";
    go.type = "button";
    go.textContent = "Go to setting";
    go.disabled = !it.path;
    go.addEventListener("click", () => {
      if (!it.path) return;
      goToSettingPath(it.path);
    });

    actions.appendChild(go);

    row.appendChild(sevPill);
    row.appendChild(main);
    row.appendChild(actions);

    listEl.appendChild(row);
  };

  es.forEach((e) => mkRow(e, "error"));
  ws.forEach((w) => mkRow(w, "warn"));
}

function setValidationUI(res) {
  const ok = Boolean(res && res.ok);
  const errors = Array.isArray(res && res.errors) ? res.errors : [];
  const warnings = Array.isArray(res && res.warnings) ? res.warnings : [];

  lastValidation = { ok, errors, warnings };
  lastValidatedAt = Date.now();

  buildIssueIndex(errors, warnings);
  renderIssues(errors, warnings);

  const meta = $("validationMeta");
  if (meta) {
    const when = new Date(lastValidatedAt).toLocaleString();
    const schema = SCHEMA_VERSION !== null ? `Schema v${SCHEMA_VERSION}` : "Schema";
    meta.textContent = filePath ? `${schema}. Last validated: ${when}.` : "No file loaded.";
  }

  const pill = $("validationPill");
  const text = $("validationText");

  if (!filePath) {
    if (pill) {
      pill.className = "status-pill status-pill-muted";
      pill.textContent = "Not validated";
    }
    if (text) text.textContent = "Load a config file to validate.";
    updateConfigStatePill();
    updateRunGating();
    return;
  }

  if (ok) {
    if (pill) {
      pill.className = "status-pill status-pill-ok";
      pill.textContent = "Valid";
    }
    if (text) text.textContent = "Configuration is valid.";
  } else {
    if (pill) {
      pill.className = "status-pill status-pill-bad";
      pill.textContent = "Invalid";
    }
    if (text) text.textContent = "Configuration has validation issues.";
  }

  updateConfigStatePill();
  updateRunGating();
  refreshView(getActiveViewName()).catch(() => {});
}

function setRunStatus(kind, headline) {
  const pill = $("runStatus");
  const text = $("runStatusText");

  if (!pill || !text) return;

  pill.className = "status-pill " + (kind ? `status-pill-${kind}` : "status-pill-muted");
  pill.textContent = headline || "Status";

  text.textContent = kind === "ok"
    ? "Automation is running. Watch logs below."
    : kind === "warn"
      ? "Automation is paused. Click Resume to continue, or Stop to end."
    : kind === "bad"
      ? "Automation failed. See logs and validation output."
      : "Start the automation to view logs here.";
}

function clearLog() {
  logEntries = [];
  renderLog();
}

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function parseLogPayload(payload) {
  const p = (payload && typeof payload === "object") ? payload : { line: payload };
  const raw = String(p.line ?? "");
  const stream = String(p.stream || "").toLowerCase();

  const m = raw.match(/^\[(ERROR|WARN|INFO|DEBUG)\]\s*/i);
  if (m) {
    const level = String(m[1]).toLowerCase();
    return { ts: Date.now(), level, text: raw.replace(m[0], "") };
  }

  // If it came from stderr and there is no explicit prefix, treat it as error.
  if (stream === "stderr") return { ts: Date.now(), level: "error", text: raw };

  return { ts: Date.now(), level: "info", text: raw };
}

function logMeetsThreshold(level) {
  const thr = LOG_LEVELS[String(logViewerLevel || "info").toLowerCase()] ?? LOG_LEVELS.info;
  const sev = LOG_LEVELS[String(level || "info").toLowerCase()] ?? LOG_LEVELS.info;
  return sev <= thr;
}

let __logRenderRaf = null;
function scheduleRenderLog() {
  if (__logRenderRaf) return;
  __logRenderRaf = window.requestAnimationFrame(() => {
    __logRenderRaf = null;
    renderLog();
  });
}

function appendLog(payload) {
  const entry = parseLogPayload(payload);
  if (!entry.text || !entry.text.trim()) return;

  // Keep bounded buffer.
  const maxLines = 1200;
  logEntries = Array.isArray(logEntries) ? logEntries : [];
  logEntries.push(entry);
  if (logEntries.length > maxLines) logEntries.splice(0, logEntries.length - maxLines);

  scheduleRenderLog();
}

function renderLog() {
  const log = $("runLog");
  if (!log) return;

  const q = String(logSearch || "").toLowerCase();

  const filtered = (Array.isArray(logEntries) ? logEntries : []).filter((e) => {
    if (!logMeetsThreshold(e.level)) return false;
    if (q && !String(e.text || "").toLowerCase().includes(q)) return false;
    return true;
  });

  log.innerHTML = "";

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "(no output)";
    log.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const e of filtered) {
    const row = document.createElement("div");
    row.className = `log-line level-${String(e.level || "info")}`;

    const ts = document.createElement("div");
    ts.className = "log-ts";
    const dt = new Date(Number(e.ts) || Date.now());
    ts.textContent = dt.toLocaleTimeString();

    const lvl = document.createElement("div");
    lvl.className = "log-lvl";
    lvl.textContent = String(e.level || "info").toUpperCase();

    const msg = document.createElement("div");
    msg.className = "log-msg";
    msg.textContent = String(e.text || "");

    row.appendChild(ts);
    row.appendChild(lvl);
    row.appendChild(msg);
    frag.appendChild(row);
  }

  log.appendChild(frag);
  if (logAutoScroll) log.scrollTop = log.scrollHeight;
}

async function refreshView(viewName) {
  const v = String(viewName || "");
  if (!config) {
    if (v === "history") await refreshHistory().catch(() => {});
    return;
  }

  if (v === "general") renderGeneral();
  if (v === "accounts") renderAccounts();
  if (v === "tasks") renderTasks();
  if (v === "advanced") renderAdvanced();
  if (v === "history") await refreshHistory().catch(() => {});
}

function getActiveViewName() {
  const v = document.querySelector(".view.is-active");
  if (!v || !v.id) return "validation";
  const id = String(v.id);
  if (id.startsWith("view-")) return id.slice(5);
  return "validation";
}

function goToSettingPath(path) {
  const p = String(path || "").trim();
  if (!p) return;

  // General fields are keyed by element id.
  const direct = document.getElementById(p);
  if (direct) {
    setView("general");
    refreshView("general").catch(() => {});
    setTimeout(() => {
      try {
        direct.scrollIntoView({ block: "center", behavior: "smooth" });
        direct.focus();
      } catch {}
    }, 0);
    return;
  }

  // accounts[i].field
  const am = p.match(/^accounts\[(\d+)\]/);
  if (am) {
    const idx = Number(am[1]);
    setView("accounts");
    refreshView("accounts").catch(() => {});
    setTimeout(() => {
      try {
        const acc = Array.isArray(config?.accounts) ? config.accounts[idx] : null;
        const key = accountUiKey(acc, idx);
        uiCollapse.accounts.delete(key);
      } catch {}
      const el = document.querySelector(`#accounts .item[data-idx="${idx}"]`);
      try {
        const body = el ? el.querySelector(".item-body") : null;
        if (el && body) setItemCollapsed(el, false, body, { key: accountUiKey(Array.isArray(config?.accounts) ? config.accounts[idx] : null, idx), store: uiCollapse.accounts });
      } catch {}
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
    return;
  }

  // tasks[i].field
  const tm = p.match(/^tasks\[(\d+)\]/);
  if (tm) {
    const idx = Number(tm[1]);
    setView("tasks");
    refreshView("tasks").catch(() => {});
    setTimeout(() => {
      try {
        const t = Array.isArray(config?.tasks) ? config.tasks[idx] : null;
        const key = taskUiKey(t, idx);
        uiCollapse.tasks.delete(key);
      } catch {}
      const el = document.querySelector(`#tasks .item[data-idx="${idx}"]`);
      try {
        const body = el ? el.querySelector(".item-body") : null;
        if (el && body) setItemCollapsed(el, false, body, { key: taskUiKey(Array.isArray(config?.tasks) ? config.tasks[idx] : null, idx), store: uiCollapse.tasks });
      } catch {}
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
    return;
  }

  // Fallback: go to validation.
  setView("validation");
}


function wireNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = String(btn.dataset.view || "");
      setView(v);

      // Views are not automatically re-rendered on navigation. Refresh explicitly.
      refreshView(v).catch(() => {});
    });
  });
}

function setAdvancedErrors(errors) {
  const ul = $("advancedErrors");
  if (!ul) return;
  ul.innerHTML = "";

  const list = Array.isArray(errors) ? errors : [];
  if (!list.length) {
    const li = document.createElement("li");
    li.textContent = "(none)";
    li.style.color = "var(--muted)";
    ul.appendChild(li);
    return;
  }

  list.forEach((e) => {
    const li = document.createElement("li");
    li.textContent = String(e);
    ul.appendChild(li);
  });
}

function tokenizeLine(line) {
  const core = window.AdvancedTasking;
  if (core && typeof core.tokenizeLine === "function") return core.tokenizeLine(line);
  // Minimal fallback.
  return String(line || "").trim().split(/\s+/).filter(Boolean);
}

function parseAdvancedScript(text) {
  const core = window.AdvancedTasking;
  if (core && typeof core.parseAdvancedScript === "function") {
    return core.parseAdvancedScript(text, {
      taskTypes: TASK_TYPES,
      priority: { min: PRIORITY_MIN, max: PRIORITY_MAX, default: PRIORITY_DEFAULT },
      ensureTaskDefaults
    });
  }
  return { ok: false, tasks: [], errors: ["Advanced tasking core not loaded."] };
}

function quoteIfNeeded(v) {
  const core = window.AdvancedTasking;
  if (core && typeof core.quoteIfNeeded === "function") return core.quoteIfNeeded(v);
  const s = String(v ?? "");
  if (!s) return '""';
  if (/\s|"|'/g.test(s)) return '"' + s.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"") + '"';
  return s;
}

function scriptFromTasksList(tasks) {
  const core = window.AdvancedTasking;
  if (core && typeof core.scriptFromTasksList === "function") {
    return core.scriptFromTasksList(tasks, {
      taskTypes: TASK_TYPES,
      priority: { min: PRIORITY_MIN, max: PRIORITY_MAX, default: PRIORITY_DEFAULT }
    });
  }
  // Fallback to the legacy implementation.
  const list = Array.isArray(tasks) ? tasks : [];
  const lines = [];

  for (const t of list) {
    const type = String(t?.type || "").toUpperCase();
    if (!type) continue;
    const parts = [type];
    if (t?.id) parts.push(`id=${quoteIfNeeded(t.id)}`);
    if (t?.priority !== undefined) parts.push(`priority=${quoteIfNeeded(t.priority)}`);
    if (t?.account) parts.push(`account=${quoteIfNeeded(t.account)}`);
    if (t?.url) parts.push(`url=${quoteIfNeeded(t.url)}`);
    if (t?.message) parts.push(`message=${quoteIfNeeded(t.message)}`);
    if (t?.file) parts.push(`file=${quoteIfNeeded(t.file)}`);
    if (t?.command) parts.push(`command=${quoteIfNeeded(t.command)}`);
    if (t?.index !== undefined && t?.index !== null && t?.index !== "") parts.push(`index=${quoteIfNeeded(t.index)}`);
    if (t?.emoji) parts.push(`emoji=${quoteIfNeeded(t.emoji)}`);
    if (t?.seconds !== undefined && t?.seconds !== null && t?.seconds !== "") parts.push(`seconds=${quoteIfNeeded(t.seconds)}`);
    if (t?.interval_ms !== undefined && t?.interval_ms !== null && t?.interval_ms !== "") parts.push(`interval_ms=${quoteIfNeeded(t.interval_ms)}`);
    if (t?.selector?.css) parts.push(`css=${quoteIfNeeded(t.selector.css)}`);
    if (t?.selector?.id) parts.push(`selector.id=${quoteIfNeeded(t.selector.id)}`);
    lines.push(parts.join(" "));
  }

  return lines.join("\n") + (lines.length ? "\n" : "");
}

function renderAdvanced() {
  const ta = $("advancedScript");
  const meta = $("advancedMeta");
  if (!ta || !meta) return;

  if (!config) {
    meta.textContent = "Load a config file to use this view.";
    ta.value = "";
    setAdvancedErrors([]);
    return;
  }

  if (config.advanced_tasking_script === undefined || config.advanced_tasking_script === null) {
    config.advanced_tasking_script = "";
  }

  const next = String(config.advanced_tasking_script || "");
  if (document.activeElement !== ta && ta.value !== next) ta.value = next;

  const n = Array.isArray(config.tasks) ? config.tasks.length : 0;
  meta.textContent = `One task per line. Currently ${n} task${n === 1 ? "" : "s"} in config.`;

  const parsed = parseAdvancedScript(ta.value);
  setAdvancedErrors(parsed.errors);
}

function formatBytes(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let u = 0;
  let v = b;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

async function refreshHistory() {
  const root = $("historyList");
  const meta = $("historyMeta");
  if (!root || !meta) return;

  root.innerHTML = "";

  if (!filePath) {
    meta.textContent = "No file loaded.";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Open a config.json to view history.";
    root.appendChild(empty);
    return;
  }

  const res = await window.api.listHistory(filePath);
  if (!res || !res.ok) {
    meta.textContent = "History unavailable.";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = res?.error || "Failed to load history.";
    root.appendChild(empty);
    return;
  }

  const items = Array.isArray(res.items) ? res.items : [];
  meta.textContent = items.length
    ? `${items.length} snapshot${items.length === 1 ? "" : "s"} stored in ${res.dir || "history"}.`
    : "No snapshots yet. Save to create history entries.";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No snapshots yet.";
    root.appendChild(empty);
    return;
  }

  // Use the callback index for dataset ids and any per-item actions.
  // (Array.prototype.forEach provides the index as the 2nd argument.)
  items.forEach((it, idx) => {
    const item = document.createElement("div");
    item.className = "item";
    item.dataset.idx = String(idx);

    const head = document.createElement("div");
    head.className = "item-head";

    const left = document.createElement("div");
    left.className = "item-left";

    const title = document.createElement("div");
    title.className = "item-title";

    const nameRow = document.createElement("div");
    nameRow.className = "item-title-row";

    const name = document.createElement("div");
    name.className = "item-name";
    name.textContent = String(it.label || it.id || "Snapshot");

    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = formatBytes(it.sizeBytes);

    nameRow.appendChild(name);
    nameRow.appendChild(tag);

    // Note: Validation markers belong on Accounts/Tasks items, not History.

    const sub = document.createElement("div");
    sub.className = "item-sub";
    const dt = it.createdAt ? new Date(it.createdAt) : null;
    sub.textContent = dt && !isNaN(dt.getTime()) ? dt.toLocaleString() : "";

    title.appendChild(nameRow);
    title.appendChild(sub);
    left.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "btn btn-mini";
    restore.textContent = "Revert";
    restore.addEventListener("click", async () => {
      if (!filePath) return;

      const msg = [
        "Revert will overwrite your current config.json.",
        "A safety snapshot will be created before restore.",
        "\n\nContinue?"
      ].join("\n");

      const ok = await uiConfirm({
        title: "Revert config",
        message: msg,
        confirmText: "Revert",
        cancelText: "Cancel",
        danger: true
      });

      if (!ok) return;

      const r = await window.api.restoreHistory(filePath, it.id);
      if (!r || !r.ok) {
        setBanner("bad", r?.error || "Restore failed.");
        return;
      }

      setBanner("ok", "Reverted to selected snapshot.");
      await loadConfigAtPath(filePath, { created: false });
      refreshHistory().catch(() => {});
    });

    actions.appendChild(restore);
    head.appendChild(left);
    head.appendChild(actions);

    item.appendChild(head);
    root.appendChild(item);
  });
}

function prettyFieldLabel(label) {
  const key = String(label ?? "");
  const overrides = {
    "check_handler": "Custom handler",
    "cooldown_after_use_ms": "Cooldown after use (ms)",
    "max_tasks_per_session": "Max tasks per session (legacy)",
    "timeout_ms": "Timeout (ms)",
    "interval_ms": "Interval (ms)",
    "url_contains": "URL contains",
    "full_page": "Full page"
  };

  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];

  // Only fix obvious raw config keys with underscores.
  if (key.includes("_")) {
    return key
      .split("_")
      .filter(Boolean)
      .map((w) => w.length ? (w[0].toUpperCase() + w.slice(1)) : w)
      .join(" ");
  }

  return key;
}

function mkField(label, inputEl, hint) {
  const wrap = document.createElement("label");
  wrap.className = "field";

  const l = document.createElement("div");
  l.className = "field-label";
  l.textContent = prettyFieldLabel(label);

  wrap.appendChild(l);
  wrap.appendChild(inputEl);

  if (hint) {
    const h = document.createElement("div");
    h.className = "field-hint";
    h.textContent = hint;
    wrap.appendChild(h);
  }

  return wrap;
}

function mkInput({ value, placeholder, type = "text", onInput, spellcheck = false }) {
  const inp = document.createElement("input");
  inp.className = "input";
  inp.type = type;
  inp.value = value ?? "";
  inp.placeholder = placeholder || "";
  inp.spellcheck = Boolean(spellcheck);
  inp.autocomplete = "off";

  inp.addEventListener("input", () => onInput(inp.value));
  return inp;
}

function mkNumberInput({ value, placeholder, min, onInput }) {
  const inp = document.createElement("input");
  inp.className = "input";
  inp.inputMode = "numeric";
  inp.value = value ?? "";
  inp.placeholder = placeholder || "";
  if (min !== undefined) inp.min = String(min);

  inp.addEventListener("input", () => {
    const n = Number(inp.value);
    onInput(Number.isFinite(n) ? n : NaN);
  });

  return inp;
}

function mkRangeInput({ value, min = PRIORITY_MIN, max = PRIORITY_MAX, step = 1, onInput }) {
  const wrap = document.createElement("div");
  wrap.className = "range";

  const inp = document.createElement("input");
  inp.type = "range";
  inp.min = String(min);
  inp.max = String(max);
  inp.step = String(step);
  inp.value = String(clampInt(value, min, max, PRIORITY_DEFAULT));

  const out = document.createElement("div");
  out.className = "range-value";
  out.textContent = String(inp.value);

  const emit = () => {
    const v = clampInt(inp.value, min, max, PRIORITY_DEFAULT);
    inp.value = String(v);
    out.textContent = String(v);
    onInput(v);
  };

  inp.addEventListener("input", emit);
  inp.addEventListener("change", emit);

  wrap.appendChild(inp);
  wrap.appendChild(out);
  return wrap;
}

function mkSelect({ value, options, onChange }) {
  // Use a custom dropdown so we can fully style the menu (native <select>
  // dropdown option styling is limited and inconsistent across platforms).
  const opts = (options || []).map((o) => ({ value: o, label: o, disabled: false }));
  return mkSlideSelect({ value, options: opts, onChange });
}

let __openSlideSelect = null;

function closeSlideSelect(sel) {
  if (!sel) return;
  sel.classList.remove("is-open");

  // Prevent menu clipping by allowing the parent .item to overflow while open.
  try {
    const item = sel.closest(".item");
    if (item) item.classList.remove("is-menu-open");
  } catch {
    // ignore
  }
}

function closeAnySlideSelect(except) {
  if (__openSlideSelect && __openSlideSelect !== except) closeSlideSelect(__openSlideSelect);
  if (__openSlideSelect && __openSlideSelect === except && !except.classList.contains("is-open")) {
    __openSlideSelect = null;
  }
}

function mkSlideSelect({ value, options, onChange }) {
  const wrap = document.createElement("div");
  wrap.className = "slide-select";

  const trigger = document.createElement("button");
  trigger.className = "slide-select-trigger";
  trigger.type = "button";

  const label = document.createElement("span");
  label.className = "slide-select-value";

  const caret = document.createElement("span");
  caret.className = "slide-select-caret";
  caret.setAttribute("aria-hidden", "true");  caret.classList.add("icon");
  caret.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"/></svg>';

  trigger.appendChild(label);
  trigger.appendChild(caret);

  const menu = document.createElement("div");
  menu.className = "menu slide-select-menu";
  menu.setAttribute("role", "listbox");

  const opts = Array.isArray(options) ? options : [];
  let current = String(value ?? "");

  const setValue = (next, { emit } = {}) => {
    current = String(next ?? "");

    const currentOpt = opts.find((o) => String(o.value) === current);
    label.textContent = currentOpt ? String(currentOpt.label) : (current || "(select)");

    menu.querySelectorAll(".slide-select-item").forEach((b) => {
      b.classList.toggle("is-selected", String(b.dataset.value) === current);
    });

    // .value is implemented via a getter/setter (defined once below).

    if (emit) {
      // Dispatch a native-like change event so upgraded <select> replacements work with existing listeners.
      try { wrap.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
      try { wrap.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    }

    if (emit && typeof onChange === "function") onChange(current);
  };

// Make the component behave like a native <select> for existing code.
try {
  Object.defineProperty(wrap, "value", {
    get: () => current,
    set: (v) => setValue(String(v ?? ""), { emit: false }),
    configurable: true
  });
} catch {
  // Fallback: plain property.
  wrap.value = current;
}



  const pick = (next) => {
    setValue(next, { emit: true });
    closeSlideSelect(wrap);
    __openSlideSelect = null;
  };

  const buildItem = (o) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item slide-select-item";
    btn.textContent = String(o.label ?? o.value ?? "");
    btn.dataset.value = String(o.value ?? "");
    btn.disabled = Boolean(o.disabled);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (btn.disabled) return;
      pick(btn.dataset.value);
    });
    return btn;
  };

  opts.forEach((o) => menu.appendChild(buildItem(o)));

  const toggleOpen = () => {
    const willOpen = !wrap.classList.contains("is-open");
    closeAnySlideSelect(wrap);

    if (willOpen) {
      wrap.classList.add("is-open");
      __openSlideSelect = wrap;

      // Prevent menu clipping when the select is inside an .item (task/account cards).
      try {
        const item = wrap.closest(".item");
        if (item) item.classList.add("is-menu-open");
      } catch {
        // ignore
      }

      // Focus the selected item (or first enabled) for keyboard users.
      const selected = menu.querySelector('.slide-select-item.is-selected:not(:disabled)');
      const firstEnabled = menu.querySelector('.slide-select-item:not(:disabled)');
      (selected || firstEnabled || trigger).focus({ preventScroll: true });
    } else {
      closeSlideSelect(wrap);
      __openSlideSelect = null;
      trigger.focus({ preventScroll: true });
    }
  };

  trigger.addEventListener("click", (ev) => {
    ev.preventDefault();
    toggleOpen();
  });

  // Basic keyboard navigation.
  const focusMove = (dir) => {
    const items = Array.from(menu.querySelectorAll('.slide-select-item:not(:disabled)'));
    if (!items.length) return;
    const active = document.activeElement;
    let idx = Math.max(0, items.indexOf(active));
    idx = dir > 0 ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
    items[idx].focus({ preventScroll: true });
  };

  wrap.addEventListener("keydown", (ev) => {
    const key = ev.key;

    if (key === "Escape") {
      if (wrap.classList.contains("is-open")) {
        ev.preventDefault();
        closeSlideSelect(wrap);
        __openSlideSelect = null;
        trigger.focus({ preventScroll: true });
      }
      return;
    }

    if (key === "Enter" || key === " ") {
      if (!wrap.classList.contains("is-open")) {
        ev.preventDefault();
        toggleOpen();
        return;
      }

      const active = document.activeElement;
      if (active && active.classList && active.classList.contains("slide-select-item")) {
        ev.preventDefault();
        if (!active.disabled) pick(active.dataset.value);
      }
      return;
    }

    if (key === "ArrowDown") {
      ev.preventDefault();
      if (!wrap.classList.contains("is-open")) toggleOpen();
      else focusMove(1);
      return;
    }

    if (key === "ArrowUp") {
      ev.preventDefault();
      if (!wrap.classList.contains("is-open")) toggleOpen();
      else focusMove(-1);
    }
  });

  // Setup initial value.
  setValue(current, { emit: false });

  wrap.appendChild(trigger);
  wrap.appendChild(menu);

  return wrap;
}


// Upgrade native <select> controls into the styled slide-select dropdowns.
// This keeps IDs stable and dispatches change events so existing code continues to work.
function upgradeNativeSelect(id) {
  const sel = document.getElementById(id);
  if (!sel || String(sel.tagName || "").toUpperCase() !== "SELECT") return null;

  const opts = Array.from(sel.querySelectorAll("option")).map((o) => ({
    value: String(o.value ?? ""),
    label: String(o.textContent ?? o.value ?? ""),
    disabled: Boolean(o.disabled)
  }));

  const mini = sel.classList.contains("input-mini");
  const wrap = mkSlideSelect({ value: String(sel.value ?? ""), options: opts });

  wrap.id = id;
  if (mini) wrap.classList.add("slide-select-mini");

  // Preserve min width where present.
  if (sel.style && sel.style.minWidth) wrap.style.minWidth = sel.style.minWidth;

  sel.replaceWith(wrap);
  return wrap;
}

function upgradeNativeSelects() {
  [
    "log_level",
    "accountsFilter",
    "tasksFilterState",
    "logLevelSelect"
  ].forEach((id) => upgradeNativeSelect(id));
}


function mkCheck({ checked, label, onChange }) {
  const wrap = document.createElement("label");
  wrap.className = "toggle";
  wrap.style.padding = "10px";

  const inp = document.createElement("input");
  inp.type = "checkbox";
  inp.checked = Boolean(checked);

  const ui = document.createElement("span");
  ui.className = "toggle-ui";

  const text = document.createElement("span");
  text.className = "toggle-label";
  text.textContent = label;

  inp.addEventListener("change", () => onChange(Boolean(inp.checked)));

  wrap.appendChild(inp);
  wrap.appendChild(ui);
  wrap.appendChild(text);

  return wrap;
}

function mkAccountChecklist({ accounts, selected, disabled, compact, onChange }) {
  const list = Array.isArray(accounts) ? accounts : [];
  let sel = new Set((Array.isArray(selected) ? selected : []).map((v) => String(v).trim().toLowerCase()).filter(Boolean));

  const wrap = document.createElement("div");
  wrap.className = compact ? "checklist checklist-compact" : "checklist";
  wrap.style.maxHeight = compact ? "120px" : "160px";

  if (!list.length) {
    const empty = document.createElement("div");
    empty.style.color = "var(--muted)";
    empty.style.fontSize = "12px";
    empty.textContent = "(no accounts)";
    wrap.appendChild(empty);
    return wrap;
  }

  const emit = (nextSet) => {
    sel = nextSet;
    const out = [];
    for (const a of list) {
      const email = String(a?.email || "").trim();
      if (!email) continue;
      if (nextSet.has(email.toLowerCase())) out.push(email);
    }
    onChange(out);
  };

  for (const a of list) {
    const email = String(a?.email || "").trim();
    if (!email) continue;

    const row = document.createElement("label");
    row.className = compact ? "check-item check-item-compact" : "check-item";

    const isEnabledAcc = a && a.enabled !== false;
    if (!isEnabledAcc) row.classList.add("is-disabled");

    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = sel.has(email.toLowerCase());
    inp.disabled = Boolean(disabled) || !isEnabledAcc;
    inp.addEventListener("change", () => {
      const next = new Set(sel);
      if (inp.checked) next.add(email.toLowerCase());
      else next.delete(email.toLowerCase());
      emit(next);
    });

    const text = document.createElement("div");
    text.className = "check-item-text";

    const title = document.createElement("div");
    title.className = "check-item-title";
    title.textContent = a?.name ? String(a.name) : email;

    const sub = document.createElement("div");
    sub.className = "check-item-sub";
    sub.textContent = email;

    text.appendChild(title);
    text.appendChild(sub);

    row.appendChild(inp);
    row.appendChild(text);

    wrap.appendChild(row);
  }

  return wrap;
}

function renderGeneral() {
  if (!config) return;

  $("server_id").value = String(config.server_id ?? "");
  $("channel_id").value = String(config.channel_id ?? "");
  $("tasks_interval").value = String(config.tasks_interval ?? "");
  $("account_switch_interval").value = String(config.account_switch_interval ?? "");
  $("no_login_delay").checked = Boolean(config.no_login_delay);

  $("run_enabled").checked = Boolean(config.run_enabled);
  $("headless").checked = Boolean(config.headless);
  $("jitter_ms").value = String(config.jitter_ms ?? "");

  $("human_typing_enabled").checked = Boolean(config.human_typing_enabled);
  $("typing_delay_ms_min").value = String(config.typing_delay_ms_min ?? "");
  $("typing_delay_ms_max").value = String(config.typing_delay_ms_max ?? "");
  $("log_level").value = String(config.log_level ?? "info");
  $("screenshot_on_error").checked = Boolean(config.screenshot_on_error);
  $("element_wait_timeout_ms").value = String(config.element_wait_timeout_ms ?? "");

  // UI theme selector.
  const themeWrap = $("uiThemeSelect");
  if (themeWrap) {
    themeWrap.innerHTML = "";
    const options = [
      { value: "system", label: "System (Windows default)" },
      { value: "dark", label: "Dark" },
      { value: "amoled", label: "AMOLED dark" },
      { value: "light", label: "White (Light)" }
    ];
    themeWrap.appendChild(mkSlideSelect({
      value: String(config.ui_theme ?? "system"),
      options,
      onChange: (v) => {
        config.ui_theme = String(v || "system");
        applyThemeMode(config.ui_theme);
        setDirty(true);
      }
    }));
  }

}


function renderAccounts() {
  // Multi sessions UI (one Firefox session per selected account).
  const msEnabled = $("multi_sessions_enabled");
  const msMaxParallel = $("multi_sessions_max_parallel");
  const msUnlimited = $("multi_sessions_max_parallel_unlimited");
  const msSelectAll = $("multi_sessions_select_all");
  const msClear = $("multi_sessions_clear");
  const msList = $("multi_sessions_accounts");

  const multiOn = Boolean(config && config.multi_sessions_enabled);

  if (config && msEnabled) {
    msEnabled.checked = multiOn;
    msEnabled.onchange = () => {
      config.multi_sessions_enabled = Boolean(msEnabled.checked);
      renderAccounts();
      // Tasks UI changes when Multi sessions toggles (targeting UI, disabled task types).
      renderTasks();
      setDirty(true);
    };
  }

  if (config && msUnlimited) {
    msUnlimited.checked = Number(config.multi_sessions_max_parallel ?? 0) === 0;
    msUnlimited.disabled = !multiOn;
    msUnlimited.onchange = () => {
      const unlimited = Boolean(msUnlimited.checked);
      if (unlimited) {
        config.multi_sessions_max_parallel = 0;
      } else if (Number(config.multi_sessions_max_parallel ?? 0) === 0) {
        config.multi_sessions_max_parallel = 2;
      }
      renderAccounts();
      setDirty(true);
    };
  }

  if (config && msMaxParallel) {
    const unlimited = Boolean(msUnlimited && msUnlimited.checked);
    msMaxParallel.value = String(config.multi_sessions_max_parallel ?? 0);
    msMaxParallel.disabled = !multiOn || unlimited;
    msMaxParallel.oninput = () => {
      config.multi_sessions_max_parallel = clampInt(msMaxParallel.value, 0, 100, 0);
      setDirty(true);
    };
  }

  if (config && msSelectAll) {
    msSelectAll.onclick = () => {
      const emails = (Array.isArray(config.accounts) ? config.accounts : [])
        .filter((a) => a && a.enabled !== false && String(a.email || "").trim())
        .map((a) => String(a.email || "").trim());
      config.multi_sessions_accounts = emails;
      setDirty(true);
      renderAccounts();
      renderTasks();
    };
  }

  if (config && msClear) {
    msClear.onclick = () => {
      config.multi_sessions_accounts = [];
      setDirty(true);
      renderAccounts();
      renderTasks();
    };
  }

  if (config && msList) {
    msList.innerHTML = "";

    const accs = Array.isArray(config.accounts) ? config.accounts : [];
    if (!accs.length) {
      const empty = document.createElement("div");
      empty.style.color = "var(--muted)";
      empty.style.fontSize = "12px";
      empty.textContent = "Add accounts to enable multi sessions.";
      msList.appendChild(empty);
    } else {
      let selected = new Set((Array.isArray(config.multi_sessions_accounts) ? config.multi_sessions_accounts : [])
        .map((v) => String(v ?? "").trim().toLowerCase())
        .filter(Boolean));

      const writeSelectionFromSet = (nextSet) => {
        // Keep a stable order based on the accounts array.
        const out = [];
        for (const a of accs) {
          const email = String(a?.email || "").trim();
          if (!email) continue;
          if (nextSet.has(email.toLowerCase())) out.push(email);
        }
        config.multi_sessions_accounts = out;
      };

      for (const a of accs) {
        const email = String(a?.email || "").trim();
        if (!email) continue;

        const row = document.createElement("label");
        row.className = "check-item";

        const enabledAcc = a && a.enabled !== false;
        if (!enabledAcc) row.classList.add("is-disabled");

        const inp = document.createElement("input");
        inp.type = "checkbox";
        inp.checked = selected.has(email.toLowerCase());
        inp.disabled = !enabledAcc;
        inp.addEventListener("change", () => {
          const next = new Set(selected);
          if (inp.checked) next.add(email.toLowerCase());
          else next.delete(email.toLowerCase());
          writeSelectionFromSet(next);
          selected = next;
          setDirty(true);
          // Task targeting depends on this list.
          renderTasks();
        });

        const text = document.createElement("div");
        text.className = "check-item-text";

        const title = document.createElement("div");
        title.className = "check-item-title";
        title.textContent = a?.name ? String(a.name) : email;

        const sub = document.createElement("div");
        sub.className = "check-item-sub";
        sub.textContent = email;

        text.appendChild(title);
        text.appendChild(sub);

        row.appendChild(inp);
        row.appendChild(text);

        msList.appendChild(row);
      }
    }
  }

  const accSearch = $("accountsSearch");
  const accFilter = $("accountsFilter");
  if (accSearch) {
    accSearch.value = uiFilters.accountsSearch;
    accSearch.oninput = () => {
      uiFilters.accountsSearch = String(accSearch.value || "").trim();
      renderAccounts();
    };
  }
  if (accFilter) {
    accFilter.value = uiFilters.accountsFilter;
    accFilter.onchange = () => {
      uiFilters.accountsFilter = String(accFilter.value || "all");
      renderAccounts();
    };
  }

  const root = $("accounts");
  root.innerHTML = "";

  // Wire root-level drop once. Use property setters to avoid duplicate listeners.
  root.ondragover = (ev) => {
    if (!dragCtx || dragCtx.kind !== "accounts") return;
    ev.preventDefault();
  };
  root.ondrop = (ev) => {
    if (!dragCtx || dragCtx.kind !== "accounts") return;
    // If the drop target is an item, let that handler run.
    if (ev.target && ev.target.closest && ev.target.closest(".item")) return;
    ev.preventDefault();
    if (!config || !Array.isArray(config.accounts)) return;
    const from = clampInt(dragCtx.from, 0, config.accounts.length - 1, -1);
    if (from < 0) return;
    const to = config.accounts.length - 1;
    config.accounts = moveItem(config.accounts, from, to);
    setDirty(true);
    renderAccounts();
  };

  if (!config || !Array.isArray(config.accounts) || !config.accounts.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No accounts. Add one.";
    root.appendChild(empty);
    return;
  }

  const accQ = String(uiFilters.accountsSearch || "").toLowerCase();
  const accF = String(uiFilters.accountsFilter || "all");
  const accFiltering = Boolean(accQ) || accF !== "all";

  config.accounts.forEach((acc, idx) => {
    const accName = String(acc?.name || "").toLowerCase();
    const accEmail = String(acc?.email || "").toLowerCase();
    const accEnabled = acc?.enabled !== false;

    if (accF === "enabled" && !accEnabled) return;
    if (accF === "disabled" && accEnabled) return;
    if (accQ && !(accName.includes(accQ) || accEmail.includes(accQ))) return;

    const item = document.createElement("div");
    item.className = "item";
    item.dataset.idx = String(idx);

    let uiKey = accountUiKey(acc, idx);
    if (uiCollapse.accounts.has(uiKey)) item.classList.add("is-collapsed");

    const priority = clampInt(acc.priority, PRIORITY_MIN, PRIORITY_MAX, PRIORITY_DEFAULT);

    const enabled = acc.enabled !== false;
    if (!enabled) item.classList.add("is-disabled");

    const head = document.createElement("div");
    head.className = "item-head";

    const left = document.createElement("div");
    left.className = "item-left";

    const handle = document.createElement("div");
    handle.className = "drag-handle";
    handle.textContent = "⋮⋮";
    handle.title = "Drag to reorder";
    handle.setAttribute("draggable", accFiltering ? "false" : "true");
    if (accFiltering) {
      handle.title = "Reordering is disabled while filtering";
    }
    handle.addEventListener("dragstart", (ev) => {
      dragCtx = { kind: "accounts", from: idx };
      item.classList.add("is-dragging");
      clearDropMarkers(root);
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", String(idx));
      ev.stopPropagation();
    });
    handle.addEventListener("dragend", () => {
      dragCtx = { kind: null, from: null };
      item.classList.remove("is-dragging");
      clearDropMarkers(root);
    });

    const title = document.createElement("div");
    title.className = "item-title";

    const nameRow = document.createElement("div");
    nameRow.className = "item-title-row";

    const name = document.createElement("div");
    name.className = "item-name";
    name.textContent = acc.name ? String(acc.name) : ("Account " + String(idx + 1));

    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = `P${priority}`;

    nameRow.appendChild(name);
    nameRow.appendChild(tag);

    if (!enabled) {
      const off = document.createElement("div");
      off.className = "tag";
      off.textContent = "Disabled";
      nameRow.appendChild(off);
    }

    // Validation markers near the source.
    const accCounts = countIssuesForPrefix(`accounts[${idx}]`);
    if (accCounts.errors) {
      const eTag = document.createElement("div");
      eTag.className = "tag tag-bad";
      eTag.textContent = `Errors: ${accCounts.errors}`;
      nameRow.appendChild(eTag);
    } else if (accCounts.warnings) {
      const wTag = document.createElement("div");
      wTag.className = "tag tag-warn";
      wTag.textContent = `Warnings: ${accCounts.warnings}`;
      nameRow.appendChild(wTag);
    }

    const sub = document.createElement("div");
    sub.className = "item-sub";
    sub.textContent = String(acc.email || "");

    title.appendChild(nameRow);
    title.appendChild(sub);

    left.appendChild(handle);
    left.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const del = document.createElement("button");
    del.className = "btn btn-mini btn-danger";
    del.type = "button";
    del.textContent = "Remove";
    del.addEventListener("click", () => {
      const removed = config.accounts.splice(idx, 1)[0];
      const removedKey = accountUiKey(removed, idx);
      uiCollapse.accounts.delete(removedKey);
      setDirty(true);
      renderAccounts();
      showToast({
        text: `Removed account: ${String(removed?.name || removed?.email || "Account")}`,
        actionText: "Undo",
        onAction: () => {
          if (!config) return;
          config.accounts.splice(Math.min(idx, config.accounts.length), 0, removed);
          setDirty(true);
          renderAccounts();
        }
      });
    });

    actions.appendChild(del);
    head.appendChild(left);
    head.appendChild(actions);

    item.addEventListener("dragover", (ev) => {
      if (!dragCtx || dragCtx.kind !== "accounts") return;
      ev.preventDefault();
      clearDropMarkers(root);
      const rect = item.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      item.classList.add(before ? "is-drop-before" : "is-drop-after");
    });

    item.addEventListener("dragleave", () => {
      item.classList.remove("is-drop-before", "is-drop-after");
    });

    item.addEventListener("drop", (ev) => {
      if (!dragCtx || dragCtx.kind !== "accounts") return;
      ev.preventDefault();
      const from = clampInt(ev.dataTransfer.getData("text/plain"), 0, config.accounts.length - 1, -1);
      if (from < 0) return;

      const rect = item.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      let to = before ? idx : idx + 1;
      if (from < to) to -= 1;

      const next = moveItem(config.accounts, from, to);
      config.accounts = next;
      setDirty(true);
      renderAccounts();
    });

    const body = document.createElement("div");
    body.className = "item-body";

    const nameInput = mkInput({
      value: acc.name || "",
      placeholder: "Main",
      onInput: (v) => {
        config.accounts[idx].name = v;
        name.textContent = v ? String(v) : ("Account " + String(idx + 1));
        setDirty(true);
      }
    });

    const email = mkInput({
      value: acc.email || "",
      placeholder: "email@example.com",
      type: "email",
      onInput: (v) => {
        const prevKey = uiKey;
        config.accounts[idx].email = v;
        sub.textContent = String(v || "");
        uiKey = accountUiKey(config.accounts[idx], idx);
        if (prevKey !== uiKey && uiCollapse.accounts.has(prevKey)) {
          uiCollapse.accounts.delete(prevKey);
          uiCollapse.accounts.add(uiKey);
        }
        setDirty(true);
      }
    });

    const pass = mkInput({
      value: acc.password || "",
      placeholder: "password",
      type: "password",
      onInput: (v) => {
        config.accounts[idx].password = v;
        setDirty(true);
      }
    });

    // Reveal toggle (button). Keeps Electron simple.
    const reveal = document.createElement("button");
    reveal.className = "btn btn-mini";
    reveal.type = "button";
    reveal.textContent = "Show";
    reveal.addEventListener("click", () => {
      pass.type = pass.type === "password" ? "text" : "password";
      reveal.textContent = pass.type === "password" ? "Show" : "Hide";
    });

    const passWrap = document.createElement("div");
    passWrap.className = "field";
    const passLabel = document.createElement("div");
    passLabel.className = "field-label";
    passLabel.textContent = "password";
    passWrap.appendChild(passLabel);

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.alignItems = "center";
    row.appendChild(pass);
    row.appendChild(reveal);

    passWrap.appendChild(row);

    body.appendChild(mkField("name", nameInput, "Optional. For the UI only."));
    body.appendChild(mkField("email", email, "Used to log in."));
    body.appendChild(passWrap);


    // Per-account controls.
    const enabledField = document.createElement("div");
    enabledField.className = "field";

    const enabledLabel = document.createElement("div");
    enabledLabel.className = "field-label";
    enabledLabel.textContent = "Enabled";

    const enabledToggle = mkCheck({
      checked: Boolean(enabled),
      label: "Enabled",
      onChange: (v) => {
        config.accounts[idx].enabled = v;
        setDirty(true);
        renderAccounts();
      }
    });

    const enabledHint = document.createElement("div");
    enabledHint.className = "field-hint";
    enabledHint.textContent = "Disable an account without deleting it.";

    enabledField.appendChild(enabledLabel);
    enabledField.appendChild(enabledToggle);
    enabledField.appendChild(enabledHint);

    const cooldown = mkNumberInput({
      value: acc.cooldown_after_use_ms ?? 0,
      placeholder: "0",
      min: 0,
      onInput: (n) => {
        config.accounts[idx].cooldown_after_use_ms = Number.isFinite(n) && n >= 0 ? n : 0;
        setDirty(true);
      }
    });

    const maxTasks = mkNumberInput({
      value: acc.max_tasks_per_session ?? 0,
      placeholder: "0",
      min: 0,
      onInput: (n) => {
        const v = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
        config.accounts[idx].max_tasks_per_session = v;
        setDirty(true);
      }
    });

    const notes = document.createElement("textarea");
    notes.className = "input";
    notes.rows = 2;
    notes.placeholder = "(optional)";
    notes.value = acc.notes || "";
    notes.addEventListener("input", () => {
      config.accounts[idx].notes = notes.value;
      setDirty(true);
    });

    body.appendChild(enabledField);
    body.appendChild(mkField("cooldown_after_use_ms", cooldown, "Prevents the same account from being selected too frequently."));
    body.appendChild(mkField("max_tasks_per_session", maxTasks, "Legacy. Reserved for future use. The runner currently ignores this value."));
    body.appendChild(mkField("notes", notes, "Purely UI. Helps operators remember what the account is for."));


    const pri = mkRangeInput({
      value: priority,
      onInput: (v) => {
        config.accounts[idx].priority = v;
        tag.textContent = `P${v}`;
        setDirty(true);
      }
    });
    const priField = mkField("priority", pri, "0 = lowest, 5 = highest.");
    priField.classList.add("field-inline");
    body.appendChild(priField);

    item.appendChild(head);
    item.appendChild(body);
    root.appendChild(item);
  });

  updateToggleAllBtn("tasks");
}

function ensureTaskDefaults(t) {
  const task = t || {};
  if (!TASK_TYPES.includes(task.type)) task.type = "SEND_MESSAGE";
  if (!task.id) task.id = `task_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  task.priority = clampInt(task.priority, PRIORITY_MIN, PRIORITY_MAX, PRIORITY_DEFAULT);
  if (task.enabled === undefined) task.enabled = true;
  if (task.oneshot === undefined) task.oneshot = false;
  if (task.instant === undefined) task.instant = false;
  if (!Array.isArray(task.accounts)) task.accounts = [];
  if (task.type === "UPLOAD_FILE" && !Array.isArray(task.files)) task.files = [];

  // Type-specific defaults to reduce validation friction.
  if (task.type === "FILL" && task.clear === undefined) task.clear = true;
  if (task.type === "PRESS_KEY" && (task.times === undefined || task.times === null || task.times === "")) task.times = 1;
  if (task.type === "WAIT_FOR_SELECTOR" && !task.state) task.state = "visible";
  if (task.type === "SCREENSHOT" && task.full_page === undefined) task.full_page = false;

  return task;
}

function cleanEmptyStrings(obj, keys) {
  const o = obj && typeof obj === "object" ? obj : {};
  (keys || []).forEach((k) => {
    if (!Object.prototype.hasOwnProperty.call(o, k)) return;
    const v = o[k];
    if (v === undefined || v === null) return;
    if (typeof v === "string" && v.trim() === "") delete o[k];
  });
  return o;
}

function pruneTaskForType(task, newType) {
  const t = (task && typeof task === "object") ? clone(task) : {};
  const type = String(newType || t.type || "").trim();

  // Keep a stable core across all types.
  const keep = {
    id: t.id,
    type,
    enabled: t.enabled,
    priority: t.priority,
    oneshot: t.oneshot,
    instant: t.instant,
    check_handler: t.check_handler,
    accounts: t.accounts
  };

  // Helper to keep selector only when needed.
  const hasSelector = t.selector && typeof t.selector === "object";
  const selector = hasSelector ? { ...t.selector } : undefined;
  const selCss = hasSelector ? String(selector.css || "").trim() : "";
  const selId = hasSelector ? String(selector.id || "").trim() : "";
  const selectorClean = (selCss || selId) ? { css: selCss || undefined, id: selId || undefined } : undefined;

  // Type-specific allow list.
  if (type === "LOGIN" || type === "LOGOUT" || type === "SWITCH_ACCOUNT") {
    keep.account = t.account;
  }

  if (["UPLOAD_FILE", "SEND_MESSAGE", "SLASH_COMMAND", "SEND_EMOJI", "NAVIGATE"].includes(type)) {
    keep.url = t.url;
  }
  if (type === "WAIT_FOR_NAVIGATION") {
    // Optional.
    keep.url = t.url;
    keep.url_contains = t.url_contains;
    keep.timeout_ms = t.timeout_ms;
  }

  if (type === "UPLOAD_FILE") {
    keep.file = t.file;
    keep.files = t.files;
    if (t.file_input) keep.file_input = t.file_input;
    if (t.submit) keep.submit = t.submit;
  }

  if (type === "SEND_MESSAGE") {
    keep.message = t.message;
    if (selectorClean) keep.selector = selectorClean;
    keep.timeout_ms = t.timeout_ms;
  }

  if (type === "SLASH_COMMAND") {
    keep.command = t.command;
    if (t.index !== undefined && t.index !== null && t.index !== "") keep.index = t.index;
    keep.pre_select_wait_ms = t.pre_select_wait_ms;
    keep.post_select_wait_ms = t.post_select_wait_ms;
  }

  if (type === "SEND_EMOJI") {
    keep.emoji = t.emoji;
  }

  if (type === "CLICK") {
    if (selectorClean) keep.selector = selectorClean;
    keep.timeout_ms = t.timeout_ms;
  }

  if (type === "FILL") {
    if (selectorClean) keep.selector = selectorClean;
    keep.text = t.text;
    keep.clear = t.clear;
    keep.timeout_ms = t.timeout_ms;
  }

  if (type === "PRESS_KEY") {
    keep.key = t.key;
    keep.times = t.times;
  }

  if (type === "WAIT_FOR_SELECTOR") {
    if (selectorClean) keep.selector = selectorClean;
    keep.state = t.state;
    keep.timeout_ms = t.timeout_ms;
  }

  if (type === "WAIT") {
    keep.seconds = t.seconds;
  }

  if (type === "SCREENSHOT") {
    keep.label = t.label;
    keep.path = t.path;
    keep.full_page = t.full_page;
  }

  if (type === "LOOP_AUTOMATION") {
    keep.interval_ms = t.interval_ms;
  }

  // Trim empty strings so stale UI fields do not create validation noise.
  cleanEmptyStrings(keep, [
    "id", "url", "account", "file", "message", "command", "emoji", "text", "key", "url_contains", "label", "path", "check_handler"
  ]);

  return keep;
}


function renderTasks() {
  const root = $("tasks");
  root.innerHTML = "";

  const tSearch = $("tasksSearch");
  const tType = $("tasksFilterType");
  const tAcc = $("tasksFilterAccount");
  const tState = $("tasksFilterState");

  if (tSearch) {
    tSearch.value = uiFilters.tasksSearch;
    tSearch.oninput = () => {
      uiFilters.tasksSearch = String(tSearch.value || "").trim();
      renderTasks();
    };
  }

  
// Populate type filter (themed dropdown).
if (tType) {
  const cur = String(uiFilters.tasksFilterType || "all");
  const opts = [{ value: "all", label: "All types" }];
  (Array.isArray(TASK_TYPES) ? TASK_TYPES : []).forEach((tt) => {
    opts.push({ value: String(tt), label: taskTypeLabel(tt) });
  });

  const next = mkSlideSelect({
    value: cur,
    options: opts,
    onChange: (v) => {
      uiFilters.tasksFilterType = String(v || "all");
      renderTasks();
    }
  });
  next.id = "tasksFilterType";
  next.classList.add("slide-select-mini");
  tType.replaceWith(next);
}


// Populate account filter (themed dropdown).
if (tAcc) {
  const cur = String(uiFilters.tasksFilterAccount || "all");
  const opts = [{ value: "all", label: "All accounts" }];

  (Array.isArray(config?.accounts) ? config.accounts : []).forEach((a) => {
    const email = String(a?.email || "").trim();
    if (!email) return;
    const nm = String(a?.name || "").trim();
    opts.push({ value: email, label: nm ? `${nm} (${email})` : email });
  });

  const next = mkSlideSelect({
    value: cur,
    options: opts,
    onChange: (v) => {
      uiFilters.tasksFilterAccount = String(v || "all");
      renderTasks();
    }
  });
  next.id = "tasksFilterAccount";
  next.classList.add("slide-select-mini");
  tAcc.replaceWith(next);
}

if (tState) {
    tState.value = uiFilters.tasksFilterState;
    tState.onchange = () => {
      uiFilters.tasksFilterState = String(tState.value || "all");
      renderTasks();
    };
  }

  // Wire root-level drop once. Use property setters to avoid duplicate listeners.
  root.ondragover = (ev) => {
    if (!dragCtx || dragCtx.kind !== "tasks") return;
    ev.preventDefault();
  };
  root.ondrop = (ev) => {
    if (!dragCtx || dragCtx.kind !== "tasks") return;
    // If the drop target is an item, let that handler run.
    if (ev.target && ev.target.closest && ev.target.closest(".item")) return;
    ev.preventDefault();
    if (!config || !Array.isArray(config.tasks)) return;
    const from = clampInt(dragCtx.from, 0, config.tasks.length - 1, -1);
    if (from < 0) return;
    const to = config.tasks.length - 1;
    config.tasks = moveItem(config.tasks, from, to);
    setDirty(true);
    renderTasks();
  };

  if (!config || !Array.isArray(config.tasks) || !config.tasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No tasks. Add one.";
    root.appendChild(empty);
    return;
  }

  config.tasks = config.tasks.map(ensureTaskDefaults);

  const usesUrl = (type) => ["UPLOAD_FILE", "SEND_MESSAGE", "SLASH_COMMAND", "SEND_EMOJI", "NAVIGATE"].includes(type);

  const accountChoices = (Array.isArray(config.accounts) ? config.accounts : [])
    .map((a) => {
      const email = String(a?.email || "").trim();
      if (!email) return null;
      const name = String(a?.name || "").trim();
      const label = name ? `${name} (${email})` : email;
      return { value: email, label, disabled: a?.enabled === false };
    })
    .filter(Boolean);

  const multiEnabled = Boolean(config && config.multi_sessions_enabled === true);
  const multiAccounts = multiEnabled ? getSelectedMultiSessionAccountsUi(config) : [];
  const multiEmails = new Set(multiAccounts.map((a) => normalizeEmail(a?.email)).filter(Boolean));

  const mkAccountSelect = ({ value, allowEmpty, emptyLabel, onChange }) => {
    const opts = [];
    if (allowEmpty) {
      opts.push({ value: "", label: emptyLabel || "(none)", disabled: false });
    }
    accountChoices.forEach((o) => opts.push({ value: o.value, label: o.label, disabled: Boolean(o.disabled) }));

    return mkSlideSelect({
      value: value || "",
      options: opts,
      onChange
    });
  };

  const taskQ = String(uiFilters.tasksSearch || "").toLowerCase();
  const typeF = String(uiFilters.tasksFilterType || "all");
  const accF = String(uiFilters.tasksFilterAccount || "all");
  const stateF = String(uiFilters.tasksFilterState || "all");
  const taskFiltering = Boolean(taskQ) || typeF !== "all" || accF !== "all" || stateF !== "all";

  config.tasks.forEach((t, idx) => {
    const tName = String(t?.name || "").toLowerCase();
    const tId = String(t?.id || "").toLowerCase();
    const tTypeVal = String(t?.type || "").toUpperCase();
    const tUrl = String(t?.url || "").toLowerCase();
    const tAccount = String(t?.account || "").trim();

    if (typeF !== "all" && String(typeF).toUpperCase() !== tTypeVal) return;
    if (accF !== "all") {
      const targets = [];
      if (tAccount) targets.push(tAccount);
      if (Array.isArray(t?.accounts) && t.accounts.length) targets.push(...t.accounts);
      if (!targets.map(normalizeEmail).includes(normalizeEmail(accF))) return;
    }

    if (stateF === "enabled" && t?.enabled === false) return;
    if (stateF === "disabled" && t?.enabled !== false) return;
    if (stateF === "issues") {
      const prefix = `tasks[${idx}]`;
      let has = false;
      for (const k of issueIndex.errors.keys()) { if (String(k).startsWith(prefix)) { has = true; break; } }
      if (!has) { for (const k of issueIndex.warnings.keys()) { if (String(k).startsWith(prefix)) { has = true; break; } } }
      if (!has) return;
    }
    if (taskQ && !(tName.includes(taskQ) || tId.includes(taskQ) || tUrl.includes(taskQ) || tTypeVal.toLowerCase().includes(taskQ))) return;

    const item = document.createElement("div");
    item.className = "item";
    item.dataset.idx = String(idx);

    let uiKey = taskUiKey(t, idx);
    if (uiCollapse.tasks.has(uiKey)) item.classList.add("is-collapsed");

    const priority = clampInt(t.priority, PRIORITY_MIN, PRIORITY_MAX, PRIORITY_DEFAULT);

    const head = document.createElement("div");
    head.className = "item-head";

    const left = document.createElement("div");
    left.className = "item-left";

    const handle = document.createElement("div");
    handle.className = "drag-handle";
    handle.textContent = "⋮⋮";
    handle.title = "Drag to reorder";
    handle.setAttribute("draggable", taskFiltering ? "false" : "true");
    if (taskFiltering) {
      handle.title = "Reordering is disabled while filtering";
    }
    handle.addEventListener("dragstart", (ev) => {
      dragCtx = { kind: "tasks", from: idx };
      item.classList.add("is-dragging");
      clearDropMarkers(root);
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", String(idx));
      ev.stopPropagation();
    });
    handle.addEventListener("dragend", () => {
      dragCtx = { kind: null, from: null };
      item.classList.remove("is-dragging");
      clearDropMarkers(root);
    });

    const title = document.createElement("div");
    title.className = "item-title";

    const nameRow = document.createElement("div");
    nameRow.className = "item-title-row";

    const name = document.createElement("div");
    name.className = "item-name";
    const displayName = t.name ? String(t.name) : (t.type ? taskTypeLabel(t.type) : (t.id ? String(t.id) : ("Task " + String(idx + 1))));
    name.textContent = displayName;

    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = `P${priority}`;

    nameRow.appendChild(name);
    nameRow.appendChild(tag);

    if (t?.enabled === false) {
      const off = document.createElement("div");
      off.className = "tag";
      off.textContent = "Disabled";
      nameRow.appendChild(off);
    }

    // Validation markers near the source.
    const taskCounts = countIssuesForPrefix(`tasks[${idx}]`);
    if (taskCounts.errors) {
      const eTag = document.createElement("div");
      eTag.className = "tag tag-bad";
      eTag.textContent = `Errors: ${taskCounts.errors}`;
      nameRow.appendChild(eTag);
    } else if (taskCounts.warnings) {
      const wTag = document.createElement("div");
      wTag.className = "tag tag-warn";
      wTag.textContent = `Warnings: ${taskCounts.warnings}`;
      nameRow.appendChild(wTag);
    }

    const sub = document.createElement("div");
    sub.className = "item-sub";
    const typeLabel = t.type ? taskTypeLabel(t.type) : "";
    const parts = [];
    if (typeLabel) parts.push(typeLabel);
    if (multiEnabled) {
      const targets = Array.isArray(t?.accounts) ? t.accounts.map((x) => String(x || "").trim()).filter(Boolean) : [];
      parts.push(targets.length ? `Targets: ${targets.length}` : "Targets: all sessions");
    } else {
      const a = String(t?.account || "").trim();
      if (a) parts.push(`Account: ${a}`);
    }
    if (t.url) parts.push(String(t.url));
    sub.textContent = parts.join(" • ");

    title.appendChild(nameRow);
    title.appendChild(sub);

    left.appendChild(handle);
    left.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "item-actions";

    // Single expand/collapse toggle with animation.
    let bodyEl = null;
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "btn btn-mini";
    toggleBtn.type = "button";
    toggleBtn.dataset.collapseToggle = "task";

    const syncToggle = () => {
      const collapsed = item.classList.contains("is-collapsed");
      toggleBtn.textContent = collapsed ? "Expand" : "Collapse";
      toggleBtn.setAttribute("aria-expanded", String(!collapsed));
    };

    toggleBtn.addEventListener("click", () => {
      // Refresh key in case the operator edited the task id.
      uiKey = taskUiKey(config.tasks[idx], idx);
      const wantCollapsed = !item.classList.contains("is-collapsed");
      setItemCollapsed(item, wantCollapsed, bodyEl, { key: uiKey, store: uiCollapse.tasks });
      syncToggle();
      updateToggleAllBtn("tasks");
    });

    actions.appendChild(toggleBtn);

    const dup = document.createElement("button");
    dup.className = "btn btn-mini";
    dup.type = "button";
    dup.textContent = "Duplicate";
    dup.addEventListener("click", () => {
      const copy = clone(t);
      copy.id = `${copy.id}_copy`;
      config.tasks.splice(idx + 1, 0, copy);
      setDirty(true);
      renderTasks();
    });

    const del = document.createElement("button");
    del.className = "btn btn-mini btn-danger";
    del.type = "button";
    del.textContent = "Remove";
    del.addEventListener("click", () => {
      const removed = config.tasks.splice(idx, 1)[0];
      const removedKey = taskUiKey(removed, idx);
      uiCollapse.tasks.delete(removedKey);
      setDirty(true);
      renderTasks();
      showToast({
        text: `Removed task: ${String(removed?.name || removed?.id || removed?.type || "Task")}`,
        actionText: "Undo",
        onAction: () => {
          if (!config) return;
          config.tasks.splice(Math.min(idx, config.tasks.length), 0, removed);
          setDirty(true);
          renderTasks();
        }
      });
    });

    actions.appendChild(dup);
    actions.appendChild(del);

    head.appendChild(left);
    head.appendChild(actions);

    item.addEventListener("dragover", (ev) => {
      if (!dragCtx || dragCtx.kind !== "tasks") return;
      ev.preventDefault();
      clearDropMarkers(root);
      const rect = item.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      item.classList.add(before ? "is-drop-before" : "is-drop-after");
    });

    item.addEventListener("dragleave", () => {
      item.classList.remove("is-drop-before", "is-drop-after");
    });

    item.addEventListener("drop", (ev) => {
      if (!dragCtx || dragCtx.kind !== "tasks") return;
      ev.preventDefault();
      const from = clampInt(ev.dataTransfer.getData("text/plain"), 0, config.tasks.length - 1, -1);
      if (from < 0) return;

      const rect = item.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      let to = before ? idx : idx + 1;
      if (from < to) to -= 1;

      const next = moveItem(config.tasks, from, to);
      config.tasks = next;
      setDirty(true);
      renderTasks();
    });

    const body = document.createElement("div");
    body.className = "item-body";
    bodyEl = body;
    syncToggle();

    const idInput = mkInput({
      value: t.id || "",
      placeholder: "task_id",
      onInput: (v) => {
        const prevKey = uiKey;
        const nextId = v.trim();
        config.tasks[idx].id = nextId;
        const cur = config.tasks[idx];
        const nextDisplayName = cur?.name
          ? String(cur.name)
          : (cur?.type ? taskTypeLabel(cur.type) : (cur?.id ? String(cur.id) : ("Task " + String(idx + 1))));
        name.textContent = nextDisplayName;
        uiKey = taskUiKey(config.tasks[idx], idx);
        if (prevKey !== uiKey && uiCollapse.tasks.has(prevKey)) {
          uiCollapse.tasks.delete(prevKey);
          uiCollapse.tasks.add(uiKey);
        }
        setDirty(true);
      }
    });

    const typeSel = mkSlideSelect({
      value: t.type,
      options: TASK_TYPES.map((tt) => ({
        value: tt,
        label: taskTypeLabel(tt),
        disabled: multiEnabled && String(tt) === "SWITCH_ACCOUNT"
      })),
      onChange: (v) => {
        // When switching types, prune irrelevant fields. Prevents stale fields from causing validation errors.
        config.tasks[idx] = ensureTaskDefaults(pruneTaskForType(config.tasks[idx], v));

        // Initialize WAIT defaults to reduce validation friction.
        if (v === "WAIT" && (config.tasks[idx].seconds === undefined || config.tasks[idx].seconds === null || config.tasks[idx].seconds === "")) {
          config.tasks[idx].seconds = 1;
        }
        setDirty(true);
        renderTasks();
      }
    });

    const checkHandler = mkInput({
      value: t.check_handler || "",
      placeholder: "(optional) custom handler id",
      onInput: (v) => {
        config.tasks[idx].check_handler = v;
        setDirty(true);
      }
    });

    // Task enable/disable.
    const enabledField = document.createElement("div");
    enabledField.className = "field";
    const enabledLabel = document.createElement("div");
    enabledLabel.className = "field-label";
    enabledLabel.textContent = "Enabled";
    const enabledToggle = mkCheck({
      checked: t.enabled !== false,
      label: "Enabled",
      onChange: (v) => {
        config.tasks[idx].enabled = Boolean(v);
        setDirty(true);
        renderTasks();
      }
    });
    const enabledHint = document.createElement("div");
    enabledHint.className = "field-hint";
    enabledHint.textContent = "Disable a task without deleting it. Disabled tasks are skipped by the runner.";
    enabledField.appendChild(enabledLabel);
    enabledField.appendChild(enabledToggle);
    enabledField.appendChild(enabledHint);

    body.appendChild(enabledField);
    body.appendChild(mkField("id", idInput, "Must be unique."));
    body.appendChild(mkField("type", typeSel, "Controls which fields are required."));

    if (usesUrl(t.type)) {
      const url = mkInput({
        value: t.url || "",
        placeholder: "https://discord.com/channels/...",
        onInput: (v) => {
          config.tasks[idx].url = v.trim();
          setDirty(true);
        }
      });
      body.appendChild(mkField("url", url, "Target channel URL."));
    }

    body.appendChild(mkField("check_handler", checkHandler, "Optional. Gate execution via a custom handler."));

    // Optional task-level targeting in Multi sessions mode.
    const targetsSupported = multiEnabled
      && multiAccounts.length > 1
      && !["WAIT", "LOOP_AUTOMATION", "SWITCH_ACCOUNT"].includes(String(t.type || "").trim());

    if (targetsSupported) {
      const details = document.createElement("details");
      details.className = "acct-target";

      const summary = document.createElement("summary");
      summary.className = "acct-target-summary";

      const summaryLeft = document.createElement("div");
      summaryLeft.className = "acct-target-title";
      summaryLeft.textContent = "Target accounts";

      const summaryRight = document.createElement("div");
      summaryRight.className = "acct-target-value";

      const setSummary = () => {
        const selected = Array.isArray(config.tasks[idx].accounts) ? config.tasks[idx].accounts : [];
        const active = selected.map((v) => normalizeEmail(v)).filter(Boolean);
        const activeCount = active.filter((e) => multiEmails.has(e)).length;
        const inactiveCount = Math.max(0, active.length - activeCount);

        if (!activeCount) {
          summaryRight.textContent = "All sessions";
          return;
        }
        summaryRight.textContent = inactiveCount
          ? `${activeCount} selected, ${inactiveCount} inactive`
          : `${activeCount} selected`;
      };

      summary.appendChild(summaryLeft);
      summary.appendChild(summaryRight);
      details.appendChild(summary);

      const tools = document.createElement("div");
      tools.className = "mini-row";

      const selectAll = document.createElement("button");
      selectAll.className = "btn btn-mini";
      selectAll.type = "button";
      selectAll.textContent = "Select all";
      selectAll.addEventListener("click", () => {
        config.tasks[idx].accounts = multiAccounts.map((a) => String(a.email || "").trim()).filter(Boolean);
        setDirty(true);
        setSummary();
        renderTasks();
      });

      const clear = document.createElement("button");
      clear.className = "btn btn-mini";
      clear.type = "button";
      clear.textContent = "Clear";
      clear.addEventListener("click", () => {
        config.tasks[idx].accounts = [];
        setDirty(true);
        setSummary();
        renderTasks();
      });

      tools.appendChild(selectAll);
      tools.appendChild(clear);

      const selectedNow = Array.isArray(config.tasks[idx].accounts) ? config.tasks[idx].accounts : [];
      const extra = selectedNow.map((v) => normalizeEmail(v)).filter(Boolean).filter((e) => !multiEmails.has(e));

      const checklist = mkAccountChecklist({
        accounts: multiAccounts,
        selected: selectedNow,
        disabled: false,
        compact: true,
        onChange: (arr) => {
          config.tasks[idx].accounts = Array.isArray(arr) ? arr : [];
          setDirty(true);
          setSummary();
        }
      });

      const hint = document.createElement("div");
      hint.className = "field-hint";
      hint.textContent = extra.length
        ? "Some selected accounts are not active in Multi sessions and will be ignored."
        : "Optional. Leave empty to run on all active sessions.";

      const inner = document.createElement("div");
      inner.className = "acct-target-body";
      inner.appendChild(tools);
      inner.appendChild(checklist);
      inner.appendChild(hint);

      details.appendChild(inner);
      setSummary();

      const field = mkField("accounts", details, "Limits this task to specific sessions.");
      field.classList.add("field-inline");
      body.appendChild(field);
    }

    const pri = mkRangeInput({
      value: priority,
      onInput: (v) => {
        config.tasks[idx].priority = v;
        tag.textContent = `P${v}`;
        setDirty(true);
      }
    });
    const priField = mkField("priority", pri, "0 = lowest, 5 = highest.");
    priField.classList.add("field-inline");
    body.appendChild(priField);

    const oneshot = mkCheck({
      checked: Boolean(t.oneshot),
      label: "Run once",
      onChange: (v) => {
        config.tasks[idx].oneshot = v;
        setDirty(true);
      }
    });

    const usesFastTyping = ["SEND_MESSAGE", "SLASH_COMMAND", "SEND_EMOJI", "FILL"].includes(String(t.type || "").trim());

    const boolWrap = document.createElement("div");
    boolWrap.style.display = "flex";
    boolWrap.style.gap = "10px";
    boolWrap.style.flexWrap = "wrap";
    boolWrap.appendChild(oneshot);

    if (usesFastTyping) {
      const instant = mkCheck({
        checked: Boolean(t.instant),
        label: "Fast typing",
        onChange: (v) => {
          config.tasks[idx].instant = v;
          setDirty(true);
        }
      });
      boolWrap.appendChild(instant);
    }

    body.appendChild(mkField(
      "Options",
      boolWrap,
      usesFastTyping
        ? "Run once skips this task after it succeeds once. Fast typing sends text with no per-character delay."
        : "Run once skips this task after it succeeds once."
    ));

    // Type-specific
    if (t.type === "LOGIN") {
      if (multiEnabled) {
        const info = document.createElement("div");
        info.className = "field field-inline";
        info.textContent = "Multi sessions: LOGIN uses each session's bound account. Use Target accounts to limit sessions.";
        body.appendChild(info);
      } else {
      const acc = mkAccountSelect({
        value: t.account || "",
        allowEmpty: true,
        emptyLabel: "(select account)",
        onChange: (v) => {
          config.tasks[idx].account = v;
          setDirty(true);
        }
      });
      body.appendChild(mkField("account", acc, "Account to log in as. Uses the account email."));
      }
    }

    if (t.type === "LOGOUT") {
      if (multiEnabled) {
        const info = document.createElement("div");
        info.className = "field field-inline";
        info.textContent = "Multi sessions: LOGOUT runs per session. Use Target accounts to pick which sessions to log out.";
        body.appendChild(info);
      } else {
      const acc = mkAccountSelect({
        value: t.account || "",
        allowEmpty: true,
        emptyLabel: "(select account)",
        onChange: (v) => {
          config.tasks[idx].account = v;
          setDirty(true);
        }
      });
      body.appendChild(mkField("account", acc, "Account to log out. The runner clears the Discord session."));
      }
    }

    if (t.type === "SWITCH_ACCOUNT") {
      if (multiEnabled) {
        const warn = document.createElement("div");
        warn.className = "field field-inline";
        warn.textContent = "Multi sessions: SWITCH_ACCOUNT is not used. Each session is already pinned to one account. Remove this task.";
        body.appendChild(warn);
      } else {
      const acc = mkAccountSelect({
        value: t.account || "",
        allowEmpty: true,
        emptyLabel: "Auto pick next eligible",
        onChange: (v) => {
          config.tasks[idx].account = v;
          setDirty(true);
        }
      });
      body.appendChild(mkField("account", acc, "Optional. Pick a specific account, or leave blank to rotate."));

      const info = document.createElement("div");
      info.className = "field field-inline";
      info.innerHTML = 'Switching only happens when this task runs. <span class="kbd">account_switch_interval</span> is ignored by the runner.';
      body.appendChild(info);
      }
    }

    if (t.type === "UPLOAD_FILE") {
      const filesWrap = document.createElement("div");

      const addRow = document.createElement("div");
      addRow.className = "mini-row";
      addRow.style.gap = "8px";

      const addBtn = document.createElement("button");
      addBtn.className = "btn btn-mini";
      addBtn.type = "button";
      addBtn.textContent = "Upload files";
      addBtn.addEventListener("click", async () => {
        if (!window.api || typeof window.api.pickFiles !== "function") return;
        const picked = await window.api.pickFiles();
        const existing = Array.isArray(config.tasks[idx].files) ? config.tasks[idx].files : [];
        const next = uniq(existing.concat(Array.isArray(picked) ? picked : [])
          .map((p) => String(p ?? "").trim())
          .filter(Boolean));
        config.tasks[idx].files = next;
        // Backward compat.
        if (next.length === 1) config.tasks[idx].file = next[0];
        setDirty(true);
        renderTasks();
      });

      const clearBtn = document.createElement("button");
      clearBtn.className = "btn btn-mini";
      clearBtn.type = "button";
      clearBtn.textContent = "Clear";
      clearBtn.addEventListener("click", () => {
        config.tasks[idx].files = [];
        config.tasks[idx].file = "";
        setDirty(true);
        renderTasks();
      });

      addRow.appendChild(addBtn);
      addRow.appendChild(clearBtn);

      const list = document.createElement("div");
      list.className = "file-list";

      const files = Array.isArray(t.files) ? t.files : (String(t.file || "").trim() ? [String(t.file).trim()] : []);
      if (!files.length) {
        const empty = document.createElement("div");
        empty.style.color = "var(--muted)";
        empty.style.fontSize = "12px";
        empty.textContent = "No files selected.";
        list.appendChild(empty);
      } else {
        files.forEach((p) => {
          const chip = document.createElement("div");
          chip.className = "file-chip";

          const name = document.createElement("div");
          name.className = "file-chip-name";
          name.textContent = String(p).split(/[\\/]/).pop() || String(p);

          const pathEl = document.createElement("div");
          pathEl.className = "file-chip-path";
          pathEl.textContent = String(p);

          const rm = document.createElement("button");
          rm.className = "icon-btn icon-btn-sm";
          rm.type = "button";
          rm.textContent = "✕";
          rm.title = "Remove";
          rm.addEventListener("click", () => {
            const cur = Array.isArray(config.tasks[idx].files) ? config.tasks[idx].files : [];
            const next = cur.filter((x) => String(x) !== String(p));
            config.tasks[idx].files = next;
            config.tasks[idx].file = next.length === 1 ? next[0] : "";
            setDirty(true);
            renderTasks();
          });

          const col = document.createElement("div");
          col.style.flex = "1";
          col.style.minWidth = "0";
          col.appendChild(name);
          col.appendChild(pathEl);

          chip.appendChild(col);
          chip.appendChild(rm);

          list.appendChild(chip);
        });
      }

      filesWrap.appendChild(addRow);
      filesWrap.appendChild(list);

      const field = mkField("files", filesWrap, "Click Upload files to pick one or more files. Use ✕ to remove a file.");
      field.classList.add("field-inline");
      body.appendChild(field);
    }

    if (t.type === "SEND_MESSAGE") {
      const msg = mkInput({
        value: t.message || "",
        placeholder: "Message text",
        onInput: (v) => {
          config.tasks[idx].message = v;
          setDirty(true);
        }
      });
      const wrap = mkField("message", msg, "Text that will be sent.");
      wrap.classList.add("field-inline");
      body.appendChild(wrap);
    }

    if (t.type === "SLASH_COMMAND") {
  const cmd = mkInput({
    value: t.command || "",
    placeholder: "/bump",
    onInput: (v) => {
      config.tasks[idx].command = v;
      setDirty(true);
    }
  });

  const index = mkNumberInput({
    value: t.index ?? "",
    placeholder: "0",
    onInput: (n) => {
      if (Number.isFinite(n)) config.tasks[idx].index = n;
      else delete config.tasks[idx].index;
      setDirty(true);
    }
  });

  body.appendChild(mkField("command", cmd, "Slash command to run."));
  body.appendChild(mkField("index", index, "Optional. Autocomplete index fallback, usually 0."));
}

if (t.type === "SEND_EMOJI") {
  const emoji = mkInput({
    value: t.emoji || "",
    placeholder: "😭 or :sob: or <a:name:123...>",
    onInput: (v) => {
      config.tasks[idx].emoji = v;
      setDirty(true);
    }
  });
  body.appendChild(mkField("emoji", emoji, "Emoji to send. Supports unicode emoji, :name:, and <a:name:id>."));
}

if (t.type === "CLICK") {
  const selCss = mkInput({
    value: (t.selector && t.selector.css) ? t.selector.css : "",
    placeholder: ".button-class",
    onInput: (v) => {
      if (!config.tasks[idx].selector || typeof config.tasks[idx].selector !== "object") config.tasks[idx].selector = {};
      config.tasks[idx].selector.css = v;
      setDirty(true);
    }
  });

  const selId = mkInput({
    value: (t.selector && t.selector.id) ? t.selector.id : "",
    placeholder: "submit-button",
    onInput: (v) => {
      if (!config.tasks[idx].selector || typeof config.tasks[idx].selector !== "object") config.tasks[idx].selector = {};
      config.tasks[idx].selector.id = v;
      setDirty(true);
    }
  });

  body.appendChild(mkField("selector.css", selCss, "CSS selector to click."));
  body.appendChild(mkField("selector.id", selId, "Element id to click (alternative to CSS)."));
}

if (t.type === "FILL") {
  const selCss = mkInput({
    value: (t.selector && t.selector.css) ? t.selector.css : "",
    placeholder: "input[name=\"email\"]",
    onInput: (v) => {
      if (!config.tasks[idx].selector || typeof config.tasks[idx].selector !== "object") config.tasks[idx].selector = {};
      config.tasks[idx].selector.css = v;
      setDirty(true);
    }
  });

  const selId = mkInput({
    value: (t.selector && t.selector.id) ? t.selector.id : "",
    placeholder: "email",
    onInput: (v) => {
      if (!config.tasks[idx].selector || typeof config.tasks[idx].selector !== "object") config.tasks[idx].selector = {};
      config.tasks[idx].selector.id = v;
      setDirty(true);
    }
  });

  const textVal = mkInput({
    value: t.text || "",
    placeholder: "text to type",
    onInput: (v) => {
      config.tasks[idx].text = v;
      setDirty(true);
    }
  });

  const clear = mkCheck({
    checked: Boolean(t.clear),
    label: "Clear first",
    onChange: (b) => {
      config.tasks[idx].clear = Boolean(b);
      setDirty(true);
    }
  });

  body.appendChild(mkField("selector.css", selCss, "CSS selector for the input element."));
  body.appendChild(mkField("selector.id", selId, "Element id (alternative to CSS)."));
  body.appendChild(mkField("text", textVal, "Text to type."));
  body.appendChild(mkField("clear", clear, "When enabled, attempts to clear the field first."));
}

if (t.type === "PRESS_KEY") {
  const key = mkInput({
    value: t.key || "",
    placeholder: "Enter",
    onInput: (v) => {
      config.tasks[idx].key = v.trim();
      setDirty(true);
    }
  });

  const times = mkNumberInput({
    value: t.times ?? "",
    placeholder: "1",
    onInput: (n) => {
      if (Number.isFinite(n) && n >= 1) config.tasks[idx].times = Math.round(n);
      else config.tasks[idx].times = 1;
      setDirty(true);
    }
  });

  body.appendChild(mkField("key", key, "Keyboard key name, e.g. Enter, Tab, Escape, ArrowDown."));
  body.appendChild(mkField("times", times, "How many times to press the key."));
}

if (t.type === "WAIT_FOR_SELECTOR") {
  const selCss = mkInput({
    value: (t.selector && t.selector.css) ? t.selector.css : "",
    placeholder: "div[role=\"textbox\"]",
    onInput: (v) => {
      if (!config.tasks[idx].selector || typeof config.tasks[idx].selector !== "object") config.tasks[idx].selector = {};
      config.tasks[idx].selector.css = v;
      setDirty(true);
    }
  });

  const selId = mkInput({
    value: (t.selector && t.selector.id) ? t.selector.id : "",
    placeholder: "some-id",
    onInput: (v) => {
      if (!config.tasks[idx].selector || typeof config.tasks[idx].selector !== "object") config.tasks[idx].selector = {};
      config.tasks[idx].selector.id = v;
      setDirty(true);
    }
  });

  const state = mkSelect({
    value: t.state || "visible",
    options: ["visible", "attached", "hidden"],
    onChange: (v) => {
      config.tasks[idx].state = v;
      setDirty(true);
    }
  });

  const timeout = mkNumberInput({
    value: t.timeout_ms ?? "",
    placeholder: String(config.element_wait_timeout_ms ?? 30000),
    onInput: (n) => {
      if (Number.isFinite(n) && n >= 0) config.tasks[idx].timeout_ms = Math.round(n);
      else delete config.tasks[idx].timeout_ms;
      setDirty(true);
    }
  });

  body.appendChild(mkField("selector.css", selCss, "CSS selector to wait for."));
  body.appendChild(mkField("selector.id", selId, "Element id (alternative to CSS)."));
  body.appendChild(mkField("state", state, "attached waits for presence. visible waits for visibility. hidden waits for removal or invisibility."));
  body.appendChild(mkField("timeout_ms", timeout, "Optional override for element_wait_timeout_ms."));
}

if (t.type === "WAIT_FOR_NAVIGATION") {
  const urlExact = mkInput({
    value: t.url || "",
    placeholder: "https://example.com/after",
    onInput: (v) => {
      config.tasks[idx].url = v.trim();
      setDirty(true);
    }
  });

  const urlContains = mkInput({
    value: t.url_contains || "",
    placeholder: "/channels/",
    onInput: (v) => {
      config.tasks[idx].url_contains = v.trim();
      setDirty(true);
    }
  });

  const timeout = mkNumberInput({
    value: t.timeout_ms ?? "",
    placeholder: String(config.element_wait_timeout_ms ?? 30000),
    onInput: (n) => {
      if (Number.isFinite(n) && n >= 0) config.tasks[idx].timeout_ms = Math.round(n);
      else delete config.tasks[idx].timeout_ms;
      setDirty(true);
    }
  });

  body.appendChild(mkField("url", urlExact, "Optional exact URL to wait for."));
  body.appendChild(mkField("url_contains", urlContains, "Optional URL substring to wait for."));
  body.appendChild(mkField("timeout_ms", timeout, "Optional override for element_wait_timeout_ms."));
}

if (t.type === "SCREENSHOT") {
  const label = mkInput({
    value: t.label || "",
    placeholder: "after_login",
    onInput: (v) => {
      config.tasks[idx].label = v.trim();
      setDirty(true);
    }
  });

  const outPath = mkInput({
    value: t.path || "",
    placeholder: "screenshots/after_login.png",
    onInput: (v) => {
      config.tasks[idx].path = v.trim();
      setDirty(true);
    }
  });

  const full = mkCheck({
    checked: Boolean(t.full_page),
    label: "Full page",
    onChange: (b) => {
      config.tasks[idx].full_page = Boolean(b);
      setDirty(true);
    }
  });

  body.appendChild(mkField("label", label, "Optional label used for auto-filename."));
  body.appendChild(mkField("path", outPath, "Optional explicit path. Relative paths resolve under screenshot_dir."));
  body.appendChild(mkField("full_page", full, "Best-effort full-page screenshot. May resize viewport temporarily."));
}

    if (t.type === "WAIT") {
      const secs = mkNumberInput({
        value: t.seconds ?? "",
        placeholder: "1",
        min: 0,
        onInput: (n) => {
          config.tasks[idx].seconds = Number.isFinite(n) && n >= 0 ? n : (config.tasks[idx].seconds ?? 1);
          setDirty(true);
        }
      });
      body.appendChild(mkField("seconds", secs, "Time to wait before continuing (in seconds)."));
    }

if (t.type === "LOOP_AUTOMATION") {
      const interval = mkNumberInput({
        value: t.interval_ms ?? "",
        placeholder: String(config?.tasks_interval ?? 1000),
        onInput: (n) => {
          if (Number.isFinite(n) && n >= 50) config.tasks[idx].interval_ms = n;
          else delete config.tasks[idx].interval_ms;
          setDirty(true);
        }
      });
      body.appendChild(mkField("interval_ms", interval, "Optional. Overrides General.tasks_interval for the loop delay."));

      const info = document.createElement("div");
      info.className = "field field-inline";
      info.innerHTML = 'Must be the <span class="kbd">last</span> task. Without it, the runner executes tasks once and exits.';
      body.appendChild(info);
    }

    item.appendChild(head);
    item.appendChild(body);
    root.appendChild(item);
  });

  updateToggleAllBtn("accounts");
}

async function validateNow({ quiet } = {}) {
  if (!filePath || !config) return;

  normalizeConfig();

  const res = await window.api.validateConfig(config);
  setValidationUI(res);

  if (!quiet) {
    if (res && res.ok) setBanner("ok", "Validation passed.");
    else setBanner("bad", "Validation failed. Review errors.");
  }

  return res;
}

async function saveNow({ quiet } = {}) {
  if (!filePath || !config) return { ok: false, errors: ["No file loaded."] };

  normalizeConfig();

  const v = await validateNow({ quiet: true });
  if (!v || !v.ok) {
    setBanner("bad", "Cannot save. Fix validation errors.");
    setView("validation");
    return { ok: false, errors: v?.errors || ["Validation failed."] };
  }

  const res = await window.api.writeJson(filePath, config);
  if (res && res.ok) {
    setDirty(false);
    if (!quiet) setBanner("ok", "Saved.");
    // Keep the history view current.
    refreshHistory().catch(() => {});
  } else {
    setBanner("bad", "Save failed.");
  }
  return res;
}

async function openConfig() {
  const picked = await window.api.openConfig();
  if (!picked) return;

  await loadConfigAtPath(picked, { created: false });
}

async function loadConfigAtPath(picked, { created } = {}) {
  const res = await window.api.readJson(picked);
  if (!res || !res.data || typeof res.data !== "object") {
    filePath = null;
    config = null;
    updateFileHeader();
    setEnabled(false);
    setDirty(false);
    setBanner("bad", "Failed to read JSON. Fix the file and try again.");
    setValidationUI({ ok: false, errors: res?.errors || ["Unknown error."] });
    return;
  }

  filePath = picked;
  updateFileHeader();

  config = clone(res.data);
  normalizeConfig();

  applyThemeMode(config.ui_theme ?? "system");

  // Default log viewer filter to the config's log level.
  logViewerLevel = String(config.log_level || "info").toLowerCase();
  const lvl = $("logLevelSelect");
  if (lvl) lvl.value = logViewerLevel;

  setEnabled(true);
  // If the main process migrated the config, treat it as dirty until the user saves.
  setDirty(Boolean(res.migrated));

  renderGeneral();
  renderAccounts();
  renderTasks();
  renderAdvanced();
  refreshHistory().catch(() => {});
  clearLog();
  setRunning(false);
  setRunStatus("muted", "Not running");

  setValidationUI(res);

  if (res.ok) {
    if (res.migrated && res.migration) {
      const from = res.migration.from;
      const to = res.migration.to;
      const notes = Array.isArray(res.migration.notes) && res.migration.notes.length
        ? ` ${res.migration.notes.join(" ")}`
        : "";
      setBanner("ok", `Loaded and migrated v${from} → v${to}. Please save.${notes}`);
    } else {
      setBanner("ok", created ? "Created new config.json. Configuration is valid." : "Loaded. Configuration is valid.");
    }
  } else {
    setBanner("bad", created ? "Created new config.json. Fix validation issues." : "Loaded. Configuration has validation issues.");
  }

  setView("validation");
}

async function ensureDefaultConfigOnBoot() {
  if (!window.api || typeof window.api.ensureDefaultConfig !== "function") return;

  setBanner("muted", "Preparing config.json...");

  const r = await window.api.ensureDefaultConfig();
  if (!r || !r.ok || !r.path) {
    setBanner("bad", r?.error || "Failed to create or load default config.json.");
    return;
  }

  await loadConfigAtPath(r.path, { created: Boolean(r.created) });
}

async function exportSanitized() {
  if (!filePath || !config) return;

  normalizeConfig();

  const v = await validateNow({ quiet: true });
  if (!v || !v.ok) {
    setBanner("bad", "Cannot export. Fix validation errors.");
    setView("validation");
    return;
  }

  const res = await window.api.exportSanitized(filePath, config);
  if (res && res.ok) setBanner("ok", "Exported sanitized config.");
  else if (res && res.canceled) setBanner("muted", "Export canceled.");
  else setBanner("bad", "Export failed.");
}

async function exportFull() {
  if (!filePath || !config) return;

  const msg = [
    "This export will include sensitive data.",
    "It may contain usernames, emails, and passwords.",
    "Only export to a secure location.",
    "\nContinue?"
  ].join("\n");

  const ok = await uiConfirm({
    title: "Export full config",
    message: msg,
    confirmText: "Export",
    cancelText: "Cancel",
    danger: true
  });

  if (!ok) {
    setBanner("muted", "Export canceled.");
    return;
  }

  normalizeConfig();

  const v = await validateNow({ quiet: true });
  if (!v || !v.ok) {
    setBanner("bad", "Cannot export. Fix validation errors.");
    setView("validation");
    return;
  }

  const res = await window.api.exportFull(filePath, config);
  if (res && res.ok) setBanner("ok", "Exported full config.");
  else if (res && res.canceled) setBanner("muted", "Export canceled.");
  else setBanner("bad", "Export failed.");
}

async function startAutomation() {
  if (!filePath || !config) return;

  const saved = await saveNow({ quiet: true });
  if (!saved || !saved.ok) return;

  clearLog();
  setRunStatus("muted", "Starting...");
  setBanner("muted", "Starting automation...");

  const res = await window.api.runAutomation(filePath);
  if (!res || !res.ok) {
    setRunStatus("bad", "Failed to start");
    setRunning(false);
    setBanner("bad", res?.error || "Failed to start.");
    return;
  }

  setRunning(true);
  setPaused(false);
  setRunStatus("ok", "Running");
  setBanner("ok", `Automation started. PID ${res.pid}`);
  setView("automation");
  setEnabled(true);
}

async function pauseAutomation() {
  const res = await window.api.pauseAutomation();
  if (!res || !res.ok) {
    setBanner("bad", res?.error || "Failed to pause.");
    return;
  }
  setPaused(true);
  setBanner("muted", "Paused.");
}

async function resumeAutomation() {
  const res = await window.api.resumeAutomation();
  if (!res || !res.ok) {
    setBanner("bad", res?.error || "Failed to resume.");
    return;
  }
  setPaused(false);
  setBanner("ok", "Resumed.");
}

async function onRunClick() {
  if (!isRunning) return startAutomation();
}

async function onPauseClick() {
  if (!isRunning) return;
  if (isPaused) return resumeAutomation();
  return pauseAutomation();
}

async function stopAutomation() {
  const res = await window.api.stopAutomation();
  if (!res || !res.ok) {
    setBanner("bad", res?.error || "Failed to stop.");
    return;
  }

  // Stop clears pause state by design.
  setPaused(false);
  setBanner("ok", "Stop requested.");
}


function wireGeneralBindings() {
  const bindInput = (id, handler) => {
    const e = $(id);
    if (!e) return;
    e.addEventListener("input", () => {
      if (!config) return;
      handler();
      setDirty(true);
    });
  };

  const bindChange = (id, handler) => {
    const e = $(id);
    if (!e) return;
    e.addEventListener("change", () => {
      if (!config) return;
      handler();
      setDirty(true);
    });
  };

  bindInput("server_id", () => { config.server_id = $("server_id").value.trim(); });
  bindInput("channel_id", () => { config.channel_id = $("channel_id").value.trim(); });

  bindInput("tasks_interval", () => {
    const n = Number($("tasks_interval").value);
    if (Number.isFinite(n)) config.tasks_interval = n;
  });

  bindInput("account_switch_interval", () => {
    const n = Number($("account_switch_interval").value);
    if (Number.isFinite(n)) config.account_switch_interval = n;
  });

  bindChange("no_login_delay", () => { config.no_login_delay = Boolean($("no_login_delay").checked); });

  bindChange("run_enabled", () => { config.run_enabled = Boolean($("run_enabled").checked); });
  bindChange("headless", () => { config.headless = Boolean($("headless").checked); });

  bindInput("jitter_ms", () => {
    const n = Number($("jitter_ms").value);
    if (Number.isFinite(n)) config.jitter_ms = Math.max(0, n);
  });

  bindChange("human_typing_enabled", () => {
    config.human_typing_enabled = Boolean($("human_typing_enabled").checked);
  });

  bindInput("typing_delay_ms_min", () => {
    const n = Number($("typing_delay_ms_min").value);
    if (Number.isFinite(n) && n >= 0) config.typing_delay_ms_min = n;
  });

  bindInput("typing_delay_ms_max", () => {
    const n = Number($("typing_delay_ms_max").value);
    if (Number.isFinite(n) && n >= 0) config.typing_delay_ms_max = n;
  });

  bindChange("log_level", () => {
    const v = String($("log_level").value || "").toLowerCase();
    if (["error", "warn", "info", "debug"].includes(v)) config.log_level = v;
  });

  bindChange("screenshot_on_error", () => { config.screenshot_on_error = Boolean($("screenshot_on_error").checked); });

  bindInput("element_wait_timeout_ms", () => {
    const n = Number($("element_wait_timeout_ms").value);
    if (Number.isFinite(n) && n >= 100) config.element_wait_timeout_ms = n;
  });

}

function wireButtons() {
  $("openBtn").addEventListener("click", openConfig);
  $("validateBtn").addEventListener("click", () => validateNow({ quiet: false }));
  $("saveBtn").addEventListener("click", () => saveNow({ quiet: false }));
  $("exportBtn").addEventListener("click", exportSanitized);
  $("exportFullBtn").addEventListener("click", exportFull);

  // Actions menu (secondary commands).
  const actionsBtn = $("actionsBtn");
  const actionsMenu = $("actionsMenu");
  if (actionsBtn && actionsMenu) {
    const close = () => {
      actionsMenu.classList.remove("is-open");
      actionsBtn.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      actionsMenu.classList.add("is-open");
      actionsBtn.setAttribute("aria-expanded", "true");
    };
    actionsBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (actionsMenu.classList.contains("is-open")) close(); else open();
    });
    document.addEventListener("click", (ev) => {
      if (actionsMenu.classList.contains("is-open")) {
        const t = ev.target;
        if (!actionsMenu.contains(t) && t !== actionsBtn) close();
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
    });
    actionsMenu.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => close());
    });
  }

  // File header tools.
  const copyPath = $("copyPathBtn");
  if (copyPath) copyPath.addEventListener("click", async () => {
    if (!filePath) return;
    await window.api.copyText(String(filePath)).catch(() => {});
    showToast({ text: "Copied config path." });
  });
  const openFolder = $("openFolderBtn");
  if (openFolder) openFolder.addEventListener("click", async () => {
    if (!filePath) return;
    await window.api.showInFolder(String(filePath)).catch(() => {});
  });

  // Quick copy helpers.
  const copyServer = $("copyServerIdBtn");
  if (copyServer) copyServer.addEventListener("click", async () => {
    const v = $("server_id") ? String($("server_id").value || "").trim() : "";
    if (!v) return;
    await window.api.copyText(v).catch(() => {});
    showToast({ text: "Copied Server ID." });
  });
  const copyChannel = $("copyChannelIdBtn");
  if (copyChannel) copyChannel.addEventListener("click", async () => {
    const v = $("channel_id") ? String($("channel_id").value || "").trim() : "";
    if (!v) return;
    await window.api.copyText(v).catch(() => {});
    showToast({ text: "Copied Channel ID." });
  });

  const emptyExport = $("issuesEmptyExportBtn");
  if (emptyExport) emptyExport.addEventListener("click", exportSanitized);
  const emptyRun = $("issuesEmptyGoRunBtn");
  if (emptyRun) emptyRun.addEventListener("click", () => setView("automation"));

  // Log viewer controls.
  const ls = $("logSearch");
  if (ls) {
    ls.value = logSearch;
    ls.oninput = () => {
      logSearch = String(ls.value || "").trim();
      renderLog();
    };
  }

  const lvl = $("logLevelSelect");
  if (lvl) {
    lvl.value = logViewerLevel;
    lvl.onchange = () => {
      logViewerLevel = String(lvl.value || "info").toLowerCase();
      renderLog();
    };
  }

  const as = $("logAutoScroll");
  if (as) {
    as.checked = Boolean(logAutoScroll);
    as.onchange = () => { logAutoScroll = Boolean(as.checked); };
  }

  const copyBtn = $("logCopyBtn");
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const q = String(logSearch || "").toLowerCase();
      const filtered = (Array.isArray(logEntries) ? logEntries : []).filter((e) => {
        if (!logMeetsThreshold(e.level)) return false;
        if (q && !String(e.text || "").toLowerCase().includes(q)) return false;
        return true;
      });
      const text = filtered
        .map((e) => {
          const dt = new Date(Number(e.ts) || Date.now());
          return `${dt.toLocaleTimeString()} [${String(e.level || "info").toUpperCase()}] ${String(e.text || "")}`;
        })
        .join("\n");
      if (!text) return;
      await window.api.copyText(text).catch(() => {});
      showToast({ text: "Copied logs to clipboard." });
    };
  }

  const clearBtn = $("logClearBtn");
  if (clearBtn) {
    clearBtn.onclick = () => {
      clearLog();
    };
  }

  const advTa = $("advancedScript");
  if (advTa) {
    advTa.addEventListener("input", () => {
      if (!config) return;
      config.advanced_tasking_script = String(advTa.value || "");
      setDirty(true);
      const parsed = parseAdvancedScript(advTa.value);
      setAdvancedErrors(parsed.errors);
    });
  }

  const fromTasks = $("scriptFromTasksBtn");
  if (fromTasks) {
    fromTasks.addEventListener("click", () => {
      if (!config) return;
      const script = scriptFromTasksList(config.tasks);
      config.advanced_tasking_script = script;
      if (advTa) advTa.value = script;
      setDirty(true);
      renderAdvanced();
    });
  }

  const applyScript = $("applyScriptBtn");
  if (applyScript) {
    applyScript.addEventListener("click", () => {
      if (!config || !advTa) return;
      const parsed = parseAdvancedScript(advTa.value);
      setAdvancedErrors(parsed.errors);
      if (!parsed.ok) {
        setBanner("bad", "Advanced tasking parse errors. Fix them before applying.");
        return;
      }
      config.tasks = parsed.tasks;
      setDirty(true);
      renderTasks();
      setBanner("ok", `Applied ${parsed.tasks.length} task${parsed.tasks.length === 1 ? "" : "s"} from Advanced tasking.`);
      validateNow({ quiet: true }).catch(() => {});
    });
  }

  const histRefresh = $("historyRefreshBtn");
  if (histRefresh) histRefresh.addEventListener("click", () => refreshHistory().catch(() => {}));

  $("addAccountBtn").addEventListener("click", () => {
    if (!config) return;
    config.accounts.push({ name: "", email: "", password: "", priority: PRIORITY_DEFAULT, enabled: true, cooldown_after_use_ms: 0, max_tasks_per_session: 0, notes: "" });
    setDirty(true);
    renderAccounts();
  });

  const toggleAll = (kind) => {
    if (!config) return;
    const root = $(kind);
    if (!root) return;

    const list = kind === "accounts" ? (Array.isArray(config.accounts) ? config.accounts : []) : (Array.isArray(config.tasks) ? config.tasks : []);
    const store = kind === "accounts" ? uiCollapse.accounts : uiCollapse.tasks;
    const keyFn = kind === "accounts" ? accountUiKey : taskUiKey;

    const items = Array.from(root.querySelectorAll(":scope > .item"));
    if (!items.length || !list.length) return;

    const allCollapsed = list.every((x, i) => store.has(keyFn(x, i)));
    const targetCollapsed = !allCollapsed;

    items.forEach((item, i) => {
      const body = item.querySelector(".item-body");
      const key = keyFn(list[i], i);
      setItemCollapsed(item, targetCollapsed, body, { key, store });

      // Keep per-item toggle labels in sync.
      if (kind === "tasks") {
        const b = item.querySelector('[data-collapse-toggle="task"]');
        if (b) b.textContent = item.classList.contains("is-collapsed") ? "Expand" : "Collapse";
      }
    });

    updateToggleAllBtn(kind);
  };

  const accToggleAll = $("accountsToggleAllBtn");
  if (accToggleAll) accToggleAll.addEventListener("click", () => toggleAll("accounts"));

  $("addTaskBtn").addEventListener("click", () => {
    if (!config) return;
    config.tasks.push(ensureTaskDefaults({ type: "SEND_MESSAGE" }));
    setDirty(true);
    renderTasks();
  });

  const taskToggleAll = $("tasksToggleAllBtn");
  if (taskToggleAll) taskToggleAll.addEventListener("click", () => toggleAll("tasks"));

  $("runBtn").addEventListener("click", onRunClick);
  const pauseBtn = $("pauseBtn");
  if (pauseBtn) pauseBtn.addEventListener("click", onPauseClick);
  $("stopBtn").addEventListener("click", stopAutomation);


// Instructions: "Go to tab" buttons.
document.querySelectorAll("[data-goto]").forEach((b) => {
  b.addEventListener("click", () => {
    const to = String(b.dataset.goto || "").trim();
    if (!to) return;
    setView(to);
  });
});

const instrToggle = $("instrToggleAllBtn");
if (instrToggle) instrToggle.addEventListener("click", () => {
  const root = $("instructionsDoc");
  if (!root) return;
  const details = Array.from(root.querySelectorAll("details.doc-acc"));
  if (!details.length) return;
  const allOpen = details.every((d) => d.open);
  const nextOpen = !allOpen;
  details.forEach((d) => { d.open = nextOpen; });
  instrToggle.textContent = nextOpen ? "Collapse all" : "Expand all";
});

// Keep the Instructions toggle label correct when a section is opened/closed.
const docRoot = $("instructionsDoc");
if (docRoot) {
  docRoot.addEventListener("toggle", () => {
    const btn = $("instrToggleAllBtn");
    if (!btn) return;
    const details = Array.from(docRoot.querySelectorAll("details.doc-acc"));
    if (!details.length) return;
    const allOpen = details.every((d) => d.open);
    btn.textContent = allOpen ? "Collapse all" : "Expand all";
  }, true);
}


}

function wireAutomationEvents() {
  window.api.onAutomationLog((line) => {
    appendLog(line);
  });

  window.api.onAutomationState((payload) => {
    const running = Boolean(payload && payload.running);
    const paused = Boolean(payload && payload.paused);
    setRunning(running);
    setPaused(paused);
    setEnabled(Boolean(filePath));

    if (!running) {
      setPaused(false);
      const reason = String(payload?.reason || "");
      setRunStatus("muted", "Not running");

      if (reason === "stopped") {
        setBanner("muted", "Automation stopped.");
        return;
      }
      if (reason === "completed") {
        setBanner("ok", "Automation completed.");
        return;
      }

      // Default: show exit details, but avoid scaring the user on a normal Stop.
      if (payload && (payload.code !== null || payload.signal)) {
        const code = payload.code === null || payload.code === undefined ? "" : `code ${payload.code}`;
        const sig = payload.signal ? `signal ${payload.signal}` : "";
        const suffix = [code, sig].filter(Boolean).join(", ");
        setBanner("muted", suffix ? `Automation exited. ${suffix}` : "Automation exited.");
        return;
      }
    }
  });
}

async function loadConfigMeta() {
  try {
    if (!window.api || typeof window.api.getConfigMeta !== "function") return;
    const res = await window.api.getConfigMeta();
    if (!res || !res.ok) return;

    if (Array.isArray(res.taskTypes) && res.taskTypes.length) {
      TASK_TYPES = res.taskTypes.map((t) => String(t));
    }

    if (res.taskTypeLabels && typeof res.taskTypeLabels === "object") {
      TASK_TYPE_LABELS = { ...res.taskTypeLabels };
    }

    if (res.configVersion !== undefined && res.configVersion !== null) {
      const cv = Number(res.configVersion);
      if (Number.isFinite(cv)) SCHEMA_VERSION = cv;
    }

    const p = res.priority || {};
    if (p.MIN !== undefined) PRIORITY_MIN = Number(p.MIN);
    if (p.MAX !== undefined) PRIORITY_MAX = Number(p.MAX);
    if (p.DEFAULT !== undefined) PRIORITY_DEFAULT = Number(p.DEFAULT);

    // Safety.
    if (!Number.isFinite(PRIORITY_MIN)) PRIORITY_MIN = 0;
    if (!Number.isFinite(PRIORITY_MAX)) PRIORITY_MAX = 5;
    if (!Number.isFinite(PRIORITY_DEFAULT)) PRIORITY_DEFAULT = 3;
  } catch {
    // Ignore. Fallback constants remain.
  }
}

async function loadAppInfo() {
  try {
    if (!window.api || typeof window.api.getAppInfo !== "function") return;
    const res = await window.api.getAppInfo();
    if (!res || !res.ok) return;
    appInfo = res;

    // Populate "About" placeholders in the Instructions tab, if present.
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val ?? "");
    };

    set("aboutAppName", res.name || "Dab");
    set("aboutAppDesc", res.description || "Config editor and automation runner.");
    set("aboutAppAuthor", res.author || "Unknown");
    set("aboutAppLicense", res.license || "");
    set("aboutAppVersion", res.version || "");
  } catch {
    // ignore
  }
}



async function init() {
  initModal();
  // Replace native selects with the themed menu dropdowns before wiring events.
  upgradeNativeSelects();
  wireNav();
  wireButtons();
  wireGeneralBindings();
  wireAutomationEvents();

  // Keyboard shortcuts.
  document.addEventListener("keydown", (ev) => {
    const isMod = Boolean(ev.ctrlKey || ev.metaKey);
    const key = String(ev.key || "").toLowerCase();
    if (isMod && key === "s") {
      ev.preventDefault();
      const btn = $("saveBtn");
      if (btn && !btn.disabled) saveNow({ quiet: false }).catch(() => {});
    }
  });

  // Close dropdown menus on outside click.
  document.addEventListener("click", (ev) => {
    if (!__openSlideSelect) return;
    const t = ev.target;
    if (t && t.closest && t.closest(".slide-select")) return;
    closeSlideSelect(__openSlideSelect);
    __openSlideSelect = null;
  });

  setEnabled(false);
  setDirty(false);
  setRunning(false);

  setValidationUI({ ok: false, errors: [] });

  // Default view.
  setView("validation");

  // Load config meta first so the UI stays in sync with the schema...
  await loadConfigMeta();
  await loadAppInfo();

  // Auto-create and load a default config if the user doesn't have one.
  // This ensures first run is usable without manual file prep.
  ensureDefaultConfigOnBoot();
}

document.addEventListener("DOMContentLoaded", init);
