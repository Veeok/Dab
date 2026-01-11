"use strict";

const path = require("path");
const { ensureGeckodriver } = require("./geckodriver");

// electron-builder Arch enum values (from docs): ia32=0, x64=1, armv7l=2, arm64=3, universal=4
function archToString(arch) {
  if (typeof arch === "string") return arch;
  switch (arch) {
    case 0: return "ia32";
    case 1: return "x64";
    case 2: return "armv7l";
    case 3: return "arm64";
    case 4: return "universal";
    default: return String(arch);
  }
}

exports.default = async function beforePack(context) {
  const projectDir = context.appDir || process.cwd();
  const platform = context.electronPlatformName || process.platform;
  const arch = archToString(context.arch);

  // For mac builds, it is common to publish both x64 and arm64.
  // If the current build arch is "universal", fetch both.
  if (platform === "darwin" && (arch === "universal" || arch === "x64" || arch === "arm64")) {
    await ensureGeckodriver(projectDir, "darwin", "x64");
    await ensureGeckodriver(projectDir, "darwin", "arm64");
    return;
  }

  // Default: fetch the exact platform/arch being built.
  await ensureGeckodriver(projectDir, platform, arch === "universal" ? "x64" : arch);
};
