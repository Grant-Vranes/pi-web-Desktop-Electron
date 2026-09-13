#!/usr/bin/env node
// Downloads the pinned diagrams.net webapp (draw.war) and unpacks it into
// public/drawio/ for the offline drawio viewer/editor. public/drawio is
// gitignored — build/dev scripts run this automatically. The version is
// pinned deliberately; upgrading drawio is an explicit human action
// (change PINNED_VERSION, re-run).
// --soft: dev-time best effort — warn and exit 0 on failure so `npm run dev`
// never blocks; the viewer falls back to the text view at runtime.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import extract from "extract-zip";

const PINNED_VERSION = "31.4.5";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public", "drawio");
const versionFile = join(target, "DRAWIO_VERSION");
const soft = process.argv.includes("--soft");

function fail(message) {
  if (soft) {
    console.warn(`[fetch-drawio] ${message}`);
    console.warn("[fetch-drawio] continuing without drawio assets; .drawio files will open as text.");
    process.exit(0);
  }
  console.error(`[fetch-drawio] ${message}`);
  process.exit(1);
}

if (existsSync(versionFile) && readFileSync(versionFile, "utf8").trim() === PINNED_VERSION) {
  console.log(`drawio v${PINNED_VERSION} already vendored at ${target}`);
  process.exit(0);
}

const url = `https://github.com/jgraph/drawio/releases/download/v${PINNED_VERSION}/draw.war`;
const warPath = join(root, "public", `draw-${PINNED_VERSION}.war`);
mkdirSync(join(root, "public"), { recursive: true });

// The whole download -> write -> unpack -> sanity -> version-write sequence
// is guarded so ANY throw routes through fail(): --soft must never crash dev
// with a non-zero exit. The temp war is cleaned in a finally, so an early
// abort or unpack failure cannot leave a ~90MB draw-*.war behind.
console.log(`Downloading ${url} ...`);
let res;
try {
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (error) {
    throw new Error(`Download failed: ${error}`);
  }
  if (!res.ok) fail(`Download failed: HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024 * 1024) fail(`Downloaded file is suspiciously small (${buf.length} bytes) — aborting`);
  writeFileSync(warPath, buf);

  console.log(`Unpacking into ${target} ...`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  try {
    await extract(warPath, { dir: target });
  } catch (error) {
    throw new Error(`Unpack failed: ${error}`);
  }

  // Sanity checks: files the viewer and editor actually load must exist.
  for (const required of ["index.html", join("js", "app.min.js"), join("js", "viewer.min.js")]) {
    if (!existsSync(join(target, required))) {
      fail(`Vendored webapp is missing ${required} — the war layout may have changed`);
    }
  }
  writeFileSync(versionFile, `${PINNED_VERSION}\n`);
} catch (error) {
  fail(`Unexpected failure: ${error}`);
} finally {
  rmSync(warPath, { force: true });
}
console.log(`drawio v${PINNED_VERSION} vendored OK`);
