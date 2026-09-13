import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./drawio-file.ts");
}

test("accepts mxfile and mxGraphModel XML roots", async () => {
  const { isValidDrawioXml } = await loadSubject();
  assert.equal(isValidDrawioXml('<mxfile host="pi-web"><diagram/></mxfile>'), true);
  assert.equal(isValidDrawioXml("<mxGraphModel><root/></mxGraphModel>"), true);
  assert.equal(isValidDrawioXml("  <MXFILE page='1'>"), true);
});

test("rejects empty, non-xml, and fully compressed bodies", async () => {
  const { isValidDrawioXml } = await loadSubject();
  assert.equal(isValidDrawioXml(""), false);
  assert.equal(isValidDrawioXml("not xml at all"), false);
  // deflate+base64 全压缩体:无 '<' 字符,有意拒绝
  assert.equal(isValidDrawioXml("jVNdb9owFP01vOfadAmJXVQJN9GFW7tJm5aSB4xr2A2MxE399U0"), false);
});

test("rejects non-string input", async () => {
  const { isValidDrawioXml } = await loadSubject();
  assert.equal(isValidDrawioXml(/** @type {any} */ (null)), false);
  assert.equal(isValidDrawioXml(/** @type {any} */ (undefined)), false);
});

test("exposes a valid blank-canvas template", async () => {
  const { EMPTY_DRAWIO_XML, isValidDrawioXml } = await loadSubject();
  assert.equal(isValidDrawioXml(EMPTY_DRAWIO_XML), true);
  assert.match(EMPTY_DRAWIO_XML, /<mxfile[\s>]/);
  assert.match(EMPTY_DRAWIO_XML, /<diagram[\s>]/);
  assert.match(EMPTY_DRAWIO_XML, /<mxGraphModel[\s>]/);
});