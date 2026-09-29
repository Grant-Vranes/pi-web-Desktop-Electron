import test from "node:test";
import assert from "node:assert/strict";
import { detectDesktopShell, openDesktopTerminal } from "./desktop-bridge.ts";

test("detectDesktopShell returns browser without shell globals", () => {
  assert.equal(detectDesktopShell(), "browser");
});

test("detectDesktopShell detects electron when piDesktop exists", () => {
  globalThis.window = { piDesktop: {} };
  try {
    assert.equal(detectDesktopShell(), "electron");
  } finally {
    delete globalThis.window;
  }
});

test("detectDesktopShell detects tauri when __TAURI__ exists", () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => undefined } } };
  try {
    assert.equal(detectDesktopShell(), "tauri");
  } finally {
    delete globalThis.window;
  }
});

test("openDesktopTerminal falls back to the HTTP API in browser shell", async () => {
  let requested;
  globalThis.window = {};
  globalThis.fetch = async (url, init) => {
    requested = { url, init };
    return { ok: true };
  };
  try {
    const result = await openDesktopTerminal({ cwd: "/tmp", branch: "main" });
    assert.equal(result.ok, true);
    assert.equal(requested.url, "/api/terminal/open");
    assert.deepEqual(JSON.parse(requested.init.body), { cwd: "/tmp", branch: "main" });
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test("openDesktopTerminal prefers the tauri invoke path", async () => {
  let invoked;
  globalThis.window = { __TAURI__: { core: { invoke: async (cmd, args) => { invoked = { cmd, args }; return { ok: true }; } } } };
  try {
    const result = await openDesktopTerminal({ cwd: "/tmp" });
    assert.equal(result.ok, true);
    assert.equal(invoked.cmd, "open_terminal");
    assert.deepEqual(invoked.args, { cwd: "/tmp", branch: null });
  } finally {
    delete globalThis.window;
  }
});
