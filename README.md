# Dab

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

```bash
npm install
npm start
