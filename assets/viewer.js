/*
 * viewer.js — renders the Math Comprehensive Review with PDF.js, one canvas per page, drawn as it
 * scrolls into view. The moon/sun toggle swaps between the light (original) and dark editions
 * (both built by build/build_pdfs.py), keeps your place, and points the download button at the
 * edition you are looking at. "Jump to section" comes from the PDF's own outline. Search reads
 * the PDF's text layer, highlights every match over the canvas and steps through them.
 */
import * as pdfjs from "./pdfjs/pdf.min.mjs";  // PDF.js 4.10.38 (Apache-2.0), served from this repo so its worker is same-origin

pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const FILES = {
  light: "Math_Comprehensive_Review_Study_Edition.pdf",
  dark: "Math_Comprehensive_Review_Study_Edition_Dark.pdf",
};

const $ = (id) => document.getElementById(id);
const pagesEl = $("pages");
const indicator = $("page-indicator");
const sections = $("sections");
const download = $("download");
const toggle = $("theme-toggle");

const docs = {};            // mode -> Promise<PDFDocumentProxy>, each edition loaded once
// ?mode=dark or ?mode=light opens that edition; otherwise follow the portfolio's saved choice.
const asked = new URLSearchParams(location.search).get("mode");
let mode = asked === "dark" || asked === "light" ? asked : document.documentElement.dataset.theme === "dark" ? "dark" : "light";
let doc = null;
let labels = null;          // printed page numbers, from the PDF's page labels
let generation = 0;         // bumps on every mode switch or resize, so stale renders are dropped
const rendered = new Map(); // page number -> generation it was drawn at

// fontExtraProperties keeps each font's glyph widths and toUnicode map, so search can place its highlights exactly.
const load = (m) => (docs[m] ||= pdfjs.getDocument({ url: FILES[m], fontExtraProperties: true }).promise);

function setChrome() {
  const dark = mode === "dark";
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  toggle.setAttribute("aria-pressed", String(dark));
  toggle.setAttribute("aria-label", dark ? "Switch the document to light mode" : "Switch the document to dark mode");
  toggle.title = dark ? "Light mode" : "Dark mode";
  download.href = FILES[mode];
  download.setAttribute("download", FILES[mode]);
  $("download-mode").textContent = mode;
  document.querySelector('meta[name="theme-color"]').content = dark ? "#102a43" : "#0B3D2E";
}

async function render(number) {
  const holder = pagesEl.children[number - 1];
  const stamp = generation;
  if (!holder || rendered.get(number) === stamp) return;
  rendered.set(number, stamp);
  const page = await doc.getPage(number);
  if (stamp !== generation) return;
  const base = page.getViewport({ scale: 1 });
  const scale = (holder.clientWidth / base.width) * Math.min(window.devicePixelRatio || 1, 2.5);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.setAttribute("aria-label", `Page ${label(number)}`);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  if (stamp !== generation) return;
  holder.replaceChildren(canvas, marks(number));
}

const label = (number) => (labels && labels[number - 1]) || String(number);

// Draw pages shortly before they scroll into view.
const near = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) render(Number(entry.target.dataset.page));
}, { rootMargin: "1500px 0px" });

// The page indicator follows the page nearest the top of the window.
const visible = new Set();
const seen = new IntersectionObserver((entries) => {
  for (const entry of entries) entry.isIntersecting ? visible.add(Number(entry.target.dataset.page)) : visible.delete(Number(entry.target.dataset.page));
  if (visible.size) {
    const top = Math.min(...visible);
    indicator.textContent = `Page ${label(top)} · ${top} of ${doc.numPages}`;
  }
}, { rootMargin: "-30% 0px -60% 0px" });

function currentPage() {
  return visible.size ? Math.min(...visible) : 1;
}

async function outline() {
  const items = (await doc.getOutline()) || [];
  for (const item of items) {
    let dest = item.dest;
    if (typeof dest === "string") dest = await doc.getDestination(dest);
    if (!Array.isArray(dest)) continue;
    const index = typeof dest[0] === "number" ? dest[0] : await doc.getPageIndex(dest[0]);
    const option = document.createElement("option");
    option.value = String(index + 1);
    option.textContent = item.title;
    sections.append(option);
  }
}

function goTo(number) {
  const holder = pagesEl.children[number - 1];
  if (holder) holder.scrollIntoView({ block: "start" });
}

async function show(nextMode, { keep = true } = {}) {
  const page = keep ? currentPage() : 1;
  mode = nextMode;
  setChrome();
  doc = await load(mode);
  labels = await doc.getPageLabels();
  generation += 1;
  rendered.clear();
  if (query) runSearch(query, { keepIndex: true });  // re-find in this edition; the swap need not wait
  if (!pagesEl.children.length) {
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    for (let n = 1; n <= doc.numPages; n++) {
      const holder = document.createElement("div");
      holder.className = "doc__page";
      holder.id = `page-${n}`;
      holder.dataset.page = String(n);
      holder.style.aspectRatio = `${first.width} / ${first.height}`;
      pagesEl.append(holder);
      near.observe(holder);
      seen.observe(holder);
    }
    await outline();
  } else {
    // Swap editions: redraw what is on screen now, the rest as it scrolls in.
    for (const n of [page - 1, page, page + 1, page + 2]) if (n >= 1 && n <= doc.numPages) render(n);
    near.disconnect();
    for (const holder of pagesEl.children) near.observe(holder);
  }
  if (keep) goTo(page);
}

// ---- Search ---------------------------------------------------------------------------------

const searchForm = $("search");
const searchInput = $("search-input");
const searchCount = $("search-count");
const searchPrev = $("search-prev");
const searchNext = $("search-next");

const indexes = {};         // mode -> Promise<page text index>, built on the first search
let query = "";
let hits = [];              // [{ page, start, end, top }]: character range in that page's text, top in % of the page
let pageText = null;        // the resolved index the hits point into
let current = -1;           // index into hits of the selected match
let searchRun = 0;          // drops results of superseded searches

// Case-insensitive, and any run of spaces in the query matches any run of whitespace (or a line break).
const pattern = (text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi");

// One entry per page: its text (items joined) and where each item sits in it and on the page.
function buildIndex(d) {
  const pages = [];
  for (let n = 1; n <= d.numPages; n++) {
    pages.push(d.getPage(n).then(async (page) => {
      const viewport = page.getViewport({ scale: 1 });
      const { items, styles } = await page.getTextContent();
      let text = "";
      const spans = [];
      for (const item of items) {
        if (!("str" in item)) continue;
        if (item.str) {
          const [, , c, d2, e, f] = pdfjs.Util.transform(viewport.transform, item.transform);
          const height = Math.hypot(c, d2);
          spans.push({
            start: text.length, end: text.length + item.str.length,
            left: e / viewport.width, top: (f - height) / viewport.height,
            width: (item.width * viewport.scale) / viewport.width, height: (height * 1.2) / viewport.height,
            str: item.str, fontName: item.fontName, size: Math.hypot(item.transform[2], item.transform[3]), advance: item.width, family: (styles[item.fontName] || {}).fontFamily || "sans-serif",
          });
          text += item.str;
        }
        if (item.hasEOL || (item.str && !item.str.endsWith(" "))) text += " ";
      }
      return { text, spans, fonts: page.commonObjs };
    }));
  }
  return Promise.all(pages);
}

// Each embedded font's advance per character, from its glyph widths and toUnicode map. PDF.js has
// the font once a page using it has rendered, and highlights are only drawn on rendered pages.
const advances = new Map(); // fontName -> Map(character -> advance), or null when the font is not usable
function advancesOf(fonts, name) {
  if (advances.has(name)) return advances.get(name);
  if (!fonts.has(name)) return null;
  const font = fonts.get(name);
  const map = (font.toUnicode && font.toUnicode._map) || [];
  let table = null;
  if (font.widths && map.length) {
    table = new Map();
    map.forEach((text, code) => {
      const width = font.widths[code];
      if (typeof text !== "string" || !text || width == null) return;
      const chars = [...text];  // a ligature ("fi") shares its glyph's width
      for (const ch of chars) if (!table.has(ch)) table.set(ch, width / chars.length);
    });
  }
  advances.set(name, table);
  return table;
}

// Where a substring sits along its item: the share of the item's width before it and through it.
// PDF.js joins separately placed glyphs (dot leaders, justified words) into one item with spaces
// for the gaps, so the difference between the item's width and its glyphs' (either sign) is spread
// across those spaces.
const ruler = document.createElement("canvas").getContext("2d");
const spaces = (text) => text.split(" ").length - 1;
function share(entry, span, from, to) {
  const table = advancesOf(entry.fonts, span.fontName);
  let measure;
  if (table) {
    const glyphs = (text) => ([...text].reduce((sum, ch) => sum + (table.get(ch) ?? 500), 0) * span.size) / 1000;
    const space = ((table.get(" ") ?? 250) * span.size) / 1000;
    const gap = Math.max(-space, (span.advance - glyphs(span.str)) / (spaces(span.str) || Infinity));
    measure = (text) => glyphs(text) + gap * spaces(text);
  } else {
    ruler.font = `100px ${span.family}`;
    measure = (text) => ruler.measureText(text).width;
  }
  const whole = measure(span.str);
  if (!whole) return [from / span.str.length, to / span.str.length];
  return [measure(span.str.slice(0, from)) / whole, measure(span.str.slice(0, to)) / whole];
}

// The highlight boxes for [start, end) on one page, one per text item the match touches.
function boxes(entry, start, end) {
  const out = [];
  for (const span of entry.spans) {
    if (span.end <= start || span.start >= end) continue;
    const [a, b] = share(entry, span, Math.max(start, span.start) - span.start, Math.min(end, span.end) - span.start);
    out.push({
      left: (span.left + span.width * a) * 100,
      top: span.top * 100,
      width: span.width * (b - a) * 100,
      height: span.height * 100,
    });
  }
  return out;
}

function marks(number) {
  const layer = document.createElement("div");
  layer.className = "doc__marks";
  layer.setAttribute("aria-hidden", "true");
  hits.forEach((hit, i) => {
    if (hit.page !== number) return;
    for (const box of boxes(pageText[number - 1], hit.start, hit.end)) {
      const mark = document.createElement("span");
      mark.className = i === current ? "doc__mark doc__mark--current" : "doc__mark";
      Object.assign(mark.style, { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` });
      layer.append(mark);
    }
  });
  return layer;
}

// Repaint the highlights on pages already drawn; the rest get theirs when they render.
function repaint(pages) {
  for (const number of pages) {
    const holder = pagesEl.children[number - 1];
    const old = holder && holder.querySelector(".doc__marks");
    if (old) old.replaceWith(marks(number));
  }
}

function report() {
  const any = hits.length > 0;
  searchPrev.disabled = searchNext.disabled = !any;
  searchCount.textContent = !query ? "" : any ? `${current + 1} of ${hits.length}` : "No matches";
  searchForm.classList.toggle("is-empty", Boolean(query) && !any);
}

async function runSearch(text, { keepIndex = false } = {}) {
  const run = ++searchRun;
  const before = new Set(hits.map((hit) => hit.page));
  const was = keepIndex ? current : -1;
  const near = was >= 0 ? hits[was].page : currentPage();
  query = text.trim();
  hits = [];
  current = -1;
  if (query) {
    searchCount.textContent = "Searching…";
    const index = await (indexes[mode] ||= buildIndex(doc));
    if (run !== searchRun) return;
    pageText = index;
    const needle = pattern(query);
    index.forEach((entry, i) => {
      for (const match of entry.text.matchAll(needle)) {
        const start = match.index, end = start + match[0].length;
        const first = entry.spans.find((span) => span.end > start);
        hits.push({ page: i + 1, start, end, top: first ? first.top * 100 : 0 });
      }
    });
    // Start from the first match at or after the page you are reading.
    if (hits.length) current = was >= 0 && was < hits.length ? was : Math.max(0, hits.findIndex((hit) => hit.page >= near));
  }
  report();
  repaint(new Set([...before, ...hits.map((hit) => hit.page)]));
  if (current >= 0 && !keepIndex) reveal();
}

function reveal() {
  const hit = hits[current];
  const holder = pagesEl.children[hit.page - 1];
  if (!holder) return;
  const y = holder.getBoundingClientRect().top + window.scrollY + (holder.clientHeight * hit.top) / 100;
  const bar = document.querySelector(".bar").offsetHeight;
  window.scrollTo({ top: Math.max(0, y - bar - window.innerHeight / 4) });
}

function step(delta) {
  if (!hits.length) return;
  const was = hits[current].page;
  current = (current + delta + hits.length) % hits.length;
  report();
  repaint(new Set([was, hits[current].page]));
  reveal();
}

let searchTimer = 0;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(searchInput.value), 250);
});
searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  if (searchInput.value.trim() !== query) await runSearch(searchInput.value);
  else step(1);
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); step(-1); }
  if (event.key === "Escape") { searchInput.value = ""; runSearch(""); }
});
searchPrev.addEventListener("click", () => step(-1));
// The pages are canvases, so the browser's own find sees nothing: Ctrl/Cmd+F opens this search instead.
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

toggle.addEventListener("click", () => show(mode === "dark" ? "light" : "dark"));
sections.addEventListener("change", () => {
  if (sections.value) goTo(Number(sections.value));
  sections.value = "";
});

let resizeTimer = 0;
let lastWidth = pagesEl.clientWidth;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (pagesEl.clientWidth === lastWidth) return;
    lastWidth = pagesEl.clientWidth;
    generation += 1;
    rendered.clear();
    near.disconnect();
    for (const holder of pagesEl.children) near.observe(holder);
  }, 200);
});

setChrome();
// ?q=… opens with that search run.
const asking = new URLSearchParams(location.search).get("q");
show(mode, { keep: false }).then(() => {
  if (asking) { searchInput.value = asking; return runSearch(asking); }
}).catch((error) => {
  console.error(error);
  const message = $("error");
  message.hidden = false;
  message.innerHTML = `The document could not be displayed here. <a href="${FILES[mode]}">Open the PDF directly</a>.`;
});
