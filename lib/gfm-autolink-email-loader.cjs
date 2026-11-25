// Bundler loader for mdast-util-gfm-autolink-literal, which remark-gfm uses to
// find bare URLs and emails. Since 2.0.1 its regexes start with a lookbehind,
// which Safari only parses from 16.4. A regex literal Safari cannot parse is a
// SyntaxError for the whole chunk, and this code ships in the first load of
// `/`, so iOS 16.2 showed a blank page (#753). Upstream declined to change it
// (syntax-tree/mdast-util-gfm-autolink-literal#10).
//
// Upstream reshaped its regexes in 2.1.2 (url/xmpp/mailto/email now each carry
// lookbehinds, and some contain slashes inside character classes), so this
// loader no longer matches specific literals: it scans the file for regex
// literals (skipping strings, template literals, and comments) and rewrites
// every one whose body contains a lookbehind into a runtime `new RegExp(...)`
// wrapped in try/catch, falling back to the same pattern without its leading
// lookbehind. `findAndReplace` retries a rejected match one character later, so
// the fallback finds the same matches, only slower.
"use strict";

const REGEX_PRECEDERS = new Set(
  "(,=:[!&|?{};+-~*%^<>.@/".split("").concat([" ", "\t", "\n", "\r"]),
);
const KEYWORD_PRECEDERS = /(^|[\s;{}(])(return|typeof|case|in|of|delete|void|new|do|else|yield|await)$/;

function isRegexStart(source, index) {
  let i = index - 1;
  while (i >= 0 && (source[i] === " " || source[i] === "\t" || source[i] === "\n" || source[i] === "\r")) i--;
  if (i < 0) return true;
  const prev = source[i];
  if (prev === ")" || prev === "]") return false; // division (conservative; not hit here)
  if (/[A-Za-z0-9_$]/.test(prev)) {
    // keyword followed by regex, else identifier (division)
    const line = source.slice(Math.max(0, i - 40), i + 1);
    return KEYWORD_PRECEDERS.test(line);
  }
  return true;
}

// Parse a regex literal starting at `start` (the opening slash).
// Returns {end, body, flags} or null on malformed input.
function parseRegexLiteral(source, start) {
  let i = start + 1;
  let inClass = false;
  let body = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      body += ch + (source[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === "\n") return null;
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      let j = i + 1;
      while (j < source.length && /[a-z]/.test(source[j])) j++;
      return {end: j, body, flags: source.slice(i + 1, j)};
    }
    body += ch;
    i++;
  }
  return null;
}

function stripLeadingLookbehind(body) {
  if (!/^\(\?<[=!]/.test(body)) return null;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return body.slice(i + 1);
    }
  }
  return null;
}

function rewriteGfmAutolinkEmailRegex(source) {
  let out = "";
  let changed = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    // comments
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    // strings and template literals
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") j += 2;
        else if (source[j] === ch) { j++; break; }
        else if (ch === "`" && source[j] === "$" && source[j + 1] === "{") {
          // skip template expression with brace counting (nested strings ignored; none here)
          let depth = 1;
          j += 2;
          while (j < source.length && depth > 0) {
            if (source[j] === "\\") j += 2;
            else {
              if (source[j] === "{") depth++;
              else if (source[j] === "}") depth--;
              j++;
            }
          }
        } else j++;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }
    // regex literal
    if (ch === "/" && isRegexStart(source, i)) {
      const parsed = parseRegexLiteral(source, i);
      if (parsed) {
        const replaced = stripLeadingLookbehind(parsed.body);
        if (replaced !== null) {
          changed++;
          out +=
            `(function () { try { return new RegExp(${JSON.stringify(parsed.body)}, ${JSON.stringify(parsed.flags)}); } ` +
            `catch (_) { return new RegExp(${JSON.stringify(replaced)}, ${JSON.stringify(parsed.flags)}); } })()`;
          i = parsed.end;
          continue;
        }
        out += source.slice(i, parsed.end);
        i = parsed.end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  if (changed === 0) {
    throw new Error(
      "mdast-util-gfm-autolink-literal no longer contains any regex literal with a " +
        "lookbehind that lib/gfm-autolink-email-loader.cjs rewrites. If its new code no " +
        "longer uses RegExp lookbehind (unparseable before Safari 16.4, #753), remove the loader.",
    );
  }
  return out;
}

module.exports = function gfmAutolinkEmailLoader(source) {
  return rewriteGfmAutolinkEmailRegex(source);
};
module.exports.rewriteGfmAutolinkEmailRegex = rewriteGfmAutolinkEmailRegex;
