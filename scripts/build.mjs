import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRegister, stripDates } from "../src/js/core.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "dist");
const p = (...a) => join(...a);

/* Every asset the page may reference. Copied by name so nothing ships by accident. */
const ASSETS = [
  "favicon.svg",
  "assets/icon-96.png",
  "assets/icon-180.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/mark-250.png",
  "assets/mark-500.png",
  "assets/mark-1000.png",
  "assets/og.jpg",
];

rmSync(OUT, { recursive: true, force: true });
for (const d of ["css", "js", "fonts", "assets"]) mkdirSync(p(OUT, d), { recursive: true });

/* register: validate, strip dates, inline */
const reg = JSON.parse(readFileSync(p(ROOT, "register.json"), "utf8"));
const errors = validateRegister(reg);
if (errors.length) throw new Error("register invalid:\n" + errors.join("\n"));
const runtime = JSON.stringify(stripDates(reg)).replace(/</g, "\u003c");

let html = readFileSync(p(SRC, "index.html"), "utf8");
if (!html.includes("/*REGISTER*/")) throw new Error("register placeholder missing");
html = html.replace("/*REGISTER*/", runtime);
writeFileSync(p(OUT, "index.html"), html);

/* script: core helpers inlined ahead of the browser layer, one classic script */
const core = readFileSync(p(SRC, "js/core.js"), "utf8").replace(/^export /gm, "");
const app = readFileSync(p(SRC, "js/app.js"), "utf8");
writeFileSync(p(OUT, "js/app.js"), `(function () {\n"use strict";\n${core}\n${app}\n})();\n`);

for (const f of ["tokens.css", "site.css"]) copyFileSync(p(SRC, "css", f), p(OUT, "css", f));
for (const f of readdirSync(p(SRC, "fonts"))) copyFileSync(p(SRC, "fonts", f), p(OUT, "fonts", f));
for (const f of ASSETS) {
  const from = f === "favicon.svg" ? p(SRC, "assets/favicon.svg") : p(SRC, f);
  if (!existsSync(from)) throw new Error("missing asset " + f);
  copyFileSync(from, p(OUT, f));
}

writeFileSync(p(OUT, "_headers"), `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n`);
writeFileSync(p(OUT, "robots.txt"), "User-agent: *\nAllow: /\n");

/* post-build: every relative reference in the page and the css must resolve inside dist/ */
const refs = [];
for (const m of html.matchAll(/(?:src|href)="([^"#:][^"]*)"/g)) refs.push(m[1]);
const css = readFileSync(p(OUT, "css/site.css"), "utf8");
for (const m of css.matchAll(/url\("\.\.\/([^"]+)"\)/g)) refs.push(m[1]);
const missing = refs.filter((r) => !existsSync(p(OUT, r)));
if (missing.length) throw new Error("dist is missing: " + missing.join(", "));
const logos = refs.filter((r) => /assets\/(icon|mark)-/.test(r));
if (!logos.length) throw new Error("index.html references no logo file");
console.log(`build ok: ${refs.length} references resolved, logo files in dist: ${[...new Set(logos)].join(", ")}`);
