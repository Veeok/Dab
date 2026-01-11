"use strict";

const path = require("path");
const { ensureGeckodriver } = require("./geckodriver");

async function main() {
  const projectDir = path.resolve(__dirname, "..");
  const args = new Set(process.argv.slice(2));

  const targets = [];
  if (args.has("--all")) {
    targets.push(["win32", "x64"]);
    targets.push(["linux", "x64"]);
    targets.push(["darwin", "x64"]);
    targets.push(["darwin", "arm64"]);
  } else {
    // Current platform only
    const p = process.platform;
    const a = process.arch === "x64" ? "x64" : process.arch;
    targets.push([p, a]);
    if (p === "darwin") {
      // On mac, fetch both so you can build universal later if desired.
      targets.push(["darwin", "x64"]);
      targets.push(["darwin", "arm64"]);
    }
  }

  for (const [p, a] of targets) {
    await ensureGeckodriver(projectDir, p, a);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
