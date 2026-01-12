'use strict';

/**
 * Dab automation runner.
 *
 * Task-first behavior:
 * - No automatic login, logout, or account switching.
 * - Account/session changes happen only when tasks request them.
 * - Looping is controlled by a LOOP_AUTOMATION task, which must be the last task.
 *
 * Config path resolution:
 * - Uses DAB_CONFIG_PATH when present (set by the Electron UI).
 * - Falls back to ./config.json in the project root.
 */

const fs = require('fs');
const path = require('path');
const webdriver = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');

const Config = require('./lib/config');

// -----------------------------
// Config
// -----------------------------

function resolveConfigPath() {
  const envPath = String(process.env.DAB_CONFIG_PATH || '').trim();
  if (envPath) return envPath;
  return path.join(__dirname, 'config.json');
}

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  const mig = Config.migrateConfig(parsed, { projectRootDir: path.dirname(configPath) });
  const cfg = mig.data;
  cfg.__config_path = configPath;
  return cfg;
}

function normalizePriority(p, fallback = Config.PRIORITY.DEFAULT) {
  const n = Number(p);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  if (i < Config.PRIORITY.MIN) return Config.PRIORITY.MIN;
  if (i > Config.PRIORITY.MAX) return Config.PRIORITY.MAX;
  return i;
}

// -----------------------------
// Logging
// -----------------------------

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function isRecoverableSessionError(err) {
  const msg = String(err?.message || err || '').toLowerCase();

  // Firefox/GeckoDriver transient session transport or context loss.
  // These tend to be non-deterministic and are best handled by restarting
  // the affected session and retrying the task once.
  const needles = [
    'failed to write request to stream',
    'failed to read response from stream',
    'browsing context has been discarded',
    'top-level browsing context has been discarded',
    'no such window',
    'no such browsing context',
    'target window already closed',
    'disconnected',
    'invalid session id',
    'session is not created',
    'session not created',
    'connection refused',
    'econnreset',
    'socket hang up'
  ];

  return needles.some((n) => msg.includes(n));
}

function mkLogger(cfg) {
  const threshold = LOG_LEVELS[cfg.log_level] ?? LOG_LEVELS.info;
  const emit = (level, msg) => {
    const sev = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    if (sev <= threshold) console.log(`[${String(level).toUpperCase()}] ${String(msg)}`);
  };
  return {
    error: (m) => emit('error', m),
    warn: (m) => emit('warn', m),
    info: (m) => emit('info', m),
    debug: (m) => emit('debug', m)
  };
}

function sleep(ms) {
  // Pause-aware sleep.
  const n = Number(ms);
  const total = Number.isFinite(n) && n > 0 ? n : 0;
  return controlledSleep(total);
}

// -----------------------------
// Pause / resume / stop control
// -----------------------------

class StopRequestedError extends Error {
  constructor(message = 'Stop requested') {
    super(message);
    this.name = 'StopRequestedError';
  }
}

const __control = {
  paused: false,
  stopRequested: false,
  pausePromise: null,
  pauseResolve: null,
  lastNotified: 0
};

function sendPausedState() {
  try {
    if (typeof process.send === 'function') {
      process.send({ type: 'paused', paused: Boolean(__control.paused) });
    }
  } catch {
    // ignore
  }
}

function requestPause() {
  if (__control.stopRequested) return;
  __control.paused = true;
  if (!__control.pausePromise) {
    __control.pausePromise = new Promise((r) => { __control.pauseResolve = r; });
  }
  sendPausedState();
}

function requestResume() {
  __control.paused = false;
  if (__control.pauseResolve) {
    try { __control.pauseResolve(); } catch {}
  }
  __control.pausePromise = null;
  __control.pauseResolve = null;
  sendPausedState();
}

function requestStop() {
  __control.stopRequested = true;
  // Stop clears pause.
  requestResume();
}

async function pausePoint(log) {
  if (__control.stopRequested) throw new StopRequestedError();

  if (!__control.paused) return;

  if (!__control.pausePromise) {
    __control.pausePromise = new Promise((r) => { __control.pauseResolve = r; });
  }

  // Avoid log spam while paused.
  const now = Date.now();
  if (log && now - (__control.lastNotified || 0) > 1500) {
    __control.lastNotified = now;
    log.info('Paused. Waiting for resume...');
  }

  while (__control.paused && !__control.stopRequested) {
    if (__control.pausePromise) await __control.pausePromise;
    // If pausePromise resolved, loop will re-check paused flag.
  }

  if (__control.stopRequested) throw new StopRequestedError();
}

function rawSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function controlledSleep(ms) {
  let remaining = Number(ms);
  if (!Number.isFinite(remaining) || remaining <= 0) return;

  const step = 250;
  while (remaining > 0) {
    await pausePoint();
    const chunk = Math.min(step, remaining);
    await rawSleep(chunk);
    remaining -= chunk;
  }
}

// Receive pause/resume/stop commands from the Electron main process.
if (typeof process.on === 'function') {
  process.on('message', (msg) => {
    try {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'pause') requestPause();
      else if (msg.type === 'resume') requestResume();
      else if (msg.type === 'stop') requestStop();
    } catch {
      // ignore
    }
  });
}

function randomInt(min, max) {
  const a = Math.ceil(Number(min));
  const b = Math.floor(Number(max));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.floor(Math.random() * (b - a + 1) + a);
}

// Backwards compatible helper (older code used randInt).
function randInt(min, max) {
  return randomInt(min, max);
}

function getTypingDelayRange(cfg) {
  const enabled = cfg && cfg.human_typing_enabled !== false;
  const min = Number(cfg?.typing_delay_ms_min ?? 70);
  const max = Number(cfg?.typing_delay_ms_max ?? 160);

  const a = Number.isFinite(min) && min >= 0 ? Math.round(min) : 70;
  const b = Number.isFinite(max) && max >= 0 ? Math.round(max) : 160;

  if (!enabled) return { enabled: false, min: 0, max: 0 };
  if (a <= b) return { enabled: true, min: a, max: b };
  return { enabled: true, min: b, max: a };
}

function typingDelayMs(cfg) {
  const r = getTypingDelayRange(cfg);
  if (!r.enabled) return 0;
  return randomInt(r.min, r.max);
}

function safeSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'screenshot';
}

async function saveScreenshot(driver, cfg, log, label) {
  if (!cfg.screenshot_on_error) return;

  try {
    if (!fs.existsSync(cfg.screenshot_dir)) fs.mkdirSync(cfg.screenshot_dir, { recursive: true });
    const png = await driver.takeScreenshot();
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeSlug(label)}.png`;
    const out = path.join(cfg.screenshot_dir, filename);
    fs.writeFileSync(out, png, 'base64');
    log.info(`Saved screenshot: ${out}`);
  } catch (e) {
    log.warn(`Failed to save screenshot: ${String(e && e.message ? e.message : e)}`);
  }
}

// -----------------------------
// Selenium helpers
// -----------------------------

async function navigateTo(driver, cfg, log, url) {
  const u = String(url || '').trim();
  if (!u) return;
  try {
    log.debug(`Navigating to ${u}`);
    await driver.get(u);
  } catch (err) {
    log.warn(`Navigation failed: ${String(err && err.message ? err.message : err)}`);
    await saveScreenshot(driver, cfg, log, 'navigate_error');
    throw err;
  }
}

async function waitFor(driver, cfg, by, timeoutMs) {
  const t = Number(timeoutMs);
  const timeout = Number.isFinite(t) && t >= 0 ? t : cfg.element_wait_timeout_ms;
  const started = Date.now();

  while (Date.now() - started <= timeout) {
    await pausePoint();
    const els = await driver.findElements(by).catch(() => []);
    if (els && els.length) return els[0];
    await sleep(250);
  }

  throw new Error(`Timed out after ${timeout}ms waiting for element.`);
}

async function waitForCondition(fn, timeoutMs) {
  const t = Number(timeoutMs);
  const timeout = Number.isFinite(t) && t >= 0 ? t : 0;
  const started = Date.now();
  while (Date.now() - started <= timeout) {
    await pausePoint();
    const ok = await Promise.resolve().then(fn).catch(() => false);
    if (ok) return true;
    await sleep(150);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for condition.`);
}

async function clickWhenReady(driver, cfg, by, timeoutMs) {
  const el = await waitFor(driver, cfg, by, timeoutMs);
  await waitForCondition(() => el.isDisplayed(), cfg.element_wait_timeout_ms);
  await waitForCondition(() => el.isEnabled(), cfg.element_wait_timeout_ms);
  await el.click();
  return el;
}

async function typeWhenReady(driver, cfg, by, text, timeoutMs) {
  const el = await waitFor(driver, cfg, by, timeoutMs);
  await waitForCondition(() => el.isDisplayed(), cfg.element_wait_timeout_ms);
  await el.clear().catch(() => {});
  await el.sendKeys(String(text ?? ''));
  return el;
}

async function typeWhenReadyHuman(driver, cfg, by, text, timeoutMs) {
  const el = await waitFor(driver, cfg, by, timeoutMs);
  await waitForCondition(() => el.isDisplayed(), cfg.element_wait_timeout_ms);

  // Clear first.
  await el.clear().catch(() => {});

  const s = String(text ?? "");
  const range = getTypingDelayRange(cfg);

  // If human typing is disabled, fall back to a single sendKeys.
  if (!range.enabled) {
    await el.sendKeys(s);
    return el;
  }

  // Type character by character. Re-acquire on staleness.
  let cur = el;
  for (const ch of s.split("")) {
    try {
      await cur.sendKeys(ch);
    } catch {
      cur = await waitFor(driver, cfg, by, timeoutMs);
      await cur.sendKeys(ch);
    }
    await sleep(randomInt(range.min, range.max));
  }

  return cur;
}


// -----------------------------
// Task helpers
// -----------------------------

function normalizeSelector(sel) {
  const s = (sel && typeof sel === "object") ? sel : {};
  const css = String(s.css || "").trim();
  const id = String(s.id || "").trim();
  if (css) return { by: webdriver.By.css(css), kind: "css", value: css };
  if (id) return { by: webdriver.By.id(id), kind: "id", value: id };
  return null;
}

async function focusElement(driver, el) {
  // Clicking via Actions is more reliable for complex UIs than element.click().
  await driver.actions({ async: true }).move({ origin: el }).click().perform();
}

function resolveKey(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;

  const n = raw.toUpperCase().replace(/\s+/g, "");
  const alias = {
    "ENTER": "RETURN",
    "ESC": "ESCAPE",
    "ARROWDOWN": "ARROW_DOWN",
    "ARROWUP": "ARROW_UP",
    "ARROWLEFT": "ARROW_LEFT",
    "ARROWRIGHT": "ARROW_RIGHT",
    "PAGEDOWN": "PAGE_DOWN",
    "PAGEUP": "PAGE_UP"
  };

  const k = alias[n] || n;
  return webdriver.Key[k] || raw;
}

async function waitForSelectorState(driver, cfg, sel, state, timeoutMs) {
  const info = normalizeSelector(sel);
  if (!info) throw new Error('Missing selector (provide selector.css or selector.id).');

  const t = Number(timeoutMs);
  const timeout = Number.isFinite(t) && t >= 0 ? t : cfg.element_wait_timeout_ms;
  const st = String(state || "visible").toLowerCase();

  const started = Date.now();
  const pollMs = 250;

  while (Date.now() - started <= timeout) {
    await pausePoint();

    const els = await driver.findElements(info.by).catch(() => []);

    if (st === "attached") {
      if (els && els.length) return true;
    } else if (st === "visible") {
      if (els && els.length) {
        try {
          if (await els[0].isDisplayed()) return true;
        } catch {
          // ignore
        }
      }
    } else if (st === "hidden") {
      if (!els || !els.length) return true;
      try {
        const visible = await els[0].isDisplayed();
        if (!visible) return true;
      } catch {
        return true;
      }
    } else {
      throw new Error(`Unknown state '${String(state)}'. Use attached, visible, or hidden.`);
    }

    await sleep(pollMs);
  }

  throw new Error(`WAIT_FOR_SELECTOR timed out after ${timeout}ms (${st}).`);

}

async function takeScreenshot(driver, cfg, log, task) {
  const screenshotDir = String(cfg.screenshot_dir || "").trim() || path.join(process.cwd(), "screenshots");
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

  const label = String(task?.label || "").trim();
  const requested = String(task?.path || "").trim();

  let outPath = "";
  if (requested) {
    // If user provides a relative path, resolve it under screenshot_dir to keep outputs tidy.
    outPath = path.isAbsolute(requested) ? requested : path.join(screenshotDir, requested);
  } else {
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeSlug(label || "screenshot")}.png`;
    outPath = path.join(screenshotDir, filename);
  }

  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const wantFull = Boolean(task?.full_page);

  // Best-effort: resize viewport to page height for a full-page screenshot.
  let restoreRect = null;
  try {
    if (wantFull) {
      try {
        restoreRect = await driver.manage().window().getRect();
      } catch {
        restoreRect = null;
      }
      const dims = await driver.executeScript(function () {
        const body = document.body;
        const doc = document.documentElement;
        const height = Math.max(
          body ? body.scrollHeight : 0,
          doc ? doc.scrollHeight : 0,
          body ? body.offsetHeight : 0,
          doc ? doc.offsetHeight : 0
        );
        const width = Math.max(
          body ? body.scrollWidth : 0,
          doc ? doc.scrollWidth : 0,
          body ? body.offsetWidth : 0,
          doc ? doc.offsetWidth : 0
        );
        return { width, height };
      }).catch(() => null);

      if (dims && Number.isFinite(dims.height) && Number.isFinite(dims.width)) {
        // Clamp to avoid driver limits.
        const w = Math.max(800, Math.min(2000, Math.round(dims.width)));
        const h = Math.max(600, Math.min(8000, Math.round(dims.height)));
        await driver.manage().window().setRect({ width: w, height: h }).catch(() => {});
      }
    }

    const png = await driver.takeScreenshot();
    fs.writeFileSync(outPath, png, "base64");
    log.info(`Saved screenshot: ${outPath}`);
  } finally {
    if (wantFull && restoreRect) {
      await driver.manage().window().setRect(restoreRect).catch(() => {});
    }
  }

  return outPath;
}

async function findChatInput(driver) {
  // Discord uses a contenteditable textbox. The aria-label is usually "Message #channel".
  // Try a few patterns to be resilient to UI changes.
  const candidates = [];

  try {
    const a = await driver.findElements(webdriver.By.css('[aria-label^="Message "]'));
    for (const el of a) candidates.push(el);
  } catch {}

  try {
    const b = await driver.findElements(webdriver.By.css('div[role="textbox"][contenteditable="true"]'));
    for (const el of b) candidates.push(el);
  } catch {}

  for (const el of candidates) {
    try {
      const aria = await el.getAttribute('aria-label').catch(() => '');
      if (String(aria || '').toLowerCase().includes('message')) return el;
      const cls = await el.getAttribute('class').catch(() => '');
      if (String(cls || '').includes('editor_')) return el;
    } catch {
      // ignore
    }
  }

  return null;
}

async function waitForChatInput(driver, cfg, timeoutMs) {
  const t = Number(timeoutMs);
  const timeout = Number.isFinite(t) && t > 0 ? t : cfg.element_wait_timeout_ms;
  const start = Date.now();
  while (Date.now() - start <= timeout) {
    const chat = await findChatInput(driver);
    if (chat) return chat;
    await sleep(250);
  }
  throw new Error('Chat input not found.');
}

// -----------------------------
// Session helpers
// -----------------------------

function toOrigin(u) {
  try {
    const url = new URL(String(u || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function uniqStrings(list) {
  const out = [];
  const seen = new Set();
  for (const v of list || []) {
    const s = String(v || '').trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function clearWebStorage(driver) {
  // Clear client-side storage beyond cookies. Discord can retain auth state in
  // storage types other than localStorage (e.g. CacheStorage / IndexedDB).
  // Use an async script so we can await browser Promises.
  const script = `
    const done = arguments[arguments.length - 1];
    (async () => {
      try { window.localStorage && window.localStorage.clear(); } catch {}
      try { window.sessionStorage && window.sessionStorage.clear(); } catch {}

      // CacheStorage.
      try {
        if (window.caches && caches.keys) {
          const keys = await caches.keys();
          await Promise.all((keys || []).map((k) => caches.delete(k)));
        }
      } catch {}

      // Service workers.
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all((regs || []).map((r) => r.unregister()));
        }
      } catch {}

      // IndexedDB.
      try {
        if (window.indexedDB) {
          if (indexedDB.databases) {
            const dbs = await indexedDB.databases();
            await Promise.all((dbs || []).map((d) => {
              if (!d || !d.name) return Promise.resolve();
              return new Promise((res) => {
                try {
                  const req = indexedDB.deleteDatabase(d.name);
                  req.onsuccess = () => res();
                  req.onerror = () => res();
                  req.onblocked = () => res();
                } catch {
                  res();
                }
              });
            }));
          }
        }
      } catch {}

      done(true);
    })();
  `;

  try {
    await driver.executeAsyncScript(script);
  } catch (err) {
    // If the browsing context was discarded or the session transport died,
    // bubble up so callers can recover by restarting the session.
    if (isRecoverableSessionError(err)) throw err;
    // Otherwise, best-effort only.
  }
}

async function clearSessionForOrigin(driver, cfg, log) {
  // Clear session state in a deterministic way.
  // Important: cookies and storage are per-origin, so we explicitly visit the
  // known origins and clear each.
  const maybeLog = log && typeof log.debug === 'function' ? log : null;

  const origins = [];

  // 1) Current origin (if we have one).
  try {
    const cur = await driver.getCurrentUrl();
    const o = toOrigin(cur);
    if (o) origins.push(o);
  } catch {
    // ignore
  }

  // 2) Configured origins.
  origins.push(toOrigin(cfg.base_url));
  origins.push(toOrigin(cfg.login_url));
  origins.push(toOrigin(cfg.logout_url));

  const list = uniqStrings(origins);
  if (!list.length) return;

  for (const origin of list) {
    try {
      await driver.get(origin);
    } catch (err) {
      // If the session transport is dead or the browsing context was discarded,
      // stop and let the caller recover by restarting the session.
      if (isRecoverableSessionError(err)) throw err;
      maybeLog?.debug(`Session clear: could not navigate to ${origin}. (${String(err?.message || err)})`);
    }

    // Cookies.
    try {
      await driver.manage().deleteAllCookies();
    } catch (err) {
      if (isRecoverableSessionError(err)) throw err;
      maybeLog?.debug(`Session clear: deleteAllCookies failed for ${origin}. (${String(err?.message || err)})`);
    }

    // Client-side storage.
    await clearWebStorage(driver);
  }

  await sleep(500);
}

async function logoutAndGoToLogin(driver, cfg, log) {
  await clearSessionForOrigin(driver, cfg, log);
  await navigateTo(driver, cfg, log, cfg.login_url);
}

// Discord-specific logout via UI (User Settings -> Log Out -> confirm).
// This matches Discord's documented logout path and avoids relying on /logout routes.
// If UI elements cannot be found (Discord UI change, wrong page, etc.), we fall back to
// clearing the session for the origin.
async function logoutViaDiscordUI(driver, cfg, log) {
  const timeout = Number(cfg.element_wait_timeout_ms ?? 15000);

  // Ensure we are on Discord.
  try {
    if (cfg.base_url) await driver.get(cfg.base_url);
  } catch {
    // ignore
  }

  // 1) Open User Settings via the cog.
  // Discord help docs refer to this as the "settings cog" next to username.
  // We prefer the accessible aria-label, which tends to be more stable than hashed classes.
  const settingsBy = webdriver.By.css('button[aria-label="User Settings"], [role="button"][aria-label="User Settings"]');
  try {
    await clickWhenReady(driver, cfg, settingsBy, timeout);
  } catch (err) {
    log.warn(`UI logout: could not open User Settings (aria-label selector failed). Falling back to session clear. (${String(err?.message || err)})`);
    await clearSessionForOrigin(driver, cfg, log);
    return;
  }

  // 2) Click the "Log Out" item in the settings sidebar.
  // Use a text-based XPath because Discord's sidebar classes are hashed.
  const logoutItemBy = webdriver.By.xpath("//*[normalize-space()='Log Out']/ancestor-or-self::*[self::button or self::a or @role='button'][1]");
  try {
    await clickWhenReady(driver, cfg, logoutItemBy, timeout);
  } catch (err) {
    log.warn(`UI logout: could not click settings sidebar "Log Out" item. Falling back to session clear. (${String(err?.message || err)})`);
    await clearSessionForOrigin(driver, cfg, log);
    return;
  }

  // 3) Confirm in the modal.
  // The modal has role=dialog and a heading "Log Out".
  const dialogBy = webdriver.By.xpath("//div[@role='dialog' and .//h1[normalize-space()='Log Out']]");
  let dialog = null;
  try {
    dialog = await waitFor(driver, cfg, dialogBy, timeout);
  } catch (err) {
    log.warn(`UI logout: confirmation dialog not detected. Falling back to session clear. (${String(err?.message || err)})`);
    await clearSessionForOrigin(driver, cfg, log);
    return;
  }

  const confirmBy = webdriver.By.xpath(".//button[.//*[normalize-space()='Log Out']]");
  try {
    const btn = await dialog.findElement(confirmBy);
    await btn.click();
  } catch (err) {
    log.warn(`UI logout: could not click confirm "Log Out" button. Falling back to session clear. (${String(err?.message || err)})`);
    await clearSessionForOrigin(driver, cfg, log);
    return;
  }

  // 4) Wait for login page, otherwise hard-clear and navigate to login.
  const loginBy = webdriver.By.css('input[type="email"], input[name="email"]');
  try {
    await waitFor(driver, cfg, loginBy, 15000);
  } catch {
    // Discord can sometimes land on a blank route after logout. Ensure we're clean.
    await clearSessionForOrigin(driver, cfg, log);
    if (cfg.login_url) await navigateTo(driver, cfg, log, cfg.login_url);
  }
}

async function doLogin(driver, cfg, log, account) {
  const emailSel = account.email_selector || { css: 'input[type="email"], input[name="email"]' };
  const passSel = account.password_selector || { css: 'input[type="password"], input[name="password"]' };
  const submitSel = account.submit_selector || { css: 'button[type="submit"], input[type="submit"]' };

  const byEmail = emailSel.css ? webdriver.By.css(emailSel.css) : webdriver.By.id(emailSel.id);
  const byPass = passSel.css ? webdriver.By.css(passSel.css) : webdriver.By.id(passSel.id);
  const bySubmit = submitSel.css ? webdriver.By.css(submitSel.css) : webdriver.By.id(submitSel.id);

  try {
    // If we were redirected because a token is still present, the email field won't exist.
    try {
      await waitFor(driver, cfg, byEmail, 5000);
    } catch {
      log.warn('Login form not detected. Clearing session and retrying login page.');
    await clearSessionForOrigin(driver, cfg, log);
      await navigateTo(driver, cfg, log, cfg.login_url);
      await waitFor(driver, cfg, byEmail, cfg.element_wait_timeout_ms);
    }

    log.info('Typing credentials');
    await typeWhenReadyHuman(driver, cfg, byEmail, account.email);
    await typeWhenReadyHuman(driver, cfg, byPass, account.password);

    log.info('Submitting login form');
    await clickWhenReady(driver, cfg, bySubmit);

    // Discord often needs a moment to redirect.
    if (!cfg.no_login_delay) await sleep(2000);
  } catch (err) {
    const curUrl = await driver.getCurrentUrl().catch(() => '');
    log.error(`Login failed. Current URL: ${curUrl}`);
    await saveScreenshot(driver, cfg, log, 'login_error');
    throw err;
  }
}

// -----------------------------
// Accounts
// -----------------------------

function describeAccount(acc) {
  if (!acc) return '(none)';
  const email = String(acc.email || '');
  const name = String(acc.name || '');
  return name ? `${name} (${email})` : email;
}

function findAccount(cfg, key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];

  // Prefer exact email match.
  const byEmail = accounts.find((a) => String(a.email || '').trim().toLowerCase() === k.toLowerCase());
  if (byEmail) return byEmail;

  // Fallback to name match.
  const byName = accounts.find((a) => String(a.name || '').trim().toLowerCase() === k.toLowerCase());
  return byName || null;
}

function pickNextAccount(state, cfg, currentEmail) {
  const now = Date.now();
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];

  const enabled = accounts.filter((a) => a && a.enabled !== false && String(a.email || '').trim());
  if (!enabled.length) return { account: null, waitMs: 0 };

  const eligible = enabled.filter((a) => {
    const email = String(a.email || '').trim();
    const cooldown = Number(a.cooldown_after_use_ms ?? 0);
    if (Number.isFinite(cooldown) && cooldown > 0) {
      const last = state.lastUsed[email] || 0;
      if (now - last < cooldown) return false;
    }
    return true;
  });

  if (!eligible.length) {
    // Determine min remaining cooldown.
    let minRemaining = 1000;
    for (const a of enabled) {
      const email = String(a.email || '').trim();
      const cooldown = Number(a.cooldown_after_use_ms ?? 0);
      if (!Number.isFinite(cooldown) || cooldown <= 0) continue;
      const last = state.lastUsed[email] || 0;
      const remaining = cooldown - (now - last);
      if (remaining > 0) minRemaining = Math.min(minRemaining, remaining);
    }
    return { account: null, waitMs: Math.max(250, minRemaining) };
  }

  // Sort: higher priority first, then original order.
  const sorted = eligible
    .map((a, idx) => ({ a, idx }))
    .sort((x, y) => {
      const px = normalizePriority(x.a.priority, 3);
      const py = normalizePriority(y.a.priority, 3);
      if (px !== py) return py - px;
      return x.idx - y.idx;
    })
    .map((x) => x.a);

  let cursor = Number(state.cursor ?? 0);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

  const start = cursor % sorted.length;
  for (let i = 0; i < sorted.length; i++) {
    const ix = (start + i) % sorted.length;
    const acc = sorted[ix];
    if (String(acc.email || '').trim().toLowerCase() === String(currentEmail || '').trim().toLowerCase() && sorted.length > 1) continue;
    state.cursor = ix + 1;
    return { account: acc, waitMs: 0 };
  }

  // Fallback.
  state.cursor = start + 1;
  return { account: sorted[start], waitMs: 0 };
}

// -----------------------------
// Task validation
// -----------------------------

function validateLoopTaskPlacement(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const idxs = [];
  for (let i = 0; i < list.length; i++) {
    if (String(list[i]?.type || '').trim() === 'LOOP_AUTOMATION') idxs.push(i);
  }
  if (!idxs.length) return { ok: true, hasLoop: false, error: '' };
  if (idxs.length > 1) return { ok: false, hasLoop: true, error: 'Only one LOOP_AUTOMATION task is allowed.' };
  if (idxs[0] !== list.length - 1) return { ok: false, hasLoop: true, error: 'LOOP_AUTOMATION must be the last task.' };
  return { ok: true, hasLoop: true, error: '' };
}

// -----------------------------
// Task execution
// -----------------------------

function handleCustomHandler(_cfg, handlerName) {
  // Placeholder hook for user custom actions.
  // Return false to skip.
  if (!handlerName) return true;
  return true;
}

async function ensureSessionHealthy(driver, cfg, log, taskType, sessionCtx) {
  if (!driver) return driver;

  // Enabled by default. Turn off with session_health_check=false if needed.
  const enabled = cfg && cfg.session_health_check !== false;
  if (!enabled) return driver;

  try {
    // Cheap ping to detect dead session transport early.
    await driver.getCurrentUrl();
    return driver;
  } catch (err) {
    if (!isRecoverableSessionError(err)) throw err;

    const why = String(err?.message || err);
    try { log && log.warn && log.warn(`Session health check failed (${why}). Restarting session...`); } catch {}

    const fresh = await restartBrowserSession(driver, cfg, log, `health:${String(taskType || 'task')}`);

    // In multi sessions mode, we can re-auth automatically after a restart so that tasks that
    // assume an authenticated session do not fail due to the fresh Firefox profile.
    const ctx = (sessionCtx && typeof sessionCtx === 'object') ? sessionCtx : {};
    const isMulti = cfg && cfg.multi_sessions_enabled === true && ctx.boundAccount;
    const shouldAutoLogin = isMulti && cfg.multi_sessions_auto_login !== false && String(cfg.login_url || '').trim();

    const t = String(taskType || '').trim();
    const skipAuto = (t === 'LOGIN' || t === 'LOGOUT');

    if (shouldAutoLogin && !skipAuto) {
      const acc = ctx.boundAccount;
      if (acc && String(acc.password || '').trim()) {
        try {
          log.info(`Re-authenticating after session restart as ${describeAccount(acc)}`);
          await navigateTo(fresh, cfg, log, cfg.login_url);
          await doLogin(fresh, cfg, log, acc);
        } catch (e2) {
          try { log && log.warn && log.warn(`Re-auth after restart failed: ${String(e2?.message || e2)}`); } catch {}
          try {
            const email = normalizeEmail(acc.email || '');
            await saveScreenshot(fresh, cfg, log, `health_reauth_${email.replace(/[^a-z0-9]+/g, '_')}`);
          } catch {}
        }
      }
    }

    return fresh;
  }
}


async function runTask(driver, cfg, log, task, state, oneShotRan, sessionCtx, attempt = 0) {
  const id = String(task.id || 'task');
  const type = String(task.type || '').trim();

  const ctx = (sessionCtx && typeof sessionCtx === 'object') ? sessionCtx : {};
  const isMultiSession = cfg && cfg.multi_sessions_enabled === true && ctx.boundAccount;

  if (task.oneshot && oneShotRan[id]) return { ran: false, success: true, driver };

  if (task.check_handler) {
    const ok = handleCustomHandler(cfg, task.check_handler);
    if (!ok) return { ran: false, success: true, driver };
  }

  driver = await ensureSessionHealthy(driver, cfg, log, type, ctx);

  try {
    switch (type) {
      case 'LOGIN': {
        const requestedKey = String(task.account || '').trim();

        let account = null;
        if (isMultiSession) {
          account = ctx.boundAccount;
          if (!account || !String(account.email || '').trim()) throw new Error('LOGIN in multi sessions mode requires a bound account for the session.');

          // UI may hide the account picker in multi sessions. If a value exists and it doesn't match,
          // warn and proceed with the pinned session account.
          if (requestedKey) {
            const req = findAccount(cfg, requestedKey);
            if (req && normalizeEmail(req.email) !== normalizeEmail(account.email)) {
              log.warn(`LOGIN task specifies ${describeAccount(req)} but this session is pinned to ${describeAccount(account)}. Using the pinned account.`);
            }
          }
        } else {
          if (!requestedKey) throw new Error('LOGIN task is missing "account". Provide an account email or name.');
          account = findAccount(cfg, requestedKey);
          if (!account) throw new Error(`LOGIN task account not found: ${requestedKey}`);
          if (account.enabled === false) throw new Error(`LOGIN task account is disabled: ${describeAccount(account)}`);
        }

        if (!String(account.password || '').trim()) throw new Error(`LOGIN task account has empty password: ${describeAccount(account)}`);

        log.info(`LOGIN as ${describeAccount(account)}`);

        // In multi sessions, prefer a full session restart before login to avoid stale Discord state.
        const restartOnLogin = Boolean(isMultiSession || cfg.restart_browser_on_login === true);
        if (restartOnLogin) {
          driver = await restartBrowserSession(driver, cfg, log, 'LOGIN');
          if (cfg.login_url) await navigateTo(driver, cfg, log, cfg.login_url);
        } else {
          await logoutAndGoToLogin(driver, cfg, log);
        }

        await doLogin(driver, cfg, log, account);
        state.currentEmail = String(account.email || '').trim();
        state.lastUsed[state.currentEmail] = Date.now();
        if (task.oneshot) oneShotRan[id] = true;
        return { ran: true, success: true, driver };
      }

      case 'LOGOUT': {
const key = String(task.account || '').trim();
if (key) {
  const requested = findAccount(cfg, key);
  if (!requested) log.warn(`LOGOUT account not found in config: ${key}. Proceeding to clear session anyway.`);
  if (requested && state.currentEmail && String(requested.email || '').trim().toLowerCase() !== String(state.currentEmail).toLowerCase()) {
    log.warn(`LOGOUT requested ${describeAccount(requested)} but current session is ${state.currentEmail}. Clearing session anyway.`);
  }
}

// Discord auth state is not reliably tied to cookies alone (it also uses client storage).
// The most deterministic approach is a full browser session restart, which guarantees a
// fresh Firefox profile (no cookies, storage, SW registrations, caches, etc.).
const restartOnLogout = cfg.restart_browser_on_logout !== false;

log.info(`LOGOUT (${restartOnLogout ? 'restart browser session' : 'clear session'})`);

if (restartOnLogout) {
  driver = await restartBrowserSession(driver, cfg, log, 'LOGOUT');

  // Navigate to login to make the logged-out state explicit.
  if (cfg.login_url) {
    try {
      await navigateTo(driver, cfg, log, cfg.login_url);
    } catch {
      // ignore
    }
  }

  state.currentEmail = '';
  if (task.oneshot) oneShotRan[id] = true;
  return { ran: true, success: true, driver };
}

// Fallback: deterministic "session clear" logout within the existing browser session.
// UI-driven logout in Discord is brittle (hashed classes, localization, layout changes).
// Prefer a deterministic "session clear": clear cookies + local/session storage + caches,
// then refresh/navigate to the login page.
// Best-effort server-side logout first (some services revoke server sessions on /logout).
if (cfg.logout_url) {
  try {
    await navigateTo(driver, cfg, log, cfg.logout_url);
    await sleep(750);
  } catch {
    // ignore
  }
}

await clearSessionForOrigin(driver, cfg, log);

try {
  await driver.navigate().refresh();
} catch {
  // ignore
}

if (cfg.login_url) {
  try {
    await navigateTo(driver, cfg, log, cfg.login_url);
  } catch {
    // ignore
  }
}

state.currentEmail = '';
if (task.oneshot) oneShotRan[id] = true;
return { ran: true, success: true, driver };
      }

      case 'SWITCH_ACCOUNT': {
        const explicit = String(task.account || '').trim();
        let next = null;

        if (explicit) {
          next = findAccount(cfg, explicit);
          if (!next) throw new Error(`SWITCH_ACCOUNT explicit account not found: ${explicit}`);
          if (next.enabled === false) throw new Error(`SWITCH_ACCOUNT account is disabled: ${describeAccount(next)}`);
        } else {
          const pick = pickNextAccount(state, cfg, state.currentEmail);
          if (!pick.account) {
            const w = Number(pick.waitMs ?? 1000);
            log.info(`SWITCH_ACCOUNT: no eligible account right now. Waiting ${w}ms.`);
            await sleep(w);
            if (task.oneshot) oneShotRan[id] = true;
            return { ran: true, success: true, driver };
          }
          next = pick.account;
        }

        if (!String(next.password || '')) throw new Error(`SWITCH_ACCOUNT selected account has empty password: ${describeAccount(next)}`);

        log.info(`SWITCH_ACCOUNT to ${describeAccount(next)}`);

const restartOnSwitch = cfg.restart_browser_on_switch_account !== false;

if (restartOnSwitch) {
  driver = await restartBrowserSession(driver, cfg, log, 'SWITCH_ACCOUNT');
  if (cfg.login_url) {
    try {
      await navigateTo(driver, cfg, log, cfg.login_url);
    } catch {
      // ignore
    }
  }
} else {
  await logoutAndGoToLogin(driver, cfg, log);
}

        await doLogin(driver, cfg, log, next);
        state.currentEmail = String(next.email || '').trim();
        state.lastUsed[state.currentEmail] = Date.now();

        if (task.oneshot) oneShotRan[id] = true;
        return { ran: true, success: true, driver };
      }

      case 'UPLOAD_FILE': {
        log.info(`Running task ${id}`);
        await navigateTo(driver, cfg, log, task.url);

        const fileInput = task.file_input || { css: 'input[type="file"]' };
        const submitSel = task.submit || { css: 'button[type="submit"], input[type="submit"]' };

        const byFile = fileInput.css ? webdriver.By.css(fileInput.css) : webdriver.By.id(fileInput.id);
        const bySubmit = submitSel.css ? webdriver.By.css(submitSel.css) : webdriver.By.id(submitSel.id);

        // UPLOAD_FILE supports selecting multiple files (task.files[]).
        const filePathsRaw = [];
        if (Array.isArray(task.files)) filePathsRaw.push(...task.files);
        if (!filePathsRaw.length && String(task.file || '').trim()) filePathsRaw.push(String(task.file).trim());

        const filePaths = Array.from(new Set(
          filePathsRaw.map((v) => String(v ?? '').trim()).filter(Boolean)
        ));

        if (!filePaths.length) throw new Error('UPLOAD_FILE task is missing "files". Use the UI Upload files button.');

        // Selenium accepts newline-separated file paths for multi-file <input type="file" multiple>.
        await typeWhenReady(driver, cfg, byFile, filePaths.join('\n'));
        await clickWhenReady(driver, cfg, bySubmit);

        await sleep(Number(task.post_wait_ms ?? 2000));
        if (task.oneshot) oneShotRan[id] = true;
        return { ran: true, success: true, driver };
      }

      case 'SEND_MESSAGE': {
  log.info(`Running task ${id}`);
  await navigateTo(driver, cfg, log, task.url);

  // Allow an explicit selector override (useful outside Discord).
  let chat = null;
  if (task.selector) {
    const info = normalizeSelector(task.selector);
    if (!info) throw new Error('SEND_MESSAGE task selector is invalid (provide selector.css or selector.id).');
    chat = await waitFor(driver, cfg, info.by, task.timeout_ms);
  } else {
    chat = await waitForChatInput(driver, cfg, cfg.element_wait_timeout_ms);
  }

  // Focus reliably, then type via the active element (Discord uses contenteditable).
  await focusElement(driver, chat);
  let active = await driver.switchTo().activeElement();

  const msg = String(task.message ?? '');
  const range = getTypingDelayRange(cfg);
  const fast = Boolean(task.instant) || !range.enabled;

  if (fast) {
    await active.sendKeys(msg);
  } else {
    for (const ch of msg.split('')) {
      try {
        await active.sendKeys(ch);
      } catch {
        // Discord re-renders the editor sometimes. Re-acquire and continue.
        if (task.selector) {
          const info = normalizeSelector(task.selector);
          chat = await waitFor(driver, cfg, info.by, task.timeout_ms);
        } else {
          chat = await waitForChatInput(driver, cfg, cfg.element_wait_timeout_ms);
        }
        await focusElement(driver, chat);
        active = await driver.switchTo().activeElement();
        await active.sendKeys(ch);
      }
      await sleep(randomInt(range.min, range.max));
    }
  }

  // Best-effort autocomplete click.
  try {
    const ac0 = await driver.findElements(webdriver.By.id('autocomplete-0'));
    if (ac0 && ac0.length) await ac0[0].click();
  } catch {}

  // Send.
  await active.sendKeys(webdriver.Key.RETURN);

  await sleep(Number(task.post_wait_ms ?? 250));
  if (task.oneshot) oneShotRan[id] = true;
  return { ran: true, success: true, driver };
}

case 'SLASH_COMMAND': {
        log.info(`Running task ${id}`);
        await navigateTo(driver, cfg, log, task.url);

        const chat = await waitForChatInput(driver, cfg, cfg.element_wait_timeout_ms);
        await focusElement(driver, chat);
        let active = await driver.switchTo().activeElement();

        let cmd = String(task.command ?? '').trim();
        if (!cmd) throw new Error('SLASH_COMMAND task is missing "command".');
        if (!cmd.startsWith('/')) cmd = '/' + cmd;

        // Type into the active element (Discord editor is contenteditable).
        const range = getTypingDelayRange(cfg);
        const fast = Boolean(task.instant) || !range.enabled;
        if (fast) {
          await active.sendKeys(cmd);
        } else {
          for (const ch of cmd.split('')) {
            try {
              await active.sendKeys(ch);
            } catch {
              await focusElement(driver, chat);
              active = await driver.switchTo().activeElement();
              await active.sendKeys(ch);
            }
            await sleep(randomInt(range.min, range.max));
          }
        }

        // Wait a bit for the command picker to appear.
        await sleep(Number(task.pre_select_wait_ms ?? 600));

        const timeout = Math.max(500, Number(task.autocomplete_timeout_ms ?? 2500));
        const started = Date.now();

        const findOptions = async () => {
          // Discord frequently uses role=listbox/option, but can change. Keep a few fallbacks.
          let els = [];
          try {
            els = await driver.findElements(webdriver.By.css('[role="listbox"] [role="option"]'));
          } catch {}
          if (els && els.length) return els;

          try {
            els = await driver.findElements(webdriver.By.css('[role="listbox"] [data-list-item-id]'));
          } catch {}
          if (els && els.length) return els;

          try {
            els = await driver.findElements(webdriver.By.css('[id^="autocomplete-"]'));
          } catch {}
          return els || [];
        };

        let options = [];
        while (Date.now() - started <= timeout) {
          await pausePoint(log);
          options = await findOptions();
          if (options.length) break;
          await sleep(120);
        }

        const desired = cmd.toLowerCase();

        const pickByText = async (els) => {
          for (const el of els) {
            try {
              const txt = String(await el.getText()).trim().toLowerCase();
              // Option text usually starts with "/command".
              if (txt && (txt.startsWith(desired) || txt.includes(`\n${desired}`) || txt.includes(` ${desired}`))) return el;
            } catch {
              // ignore
            }
          }
          return null;
        };

        let picked = null;
        if (options.length) {
          picked = await pickByText(options);
          if (!picked) {
            const idx = Math.max(0, Math.floor(Number(task.index ?? 0) || 0));
            picked = options[idx] || null;
          }
        }

        if (picked) {
          try {
            await picked.click();
          } catch {
            // Fallback to keyboard selection if click fails.
            const idx = Math.max(0, Math.floor(Number(task.index ?? 0) || 0));
            for (let i = 0; i < idx + 1; i++) await active.sendKeys(webdriver.Key.ARROW_DOWN);
            await active.sendKeys(webdriver.Key.RETURN);
          }
        } else {
          // No picker found. Fall back to Enter to try to run the command as-typed.
        }

        await sleep(Number(task.post_select_wait_ms ?? 200));
        await active.sendKeys(webdriver.Key.RETURN);
        await sleep(Number(task.post_wait_ms ?? 1000));
        if (task.oneshot) oneShotRan[id] = true;
        return { ran: true, success: true, driver };
      }

      case 'SEND_EMOJI': {
        log.info(`Running task ${id}`);
        await navigateTo(driver, cfg, log, task.url);

        const chat = await waitForChatInput(driver, cfg, cfg.element_wait_timeout_ms);
        await focusElement(driver, chat);
        let active = await driver.switchTo().activeElement();

        const raw = String(task.emoji ?? '').trim();
        if (!raw) throw new Error('SEND_EMOJI task is missing "emoji".');

        const normalizeEmoji = (s) => {
          const v = String(s || '').trim();
          if (!v) return '';
          // Custom Discord emoji markup: <name:id> or <a:name:id>
          if (/^<a?:[A-Za-z0-9_]+:\d+>$/.test(v)) return v;
          // Already in :name: form
          if (/^:[^\s:]{1,64}:$/.test(v)) return v;
          // Simple shortcode without colons
          if (/^[A-Za-z0-9_]{1,64}$/.test(v)) return `:${v}:`;
          // Unicode emoji or anything else
          return v;
        };

        const text = normalizeEmoji(raw);

        const range = getTypingDelayRange(cfg);
        const fast = Boolean(task.instant) || !range.enabled;

        if (fast) {
          await active.sendKeys(text);
        } else {
          for (const ch of text.split('')) {
            try {
              await active.sendKeys(ch);
            } catch {
              await focusElement(driver, chat);
              active = await driver.switchTo().activeElement();
              await active.sendKeys(ch);
            }
            await sleep(randomInt(range.min, range.max));
          }
        }

        await sleep(100);
        await active.sendKeys(webdriver.Key.RETURN);
        await sleep(Number(task.post_wait_ms ?? 250));
        if (task.oneshot) oneShotRan[id] = true;
        return { ran: true, success: true, driver };
      }

      case 'NAVIGATE': {
        log.info(`Running task ${id}`);
        await navigateTo(driver, cfg, log, task.url);
        await sleep(Number(task.post_wait_ms ?? 1000));
        if (task.oneshot) oneShotRan[id] = true;
        return { ran: true, success: true, driver };
      }

      case 'CLICK': {
        log.info(`Running task ${id}`);
        const info = normalizeSelector(task.selector);
        if (!info) throw new Error('CLICK task is missing selector.css or selector.id.');

        // Clicking via Actions is more reliable for dynamic UIs.
        const el = await waitFor(driver, cfg, info.by, task.timeout_ms);
        await waitForCondition(() => el.isDisplayed(), cfg.element_wait_timeout_ms);
        await waitForCondition(() => el.isEnabled(), cfg.element_wait_timeout_ms);
        await focusElement(driver, el);
        await sleep(Number(task.post_wait_ms ?? 1000));
        if (task.oneshot) oneShotRan[id] = true;
        return { ran: true, success: true, driver };
      }

            case 'FILL': {
  log.info(`Running task ${id}`);
  const info = normalizeSelector(task.selector);
  if (!info) throw new Error('FILL task is missing selector.css or selector.id.');

  const el = await waitFor(driver, cfg, info.by, task.timeout_ms);
  await waitForCondition(() => el.isDisplayed(), cfg.element_wait_timeout_ms);

  await focusElement(driver, el);

  const text = String(task.text ?? "");
  const clearFirst = task.clear === undefined ? true : Boolean(task.clear);

  if (clearFirst) {
    // clear() is not supported on all element types, so fall back to Ctrl+A Backspace.
    try {
      await el.clear();
    } catch {
      try {
        const active = await driver.switchTo().activeElement();
        await active.sendKeys(webdriver.Key.CONTROL, "a");
        await active.sendKeys(webdriver.Key.BACK_SPACE);
      } catch {
        // ignore
      }
    }
  }

  const range = getTypingDelayRange(cfg);
  const fast = Boolean(task.instant) || !range.enabled;

  if (fast) {
    const active = await driver.switchTo().activeElement();
    await active.sendKeys(text);
  } else {
    let active = await driver.switchTo().activeElement();
    for (const ch of text.split("")) {
      try {
        await active.sendKeys(ch);
      } catch {
        await focusElement(driver, el);
        active = await driver.switchTo().activeElement();
        await active.sendKeys(ch);
      }
      await sleep(randomInt(range.min, range.max));
    }
  }

  await sleep(Number(task.post_wait_ms ?? 250));
  if (task.oneshot) oneShotRan[id] = true;
  return { ran: true, success: true, driver };
}

case 'PRESS_KEY': {
  log.info(`Running task ${id}`);
  const keyVal = resolveKey(task.key);
  if (!keyVal) throw new Error('PRESS_KEY task is missing "key".');

  const times = Math.max(1, Math.round(Number(task.times ?? 1)));

  for (let i = 0; i < times; i++) {
    await driver.actions({ async: true }).sendKeys(keyVal).perform();
    await sleep(randInt(10, 25) * 10);
  }

  await sleep(Number(task.post_wait_ms ?? 0));
  if (task.oneshot) oneShotRan[id] = true;
  return { ran: true, success: true, driver };
}

case 'WAIT_FOR_SELECTOR': {
  log.info(`Running task ${id}`);
  await waitForSelectorState(driver, cfg, task.selector, task.state, task.timeout_ms);
  await sleep(Number(task.post_wait_ms ?? 0));
  if (task.oneshot) oneShotRan[id] = true;
  return { ran: true, success: true, driver };
}

case 'WAIT_FOR_NAVIGATION': {
  log.info(`Running task ${id}`);
  const t = Number(task.timeout_ms);
  const timeout = Number.isFinite(t) && t >= 0 ? t : cfg.element_wait_timeout_ms;

  const urlExact = String(task.url || "").trim();
  const urlContains = String(task.url_contains || "").trim();
  const beforeUrl = !urlExact && !urlContains ? await driver.getCurrentUrl().catch(() => "") : "";

  const started = Date.now();
  while (Date.now() - started <= timeout) {
    await pausePoint(log);
    const now = await driver.getCurrentUrl().catch(() => "");
    if (urlExact && String(now) === urlExact) break;
    if (urlContains && String(now).includes(urlContains)) break;
    if (!urlExact && !urlContains && String(now) && String(now) !== String(beforeUrl)) break;
    await sleep(250);
  }

  // Re-check success.
  const finalUrl = await driver.getCurrentUrl().catch(() => "");
  const ok = urlExact
    ? String(finalUrl) === urlExact
    : urlContains
      ? String(finalUrl).includes(urlContains)
      : String(finalUrl) && String(finalUrl) !== String(beforeUrl);

  if (!ok) throw new Error(`WAIT_FOR_NAVIGATION timed out after ${timeout}ms.`);

  await sleep(Number(task.post_wait_ms ?? 0));
  if (task.oneshot) oneShotRan[id] = true;
  return { ran: true, success: true, driver };
}

case 'SCREENSHOT': {
  log.info(`Running task ${id}`);
  await takeScreenshot(driver, cfg, log, task);
  await sleep(Number(task.post_wait_ms ?? 0));
  if (task.oneshot) oneShotRan[id] = true;
  return { ran: true, success: true, driver };
}

case 'WAIT': {
        const secs = Number(task.seconds);
        if (!Number.isFinite(secs) || secs < 0) throw new Error('WAIT task is missing a valid "seconds" number (>= 0).');
        const ms = Math.round(secs * 1000);
        log.info(`WAIT ${secs}s`);
        await sleep(ms);
        if (task.oneshot) oneShotRan[id] = true;
        return { ran: true, success: true, driver };
      }

case 'LOOP_AUTOMATION': {
        // Handled in the main loop. If it appears here, treat as no-op.
        if (task.oneshot) oneShotRan[id] = true;
        return { ran: true, success: true, driver };
      }

      default:
        log.warn(`Unknown task type for ${id}: ${type}. Skipping.`);
        return { ran: false, success: true, driver };
    }
  } catch (err) {
    if (err && err.name === 'StopRequestedError') throw err;

    // In multi sessions mode, and generally with GeckoDriver, the session transport can
    // occasionally drop (e.g., "Failed to write request to stream") or the browsing context
    // can be discarded. When that happens, the best recovery is to restart the browser
    // session and retry the task once.
    const autoRecover = cfg && cfg.auto_restart_on_session_error !== false;
    if (autoRecover && attempt < 1 && isRecoverableSessionError(err)) {
      try {
        log.warn(`Recoverable session error. Restarting session and retrying task ${id}. (${String(err?.message || err)})`);
        const fresh = await restartBrowserSession(driver, cfg, log, `recover:${id}`);
        return await runTask(fresh, cfg, log, task, state, oneShotRan, ctx, attempt + 1);
      } catch (restartErr) {
        log.warn(`Auto-recovery restart failed for task ${id}. (${String(restartErr?.message || restartErr)})`);
        // Fall through to normal failure handling.
      }
    }

    log.warn(`Task ${id} failed: ${String(err && err.message ? err.message : err)}`);
    await saveScreenshot(driver, cfg, log, `task_${id}_error`);
    return { ran: true, success: false, driver };
  }
}

async function buildDriver(cfg) {
  const options = new firefox.Options();
  if (cfg && cfg.headless) options.headless();

  // Optional: start Firefox in private browsing mode (reduces persistence).
  if (cfg && cfg.firefox_private_browsing === true) {
    try { options.setPreference('browser.privatebrowsing.autostart', true); } catch {}
  }

  return await new webdriver.Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .build();
}

async function restartBrowserSession(driver, cfg, log, reason) {
  const why = String(reason || 'session reset');
  try { log && log.info && log.info(`Restarting browser session (${why})`); } catch {}

  try {
    if (driver) await driver.quit();
  } catch (err) {
    try { log && log.warn && log.warn(`Browser quit failed during restart. Continuing. (${String(err?.message || err)})`); } catch {}
  }

  const fresh = await buildDriver(cfg);
  await sleep(1200);
  return fresh;
}

// -----------------------------
// Multi sessions
// -----------------------------

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function mkPrefixedLogger(base, prefix) {
  const p = String(prefix || '').trim();
  if (!p) return base;
  const wrap = (fn) => (m) => {
    try {
      fn(`${p} ${String(m)}`);
    } catch {
      // ignore
    }
  };
  return {
    error: wrap(base.error || console.error),
    warn: wrap(base.warn || console.warn),
    info: wrap(base.info || console.log),
    debug: wrap(base.debug || console.log)
  };
}

async function allSettledLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);

  let lim = Number(limit);
  if (!Number.isFinite(lim)) lim = list.length;
  lim = Math.max(1, Math.floor(lim));
  lim = Math.min(lim, Math.max(1, list.length));

  let nextIndex = 0;
  let active = 0;

  return await new Promise((resolve) => {
    const launch = () => {
      while (active < lim && nextIndex < list.length) {
        const ix = nextIndex++;
        active++;
        Promise.resolve()
          .then(() => fn(list[ix], ix))
          .then((value) => {
            out[ix] = { status: 'fulfilled', value };
          })
          .catch((reason) => {
            out[ix] = { status: 'rejected', reason };
          })
          .finally(() => {
            active--;
            if (nextIndex >= list.length && active === 0) return resolve(out);
            launch();
          });
      }
    };

    if (!list.length) return resolve([]);
    launch();
  });
}

function getMultiSessionsMaxParallel(cfg, fallback) {
  const v = Number(cfg?.multi_sessions_max_parallel ?? 0);
  if (!Number.isFinite(v) || v <= 0) return Math.max(1, Number(fallback) || 1);
  return Math.max(1, Math.floor(v));
}

function getSelectedMultiSessionAccounts(cfg, log) {
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const enabled = accounts.filter((a) => a && a.enabled !== false && String(a.email || '').trim());
  if (!enabled.length) return [];

  const selected = Array.isArray(cfg.multi_sessions_accounts) ? cfg.multi_sessions_accounts : [];
  const keys = selected.map((v) => String(v ?? '').trim()).filter(Boolean);

  if (!keys.length) return enabled;

  const out = [];
  const seen = new Set();

  for (const k of keys) {
    const acc = findAccount(cfg, k);
    if (!acc) continue;
    if (acc.enabled === false) continue;
    const email = String(acc.email || '').trim();
    if (!email) continue;
    const low = email.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(acc);
  }

  if (!out.length) {
    if (log && log.warn) log.warn('Multi sessions enabled but no selected accounts matched. Falling back to all enabled accounts.');
    return enabled;
  }

  return out;
}

function sessionEmail(session) {
  const s = session && typeof session === 'object' ? session : {};
  const e = String(s.state?.currentEmail || s.boundAccount?.email || '').trim();
  return e;
}

function taskTargetsSession(task, session) {
  const list = Array.isArray(task?.accounts) ? task.accounts : [];
  if (!list.length) return true;
  const email = normalizeEmail(sessionEmail(session));
  return list.some((v) => normalizeEmail(v) === email);
}

function computeModeSignature(cfg, selectedMultiAccounts) {
  const multi = cfg && cfg.multi_sessions_enabled === true;
  const base = {
    multi,
    headless: Boolean(cfg && cfg.headless),
    private: Boolean(cfg && cfg.firefox_private_browsing === true)
  };

  if (!multi) return JSON.stringify(base);

  const emails = (Array.isArray(selectedMultiAccounts) ? selectedMultiAccounts : [])
    .map((a) => normalizeEmail(a && a.email))
    .filter(Boolean)
    .sort();

  return JSON.stringify({ ...base, emails });
}

function pickNextAccountAvoiding(state, cfg, currentEmail, avoidSet) {
  const now = Date.now();
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const avoid = avoidSet instanceof Set ? avoidSet : new Set();

  const enabled = accounts.filter((a) => a && a.enabled !== false && String(a.email || '').trim());
  if (!enabled.length) return { account: null, waitMs: 0 };

  const eligible = enabled.filter((a) => {
    const email = String(a.email || '').trim();
    const low = email.toLowerCase();
    if (avoid.has(low)) return false;

    const cooldown = Number(a.cooldown_after_use_ms ?? 0);
    if (Number.isFinite(cooldown) && cooldown > 0) {
      const last = state.lastUsed[email] || 0;
      if (now - last < cooldown) return false;
    }
    return true;
  });

  if (!eligible.length) {
    let minRemaining = 1000;
    for (const a of enabled) {
      const email = String(a.email || '').trim();
      const cooldown = Number(a.cooldown_after_use_ms ?? 0);
      if (!Number.isFinite(cooldown) || cooldown <= 0) continue;
      const last = state.lastUsed[email] || 0;
      const remaining = cooldown - (now - last);
      if (remaining > 0) minRemaining = Math.min(minRemaining, remaining);
    }
    return { account: null, waitMs: Math.max(250, minRemaining) };
  }

  const sorted = eligible
    .map((a, idx) => ({ a, idx }))
    .sort((x, y) => {
      const px = normalizePriority(x.a.priority, 3);
      const py = normalizePriority(y.a.priority, 3);
      if (px !== py) return py - px;
      return x.idx - y.idx;
    })
    .map((x) => x.a);

  let cursor = Number(state.cursor ?? 0);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

  const start = cursor % sorted.length;
  for (let i = 0; i < sorted.length; i++) {
    const ix = (start + i) % sorted.length;
    const acc = sorted[ix];
    if (String(acc.email || '').trim().toLowerCase() === String(currentEmail || '').trim().toLowerCase() && sorted.length > 1) continue;
    state.cursor = ix + 1;
    return { account: acc, waitMs: 0 };
  }

  state.cursor = start + 1;
  return { account: sorted[start], waitMs: 0 };
}

async function buildMultiSessions(cfg, log) {
  const accounts = getSelectedMultiSessionAccounts(cfg, log);
  if (!accounts.length) throw new Error('multi_sessions_enabled=true but there are no enabled accounts to run.');

  const sessions = [];
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const tag = `[${String(acc.name || acc.email || `S${i + 1}`)}]`;
    const driver = await buildDriver(cfg);

    sessions.push({
      id: i + 1,
      tag,
      log: mkPrefixedLogger(log, tag),
      driver,
      boundAccount: acc,
      state: { cursor: 0, currentEmail: '', lastUsed: {} },
      oneShotRan: {}
    });

    // Stagger driver startup to reduce flakiness.
    await sleep(800);
  }

  const autoLogin = cfg.multi_sessions_auto_login !== false;
  if (autoLogin && cfg.login_url) {
    for (const s of sessions) {
      const acc = s.boundAccount;
      if (!String(acc.password || '').trim()) {
        s.log.warn(`Auto login skipped. Empty password for ${describeAccount(acc)}.`);
        continue;
      }

      try {
        s.log.info(`Auto login as ${describeAccount(acc)}`);
        await navigateTo(s.driver, cfg, s.log, cfg.login_url);
        await doLogin(s.driver, cfg, s.log, acc);
        s.state.currentEmail = String(acc.email || '').trim();
        s.state.lastUsed[s.state.currentEmail] = Date.now();
      } catch (err) {
        s.log.warn(`Auto login failed: ${String(err?.message || err)}`);
        await saveScreenshot(s.driver, cfg, s.log, `auto_login_${normalizeEmail(acc.email).replace(/[^a-z0-9]+/g, '_')}`);
      }

      await sleep(500);
    }
  }

  return sessions;
}

async function quitSessions(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  for (const s of list) {
    try {
      if (s && s.driver) await s.driver.quit().catch(() => {});
    } catch {
      // ignore
    }
  }
}

// -----------------------------
// Main
// -----------------------------

(async () => {
  const configPath = resolveConfigPath();
  let cfg = loadConfig(configPath);
  let log = mkLogger(cfg);
  if (cfg.__config_path) log.info(`Using config: ${cfg.__config_path}`);

  if (!cfg.run_enabled) {
    log.warn('run_enabled=false. Exiting without running automation.');
    process.exit(0);
  }

  if (!cfg.accounts || !cfg.accounts.length) {
    log.error('You must specify at least one account in accounts[].');
    process.exit(1);
  }

  let driver = null;
  let sessions = [];
  let lastSig = '';

  // In multi sessions mode, each session is pinned to one account. SWITCH_ACCOUNT would
  // create conflicting state and is therefore disabled.
  const warnedMultiSwitch = new Set();

  const singleState = { cursor: 0, currentEmail: '', lastUsed: {} };
  const singleOneShotRan = {};

  async function rebuildModeIfNeeded(cfgNow) {
    const selected = cfgNow.multi_sessions_enabled === true ? getSelectedMultiSessionAccounts(cfgNow, log) : [];
    const sig = computeModeSignature(cfgNow, selected);
    if (sig === lastSig) {
      // Refresh per-session logger wrapper to pick up log-level changes.
      if (cfgNow.multi_sessions_enabled === true) {
        sessions = sessions.map((s) => ({ ...s, log: mkPrefixedLogger(log, s.tag) }));
      }
      return;
    }

    lastSig = sig;

    // Tear down previous mode.
    if (driver) {
      try { await driver.quit().catch(() => {}); } catch {}
      driver = null;
    }
    if (sessions.length) {
      await quitSessions(sessions);
      sessions = [];
    }

    if (cfgNow.multi_sessions_enabled === true) {
      log.info(`Starting multi sessions mode. Accounts: ${selected.map((a) => String(a.email || '').trim()).filter(Boolean).join(', ')}`);
      sessions = await buildMultiSessions(cfgNow, log);
    } else {
      log.info('Starting single session mode.');
      driver = await buildDriver(cfgNow);
      await sleep(1500);
    }
  }

  try {
    await rebuildModeIfNeeded(cfg);

    while (true) {
      await pausePoint(log);

      // Reload config each cycle. Allows editing while running.
      cfg = loadConfig(configPath);
      log = mkLogger(cfg);
      if (cfg.__config_path) log.debug(`Reloaded config: ${cfg.__config_path}`);

      if (!cfg.run_enabled) {
        log.warn('run_enabled=false. Stopping automation.');
        break;
      }

      await rebuildModeIfNeeded(cfg);

      const tasks = Array.isArray(cfg.tasks) ? cfg.tasks : [];
      const loopCheck = validateLoopTaskPlacement(tasks);
      if (!loopCheck.ok) {
        log.error(loopCheck.error);
        log.error('Stopping to prevent unexpected looping behavior. Fix your tasks order and restart.');
        break;
      }

      let invocations = 0;

      for (let i = 0; i < tasks.length; i++) {
        await pausePoint(log);
        const t = tasks[i];
        if (String(t?.type || '').trim() === 'LOOP_AUTOMATION') break;

        if (cfg.multi_sessions_enabled === true) {
          if (String(t?.type || '').trim() === 'SWITCH_ACCOUNT') {
            const key = String(t.id || `task_${i}`);
            if (!warnedMultiSwitch.has(key)) {
              log.warn(`Skipping SWITCH_ACCOUNT task "${key}". Multi sessions mode pins each session to one account. Remove this task.`);
              warnedMultiSwitch.add(key);
            }
            continue;
          }

          const targets = sessions.filter((s) => taskTargetsSession(t, s));
          if (!targets.length) {
            log.debug(`Skipping task ${String(t.id || '')}: no target sessions matched.`);
            continue;
          }

          const doOne = async (s, taskOverride) => {
            const res = await runTask(s.driver, cfg, s.log, taskOverride, s.state, s.oneShotRan, {
              boundAccount: s.boundAccount,
              sessionId: s.id,
              tag: s.tag
            });
            if (res && res.driver) s.driver = res.driver;
            // Keep the "bound account" aligned to the current session email after LOGIN.
            if (String(taskOverride.type || '').trim() === 'LOGIN') {
              const cur = String(s.state.currentEmail || '').trim();
              const acc = cur ? findAccount(cfg, cur) : null;
              if (acc) s.boundAccount = acc;
            }
            return res;
          };

          const limit = getMultiSessionsMaxParallel(cfg, targets.length);
          const results = await allSettledLimit(targets, limit, (s) => doOne(s, t));
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value && r.value.ran) invocations++;
            if (r.status === 'rejected') log.warn(`Task ${String(t.id || '')} session error: ${String(r.reason?.message || r.reason)}`);
          }
        } else {
          const res = await runTask(driver, cfg, log, t, singleState, singleOneShotRan, null);
          if (res && res.driver) driver = res.driver;
          if (res && res.ran) invocations++;
        }
      }

      if (!loopCheck.hasLoop) {
        log.info(`Run complete. Task invocations: ${invocations}. No LOOP_AUTOMATION task found, exiting.`);
        break;
      }

      const loopTask = tasks[tasks.length - 1] || {};
      const base = Number(loopTask.interval_ms ?? cfg.tasks_interval);
      const baseMs = Number.isFinite(base) && base >= 50 ? base : cfg.tasks_interval;
      const jitter = Number(cfg.jitter_ms ?? 0);
      const waitMs = baseMs + (jitter > 0 ? randomInt(0, jitter) : 0);

      log.info(`Loop complete. Task invocations: ${invocations}. Waiting ${waitMs}ms before restarting.`);
      await sleep(waitMs);
    }
  } catch (err) {
    if (err && err.name === 'StopRequestedError') {
      try {
        log = log || mkLogger(cfg);
        log.info('Stop requested. Shutting down...');
      } catch {
        console.log('[INFO] Stop requested. Shutting down...');
      }
      process.exitCode = 0;
    } else {
      console.error(`[ERROR] Unhandled error: ${String(err && err.stack ? err.stack : err)}`);
      try {
        // Best-effort screenshot for single session mode.
        if (driver) await saveScreenshot(driver, cfg || loadConfig(configPath), log || mkLogger(cfg), 'fatal_error');
      } catch {
        // ignore
      }
      process.exitCode = 1;
    }
  } finally {
    try {
      if (driver) await driver.quit().catch(() => {});
    } catch {}
    try {
      if (sessions.length) await quitSessions(sessions);
    } catch {}
  }
})();
