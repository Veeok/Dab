# Dab

Dab is an Electron UI plus a Selenium runner (`index.js`) for Discord automation.

## Install and run
```bash
npm install
npm start
```

On first launch, Dab creates a default configuration automatically and loads it.

## Configuration files
- Dab stores its default config in the app user-data folder. It does not require a `config.json` in the project directory.
- Use **Import configuration** to load a different `.json` file.
- The runner receives the selected config path via the `DAB_CONFIG_PATH` environment variable.

## Multiple account control (multi sessions)
Multi sessions runs the same tasks on multiple accounts at the same time.

How it works:
- When **Multi sessions** is enabled in **Accounts**, the runner creates **one Firefox session per selected account**.
- Each session has its own profile. Cookies and local storage are isolated per account.
- Each task is executed “in sync” across all sessions.

Optional concurrency cap:
- `multi_sessions_max_parallel` limits how many sessions may execute a task at the same time.
- `0` means unlimited.

Account selection:
- In **Accounts**, enable **Multi sessions** and select the accounts to run.
- If the multi sessions selection is empty, the runner uses all enabled accounts.

Per-task targeting:
- Every task has an **accounts** checklist.
- Leave it empty to run the task on all sessions.
- Select specific accounts to run that task only on those sessions.

## LOGOUT and SWITCH_ACCOUNT
Discord session state is not reliably cleared by visiting `/logout` alone.

Defaults (recommended for Discord):
- `restart_browser_on_logout = true`
- `restart_browser_on_switch_account = true`

Effect:
- LOGOUT restarts the Firefox session (fresh temporary profile). This clears cookies and all client storage.
- SWITCH_ACCOUNT can also restart the Firefox session before logging into the next account.

In multi sessions mode:
- LOGOUT applies to the selected sessions (task account targeting) and restarts only those sessions.
- SWITCH_ACCOUNT is skipped (redundant). Each session is pinned to a single account. Use Multi sessions account selection instead.


## UPLOAD_FILE (user-friendly file picker)
UPLOAD_FILE no longer requires typing file paths in the task.

In the Tasks editor:
- Click **Upload files**.
- Select one or more files.
- Remove a file with the ✕ button.

In the config:
- The task uses `files: []` (array of paths).
- The legacy `file` field is still supported for backward compatibility.

## Requirements
- Node.js 18+
- Firefox (used by `selenium-webdriver`)
- `geckodriver` available on PATH

Notes:
- This repo includes a Linux x86_64 `geckodriver` binary. Zip downloads may lose the executable bit. The UI attempts a best-effort `chmod` when starting automation.
- On macOS or Windows, install `geckodriver` separately and ensure it is on PATH.

## Security
If you save passwords in `config.json`, they are stored in plain text.

Use **Export sanitized** to produce a shareable config with passwords removed.

## Versioning
- `config_version` is the schema migration version.
- `version` is the human-facing configuration version. It is set to `1.5.3`.


## UI theme
`ui_theme` controls the Dab UI theme:

- `system`: Follow Windows theme.
- `dark`: Force dark.
- `amoled`: Pure-black dark theme.
- `light`: White (light) theme.

You can change it in **General → Theme**.

