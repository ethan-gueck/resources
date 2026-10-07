/*
 * viewer.js — renders the Math Comprehensive Review with PDF.js, one canvas per page, drawn as it
 * scrolls into view. The moon/sun toggle swaps between the light (original) and dark editions
 * (both built by build/build_pdfs.py), keeps your place, and points the download button at the
 * edition you are looking at. "Jump to section" comes from the PDF's own outline.
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

const load = (m) => (docs[m] ||= pdfjs.getDocument(FILES[m]).promise);

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
  holder.replaceChildren(canvas);
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
show(mode, { keep: false }).catch((error) => {
  console.error(error);
  const message = $("error");
  message.hidden = false;
  message.innerHTML = `The document could not be displayed here. <a href="${FILES[mode]}">Open the PDF directly</a>.`;
});
