"use strict";

const https = require("https");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

/**
 * Downloads and extracts Mozilla geckodriver binaries into ./drivers/<platform>-<arch>/.
 *
 * Default behavior: fetch the latest GitHub release, unless GECKODRIVER_VERSION is set
 * to a tag like "v0.35.0".
 *
 * Notes:
 * - Windows assets are .zip (expanded via PowerShell Expand-Archive).
 * - Linux/macOS assets are .tar.gz (expanded via tar).
 */

function log(msg) {
  console.log(`[geckodriver] ${msg}`);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        headers: {
          "User-Agent": "dab-electron-builder",
          "Accept": "application/vnd.github+json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return resolve(httpGetJson(res.headers.location));
          }
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} for ${url}. Body: ${body.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function downloadToFile(url, destFile) {
  return new Promise((resolve, reject) => {
    const doReq = (u) => {
      const req = https.request(
        u,
        {
          headers: {
            "User-Agent": "dab-electron-builder",
            "Accept": "application/octet-stream",
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return doReq(res.headers.location);
          }
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          const out = fs.createWriteStream(destFile);
          res.pipe(out);
          out.on("finish", () => out.close(resolve));
          out.on("error", reject);
        }
      );
      req.on("error", reject);
      req.end();
    };
    doReq(url);
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function extractZip(zipPath, destDir) {
  // Use PowerShell on Windows for reliable extraction without extra deps.
  await fsp.mkdir(destDir, { recursive: true });
  const ps = process.env.ComSpec ? "powershell.exe" : "powershell";
  const cmd = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`,
  ];
  await run(ps, cmd);
}

async function extractTarGz(tarGzPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  await run("tar", ["-xzf", tarGzPath, "-C", destDir]);
}

function pickAssetUrl(releaseJson, assetName) {
  const assets = releaseJson.assets || [];
  const a = assets.find((x) => x && x.name === assetName);
  return a ? a.browser_download_url : null;
}

function geckoAssetName(platform, arch, tag) {
  // tag includes leading "v", e.g. v0.35.0
  if (platform === "win32") {
    if (arch !== "x64") return null;
    return `geckodriver-${tag}-win64.zip`;
  }
  if (platform === "linux") {
    if (arch === "x64") return `geckodriver-${tag}-linux64.tar.gz`;
    if (arch === "arm64") return `geckodriver-${tag}-linux-aarch64.tar.gz`;
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return `geckodriver-${tag}-macos.tar.gz`;
    if (arch === "arm64") return `geckodriver-${tag}-macos-aarch64.tar.gz`;
    return null;
  }
  return null;
}

async function ensureGeckodriver(projectDir, platform, arch) {
  const driverName = platform === "win32" ? "geckodriver.exe" : "geckodriver";
  const outDir = path.join(projectDir, "drivers", `${platform}-${arch}`);
  const outPath = path.join(outDir, driverName);

  if (isFile(outPath)) {
    log(`OK: ${platform}-${arch} already present`);
    return outPath;
  }

  const desiredTag = process.env.GECKODRIVER_VERSION?.trim();
  let release;
  if (desiredTag) {
    log(`Fetching geckodriver release ${desiredTag} metadata`);
    release = await httpGetJson(`https://api.github.com/repos/mozilla/geckodriver/releases/tags/${desiredTag}`);
  } else {
    log(`Fetching latest geckodriver release metadata`);
    release = await httpGetJson("https://api.github.com/repos/mozilla/geckodriver/releases/latest");
  }

  const tag = release.tag_name;
  if (!tag) throw new Error("GitHub release metadata missing tag_name.");

  const asset = geckoAssetName(platform, arch, tag);
  if (!asset) {
    throw new Error(`No geckodriver asset mapping for ${platform}-${arch}.`);
  }

  const url = pickAssetUrl(release, asset);
  if (!url) {
    const available = (release.assets || []).map((a) => a.name).join(", ");
    throw new Error(`Asset not found: ${asset}. Available: ${available}`);
  }

  await fsp.mkdir(outDir, { recursive: true });

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "geckodriver-"));
  const dlPath = path.join(tmpRoot, asset);
  const extractDir = path.join(tmpRoot, "extract");

  log(`Downloading ${asset}`);
  await downloadToFile(url, dlPath);

  log(`Extracting ${asset}`);
  if (asset.endsWith(".zip")) await extractZip(dlPath, extractDir);
  else await extractTarGz(dlPath, extractDir);

  // Find the extracted binary (archives typically contain a single file named geckodriver[.exe]).
  const extracted = path.join(extractDir, driverName);
  if (!isFile(extracted)) {
    // sometimes the archive extracts into a nested folder; search one level deep
    const entries = await fsp.readdir(extractDir, { withFileTypes: true });
    let found = null;
    for (const e of entries) {
      if (e.isDirectory()) {
        const cand = path.join(extractDir, e.name, driverName);
        if (isFile(cand)) {
          found = cand;
          break;
        }
      }
    }
    if (!found) throw new Error(`Extracted driver not found in ${extractDir}`);
    await fsp.copyFile(found, outPath);
  } else {
    await fsp.copyFile(extracted, outPath);
  }

  // Ensure executable bit on unix.
  if (platform !== "win32") {
    await fsp.chmod(outPath, 0o755).catch(() => {});
  }

  log(`Installed ${platform}-${arch} -> ${path.relative(projectDir, outPath)}`);
  return outPath;
}

module.exports = {
  ensureGeckodriver,
};
