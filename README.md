# Dab

Dab is an open source desktop app for building and running Discord automation workflows.

It includes two parts.

- **Electron UI**: configure, validate, run, inspect logs, and roll back changes safely.
- **Runner** (`index.js`): executes your task list using **Selenium WebDriver + Firefox**, driven by the config path the UI provides via `DAB_CONFIG_PATH`.

Discord can change its UI at any time. Automation can break. Use at your own risk and follow the rules of any service you automate.

---

## What Dab does

- Creates and manages a **configuration file** (`config.json`).
- Lets you define:
  - Accounts
  - Task lists (automation steps)
  - Runtime behavior (headless, delays, logging, screenshots)
- Validates your config against a schema:
  - Errors and warnings
  - Field paths
  - “Go to setting” actions
- Runs automation with an **Automation console**:
  - Run, Pause, Stop
  - Level-filtered logs (info, debug, warn, error)
  - Search, Copy, Clear, Auto scroll
- Supports:
  - **Single session** (one browser)
  - **Multi sessions** (one Firefox session per account, tasks run in sync)
- Saves safely:
  - **Every Save creates a History snapshot**
  - **Revert** to restore older snapshots

---

## Quick start

1. Fill **General**, **Accounts**, and **Tasks**.
2. Open **Validation**, fix errors.
3. Click **Save** (creates a History snapshot).
4. Open **Automation**, click **Run**.

Tip: `Ctrl+S` saves.

---

## Install

### Option A. Run from source (recommended for devs)

Requirements:
- Node.js 18+
- Firefox installed
- `geckodriver` available on PATH
  - This repo may include a Linux x86_64 `geckodriver` binary in the project root.
  - Zip downloads can lose the executable bit. If needed:
    - `chmod +x geckodriver`

Install and start:
=======
Dab is an open source desktop app for building and running Discord automations.
It combines an Electron UI with a Selenium runner (`index.js`) and provides the full workflow: configure, validate, run, inspect logs, and roll back changes safely.

## What Dab includes

- **Config-driven automation runner**
  - Runs `index.js` using the currently opened configuration path via `DAB_CONFIG_PATH`.

- **Validation gate**
  - Validates your config against the schema.
  - Run is blocked when the config is **invalid** or **unsaved**.
  - Issues can deep-link you to the relevant setting.

- **Task building, two ways**
  - **Tasks UI**: search, filters, expand, duplicate, remove.
  - **Advanced tasking**: line-based editor (one task per line) that generates the same `tasks` array used by the runner.

- **Automation console**
  - Start automation runs from the UI.
  - Pause and stop controls.
  - Live, searchable logs with level filtering and quick Copy/Clear.

- **History snapshots**
  - Every Save creates a versioned snapshot.
  - One-click Revert.
  - A safety snapshot is created before restore.

- **Multi-account support**
  - Single session or multi sessions (one Firefox session per account).

## Install and run
>>>>>>> 69c74fb (first commit)

```bash
npm install
npm start
<<<<<<< HEAD
```

### Option B. Build a packaged app

```bash
npm run dist:win
npm run dist:mac
npm run dist:linux
```
- Build outputs usually go to dist/. Do not commit build artifacts.

# Configuration files

- Dab stores its default config in the app user-data folder.
- It does not require a config.json in the project directory.
- Use Import configuration to load a different .json file.
- The runner receives the selected config path via the DAB_CONFIG_PATH environment variable.

# Validation, saving, and History

 ## Validation
 - The header pill shows combined state like Valid, saved or Invalid, unsaved.
 - Use Actions → Validate after significant edits.
 - Fix errors first. Warnings may still run, but can reduce reliability.

 ## Save
 - Save writes config.json.
 - Every Save creates a History snapshot.

 ## History
 - The History page lists saved versions.
 - Revert overwrites the current config with a selected snapshot.
 - A safety snapshot is created before restore.

 # Automation and logs
 * Runs execute index.js using the currently open config path.
 - If the config is invalid or unsaved, the Automation tab will gate the run and show what to fix.
  - Logs:
   - Level dropdown (info, debug, warn, error)
    - Search box
    - Copy and Clear
     - Optional auto scroll

# General settings (common)
- These are set in General and written to config.json exactly.
* Run enabled: master kill switch. Must be enabled to run automation.
* Headless: good for servers, disable for debugging.
* Tasks interval (ms): delay between loop cycles when LOOP_AUTOMATION is used (minimum 50ms).
* Themes: system, dark, AMOLED, light.
* Other runtime toggles may include login delay behavior and screenshot behavior depending on your schema.

## Accounts

Accounts are managed in the **Accounts** tab.

Typical fields:

- `name`. UI label.
- `email`. Login.
- `password`. Stored in config, see Security.
- `enabled`. Disable without deleting.
- `priority`. Used for selection order, if applicable.
- `notes`. UI-only helper.
- `cooldown_after_use_ms`. Prevents selection too frequently, if used by runner.
- `max_tasks_per_session`. Legacy in some builds.

Multi sessions selection and per-task targeting are covered below.

## Sessions

### Single session

- One Firefox session.
- Tasks run sequentially.
- You may rotate accounts using `SWITCH_ACCOUNT`.

### Multi sessions (multiple account control)

Multi sessions runs the same tasks on multiple accounts at the same time.

How it works:

- When Multi sessions is enabled in Accounts, Dab creates one Firefox session per selected account.
- Each session has its own profile. Cookies and local storage are isolated per account.
- Each task is executed in sync across all sessions.

Optional concurrency cap:

- `multi_sessions_max_parallel` limits how many sessions may execute a task at the same time.
- `0` means unlimited.

Account selection:

- In Accounts, enable Multi sessions and select accounts to run.
- If the multi sessions selection is empty, the runner uses all enabled accounts.

Per-task targeting:

- Every task has an account targeting option.
- Leave it empty to run the task on all sessions.
- Select specific accounts to run that task only on those sessions.

## LOGOUT and SWITCH_ACCOUNT

Discord session state is not reliably cleared by visiting `/logout` alone.

Recommended defaults:

- `restart_browser_on_logout = true`
- `restart_browser_on_switch_account = true`

Effect:

- `LOGOUT` restarts the Firefox session, fresh profile. Clears cookies and client storage.
- `SWITCH_ACCOUNT` can also restart before logging into the next account.

In multi sessions mode:

- `LOGOUT` applies to targeted sessions and restarts only those sessions.
- `SWITCH_ACCOUNT` is skipped, redundant. Each session is pinned to a single account.

## Tasks

A task is one automation step. Tasks run in order.

### Tasks UI

In Tasks:

- Use task names to keep the list readable. IDs are internal.
- Use search and filters to find tasks quickly.
- Duplicate tasks to iterate quickly.

### LOOP_AUTOMATION

- `LOOP_AUTOMATION` repeats the task list.
- Without it, the run ends after the last task.

### UPLOAD_FILE (user-friendly file picker)

In the Tasks editor:

- Click **Upload files**.
- Select one or more files.
- Remove a file with the ✕ button.

In the config:

- The task uses `files: []`, an array of paths.
- The legacy `file` field is still supported for backward compatibility.

## Advanced tasking (line-based editor)

The **Advanced tasking** tab provides a line-based script editor.

- One task per line.
- Syntax: `TYPE key=value key=value`
- Use quotes for spaces.
- Lines starting with `#` or `//` are ignored.
- This editor generates the same `tasks` array used by the runner.

Buttons:

- **Load from Tasks**. Converts the current task list into script lines.
- **Apply to Tasks**. Overwrites Tasks from the script.

Example:

```log
# One task per line
LOGIN account="user@example.com"
NAVIGATE url="https://discord.com/channels/..."
SEND_MESSAGE url="https://discord.com/channels/..." message="Hello"
WAIT seconds=2
LOOP_AUTOMATION interval_ms=1000
```
Validate and Save after applying.

## Task reference

Exact fields depend on the task type. Below are the common task types used by Dab builds.

### Core

#### LOGIN
- Purpose. Sign into Discord.
- Common fields. `account` (single session), plus login behavior fields depending on config.

#### LOGOUT
- Purpose. Clear auth state, often implemented via browser restart.

#### SWITCH_ACCOUNT (single session only)
- Purpose. Log in as a different account within one session.
- Note. Skipped in Multi sessions mode.

#### NAVIGATE
- Required. `url`

#### WAIT
- Required. `seconds`

#### LOOP_AUTOMATION
- Purpose. Repeat the task list.
- Common fields. `interval_ms`, minimum 50 ms.

### Messaging

#### SEND_MESSAGE
- Common fields. `url`, `message`

#### SLASH_COMMAND (if present in your build)
- Common fields. `url`, `command`, plus optional selection tuning fields.

#### SEND_EMOJI (if present)
- Common fields. `url`, `emoji`

### Interaction and waits

#### CLICK (if present)
- Common fields. `selector` (css or id)

#### FILL (if present)
- Common fields. `selector`, `text`, optional `clear`

#### PRESS_KEY (if present)
- Common fields. `key`, optional `times`

#### WAIT_FOR_SELECTOR (if present)
- Common fields. `selector`, optional `state`, optional `timeout_ms`

#### WAIT_FOR_NAVIGATION (if present)
- Common fields. `url` or `url_contains`, optional `timeout_ms`

### Media and files

#### SCREENSHOT (if present)
- Common fields. `label` or `path`, optional `full_page`

#### UPLOAD_FILE
- Required. `url`, `files`

If you want this section to be perfectly accurate, generate it directly from your repo’s task schema list and keep it in sync with code.

## Troubleshooting

### Run disabled
- Go to General.
- Enable **Allow automation to run**.
- Save.

### Invalid, unsaved
- Go to Validation.
- Fix errors.
- Save.

### Automation exits immediately
- Check logs for missing Firefox or geckodriver path issues.

### Tasks are flaky
- Prefer `WAIT_FOR_SELECTOR` over fixed waits.
- Increase element wait timeout.
- Confirm selectors and URLs still match Discord’s current UI.

## Security

- If you save passwords in `config.json`, they are stored in plain text.
- Do not share configs publicly.
- Use **Export sanitized** to share configs with passwords removed.

## Versioning

- `config_version` is the schema migration version.
- `version` is the human-facing configuration version. Your config may display a specific value in UI.

## UI theme

`ui_theme` controls the Dab UI theme:

- `system`. Follow OS theme.
- `dark`. Force dark.
- `amoled`. Pure-black dark theme.
- `light`. Light theme.

Change it in **General → Theme**.

## License and credits

- License. MIT
- Author. Veok
- Built with Electron, AJV, selenium-webdriver


## Cross-platform packaging notes

- Linux AppImage and deb should be built on Linux (or via Docker on Windows): `npm run dist:linux:docker`.
- macOS builds should be produced on macOS (local or CI).
- This repo uses Option B: geckodriver is bundled per platform and is downloaded automatically during `electron-builder` (beforePack hook). You can prefetch drivers with `npm run fetch:drivers`.
=======
>>>>>>> 69c74fb (first commit)
