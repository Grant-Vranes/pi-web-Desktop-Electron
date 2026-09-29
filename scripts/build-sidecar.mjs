#!/usr/bin/env node
// Build the Tauri sidecar layout:
//   src-tauri/binaries/pi-web-server-<target-triple>   (official Node binary)
//   src-tauri/resources/pi-web/                        (app payload:
//     bin/ .next/ public/ package.json node_modules/)
//
// The sidecar is a stock Node runtime; Rust spawns it with
// `resources/pi-web/bin/pi-web.js` (see src-tauri/src/main.rs). Using the
// official Node binary instead of a SEA bundle avoids SEA's inability to
// load Next.js + native modules (node-pty).
//
// Usage:
//   node scripts/build-sidecar.mjs            # build Next + assemble payload
//   node scripts/build-sidecar.mjs --no-build # reuse an existing .next build
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, chmodSync, createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { platform, arch } from "node:os";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcTauri = path.join(repoRoot, "src-tauri");
const payloadDir = path.join(srcTauri, "resources", "pi-web");
const binariesDir = path.join(srcTauri, "binaries");

const noBuild = process.argv.includes("--no-build");
const require = createRequire(import.meta.url);
const { version: nodeVersion } = process;

function fail(message) {
  console.error(`[build-sidecar] ${message}`);
  process.exit(1);
}

// Map current platform to the Rust target triple tauri expects for externalBin.
function targetTriple() {
  const p = platform();
  const a = arch();
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  if (p === "linux" && a === "arm64") return "aarch64-unknown-linux-gnu";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "win32" && a === "x64") return "x86_64-pc-windows-msvc";
  if (p === "win32" && a === "arm64") return "aarch64-pc-windows-msvc";
  fail(`unsupported platform ${p}-${a}`);
}

async function downloadNode(triple) {
  const p = platform();
  const ext = p === "win32" ? "zip" : "tar.gz";
  const url = `https://nodejs.org/dist/v${nodeVersion}/node-${nodeVersion}-${p}-${arch()}.${ext}`;
  const outBin = path.join(binariesDir, `pi-web-server-${triple}${p === "win32" ? ".exe" : ""}`);
  console.log(`[build-sidecar] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) fail(`node download failed: HTTP ${response.status}`);
  const staging = path.join(srcTauri, "target", "sidecar-staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = path.join(staging, `node.${ext}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  // Extract just the node binary (bsdtar handles both tar.gz and zip).
  const extract = spawnSync("bsdtar", ["-xf", archive, "-C", staging, "-s", `|.*node(.exe)?|node${p === "win32" ? ".exe" : ""}|`], { stdio: "pipe" });
  // bsdtar pattern substitution can be finicky; extract the whole archive
  // and find the binary instead.
  if (extract.status !== 0) {
    const untar = spawnSync("bsdtar", ["-xf", archive, "-C", staging], { stdio: "pipe" });
    if (untar.status !== 0) fail("failed to extract node archive (bsdtar required)");
  }
  const found = findFile(staging, p === "win32" ? "node.exe" : "node");
  if (!found) fail("node binary not found in archive");
  mkdirSync(binariesDir, { recursive: true });
  cpSync(found, outBin);
  if (p !== "win32") chmodSync(outBin, 0o755);
  rmSync(staging, { recursive: true, force: true });
  console.log(`[build-sidecar] sidecar -> ${outBin}`);
}

function findFile(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSafe(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

function readdirSafe(dir) {
  try {
    return require("node:fs").readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function main() {
  const triple = targetTriple();

  // 1. Next build (skip with --no-build when .next is fresh).
  if (!noBuild) {
    console.log("[build-sidecar] running npm run build …");
    const build = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    if (build.status !== 0) fail("next build failed");
  } else if (!existsSync(path.join(repoRoot, ".next", "BUILD_ID"))) {
    fail("--no-build given but .next/BUILD_ID is missing; run a build first");
  }

  // 2. Assemble the payload.
  rmSync(payloadDir, { recursive: true, force: true });
  mkdirSync(payloadDir, { recursive: true });
  console.log("[build-sidecar] assembling payload …");
  cpSync(path.join(repoRoot, "bin"), path.join(payloadDir, "bin"), { recursive: true });
  cpSync(path.join(repoRoot, "public"), path.join(payloadDir, "public"), { recursive: true });
  cpSync(path.join(repoRoot, "package.json"), path.join(payloadDir, "package.json"));
  cpSync(path.join(repoRoot, "next.config.ts"), path.join(payloadDir, "next.config.ts"));
  cpSync(path.join(repoRoot, ".next"), path.join(payloadDir, ".next"), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.next${path.sep}cache`)
      && !src.includes(`${path.sep}.next${path.sep}dev`),
  });
  cpSync(path.join(repoRoot, "node_modules"), path.join(payloadDir, "node_modules"), { recursive: true, dereference: true });

  // Prune dev dependencies from the copied tree.
  console.log("[build-sidecar] pruning dev dependencies …");
  const prune = spawnSync("npm", ["prune", "--omit=dev"], { cwd: payloadDir, stdio: "inherit" });
  if (prune.status !== 0) {
    console.warn("[build-sidecar] npm prune failed; payload keeps devDependencies (larger bundle, still functional)");
  }

  // 3. Node sidecar binary.
  await downloadNode(triple);

  console.log("[build-sidecar] done. Run: cd src-tauri && cargo tauri build");
}

await main();
