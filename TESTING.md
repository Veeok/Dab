# Testing and Debugging Guide

This document is operator and developer friendly. It focuses on what to test and how to reproduce issues.

## Quick workflow

1. Run automated tests.
2. Run the manual UI checklist.
3. When something fails, capture logs and the exact config used.

## Automated tests

Prerequisite

- Run `npm install` once in the project root.

Run tests

```bash
npm test
```

What is covered

- Config validation and migration (Ajv + extra logic)
- History store logic (snapshot, list, restore, pruning)
- Advanced tasking script parsing and serialization

Notes

- If dependencies are not installed, the config tests will be skipped.

## Manual UI test checklist

Use this list to do high confidence regression testing after changes.

### A. Startup and file handling

- Launch the app.
- Confirm a default config is created in the userData directory.
- Open an existing config.json via Open.
- Confirm the top status pills show sensible defaults (Saved, Idle).

### B. Validation

- Click Validate on a known good config. Expect: Valid.
- Introduce an error.
  - Example: add a LOGIN task without account.
  - Click Validate. Expect: Invalid with an actionable error.

### C. Save and history

- Make a small edit.
- Click Save.
- Go to History.
- Confirm a new snapshot appears.
- Click Revert on the most recent snapshot.
- Confirm the config reloads and reflects the reverted content.

Negative checks

- Try to revert when no config is loaded. Expect: clean empty state.
- Try multiple saves quickly. Expect: list stays stable and no crash.

### D. Tasks view

- Add 3 tasks.
- Drag reorder tasks. Confirm order persists.
- Add LOOP_AUTOMATION.
- Ensure it is last.
- Try to move LOOP_AUTOMATION above other tasks and Save.
  - Expect: Save blocked by validation.

### E. Advanced tasking

Happy path

- Open Advanced tasking.
- Click Load from Tasks. Confirm the script populates.
- Edit the script.
  - Example: add `WAIT seconds=1`.
- Confirm Parse errors shows (none).
- Click Apply to Tasks.
- Go to Tasks. Confirm the task list reflects changes.
- Validate and Save.

Negative checks

- Add an unknown task type (for example `FOO`). Expect: parse error.
- Add `CLICK` without `css=` or `selector.id=`. Expect: parse error.
- Click Apply to Tasks with errors present. Expect: no changes applied.

### F. Export

- Click Export sanitized.
  - Confirm the file writes and passwords are blank.
- Click Export.
  - Confirm the warning dialog appears.
  - Confirm the file writes and includes credentials.

### G. Run and stop

- Click Run.
- Confirm Running pill toggles and output appears in the log panel.
- Click Stop.
- Confirm it returns to Idle.

## Bug report template

Copy and fill:

1. Version: (app version, commit hash if applicable)
2. OS: (Windows/macOS/Linux + version)
3. Steps to reproduce:
   -
   -
4. Expected result:
5. Actual result:
6. Logs:
   - paste the relevant section from the log panel
7. Config sample:
   - attach the smallest config.json that reproduces the issue
