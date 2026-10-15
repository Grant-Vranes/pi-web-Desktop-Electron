import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./globals.css", import.meta.url), "utf8");

test("project rail items use quiet borderless cards and a refined active state", () => {
  assert.match(
    source,
    /\.project-rail-item,\s*\.project-rail-add\s*\{[\s\S]*?border: 1px solid transparent;[\s\S]*?border-radius: 10px;[\s\S]*?background: color-mix\(in srgb, var\(--bg-hover\) 58%, var\(--bg-panel\)\);/,
  );
  assert.match(
    source,
    /\.project-rail-item:hover\s*\{[\s\S]*?border-color: transparent;[\s\S]*?background: color-mix\(in srgb, var\(--accent\) 6%, var\(--bg-hover\)\);/,
  );
  assert.match(
    source,
    /\.project-rail-item\.is-active\s*\{[\s\S]*?background: color-mix\(in srgb, var\(--accent\) 12%, var\(--bg-selected\)\);[\s\S]*?border-color: transparent;[\s\S]*?box-shadow: 0 2px 8px color-mix\(in srgb, var\(--accent\) 16%, transparent\);/,
  );
});

test("project rail shows overflow cues when the tile list scrolls", () => {
  assert.match(source, /\.project-rail-list\.is-overflow-top\s*\{[\s\S]*?mask-image: linear-gradient\(to bottom, transparent 0, #000 24px\);/);
  assert.match(source, /\.project-rail-list\.is-overflow-bottom\s*\{[\s\S]*?mask-image: linear-gradient\(to top, transparent 0, #000 24px\);/);
  // The arrows float over the fade, stay quiet at rest, and wake on hover.
  assert.match(source, /\.project-rail-overflow\s*\{[\s\S]*?opacity: 0\.5;[\s\S]*?transition: opacity 140ms ease, color 140ms ease;/);
  assert.match(source, /\.project-rail-overflow:hover\s*\{[\s\S]*?opacity: 1;/);
  assert.match(source, /\.project-rail-overflow\.is-top\s*\{[\s\S]*?top: 38px;/);
  assert.match(source, /\.project-rail-overflow\.is-bottom\s*\{[\s\S]*?bottom: 45px;/);
});

test("project card activity and drag state selectors remain available", () => {
  assert.match(source, /\.project-rail-item\.is-dragging\s*\{/);
  assert.match(source, /\.project-rail-item\.is-drop-before::before,/);
  assert.match(source, /\.project-rail-item\.is-drop-after::before\s*\{/);
  assert.match(
    source,
    /\.project-rail-running,\s*\.project-rail-unread\s*\{[\s\S]*?right: -2px;[\s\S]*?bottom: -2px;/,
  );
});
