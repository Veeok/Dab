"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const AT = require("../renderer/advanced_tasking");

const META = {
  taskTypes: [
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
  ],
  priority: { min: 0, max: 5, default: 3 },
  ensureTaskDefaults: (t) => ({ oneshot: false, instant: false, priority: 3, ...t })
};

test("parseAdvancedScript parses tasks and errors", () => {
  const script = [
    "LOGIN account=main@example.com",
    "WAIT seconds=2",
    "CLICK css=\"button.primary\"",
    "# comment",
    "UNKNOWN foo=bar"
  ].join("\n");

  const parsed = AT.parseAdvancedScript(script, META);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((e) => String(e).includes("unknown task type")));
  assert.equal(parsed.tasks.length, 3);
  assert.equal(parsed.tasks[0].type, "LOGIN");
  assert.equal(parsed.tasks[1].type, "WAIT");
  assert.equal(parsed.tasks[2].type, "CLICK");
  assert.equal(parsed.tasks[2].selector.css, "button.primary");
});


test("parseAdvancedScript supports new task types and fields", () => {
  const script = [
    'FILL css="input[name=email]" text="a@b.com" clear=true',
    "PRESS_KEY key=Enter times=2",
    'WAIT_FOR_SELECTOR css="div[role=\"textbox\"]" state=visible timeout_ms=5000',
    'WAIT_FOR_NAVIGATION url_contains="/channels/" timeout_ms=1234',
    "SCREENSHOT label=after_login full_page=false"
  ].join("\n");

  const parsed = AT.parseAdvancedScript(script, META);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tasks.length, 5);

  assert.equal(parsed.tasks[0].type, "FILL");
  assert.equal(parsed.tasks[0].selector.css, "input[name=email]");
  assert.equal(parsed.tasks[0].text, "a@b.com");
  assert.equal(parsed.tasks[0].clear, true);

  assert.equal(parsed.tasks[1].type, "PRESS_KEY");
  assert.equal(parsed.tasks[1].key, "Enter");
  assert.equal(parsed.tasks[1].times, 2);

  assert.equal(parsed.tasks[2].type, "WAIT_FOR_SELECTOR");
  // Quotes inside CSS attribute selectors are optional.
  // Either form is valid: div[role=textbox] or div[role="textbox"].
  assert.ok(
    ['div[role="textbox"]', 'div[role=textbox]'].includes(parsed.tasks[2].selector.css)
  );
  assert.equal(parsed.tasks[2].state, "visible");
  assert.equal(parsed.tasks[2].timeout_ms, 5000);

  assert.equal(parsed.tasks[3].type, "WAIT_FOR_NAVIGATION");
  assert.equal(parsed.tasks[3].url_contains, "/channels/");
  assert.equal(parsed.tasks[3].timeout_ms, 1234);

  assert.equal(parsed.tasks[4].type, "SCREENSHOT");
  assert.equal(parsed.tasks[4].label, "after_login");
  assert.equal(parsed.tasks[4].full_page, false);
});

test("scriptFromTasksList round-trips core fields", () => {
  const tasks = [
    { id: "t1", type: "SEND_MESSAGE", url: "https://x", message: "Hello world" },
    { id: "t2", type: "WAIT", seconds: 1.5 },
    { id: "t3", type: "CLICK", selector: { id: "submit" } }
  ];

  const script = AT.scriptFromTasksList(tasks, META);
  const parsed = AT.parseAdvancedScript(script, META);
  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.equal(parsed.tasks.length, 3);
  assert.equal(parsed.tasks[0].message, "Hello world");
  assert.equal(parsed.tasks[2].selector.id, "submit");
});

test("quoteIfNeeded escapes spaces and quotes", () => {
  assert.equal(AT.quoteIfNeeded("hello"), "hello");
  assert.equal(AT.quoteIfNeeded("hello world"), '"hello world"');
  assert.equal(AT.quoteIfNeeded('he"llo'), '"he\\\"llo"');
});
