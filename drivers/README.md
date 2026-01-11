# Bundled geckodriver (Option B)

This app bundles **geckodriver** per platform so packaged builds work offline.

## Layout

- drivers/win32-x64/geckodriver.exe
- drivers/linux-x64/geckodriver
- drivers/darwin-x64/geckodriver
- drivers/darwin-arm64/geckodriver

## How it is kept up to date

- `electron-builder` runs `scripts/ensure-drivers.js` (beforePack hook).
- The hook downloads the latest geckodriver release from GitHub unless `GECKODRIVER_VERSION` is set.

## Manual prefetch

- Download all drivers (all platforms):

  npm run fetch:drivers

- Pin a specific version tag:

  GECKODRIVER_VERSION=v0.35.0 npm run fetch:drivers
