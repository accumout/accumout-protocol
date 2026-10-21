/* Browser layer. Core helpers (resolveRecord, buildBoard, stepSpring ...) are inlined above this file by the build. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const root = document.documentElement;
const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
let REDUCED = !!mq.matches;
if (REDUCED) root.classList.add("rm");
if (mq.addEventListener) mq.addEventListener("change", (e) => { REDUCED = e.matches; root.classList.toggle("rm", REDUCED); });

const REG = JSON.parse($("#register").textContent);
const rec = (id) => resolveRecord(REG.records[id]);

/* ---------- clipboard ---------- */
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
  const t = document.createElement("textarea");
  t.value = text;
  t.setAttribute("readonly", "");
  t.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.appendChild(t);
  t.select();
  try { document.execCommand("copy"); } catch (e) { /* nothing to do */ }
  t.remove();
}

/* ---------- register binding ---------- */
function bindRegister() {
  const ca = rec("ca");
  const slot = $("#ca");
  const btn = $("#ca-copy");
  slot.dataset.state = ca.state;
  if (!ca.inert && ca.value) {
    $("#ca-text").textContent = ca.value;
    btn.disabled = false;
    btn.removeAttribute("aria-disabled");
    btn.setAttribute("aria-label", "Copy contract address");
    let timer;
    btn.onclick = () => {
      copyText(ca.value).then(() => {
        slot.dataset.copied = "";
        $("#ca-act-t").textContent = "Copied";
        $("#ca-live").textContent = "Contract address copied";
        clearTimeout(timer);
        timer = setTimeout(() => {
          delete slot.dataset.copied;
          $("#ca-act-t").textContent = "Copy";
          $("#ca-live").textContent = "";
        }, 1800);
      });
    };
  } else {
    $("#ca-text").textContent = "pending";
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
    btn.removeAttribute("aria-label");
    btn.onclick = null;
  }

  $$("[data-social]").forEach((el) => {
    const r = rec(el.dataset.social);
    if (r.inert || !r.href) {
      el.setAttribute("aria-label", `${r.label}, pending`);
      return;
    }
    const a = document.createElement("a");
    a.className = "social";
    a.href = r.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.dataset.rec = el.dataset.rec;
    a.setAttribute("aria-label", r.handle ? `${r.label} @${r.handle}` : r.label);
    a.innerHTML = el.innerHTML;
    el.replaceWith(a);
  });

  $$("[data-rec]").forEach((el) => {
    if (el.id === "ca" || el.hasAttribute("data-social") || el.classList.contains("social")) return;
    const id = el.dataset.rec;
    const r = rec(id);
    if (el.hasAttribute("data-chain")) {
      $("[data-chain-text]", el).textContent = r.inert ? "Network pending" : r.value;
      return;
    }
    if (r.inert) return;
    const label = $("[data-label]", el);
    const text = label ? label.textContent : r.label;
    if (r.href) {
      const a = document.createElement("a");
      a.className = el.className.replace("btn-inert", "").trim();
      a.href = r.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.dataset.rec = id;
      const handle = r.handle ? ` @${r.handle}` : "";
      a.textContent = text + handle;
      el.replaceWith(a);
    } else if (r.value) {
      const em = $("em", el);
      if (em) em.textContent = looksLikeAddress(r.value) ? shortAddr(r.value) : r.value;
      el.removeAttribute("aria-disabled");
      el.classList.remove("btn-inert");
    }
  });
}

/* ---------- tweens (count-up) ---------- */
const tweens = new Set();
let tweenRaf = 0;
function tweenLoop(now) {
  tweens.forEach((t) => {
    const p = Math.min(1, (now - t.t0) / t.dur);
    const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
    t.el._v = t.from + (t.to - t.from) * e;
    t.el.textContent = t.fmt(t.el._v);
    if (p === 1) tweens.delete(t);
  });
  tweenRaf = tweens.size ? requestAnimationFrame(tweenLoop) : 0;
}
function setNum(el, value, fmt, flash) {
  if (!el) return;
  tweens.forEach((t) => { if (t.el === el) tweens.delete(t); });
  const prev = el._v;
  if (!Number.isFinite(value)) { el._v = undefined; el.textContent = DASH; return; }
  if (REDUCED || typeof requestAnimationFrame !== "function") {
    el._v = value;
    el.textContent = fmt(value);
    return;
  }
  const from = Number.isFinite(prev) ? prev : 0;
  if (from === value) { el._v = value; el.textContent = fmt(value); return; }
  if (flash && Number.isFinite(prev)) {
    const cls = value > prev ? "flash-up" : "flash-down";
    el.classList.remove("flash-up", "flash-down");
    void el.offsetWidth;
    el.classList.add(cls);
  }
  tweens.add({ el, from, to: value, fmt, t0: performance.now(), dur: Number.isFinite(prev) ? 650 : 1000 });
  if (!tweenRaf) tweenRaf = requestAnimationFrame(tweenLoop);
}

/* ---------- market ---------- */
const mrec = rec("market");
const M = { board: [], attempt: 0, timer: 0, ctrl: null, sort: "volume", had: false, busy: false };
const rowsEl = $("#board-rows");
const STATUS = { connecting: "Connecting", live: "Live", retrying: "Retrying", offline: "Feed unavailable", pending: "Feed pending" };

function setStatus(s) {
  $("#mkt-pill").dataset.status = s;
  $("#mkt-status").textContent = STATUS[s];
  $("#foot-pill").dataset.status = s;
  $("#foot-status").textContent = "Market feed " + STATUS[s].toLowerCase();
}

const ICON_COPY = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

function skeletonRows() {
  let h = "";
  for (let i = 0; i < 10; i++) {
    h += `<div class="row skeleton" aria-hidden="true"><span class="rk"><i class="sk w1"></i></span><div class="tk"><i class="sk circle"></i><div class="tk-n"><i class="sk w1"></i><i class="sk w2"></i></div></div><div class="stats"><span class="px r"><i class="sk r"></i></span><span class="ch r"><i class="sk r"></i></span><span class="vl r"><i class="sk r"></i></span><span class="lq r"><i class="sk r"></i></span></div><span class="cp"></span></div>`;
  }
  rowsEl.innerHTML = h;
}

function dashRows() {
  let h = "";
  for (let i = 0; i < 10; i++) {
    h += `<div class="row" aria-hidden="true"><span class="rk">${i + 1}</span><div class="tk"><span class="logo t4">${DASH}</span><div class="tk-n"><b class="dash">${DASH}</b><small>&nbsp;</small></div></div><div class="stats"><span class="px r dash">${DASH}</span><span class="ch r dash">${DASH}</span><span class="vl r dash">${DASH}</span><span class="lq r dash">${DASH}</span></div><button class="cp" type="button" disabled aria-label="No address">${ICON_COPY}</button></div>`;
  }
  rowsEl.innerHTML = h;
}

function tileHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 5;
}

function makeLogo(t) {
  const span = document.createElement("span");
  const letter = (t.symbol.match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
  span.className = "logo t" + tileHue(t.address);
  const tile = () => { span.textContent = letter; };
  if (t.imageUrl) {
    const img = new Image();
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => { img.remove(); tile(); };
    img.src = t.imageUrl;
    span.appendChild(img);
  } else tile();
  return span;
}

function buildRow(t, i) {
  const row = document.createElement("div");
  row.className = "row" + (REDUCED ? "" : " in");
  row.style.setProperty("--i", i);
  row.dataset.addr = t.address;
  row.setAttribute("role", "row");
  row.innerHTML = `<span class="rk"></span><div class="tk"><div class="tk-n"><b></b><small></small></div></div><div class="stats"><span class="px r"><span class="num-c" data-k="price"></span></span><span class="ch r"><span class="num-c" data-k="change"></span></span><span class="vl r"><span class="num-c" data-k="volume"></span></span><span class="lq r"><span class="num-c" data-k="liq"></span></span></div><button class="cp" type="button">${ICON_COPY}</button>`;
  $(".tk", row).prepend(makeLogo(t));
  $(".tk-n b", row).textContent = t.symbol;
  $(".tk-n small", row).textContent = t.name;
  const btn = $(".cp", row);
  btn.setAttribute("aria-label", `Copy address for ${t.symbol}`);
  let timer;
  btn.onclick = () => {
    copyText(t.address).then(() => {
      btn.dataset.done = "";
      btn.innerHTML = ICON_OK;
      $("#ca-live").textContent = `${t.symbol} address copied`;
      clearTimeout(timer);
      timer = setTimeout(() => { delete btn.dataset.done; btn.innerHTML = ICON_COPY; $("#ca-live").textContent = ""; }, 1400);
    });
  };
  return row;
}

function fillRow(row, t, rank) {
  $(".rk", row).textContent = rank;
  setNum($('[data-k="price"]', row), t.price, fmtPrice, true);
  const ch = $('[data-k="change"]', row);
  setNum(ch, t.change24, (v) => (v > 0 ? "▲ " : v < 0 ? "▼ " : "") + fmtPct(v), true);
  ch.classList.toggle("up", t.change24 >= 0);
  ch.classList.toggle("down", t.change24 < 0);
  setNum($('[data-k="volume"]', row), t.volume24, fmtUsdCompact, true);
  setNum($('[data-k="liq"]', row), t.liquidity, fmtUsdCompact, true);
}

function renderBoard(firstPaint) {
  const list = sortBoard(M.board, M.sort);
  if (firstPaint) {
    const old = $$(".row.skeleton, .row[aria-hidden]", rowsEl);
    const go = () => {
      rowsEl.innerHTML = "";
      list.forEach((t, i) => {
        const row = buildRow(t, i);
        rowsEl.appendChild(row);
        fillRow(row, t, i + 1);
      });
    };
    if (REDUCED || !old.length) go();
    else { old.forEach((r) => r.classList.add("out")); setTimeout(go, 330); }
    return;
  }
  const existing = new Map($$(".row[data-addr]", rowsEl).map((r) => [r.dataset.addr, r]));
  const before = new Map();
  existing.forEach((r, k) => before.set(k, r.getBoundingClientRect().top));
  list.forEach((t, i) => {
    let row = existing.get(t.address);
    if (!row) { row = buildRow(t, 0); row.classList.remove("in"); }
    rowsEl.appendChild(row);
    existing.delete(t.address);
    fillRow(row, t, i + 1);
    if (!REDUCED && before.has(t.address) && row.animate) {
      const dy = before.get(t.address) - row.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 560, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
    }
  });
  existing.forEach((r) => r.remove());
}

function renderTicker() {
  const track = $("#ticker-track");
  if (!M.board.length) {
    track.innerHTML = `<div class="tk-group"><span class="tk-empty">${DASH} ${DASH} ${DASH}</span></div>`;
    return;
  }
  const items = sortBoard(M.board, "volume").map((t) => `<span class="tk-item"><span class="s">${esc(t.symbol)}</span><span class="p">${fmtPrice(t.price)}</span><span class="${t.change24 >= 0 ? "up" : "down"}">${t.change24 >= 0 ? "▲" : "▼"} ${fmtPct(t.change24)}</span></span>`).join("");
  track.innerHTML = `<div class="tk-group">${items}</div><div class="tk-group" aria-hidden="true">${items}</div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function updateStats() {
  const live = !mrec.inert && M.board.length > 0;
  $$('[data-stat="count"]').forEach((el) => setNum(el, live ? M.board.length : NaN, (v) => String(Math.round(v))));
  $$('[data-stat="vol"]').forEach((el) => setNum(el, live ? M.board.reduce((a, t) => a + (t.volume24 || 0), 0) : NaN, fmtUsdCompact));
}

async function getJSON(url, signal) {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("http " + res.status);
  return res.json();
}

async function loadMarket() {
  if (mrec.inert) return;
  if (M.busy) return;
  M.busy = true;
  clearTimeout(M.timer);
  M.ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const signal = M.ctrl ? M.ctrl.signal : undefined;
  try {
    const boosts = await getJSON(mrec.href, signal);
    const addrs = solanaAddresses(boosts);
    if (!addrs.length) throw new Error("no solana entries");
    const pairs = await getJSON(REG.records.market.pairsUrl.replace("{addresses}", addrs.join(",")), signal);
    const board = buildBoard(pairs, 10);
    if (!board.length) throw new Error("empty board");
    const first = !M.had;
    M.board = board;
    M.had = true;
    M.attempt = 0;
    setStatus("live");
    $("#board-err").hidden = true;
    renderBoard(first);
    renderTicker();
    updateStats();
    M.timer = setTimeout(loadMarket, 60000);
  } catch (e) {
    if (e && e.name === "AbortError") { M.busy = false; return; }
    M.attempt += 1;
    if (M.had) setStatus("retrying");
    else {
      setStatus(M.attempt > 1 ? "offline" : "retrying");
      $("#board-err").hidden = false;
      if (M.attempt === 1) { dashRows(); renderTicker(); updateStats(); }
    }
    M.timer = setTimeout(loadMarket, backoffDelay(M.attempt - 1));
  }
  M.busy = false;
}

function startMarket() {
  if (mrec.inert) {
    setStatus("pending");
    dashRows();
    renderTicker();
    $("#board-err").hidden = false;
    $("#board-err").textContent = "The market feed has not been set up yet.";
    return;
  }
  skeletonRows();
  setStatus("connecting");
  if (!document.hidden) loadMarket();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(M.timer);
      if (M.ctrl) M.ctrl.abort();
      M.busy = false;
    } else {
      M.attempt = 0;
      loadMarket();
    }
  });
}

/* ---------- stat strip ---------- */
function stat(value, label, cap, attr, pend) {
  const v = pend ? `<div class="stat-v pend">pending</div>` : `<div class="stat-v"${attr ? ` data-stat="${attr}"` : ""}>${value}</div>`;
  return `<div class="stat">${v}<div class="stat-l">${label}</div><div class="stat-c">${cap}</div></div>`;
}
function renderStrip() {
  const chain = rec("chain");
  const ca = rec("ca");
  const audit = rec("audit");
  const live = !mrec.inert;
  const group = [
    stat(chain.value, "Settlement network", chain.inert ? "Not yet stated" : "Stated by the team", "", chain.inert),
    stat(DASH, "Tokens on the live board", live ? "DexScreener boosts" : "Feed not set", "count", !live),
    stat(DASH, "24h volume on the board", live ? "Sum of the ten" : "Feed not set", "vol", !live),
    stat(ca.inert ? "" : shortAddr(ca.value), "Contract address", ca.inert ? "Not yet stated" : "Stated by the team", "", ca.inert),
    stat("", "Security review", audit.inert ? "Not yet stated" : "Stated by the team", "", audit.inert),
  ].join("");
  $("#strip-track").innerHTML = `<div class="strip-group">${group}</div><div class="strip-group" aria-hidden="true">${group}</div>`;
}

/* ---------- springs: reveal + parallax ---------- */
const REVEAL = { k: 100, c: 10, m: 1 };
const FOLLOW = { k: 70, c: 16, m: 1 };
const live = new Set();
let springRaf = 0;
let lastT = 0;
function springLoop(now) {
  const dt = Math.min(0.064, (now - lastT) / 1000 || 0.016);
  lastT = now;
  live.forEach((a) => {
    if (a.kind === "reveal") {
      if (now < a.start) return;
      const rest = stepSpring(a.y, 0, REVEAL.k, REVEAL.c, REVEAL.m, dt);
      const op = Math.min(1, (now - a.start) / 520);
      a.el.style.opacity = String(1 - Math.pow(1 - op, 3));
      a.el.style.translate = `0 ${a.y.x.toFixed(2)}px`;
      if (rest && op >= 1) {
        a.el.style.opacity = "";
        a.el.style.translate = "none";
        a.el.removeAttribute("data-reveal");
        live.delete(a);
      }
    } else {
      const rx = stepSpring(a.x, a.tx, FOLLOW.k, FOLLOW.c, FOLLOW.m, dt);
      const ry = stepSpring(a.y, a.ty, FOLLOW.k, FOLLOW.c, FOLLOW.m, dt);
      a.el.style.translate = `${a.x.x.toFixed(2)}px ${a.y.x.toFixed(2)}px`;
      if (rx && ry && !a.hot) live.delete(a);
    }
  });
  springRaf = live.size ? requestAnimationFrame(springLoop) : 0;
}
function kick() {
  if (!springRaf) { lastT = performance.now(); springRaf = requestAnimationFrame(springLoop); }
}

function initReveal() {
  const els = $$("[data-reveal]");
  if (REDUCED || typeof IntersectionObserver !== "function") {
    els.forEach((e) => e.removeAttribute("data-reveal"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    const batch = new Map();
    entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top || a.boundingClientRect.left - b.boundingClientRect.left).forEach((e) => {
      io.unobserve(e.target);
      const parent = e.target.closest("[data-stagger]") || document.body;
      const n = batch.get(parent) || 0;
      batch.set(parent, n + 1);
      live.add({ kind: "reveal", el: e.target, y: { x: 36, v: 0 }, start: performance.now() + n * 90 });
    });
    kick();
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  els.forEach((e) => io.observe(e));
}

function initParallax() {
  const hero = $("#hero");
  const layers = $$("[data-depth]", hero).map((el) => ({ kind: "follow", el, d: parseFloat(el.dataset.depth), x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, tx: 0, ty: 0, hot: false }));
  if (REDUCED || !layers.length) return;
  let px = 0, py = 0, visible = true;
  const apply = () => {
    const sy = window.scrollY;
    layers.forEach((l) => {
      l.tx = -px * 16 * l.d;
      l.ty = -py * 12 * l.d - sy * 0.06 * l.d;
      live.add(l);
    });
    kick();
  };
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" || !visible) return;
    px = (e.clientX / window.innerWidth - 0.5) * 2;
    py = (e.clientY / window.innerHeight - 0.5) * 2;
    apply();
  }, { passive: true });
  window.addEventListener("scroll", () => { if (visible) apply(); }, { passive: true });
  if (typeof IntersectionObserver === "function") new IntersectionObserver((e) => { visible = e[0].isIntersecting; }, { threshold: 0 }).observe(hero);
}

/* ---------- misc ui ---------- */
function initSpotlight() {
  let raf = 0, ev = null;
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    ev = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const el = ev.target.closest && ev.target.closest("[data-spot], .row");
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", ev.clientX - r.left + "px");
      el.style.setProperty("--my", ev.clientY - r.top + "px");
    });
  }, { passive: true });
}

function initProgress() {
  const bar = $("#progress");
  let raf = 0;
  const upd = () => {
    raf = 0;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
  };
  window.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(upd); }, { passive: true });
  upd();
}

function initTopHeight() {
  const top = $("#top");
  const set = () => root.style.setProperty("--top-h", top.getBoundingClientRect().height + "px");
  set();
  if (typeof ResizeObserver === "function") new ResizeObserver(set).observe(top);
  else window.addEventListener("resize", set);
}

function initNav() {
  const btn = $("#menu-btn");
  const links = $("#links");
  const close = () => { links.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-label", "Open menu"); };
  btn.addEventListener("click", () => {
    const open = links.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });
  links.addEventListener("click", (e) => { if (e.target.closest("a")) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".nav")) close(); });
}

function initTabs(listSel, onPick) {
  const list = $(listSel);
  const tabs = $$('[role="tab"]', list);
  const pick = (t, focus) => {
    tabs.forEach((x) => { x.setAttribute("aria-selected", String(x === t)); x.tabIndex = x === t ? 0 : -1; });
    if (focus) t.focus();
    onPick(t);
  };
  tabs.forEach((t, i) => {
    t.tabIndex = t.getAttribute("aria-selected") === "true" ? 0 : -1;
    t.addEventListener("click", () => pick(t));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") pick(tabs[(i + 1) % tabs.length], true);
      if (e.key === "ArrowLeft") pick(tabs[(i - 1 + tabs.length) % tabs.length], true);
    });
  });
}

function initHeroTitle() {
  const h = $("#hero-title");
  const text = h.getAttribute("aria-label");
  h.textContent = "";
  let i = 0;
  text.split(" ").forEach((word, wi, arr) => {
    const w = document.createElement("span");
    w.className = "w";
    w.setAttribute("aria-hidden", "true");
    [...word].forEach((ch) => {
      const c = document.createElement("span");
      c.className = "c";
      c.style.setProperty("--i", i++);
      c.textContent = ch;
      w.appendChild(c);
    });
    h.appendChild(w);
    if (wi < arr.length - 1) h.appendChild(document.createTextNode(" "));
  });
}

function initAccessLoop() {
  if (REDUCED) return;
  const row = $(".mock-access .acc:nth-child(3)");
  if (row) setInterval(() => { if (!document.hidden) row.classList.toggle("on"); }, 2800);
}

function initThemeColor() {
  const m = document.createElement("meta");
  m.name = "theme-color";
  m.content = getComputedStyle(root).getPropertyValue("--blue").trim();
  if (m.content) document.head.appendChild(m);
}

/* ---------- boot ---------- */
initThemeColor();
bindRegister();
initHeroTitle();
renderStrip();
initTopHeight();
initProgress();
initNav();
initSpotlight();
initReveal();
initParallax();
initAccessLoop();
initTabs("#board-tabs", (t) => { M.sort = t.dataset.sort; if (M.board.length) renderBoard(false); });
initTabs("#mod-tabs", (t) => { $$(".mod").forEach((p) => p.classList.toggle("on", p.dataset.pane === t.dataset.mod)); });
startMarket();
