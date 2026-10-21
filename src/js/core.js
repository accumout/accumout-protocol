/* Pure logic. No DOM, no network. Imported as ESM by the gates and inlined by the build. */

export const STATES = ["stated", "absent", "unconfirmed"];
export const DATE_KEYS = ["checkedOn", "statedOn"];

/* ---------- register ---------- */

export function resolveRecord(rec) {
  const state = rec && STATES.includes(rec.state) ? rec.state : "absent";
  const live = state === "stated";
  const value = live ? rec.value || "" : "";
  const href = live ? rec.url || "" : "";
  return {
    state,
    inert: !live,
    label: (rec && rec.label) || "",
    value,
    href,
    handle: href ? deriveHandle(href) : "",
  };
}

export function deriveHandle(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean)[0] || "";
    return seg.replace(/^@/, "");
  } catch (e) {
    return "";
  }
}

export function validateRegister(reg) {
  const errors = [];
  const recs = (reg && reg.records) || {};
  for (const [id, r] of Object.entries(recs)) {
    if (!STATES.includes(r.state)) errors.push(`${id}: bad state`);
    if (r.state !== "stated") {
      for (const k of ["value", "url", "rpc", "pairsUrl"]) {
        if (k in r) errors.push(`${id}: ${r.state} record carries ${k}`);
      }
    } else if (!r.value && !r.url) {
      errors.push(`${id}: stated record has neither value nor url`);
    }
  }
  return errors;
}

export function stripDates(reg) {
  const copy = JSON.parse(JSON.stringify(reg));
  for (const r of Object.values(copy.records)) for (const k of DATE_KEYS) delete r[k];
  return copy;
}

/* Reads the current record, then moves it to the other branch. Anchors never assume a starting state. */
export function flipRecord(reg, id, fixture) {
  const copy = JSON.parse(JSON.stringify(reg));
  const r = copy.records[id];
  if (r.state === "stated") {
    r.state = "absent";
    for (const k of ["value", "url", "rpc", "pairsUrl", "source", "scope"]) delete r[k];
  } else {
    r.state = "stated";
    Object.assign(r, fixture);
  }
  return copy;
}

/* ---------- address scanner ---------- */

const EVM_RE = /\b0x[a-fA-F0-9]{40}\b/g;
const B58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

export function statedAddresses(reg) {
  const out = new Set();
  for (const r of Object.values(reg.records)) {
    if (r.state === "stated" && r.value) out.add(String(r.value).toLowerCase());
  }
  return out;
}

/* Matches address-shaped strings against the stated registry. Never rejects a shape on its own. */
export function scanAddresses(text, reg) {
  const known = statedAddresses(reg);
  const found = [...(text.match(EVM_RE) || []), ...(text.match(B58_RE) || [])];
  const unknown = found.filter((a) => !known.has(a.toLowerCase()));
  return { found, unknown };
}

export function looksLikeAddress(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(s) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

/* ---------- market ---------- */

export function solanaAddresses(boosts, max = 30) {
  const seen = new Set();
  for (const b of Array.isArray(boosts) ? boosts : []) {
    if (b && b.chainId === "solana" && b.tokenAddress) seen.add(b.tokenAddress);
    if (seen.size >= max) break;
  }
  return [...seen];
}

export function buildBoard(pairs, n = 10) {
  const best = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (!p || p.chainId !== "solana" || !p.baseToken) continue;
    const vol = Number(p.volume && p.volume.h24);
    if (!Number.isFinite(vol)) continue;
    const key = p.baseToken.address;
    const cur = best.get(key);
    if (!cur || vol > cur.volume24) {
      best.set(key, {
        address: key,
        symbol: p.baseToken.symbol || "?",
        name: p.baseToken.name || "",
        price: Number(p.priceUsd),
        change24: Number(p.priceChange && p.priceChange.h24),
        volume24: vol,
        liquidity: Number(p.liquidity && p.liquidity.usd),
        imageUrl: (p.info && p.info.imageUrl) || "",
        url: p.url || "",
      });
    }
  }
  return [...best.values()].sort((a, b) => b.volume24 - a.volume24).slice(0, n);
}

export function sortBoard(board, mode) {
  const by = {
    volume: (a, b) => b.volume24 - a.volume24,
    movers: (a, b) => (Number.isFinite(b.change24) ? b.change24 : -Infinity) - (Number.isFinite(a.change24) ? a.change24 : -Infinity),
    depth: (a, b) => (Number.isFinite(b.liquidity) ? b.liquidity : -1) - (Number.isFinite(a.liquidity) ? a.liquidity : -1),
  }[mode] || ((a, b) => b.volume24 - a.volume24);
  return [...board].sort(by);
}

export function backoffDelay(attempt, base = 1500, cap = 45000, rand = Math.random) {
  const raw = Math.min(cap, base * Math.pow(2, attempt));
  return Math.round(raw * (0.5 + rand() * 0.5));
}

/* ---------- formatting ---------- */

const DASH = "—";

export function fmtUsdCompact(v) {
  if (!Number.isFinite(v)) return DASH;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: v >= 1e6 ? 2 : 1 }).format(v);
}

export function fmtPrice(v) {
  if (!Number.isFinite(v)) return DASH;
  if (v >= 1000) return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1) return "$" + v.toFixed(v >= 100 ? 2 : 4);
  if (v === 0) return "$0";
  const places = Math.min(12, Math.max(4, 3 - Math.floor(Math.log10(v))));
  return "$" + v.toFixed(places);
}

export function fmtPct(v) {
  if (!Number.isFinite(v)) return DASH;
  const s = Math.abs(v) >= 1000 ? Math.round(Math.abs(v)).toLocaleString("en-US") : Math.abs(v).toFixed(2);
  return (v < 0 ? "−" : "+") + s + "%";
}

export function shortAddr(a) {
  return a && a.length > 12 ? a.slice(0, 4) + "…" + a.slice(-4) : a || "";
}

/* ---------- spring (damped harmonic oscillator, semi-implicit Euler, fixed sub-step) ---------- */

export function stepSpring(s, target, k, c, m, dt) {
  const h = 1 / 240;
  let t = Math.min(dt, 0.064);
  while (t > 1e-9) {
    const d = Math.min(h, t);
    const a = (-k * (s.x - target) - c * s.v) / m;
    s.v += a * d;
    s.x += s.v * d;
    t -= d;
  }
  return Math.abs(s.v) < 0.001 && Math.abs(s.x - target) < 0.001;
}

export function dampingRatio(k, c, m) {
  return c / (2 * Math.sqrt(k * m));
}
