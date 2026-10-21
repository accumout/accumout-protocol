/* Release gates. Run after `npm run build`. Exit code 0 only if every gate passes. */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import * as core from "../src/js/core.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const rd = (...a) => readFileSync(join(...a), "utf8");

/* ---------- inputs ---------- */
function loadDist() {
  const html = rd(DIST, "index.html");
  const m = html.match(/<script type="application\/json" id="register">([\s\S]*?)<\/script>/);
  return {
    html,
    css: rd(DIST, "css/site.css"),
    tokens: rd(DIST, "css/tokens.css"),
    js: rd(DIST, "js/app.js"),
    fav: rd(DIST, "favicon.svg"),
    runtimeReg: JSON.parse(m[1]),
    sourceReg: JSON.parse(rd(ROOT, "register.json")),
  };
}

const ref = JSON.parse(rd(ROOT, "scripts/ref-fingerprint.json"));
const refBigrams = new Set(ref.bigrams);
const refWords = new Set(ref.words5);
const sha = (s) => createHash("sha1").update(s).digest("hex").slice(0, 10);

/* ---------- text helpers ---------- */
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m]);
function visibleText(html) {
  return decode(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function attrText(html) {
  const out = [];
  const body = html.replace(/<script[\s\S]*?<\/script>/g, " ");
  for (const m of body.matchAll(/\s(aria-[a-z]+|title|alt|content|placeholder)="([^"]*)"/g)) out.push(m[2]);
  return decode(out.join(". "));
}
const DATE_RES = [
  /\b(19|20)\d{2}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i,
  /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i,
  /\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?\b/i,
  /\b(as of|checked|last updated|updated|ago|just now)\b/i,
];
const dateHits = (s) => DATE_RES.filter((r) => r.test(s)).map((r) => String(r));
const bigramsOf = (text) => {
  const out = [];
  for (const line of text.split(/[\n.!?]+/)) {
    const w = line.toLowerCase().match(/[a-z0-9]+/g) || [];
    for (let i = 0; i < w.length - 1; i++) out.push(w[i] + " " + w[i + 1]);
  }
  return out;
};

/* ---------- minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) ---------- */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let p = 8, w, h, bd, ct; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; }
    if (type === "IDAT") idat.push(d);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (bd !== 8 || !bpp) throw new Error("unsupported png");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, ct, bpp, px: out };
}

/* ---------- static gates: pure functions of a context, so mutations can reuse them ---------- */
const LOGOS = ["assets/icon-96.png", "assets/icon-180.png", "assets/icon-192.png", "assets/icon-512.png", "assets/mark-250.png", "assets/mark-500.png", "assets/mark-1000.png"];

const STATIC = {
  "register: shape valid, inert records carry no value or url": (c) => [...core.validateRegister(c.sourceReg), ...core.validateRegister(c.runtimeReg)],

  "register: shipped copy has no date keys, source keeps them as data": (c) => {
    const p = [];
    for (const [id, r] of Object.entries(c.runtimeReg.records)) for (const k of core.DATE_KEYS) if (k in r) p.push(`${id}.${k} shipped`);
    if (!Object.values(c.sourceReg.records).some((r) => core.DATE_KEYS.some((k) => k in r))) p.push("source register lost its dates");
    return p;
  },

  "dates: none in visible text, attributes, script or css strings": (c) => {
    const p = [];
    const shipped = { ...c.runtimeReg };
    const scan = { visible: visibleText(c.html), attrs: attrText(c.html), runtimeRegister: JSON.stringify(shipped), js: c.js.replace(/\/\*[\s\S]*?\*\//g, ""), cssContent: (c.css.match(/content:\s*"[^"]*"/g) || []).join(" ") };
    for (const [k, v] of Object.entries(scan)) for (const h of dateHits(k === "js" ? (v.match(/(["'`])(?:\\.|(?!\1).)*\1/g) || []).join(" ") : v)) p.push(`${k}: ${h}`);
    if (/toLocale(Date|Time)String|toISOString|new Date\(|Date\.now/.test(c.js)) p.push("js: clock call");
    return p;
  },

  "logo: files in dist, referenced by relative path, valid PNG headers": (c) => {
    const p = [];
    const refs = [...c.html.matchAll(/(?:src|href)="([^"#:][^"]*)"/g)].map((m) => m[1]);
    for (const f of LOGOS) if (!existsSync(join(DIST, f))) p.push(`missing in dist: ${f}`);
    for (const r of refs) if (!existsSync(join(DIST, r))) p.push(`unresolved: ${r}`);
    if (refs.some((r) => r.startsWith("/"))) p.push("root-relative reference");
    if (!refs.some((r) => /assets\/icon-/.test(r))) p.push("no icon reference");
    if (!refs.some((r) => /assets\/mark-/.test(r))) p.push("no mark reference");
    for (const f of LOGOS) if (existsSync(join(DIST, f))) {
      const b = readFileSync(join(DIST, f));
      if (b.toString("latin1", 1, 4) !== "PNG") p.push(`${f} is not a png`);
    }
    return p;
  },

  "logo: resized mark has no dark fringe (premultiplied resize held)": () => {
    const img = decodePng(readFileSync(join(DIST, "assets/mark-500.png")));
    if (img.ct !== 6) return ["mark-500 is not RGBA"];
    let n = 0, sum = 0;
    for (let i = 0; i < img.px.length; i += 4) {
      const a = img.px[i + 3];
      if (a > 20 && a < 235) { n++; sum += (img.px[i] + img.px[i + 1] + img.px[i + 2]) / 3; }
    }
    return n < 50 || sum / n > 110 ? [] : [`edge pixels average luma ${(sum / n).toFixed(0)}`];
  },

  "favicon: 32x32 svg, well formed, no comments or double hyphens, palette colours only": (c) => {
    const p = [];
    if (!/viewBox="0 0 32 32"/.test(c.fav) || !/width="32"/.test(c.fav) || !/height="32"/.test(c.fav)) p.push("not 32x32");
    if (c.fav.includes("<!--")) p.push("xml comment");
    if (c.fav.includes("--")) p.push("double hyphen");
    try { new JSDOM(c.fav, { contentType: "image/svg+xml" }); } catch (e) { p.push("not well formed: " + e.message.slice(0, 60)); }
    const tokens = new Set([...c.tokens.matchAll(/--[a-z]+:\s*(#[0-9a-f]{6})/g)].map((m) => m[1].toLowerCase()));
    for (const h of c.fav.match(/#[0-9a-fA-F]{6}/g) || []) if (!tokens.has(h.toLowerCase())) p.push("colour outside tokens " + h);
    for (const n of (c.fav.match(/[ML]\s?-?\d+\.?\d*\s-?\d+\.?\d*/g) || []).flatMap((s) => s.match(/-?\d+\.?\d*/g).map(Number))) if (n < -0.5 || n > 32.5) p.push("coordinate out of grid " + n);
    return p;
  },

  "palette: literals live in tokens.css only, provenance recorded": (c) => {
    const p = [];
    const lit = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\blab\(/;
    const strip = (s) => s.replace(/href="#[^"]*"/g, "");
    if (lit.test(strip(c.css))) p.push("literal in site.css");
    if (lit.test(c.js.replace(/"#[a-z][a-z-]*"/g, ""))) p.push("literal in app.js");
    if (lit.test(strip(c.html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, "")))) p.push("literal in index.html");
    const defs = [...c.tokens.matchAll(/(--[a-z]+):\s*(#[0-9a-f]{6});/g)];
    if (defs.length < 10) p.push("tokens missing");
    for (const [, name, hex] of defs) if (!new RegExp(hex.slice(1) + "\\s+\\d+,\\d+").test(c.tokens)) p.push(`no pixel provenance for ${name}`);
    if (!/k-means/.test(c.tokens)) p.push("no method note");
    return p;
  },

  "units: no ch units in css": (c) => (/\d(\.\d+)?ch\b/.test(c.css) ? ["ch unit found"] : []),

  "tap targets: every interactive selector holds 44x44 in css": (c) => {
    const need = [".social", ".menu-btn", ".cp", ".tabs button", ".links a", ".ca-value", ".foot-cols a", ".chip-foot", ".pill"];
    const p = [];
    for (const sel of need) {
      const re = new RegExp("(^|\\n|\\})" + sel.replace(/[.]/g, "\\.") + "\\s*\\{([^}]*)\\}", "g");
      let ok = false;
      for (const m of c.css.matchAll(re)) if (/(min-)?height:\s*44px/.test(m[2])) ok = true;
      if (!ok) p.push(sel);
    }
    return p;
  },

  "motion: reduced-motion kills animation, transition and reveal; js honours it": (c) => {
    const p = [];
    const blk = c.css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/);
    if (!blk) return ["no reduced-motion block"];
    if (!/animation: none !important/.test(blk[1])) p.push("animation not disabled");
    if (!/transition: none !important/.test(blk[1])) p.push("transition not disabled");
    if (!/\[data-reveal\]/.test(blk[1])) p.push("reveal not reset");
    for (const needle of ["prefers-reduced-motion", "REDUCED"]) if (!c.js.includes(needle)) p.push("js lacks " + needle);
    return p;
  },

  "links: no href on unstated records, no social urls hardcoded": (c) => {
    const p = [];
    const body = c.html.replace(/<script[\s\S]*?<\/script>/g, "");
    for (const m of body.matchAll(/<(span|a|button|div)\b[^>]*data-rec="[^"]+"[^>]*>/g)) if (/\shref=/.test(m[0])) p.push("href on " + m[0].slice(0, 60));
    for (const re of [/x\.com\//, /twitter\.com\//, /github\.com\//]) {
      if (re.test(body)) p.push("hardcoded " + re);
      if (re.test(c.js)) p.push("hardcoded in js " + re);
    }
    for (const id of ["x", "github"]) {
      const r = c.runtimeReg.records[id];
      if (r.state !== "stated" && ("url" in r || "value" in r)) p.push(id + " inert but carries data");
    }
    return p;
  },

  "scanner: unknown address-shaped strings absent from the page": (c) => {
    const text = visibleText(c.html) + " " + attrText(c.html);
    return core.scanAddresses(text, c.runtimeReg).unknown.map((a) => "unknown address " + a);
  },

  "copy: zero 2-grams shared with the reference": (c) => {
    const jsText = (c.js.match(/(["'`])(?:\.|(?!\1)[^\n])*\1/g) || []).map((l) => l.slice(1, -1)).filter((l) => /[A-Za-z]+ [A-Za-z]+/.test(l) && !/[<>{};=]/.test(l)).join(". ");
    const segmented = decode(c.html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, ". "));
    const text = segmented + ". " + attrText(c.html) + ". " + jsText;
    const hits = [...new Set(bigramsOf(text).filter((b) => refBigrams.has(sha(b))))];
    return hits.map((b) => "shared 2-gram: " + b);
  },

  "copy: no reference brand or product terms": (c) => {
    const text = (visibleText(c.html) + " " + attrText(c.html)).toLowerCase();
    return ["arcen", "x402", "stellar", "bot chain", "iframeless", "wagmi"].filter((t) => text.includes(t)).map((t) => "term " + t);
  },

  "market: independent of the contract record (source never reads it)": (c) => {
    const body = c.js.slice(c.js.lastIndexOf("/* ---------- market"), c.js.indexOf("/* ---------- stat strip"));
    return /rec\("ca"\)|records\.ca\b|\bca\./.test(body) ? ["market block reads the ca record"] : [];
  },
};

/* repo-level gates */
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (["node_modules", "brand", "reference", ".git"].includes(f)) continue;
    const p = join(dir, f);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const REPO = {
  "hygiene: no CLAUDE.md, no .claude, no attribution anywhere in repo or dist": () => {
    const p = [];
    for (const n of ["CLAUDE.md", ".claude"]) if (existsSync(join(ROOT, n))) p.push(n + " present");
    const re = /claude|anthropic|co-authored-by|generated (with|by)|\bchatgpt\b|openai|\bllm\b/i;
    for (const f of walk(ROOT)) {
      if (/\.(png|jpe?g|ttf|json)$/.test(f) && !/package\.json$|register\.json$/.test(f)) continue;
      if (f.endsWith("gates.mjs") || f.includes("package-lock")) continue;
      if (re.test(readFileSync(f, "utf8"))) p.push("attribution text in " + relative(ROOT, f));
    }
    return p;
  },
  "repo files: README, whitepaper, LICENSE present, none inside dist": () => {
    const p = [];
    const rm = existsSync(join(ROOT, "README.md")) ? rd(ROOT, "README.md") : "";
    for (const f of ["README.md", "docs/whitepaper.md", "LICENSE"]) if (!existsSync(join(ROOT, f))) p.push("missing " + f);
    if (rm) {
      for (const [n, re] of [["name", /Accumout/], ["badge", /!\[[^\]]*\]\(https:\/\/img\.shields\.io[^)]*\)/], ["Solana", /Solana/], ["CA placeholder", /contract address/i], ["Overview", /^## Overview/m], ["Features", /^## Features/m], ["Links", /^## Links/m]]) if (!re.test(rm)) p.push("README lacks " + n);
    }
    if (existsSync(join(ROOT, "LICENSE")) && !/MIT License[\s\S]*Copyright \(c\) 2026 Accumout/.test(rd(ROOT, "LICENSE"))) p.push("LICENSE not MIT / Accumout / 2026");
    for (const f of ["README.md", "LICENSE", "docs"]) if (existsSync(join(DIST, f))) p.push(f + " inside dist");
    if (existsSync(join(DIST, "register.json"))) p.push("register.json shipped");
    return p;
  },
};

/* ---------- runtime harness (real app.js inside jsdom) ---------- */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addr = (seed) => Array.from({ length: 44 }, (_, i) => B58[(seed * 7 + i * 13 + (i * i) % 11) % 58]).join("");
const FIXTURE = { ca: { value: addr(3) }, x: { url: "https://x.com/accumout_test" }, github: { url: "https://github.com/accumout-test/site" } };

function boosts() {
  const list = [];
  for (let i = 0; i < 12; i++) list.push({ chainId: "solana", tokenAddress: addr(10 + i) });
  list.push({ chainId: "ethereum", tokenAddress: "0x" + "ab".repeat(20) });
  list.push({ chainId: "solana", tokenAddress: addr(10) });
  return list;
}
function pairs() {
  const out = [];
  for (let i = 0; i < 12; i++) {
    out.push({
      chainId: "solana", url: "https://example.invalid/p" + i, baseToken: { address: addr(10 + i), symbol: "T" + String.fromCharCode(65 + i), name: "Token " + i },
      priceUsd: String(0.0001 * (i + 1)), volume: { h24: 1000 * (i + 1) * (i === 5 ? 0 : 1) + 500 }, liquidity: { usd: 2000 * (i + 1) }, priceChange: { h24: i % 2 ? -3.5 * i : 4.25 * i },
      info: i % 3 === 0 ? { imageUrl: "https://example.invalid/i" + i + ".png" } : undefined,
    });
  }
  out.push({ ...out[0], volume: { h24: 99 }, priceUsd: "9" }); /* weaker duplicate of the same token */
  out.push({ chainId: "solana", baseToken: { address: addr(40), symbol: "NAN", name: "n" }, volume: {}, priceUsd: "1" });
  return out;
}

function makeFetch(plan, calls) {
  return (url, opts) => {
    calls.push(String(url));
    const mode = typeof plan === "function" ? plan(calls.length) : plan;
    if (mode === "fail") return Promise.reject(new Error("network"));
    const body = String(url).includes("/tokens/v1/") ? pairs() : boosts();
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
}

async function boot({ register, plan = "ok", reduced = false, hidden = false } = {}) {
  const reg = register || JSON.parse(loadDist().html.match(/id="register">([\s\S]*?)<\/script>/)[1]);
  let html = rd(DIST, "index.html").replace(/(<script type="application\/json" id="register">)[\s\S]*?(<\/script>)/, `$1${JSON.stringify(reg).replace(/</g, "\\u003c")}$2`);
  const appJs = rd(DIST, "js/app.js");
  html = html.replace('<script src="js/app.js" defer></script>', "");
  const calls = [], timers = [], cleared = [], copied = [], aborts = [];
  const dom = new JSDOM(html, {
    runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(w) {
      w.fetch = makeFetch(plan, calls);
      Object.defineProperty(w.navigator, "clipboard", { value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } });
      if (reduced) w.matchMedia = () => ({ matches: true, addEventListener() {} });
      const st = w.setTimeout.bind(w), ct = w.clearTimeout.bind(w);
      w.setTimeout = (fn, d, ...a) => { const id = st(fn, d, ...a); timers.push({ id, fn, d }); return id; };
      w.clearTimeout = (id) => { cleared.push(id); return ct(id); };
      const AC = w.AbortController;
      w.AbortController = class extends AC { abort() { aborts.push(1); super.abort(); } };
      let hid = hidden;
      Object.defineProperty(w.document, "hidden", { get: () => hid, configurable: true });
      w.__setHidden = (v) => { hid = v; w.document.dispatchEvent(new w.Event("visibilitychange")); };
    },
  });
  dom.window.eval(appJs);
  return { w: dom.window, d: dom.window.document, calls, timers, cleared, copied, aborts };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rowsOf = (d) => [...d.querySelectorAll("#board-rows .row[data-addr]")];
const toState = (reg, id, want) => (reg.records[id].state === want ? JSON.parse(JSON.stringify(reg)) : core.flipRecord(reg, id, FIXTURE[id] || { value: "x" }));
const baseReg = () => JSON.parse(loadDist().html.match(/id="register">([\s\S]*?)<\/script>/)[1]);
const must = (cond, msg, out) => { if (!cond) out.push(msg); };

const RUNTIME = {
  "branch ca=absent: slot inert, shows pending only, copy disabled, no address anywhere": async () => {
    const p = [];
    const { d } = await boot({ register: toState(baseReg(), "ca", "absent") });
    const slot = d.querySelector("#ca");
    must(slot.dataset.state === "absent", "state attr", p);
    must(d.querySelector("#ca-text").textContent === "pending", "text is not pending", p);
    must(d.querySelector("#ca-copy").disabled, "copy enabled", p);
    must(!core.scanAddresses(slot.textContent, { records: {} }).found.length, "address-shaped text in slot", p);
    must(/pending/.test(d.querySelector('.case-hero [data-rec="ca"]').textContent), "case chip not pending", p);
    return p;
  },

  "branch ca=stated: full address in slot, click copies, feedback shown then cleared": async () => {
    const p = [];
    const { d, copied, w } = await boot({ register: toState(baseReg(), "ca", "stated") });
    const slot = d.querySelector("#ca");
    must(slot.dataset.state === "stated", "state attr", p);
    must(d.querySelector("#ca-text").textContent === FIXTURE.ca.value, "slot lacks the full address", p);
    const btn = d.querySelector("#ca-copy");
    must(!btn.disabled, "copy disabled", p);
    btn.click();
    await wait(30);
    must(copied[0] === FIXTURE.ca.value, "clipboard did not get the address", p);
    must("copied" in slot.dataset && d.querySelector("#ca-act-t").textContent === "Copied", "no copy feedback", p);
    must(d.querySelector("#ca-live").textContent.length > 0, "no live-region announcement", p);
    await wait(1900);
    must(!("copied" in slot.dataset) && d.querySelector("#ca-act-t").textContent === "Copy", "feedback not cleared", p);
    w.close();
    return p;
  },

  "market parity: board identical whether ca is stated or absent": async () => {
    const p = [];
    const run = async (want) => {
      const { d, w } = await boot({ register: toState(baseReg(), "ca", want), reduced: true });
      await wait(150);
      const out = { rows: rowsOf(d).map((r) => r.dataset.addr), status: d.querySelector("#mkt-status").textContent, ticker: d.querySelector("#ticker-track").textContent };
      w.close();
      return out;
    };
    const a = await run("absent"), s = await run("stated");
    must(a.rows.length === 10 && s.rows.length === 10, `row count ${a.rows.length}/${s.rows.length}`, p);
    must(JSON.stringify(a) === JSON.stringify(s), "market output differs by ca state", p);
    must(a.status === "Live", "status not Live", p);
    return p;
  },

  "market: top 10 by 24h volume, solana only, duplicates and bad volumes handled": async () => {
    const p = [];
    const { d, calls } = await boot({ reduced: true });
    await wait(150);
    const rows = rowsOf(d);
    const vols = rows.map((r) => r.querySelector('[data-k="volume"]').textContent);
    must(rows.length === 10, "not 10 rows", p);
    must(calls[0] === "https://api.dexscreener.com/token-boosts/top/v1", "wrong boosts url", p);
    must(/^https:\/\/api\.dexscreener\.com\/tokens\/v1\/solana\//.test(calls[1] || ""), "wrong pairs url", p);
    must(!calls[1].includes("0xabab"), "non-solana address sent", p);
    must(new Set(calls[1].split("/solana/")[1].split(",")).size === calls[1].split("/solana/")[1].split(",").length, "address list has duplicates", p);
    must(rows[0].querySelector(".tk-n b").textContent === "TL", "first row is not the highest volume", p);
    must(!rows.some((r) => r.querySelector(".tk-n b").textContent === "NAN"), "bad-volume pair kept", p);
    must(!rows.some((r) => r.querySelector(".tk-n b").textContent === "TF"), "zero-volume neighbour ordering", p);
    must(rows.every((r) => r.querySelector(".cp") && r.querySelector(".cp").getAttribute("aria-label").startsWith("Copy address for")), "copy buttons missing", p);
    const keep = new Set(vols);
    must(keep.size > 5, "volumes not rendered", p);
    return p;
  },

  "market: copy-per-address copies the full token address with feedback": async () => {
    const p = [];
    const { d, copied } = await boot({ reduced: true });
    await wait(150);
    const row = rowsOf(d)[0];
    row.querySelector(".cp").click();
    await wait(30);
    must(copied[0] === row.dataset.addr && copied[0].length === 44, "wrong address copied", p);
    must("done" in row.querySelector(".cp").dataset, "no feedback", p);
    return p;
  },

  "market: letter tile when imageUrl missing and when the image fails": async () => {
    const p = [];
    const { d, w } = await boot({ reduced: true });
    await wait(150);
    const rows = rowsOf(d);
    const noImg = rows.find((r) => !r.querySelector(".logo img"));
    must(noImg && /^[A-Z0-9]$/.test(noImg.querySelector(".logo").textContent), "no tile for missing image", p);
    const withImg = rows.find((r) => r.querySelector(".logo img"));
    must(!!withImg, "no row with an image", p);
    if (withImg) {
      withImg.querySelector(".logo img").dispatchEvent(new w.Event("error"));
      must(!withImg.querySelector(".logo img") && /^[A-Z0-9]$/.test(withImg.querySelector(".logo").textContent), "tile not shown after image error", p);
    }
    return p;
  },

  "market: skeleton first, then real rows fade in staggered": async () => {
    const p = [];
    const { d } = await boot({ plan: () => "ok" });
    must(d.querySelectorAll("#board-rows .row.skeleton").length === 10, "no skeletons at start", p);
    await wait(700);
    const rows = rowsOf(d);
    must(rows.length === 10 && !d.querySelector(".row.skeleton"), "skeletons not replaced", p);
    must(rows.every((r, i) => r.classList.contains("in") && r.style.getPropertyValue("--i") === String(i)), "stagger index missing", p);
    return p;
  },

  "market: failure shows dashes and an error, retries with growing pauses, keeps last good data": async () => {
    const p = [];
    const f = await boot({ plan: "fail" });
    await wait(60);
    must(f.d.querySelectorAll("#board-rows .row").length === 10 && f.d.querySelector("#board-rows .row .dash"), "no dash rows", p);
    must(!f.d.querySelector("#board-err").hidden, "no error shown", p);
    must(["Retrying", "Feed unavailable"].includes(f.d.querySelector("#mkt-status").textContent), "status wrong on failure", p);
    const retry1 = f.timers.filter((t) => t.d !== 0 && t.d < 60000).map((t) => t.d);
    must(retry1.length && retry1[0] >= 750 && retry1[0] <= 1500, `first backoff ${retry1[0]}`, p);
    const last = f.timers[f.timers.length - 1];
    last.fn();
    await wait(60);
    const retry2 = f.timers.filter((t) => t.d !== 0 && t.d < 60000).map((t) => t.d);
    must(retry2.length >= 2 && retry2[1] >= 1500 && retry2[1] <= 3000, `second backoff ${retry2[1]}`, p);
    for (let a = 0; a < 6; a++) must(core.backoffDelay(a + 1, 1500, 45000, () => 1) >= core.backoffDelay(a, 1500, 45000, () => 1), "backoff not monotonic", p);
    must(core.backoffDelay(30, 1500, 45000, () => 1) === 45000, "backoff uncapped", p);

    let n = 0;
    const g = await boot({ plan: () => (++n <= 2 ? "ok" : "fail"), reduced: true });
    await wait(150);
    const before = rowsOf(g.d).map((r) => r.dataset.addr).join();
    g.w.__setHidden(true);
    g.w.__setHidden(false);
    await wait(150);
    must(g.d.querySelector("#mkt-status").textContent === "Retrying", "status not Retrying after refresh failure", p);
    must(rowsOf(g.d).map((r) => r.dataset.addr).join() === before && before.length > 0, "last good data lost", p);
    return p;
  },

  "market: polls every 60s, pauses while hidden, refetches at once when visible": async () => {
    const p = [];
    const { w, calls, timers, cleared, aborts } = await boot({ reduced: true });
    await wait(150);
    const poll = timers.find((t) => t.d === 60000);
    must(!!poll, "no 60s poll scheduled", p);
    const n0 = calls.length;
    w.__setHidden(true);
    must(poll && cleared.includes(poll.id), "poll timer not cleared when hidden", p);
    await wait(50);
    must(calls.length === n0, "fetched while hidden", p);
    w.__setHidden(false);
    await wait(30);
    must(calls.length > n0, "no immediate fetch on visible", p);
    must(aborts.length >= 1, "in-flight request not aborted on hide", p);
    const hiddenBoot = await boot({ hidden: true });
    await wait(60);
    must(hiddenBoot.calls.length === 0, "fetched at boot while hidden", p);
    return p;
  },

  "branch market=absent: feed inert, no request sent, ca state has no effect": async () => {
    const p = [];
    for (const ca of ["absent", "stated"]) {
      const reg = toState(toState(baseReg(), "ca", ca), "market", "absent");
      const { d, calls } = await boot({ register: reg });
      await wait(80);
      must(calls.length === 0, `request sent with market absent (ca ${ca})`, p);
      must(d.querySelector("#mkt-status").textContent === "Feed pending", "status not pending", p);
      must(!rowsOf(d).length, "rows rendered", p);
    }
    return p;
  },

  "branch market=stated: feed live from the register url alone": async () => {
    const p = [];
    const reg = toState(baseReg(), "market", "stated");
    reg.records.market.url = "https://example.invalid/boosts";
    const { calls } = await boot({ register: reg, reduced: true });
    await wait(60);
    must(calls[0] === "https://example.invalid/boosts", "feed ignores the register url", p);
    return p;
  },

  "social: both icons at every state, inert without href, live links derive the handle": async () => {
    const p = [];
    for (const want of ["absent", "stated"]) {
      let reg = baseReg();
      reg = toState(toState(reg, "x", want), "github", want);
      const { d } = await boot({ register: reg });
      const box = d.querySelector(".nav-right");
      for (const id of ["x", "github"]) {
        const el = box.querySelector(`[data-rec="${id}"]`);
        must(!!el && !!el.querySelector("svg"), `${id} icon missing (${want})`, p);
        if (!el) continue;
        must(!el.textContent.trim(), `${id} has a text label`, p);
        if (want === "absent") {
          must(el.tagName !== "A" && !el.hasAttribute("href"), `${id} has href while absent`, p);
          must(/pending/.test(el.getAttribute("aria-label")), `${id} aria-label`, p);
        } else {
          must(el.tagName === "A" && el.getAttribute("href") === FIXTURE[id].url, `${id} href`, p);
          must(el.getAttribute("aria-label").endsWith("@" + core.deriveHandle(FIXTURE[id].url)) && core.deriveHandle(FIXTURE[id].url).length > 0, `${id} handle not derived`, p);
        }
      }
    }
    return p;
  },

  "rendered page carries no dates in any branch": async () => {
    const p = [];
    for (const want of ["absent", "stated"]) {
      const reg = toState(toState(toState(baseReg(), "ca", want), "x", want), "github", want);
      const { d } = await boot({ register: reg });
      await wait(700);
      const text = d.body.textContent + " " + [...d.querySelectorAll("*")].flatMap((e) => [...e.attributes].filter((a) => /^(aria-|title|alt)/.test(a.name)).map((a) => a.value)).join(" ");
      for (const h of dateHits(text.replace(/\s+/g, " "))) p.push(`${want}: ${h}`);
    }
    return p;
  },

  "address scanner: matches the stated registry, never rejects a shape on its own": async () => {
    const p = [];
    const evm = "0x" + "Ab12".repeat(10);
    const reg = JSON.parse(JSON.stringify(baseReg()));
    const stated = toState(reg, "ca", "stated");
    stated.records.ca.value = evm;
    must(core.scanAddresses(`see ${evm} here`, stated).unknown.length === 0, "stated 0x hex rejected", p);
    must(core.scanAddresses(`see ${evm.toLowerCase()} here`, stated).unknown.length === 0, "case-folded 0x rejected", p);
    must(core.scanAddresses(`see ${"0x" + "cd34".repeat(10)} here`, stated).unknown.length === 1, "unknown 0x not flagged", p);
    must(core.scanAddresses(`see ${FIXTURE.ca.value}`, toState(reg, "ca", "stated")).unknown.length === 0, "stated base58 rejected", p);
    must(core.scanAddresses(`see ${FIXTURE.ca.value}`, toState(reg, "ca", "absent")).unknown.length === 1, "absent ca address not flagged", p);
    must(core.looksLikeAddress(evm) && core.looksLikeAddress(FIXTURE.ca.value) && !core.looksLikeAddress("hello world"), "shape helper", p);
    const { d } = await boot({ register: toState(reg, "ca", "stated"), reduced: true });
    await wait(120);
    const text = [...d.body.querySelectorAll("*")].filter((e) => !e.closest("#ca") && !e.closest("#board-rows")).map((e) => (e.children.length ? "" : e.textContent)).join(" ");
    must(core.scanAddresses(text, toState(reg, "ca", "stated")).unknown.length === 0, "unknown address outside the exempt slot", p);
    return p;
  },

  "reduced motion: no reveal state, no stagger classes, numbers land at once": async () => {
    const p = [];
    const { d } = await boot({ reduced: true });
    await wait(150);
    must(d.documentElement.classList.contains("rm"), "rm class missing", p);
    must(!d.querySelector("[data-reveal]"), "reveal attributes remain", p);
    must(!d.querySelector(".row.in"), "stagger classes remain", p);
    must(!/^[—]$/.test(d.querySelector('[data-stat="vol"]').textContent.trim()), "stat not final", p);
    return p;
  },

  "count-up: animates to the final value and flashes on change": async () => {
    const p = [];
    let n = 0;
    const { d, w } = await boot({ plan: "ok" });
    await wait(1700);
    const cell = d.querySelector('#board-rows .row[data-addr] [data-k="price"]');
    must(/^\$/.test(cell.textContent) && cell.textContent !== "$0", "count-up did not land", p);
    cell._v = (cell._v || 1) * 0.5;
    void n;
    w.__setHidden(true);
    w.__setHidden(false);
    await wait(250);
    must(/flash-(up|down)/.test(cell.className), "no flash on change", p);
    return p;
  },
};

/* ---------- mutation proofs: break the current build and demand the gate notices ---------- */
function mutate(ctx, fn) { const c = JSON.parse(JSON.stringify({ ...ctx })); fn(c); return c; }
const anyNotStated = (reg) => Object.entries(reg.records).find(([, r]) => r.state !== "stated");
const MUTATIONS = {
  "mutation: inert record given a value is caught": () => {
    const c = mutate(loadDist(), (x) => { const e = anyNotStated(x.runtimeReg) || ((x.runtimeReg = core.flipRecord(x.runtimeReg, "market", {})), anyNotStated(x.runtimeReg)); e[1].value = "leak"; });
    return STATIC["register: shape valid, inert records carry no value or url"](c).length > 0;
  },
  "mutation: href on an inert social icon is caught": () => {
    const c = mutate(loadDist(), (x) => { x.html = x.html.replace(/(<span class="social" data-rec="[a-z]+")/, '$1 href="https://x.com/leak"'); });
    return STATIC["links: no href on unstated records, no social urls hardcoded"](c).length > 0;
  },
  "mutation: a visible date is caught": () => STATIC["dates: none in visible text, attributes, script or css strings"](mutate(loadDist(), (x) => { x.html = x.html.replace("<h1", "<p>Updated 12 Mar</p><h1"); })).length > 0,
  "mutation: a time string in an aria-label is caught": () => STATIC["dates: none in visible text, attributes, script or css strings"](mutate(loadDist(), (x) => { x.html = x.html.replace('aria-label="Primary"', 'aria-label="Primary 10:45"'); })).length > 0,
  "mutation: a hex literal outside tokens is caught": () => STATIC["palette: literals live in tokens.css only, provenance recorded"](mutate(loadDist(), (x) => { x.css += "\n.x{color:#123abc}"; })).length > 0,
  "mutation: a ch unit is caught": () => STATIC["units: no ch units in css"](mutate(loadDist(), (x) => { x.css += "\n.x{width:40ch}"; })).length > 0,
  "mutation: an unknown address is flagged, the stated one passes": () => {
    const base = loadDist();
    const unknown = STATIC["scanner: unknown address-shaped strings absent from the page"](mutate(base, (x) => { x.html = x.html.replace("<h1", `<p>${addr(77)}</p><h1`); })).length > 0;
    const regS = toState(base.runtimeReg, "ca", "stated");
    const passes = STATIC["scanner: unknown address-shaped strings absent from the page"](mutate(base, (x) => { x.runtimeReg = regS; x.html = x.html.replace("<h1", `<p>${regS.records.ca.value}</p><h1`); })).length === 0;
    return unknown && passes;
  },
  "mutation: a shared 2-gram is caught": () => STATIC["copy: zero 2-grams shared with the reference"](mutate(loadDist(), (x) => { x.html = x.html.replace("<h1", "<p>Wallet native billing</p><h1"); })).length > 0,
  "mutation: an xml comment with double hyphens in the favicon is caught": () => STATIC["favicon: 32x32 svg, well formed, no comments or double hyphens, palette colours only"](mutate(loadDist(), (x) => { x.fav = x.fav.replace("<rect", "<!-- a -- b --><rect"); })).length > 0,
  "mutation: market reading the ca record is caught": () => STATIC["market: independent of the contract record (source never reads it)"](mutate(loadDist(), (x) => { x.js = x.js.replace("async function loadMarket() {", 'async function loadMarket() { rec("ca");'); })).length > 0,
  "mutation: dropping the logo reference is caught": () => STATIC["logo: files in dist, referenced by relative path, valid PNG headers"](mutate(loadDist(), (x) => { x.html = x.html.replace(/assets\/icon-\d+\.png/g, "x.png").replace(/assets\/mark-\d+\.png/g, "y.png"); })).length > 0,
};

/* ---------- runner ---------- */
let pass = 0, fail = 0;
const failures = [];
function report(name, problems) {
  if (!problems.length) { pass++; console.log("  pass  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name); problems.forEach((x) => console.log("          - " + x)); }
}

if (!existsSync(join(DIST, "index.html"))) { console.error("dist/ missing, run npm run build first"); process.exit(1); }
const ctx = loadDist();
console.log("static gates");
for (const [n, fn] of Object.entries(STATIC)) report(n, fn(ctx));
console.log("repo gates");
for (const [n, fn] of Object.entries(REPO)) report(n, fn());
console.log("runtime gates (app.js executed in jsdom, both branches of every record)");
for (const [n, fn] of Object.entries(RUNTIME)) { try { report(n, await fn()); } catch (e) { report(n, ["threw: " + (e.stack || e).toString().split("\n").slice(0, 3).join(" | ")]); } }
console.log("mutation proofs (anchors read the current record at run time)");
for (const [n, fn] of Object.entries(MUTATIONS)) { let ok = false; try { ok = fn(); } catch (e) { ok = false; } report(n, ok ? [] : ["gate did not notice the mutation"]); }

const refWordHits = new Set((visibleText(ctx.html).toLowerCase().match(/[a-z0-9]{5,}/g) || []).filter((w) => refWords.has(sha(w))));
console.log(`\ninfo: ${refWordHits.size} distinct 5+ letter words also appear in the reference (domain vocabulary): ${[...refWordHits].sort().join(", ")}`);
console.log(`\ngates: ${pass + fail} total, ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
