// doc-search dashboard.
//
// Search runs locally in the tab using the same engine module as the CLI
// (public/kb.mjs is generated from src/kb.mjs). "Ask" calls /api/ask, which
// proxies the official docs ask endpoint — if that function is not deployed,
// the page says so instead of pretending.

import { searchDocs, toToolResult, listSections, INDEX_META, DOCS } from "./kb.mjs";

const $ = (sel) => document.querySelector(sel);

const state = {
  mode: "search",
  query: "",
  section: null,
  limit: 5,
  results: [],
  active: -1,
  busy: false
};

const els = {
  q: $("#q"),
  goal: $("#goal"),
  goalRow: $("#goal-row"),
  go: $("#go"),
  sections: $("#sections"),
  limit: $("#limit"),
  hint: $("#hint"),
  pages: $("#pages"),
  status: $("#status"),
  results: $("#results"),
  answer: $("#answer"),
  examples: $("#examples"),
  provenance: $("#provenance")
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/* ---------------------------------------------------------------- markdown */

/** Minimal markdown for answers: fences, headings, lists, links, emphasis. */
function renderMarkdown(source) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null;
  let fence = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
      list = null;
    }
  };

  const inline = (text) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((\S+?)\)/g, (_, label, href) =>
        /^https?:/.test(href)
          ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
          : `<a href="https://docs.pharos.xyz${href.replace(/\.md$/, "")}" target="_blank" rel="noreferrer">${label}</a>`
      );

  for (const line of lines) {
    if (fence) {
      if (line.trim().startsWith("```")) {
        out.push(`<pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (line.trim().startsWith("```")) {
      flushParagraph();
      flushList();
      fence = { lines: [] };
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ordered || bullet) {
      flushParagraph();
      const tag = ordered ? "ol" : "ul";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((ordered || bullet)[1]);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (fence) out.push(`<pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return out.join("\n");
}

/** Wrap query terms in <mark>, on already-escaped text. */
function highlight(escapedText, terms) {
  const words = terms.filter((term) => term.length > 1).slice(0, 8);
  if (!words.length) return escapedText;
  const pattern = words
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  return escapedText.replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
}

/* ------------------------------------------------------------------- chrome */

function sectionCounts() {
  const counts = new Map();
  for (const doc of DOCS) counts.set(doc.section, (counts.get(doc.section) || 0) + 1);
  return counts;
}

function renderSections() {
  const counts = sectionCounts();
  const sections = listSections();
  els.sections.innerHTML = "";
  const all = document.createElement("button");
  all.className = "chip is-active";
  all.type = "button";
  all.dataset.section = "";
  all.innerHTML = `All<span class="count">${DOCS.length}</span>`;
  els.sections.append(all);
  for (const section of sections) {
    const button = document.createElement("button");
    button.className = "chip";
    button.type = "button";
    button.dataset.section = section;
    button.innerHTML = `${escapeHtml(section)}<span class="count">${counts.get(section) || 0}</span>`;
    els.sections.append(button);
  }
  els.sections.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.section = chip.dataset.section || null;
    for (const node of els.sections.querySelectorAll(".chip")) node.classList.toggle("is-active", node === chip);
    run();
  });
}

function renderExamples() {
  const examples = [
    "what is the pacific mainnet chain id and rpc",
    "how do I get PROS gas",
    "deploy a contract with foundry",
    "eth_getProof",
    "x402 payment flow",
    "node monitoring setup",
    "canonical contracts"
  ];
  for (const example of examples) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.type = "button";
    chip.textContent = example;
    chip.addEventListener("click", () => {
      els.q.value = example;
      setMode("search");
      run();
    });
    els.examples.append(chip);
  }
}

function setMode(mode) {
  state.mode = mode;
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  els.goalRow.hidden = mode !== "ask";
  els.go.textContent = mode === "ask" ? "Ask" : "Search";
  els.q.placeholder =
    mode === "ask" ? "how do I bridge USDC to Pharos?" : "what is the pacific mainnet chain id and rpc";
  els.hint.innerHTML =
    mode === "ask"
      ? "Ask sends your question to <code>docs.pharos.xyz</code> through this site's <code>/api/ask</code>. Answers are grounded in the docs and cited; slow (7–25s) because the docs generate them."
      : `Search runs entirely in this tab against a build of ${INDEX_META.pageCount} pages. Press <span class="kbd">/</span> to focus.`;
  els.answer.hidden = true;
  if (mode === "search") renderResults();
}

function showStatus(kind, html) {
  els.status.className = `status ${kind}`;
  els.status.innerHTML = html;
  els.status.hidden = false;
}

function clearStatus() {
  els.status.hidden = true;
  els.status.innerHTML = "";
}

/* ------------------------------------------------------------------ search */

function renderResults() {
  const { results, query } = state;
  els.results.innerHTML = "";
  if (state.mode !== "search" || !query) return;
  if (!results.length) return;

  const terms = results[0]?.matchedTerms?.length
    ? [...new Set(results.flatMap((doc) => doc.matchedTerms))]
    : query.toLowerCase().split(/\s+/);

  results.forEach((doc, index) => {
    const article = document.createElement("article");
    article.className = "result";
    article.dataset.index = String(index);
    article.innerHTML = `
      <div class="result-head">
        <h3><a href="${doc.url}" target="_blank" rel="noreferrer">${escapeHtml(doc.title)}</a></h3>
        <span class="badge">${escapeHtml(doc.section)}</span>
      </div>
      <p class="url">${escapeHtml(doc.url.replace(/^https?:\/\//, ""))}</p>
      <p class="snippet">${highlight(escapeHtml(doc.snippet || ""), terms)}</p>
      <div class="actions">
        <a href="${doc.url}" target="_blank" rel="noreferrer">open page ↗</a>
        <a href="${doc.mdUrl}" target="_blank" rel="noreferrer">markdown</a>
        <button type="button" data-copy="${escapeHtml(`npx pharos-docs doc ${doc.id}`)}">copy CLI command</button>
      </div>
      ${doc.headings?.length ? `<p class="headings">${doc.headings.slice(0, 5).map((h) => `<span>${escapeHtml(h)}</span>`).join("")}</p>` : ""}
    `;
    els.results.append(article);
  });

  const best = results[0];
  const score = Math.round(best.score);
  showStatus(
    state.resultsConfidence?.level === "low" ? "warn" : "ok",
    `<strong>${results.length} page${results.length === 1 ? "" : "s"}</strong> · best match <strong>${escapeHtml(best.title)}</strong> (score ${score}) · ranked offline, no network call.`
  );
}

function runSearch() {
  const query = state.query.trim();
  els.results.innerHTML = "";
  if (!query) {
    clearStatus();
    return;
  }
  const results = searchDocs(query, { limit: state.limit, section: state.section });
  const payload = toToolResult(query, results);
  state.results = payload.results;
  state.resultsConfidence = payload.confidence;
  state.active = -1;

  if (!results.length) {
    const suggestions = payload.suggestions?.length ? ` Did you mean: ${payload.suggestions.map(escapeHtml).join(", ")}?` : "";
    showStatus(
      "warn",
      `No page in the offline index matched <strong>${escapeHtml(query)}</strong>.${suggestions} Try <a href="#" data-ask="${escapeHtml(query)}">asking the live docs</a>.`
    );
    return;
  }
  renderResults();
  if (payload.confidence.level !== "high") {
    showStatus(
      payload.confidence.level === "low" ? "warn" : "",
      `<strong>${results.length} page${results.length === 1 ? "" : "s"}</strong> · ${escapeHtml(payload.confidence.reason || "")} · <a href="#" data-ask="${escapeHtml(query)}">ask the live docs</a> for a written answer.`
    );
  }
}

/* --------------------------------------------------------------------- ask */

async function runAsk() {
  const question = state.query.trim();
  if (!question) return;
  const goal = els.goal.value.trim();
  state.busy = true;
  els.go.disabled = true;
  els.results.innerHTML = "";
  els.answer.hidden = true;
  showStatus("", `Asking the live docs… <span class="mono">${escapeHtml(question)}</span> — this usually takes 7–25 seconds.`);

  const started = Date.now();
  try {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, goal })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      const message = payload?.error?.message || `HTTP ${response.status}`;
      const code = payload?.error?.code || "error";
      throw Object.assign(new Error(message), { code, status: response.status });
    }
    renderAnswer(payload, Date.now() - started);
  } catch (err) {
    const deployed = await hasApi();
    const detail = deployed
      ? `${escapeHtml(err.message)} <span class="mono">(${escapeHtml(err.code || "error")})</span>`
      : `This deployment has no <code>/api/ask</code> function, so live answers are unavailable. The offline search above still works.`;
    showStatus(
      "err",
      `<strong>Live ask failed.</strong> ${detail}
       <br /><a href="https://docs.pharos.xyz/?ask=${encodeURIComponent(question)}" target="_blank" rel="noreferrer">Ask on docs.pharos.xyz ↗</a>
       · <a href="#" data-mode="search">Search the offline index instead</a>`
    );
  } finally {
    state.busy = false;
    els.go.disabled = false;
  }
}

function renderAnswer(payload, elapsedMs) {
  const sources = payload.sources || [];
  els.answer.hidden = false;
  els.answer.innerHTML = `
    <h2>${escapeHtml(payload.question)}</h2>
    <p class="sub">grounded answer from docs.pharos.xyz · ${Math.round(elapsedMs / 1000)}s · ${sources.length} source${sources.length === 1 ? "" : "s"}</p>
    <div class="body">${renderMarkdown(payload.answer)}</div>
    ${
      sources.length
        ? `<h4>Sources</h4><ul class="sources">${sources
            .slice(0, 10)
            .map((source) => `<li><a href="${source.url}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a> <span class="t">${escapeHtml(source.url.replace(/^https?:\/\//, ""))}</span></li>`)
            .join("")}</ul>`
        : ""
    }
    ${
      payload.followups?.length
        ? `<h4>Follow-ups</h4><div class="chips">${payload.followups
            .slice(0, 4)
            .map((item) => `<button class="chip" type="button" data-followup="${escapeHtml(item.question)}">${escapeHtml(item.question)}</button>`)
            .join("")}</div>`
        : ""
    }
  `;
  clearStatus();
  els.answer.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function hasApi() {
  try {
    const response = await fetch("/api/meta", { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- wiring */

function run() {
  state.query = els.q.value;
  syncUrl();
  if (state.mode === "ask") return runAsk();
  runSearch();
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.section) params.set("s", state.section);
  if (state.mode === "ask") params.set("m", "ask");
  const next = params.toString() ? `?${params}` : location.pathname;
  history.replaceState(null, "", next);
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  const query = params.get("q") || "";
  const section = params.get("s") || null;
  const mode = params.get("m") === "ask" ? "ask" : "search";
  if (query) els.q.value = query;
  if (mode) setMode(mode);
  if (section) {
    state.section = section;
    for (const chip of els.sections.querySelectorAll(".chip")) {
      chip.classList.toggle("is-active", chip.dataset.section === section);
    }
  }
  if (query) run();
}

let debounce;
els.q.addEventListener("input", () => {
  clearTimeout(debounce);
  if (state.mode === "ask") return;
  debounce = setTimeout(() => {
    state.query = els.q.value;
    syncUrl();
    runSearch();
  }, 110);
});

els.q.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    run();
  } else if (event.key === "Escape") {
    els.q.value = "";
    state.query = "";
    els.results.innerHTML = "";
    clearStatus();
    syncUrl();
  } else if (event.key === "ArrowDown" && state.results.length) {
    event.preventDefault();
    moveActive(1);
  } else if (event.key === "ArrowUp" && state.results.length) {
    event.preventDefault();
    moveActive(-1);
  }
});

function moveActive(delta) {
  const nodes = [...els.results.querySelectorAll(".result")];
  if (!nodes.length) return;
  state.active = (state.active + delta + nodes.length) % nodes.length;
  nodes.forEach((node, index) => node.classList.toggle("is-active", index === state.active));
  nodes[state.active].scrollIntoView({ block: "nearest" });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== els.q) {
    event.preventDefault();
    els.q.focus();
    els.q.select();
  }
});

els.go.addEventListener("click", run);
els.limit.addEventListener("change", () => {
  state.limit = Number(els.limit.value);
  runSearch();
});

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    setMode(tab.dataset.mode);
    if (state.query.trim() && tab.dataset.mode === "ask") runAsk();
  });
}

document.addEventListener("click", async (event) => {
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    const text = copy.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
      const original = copy.textContent;
      copy.textContent = "copied";
      setTimeout(() => (copy.textContent = original), 1200);
    } catch {
      copy.textContent = "copy failed";
    }
    return;
  }
  const ask = event.target.closest("[data-ask]");
  if (ask) {
    event.preventDefault();
    els.q.value = ask.dataset.ask;
    setMode("ask");
    runAsk();
    return;
  }
  const followup = event.target.closest("[data-followup]");
  if (followup) {
    els.q.value = followup.dataset.followup;
    runAsk();
    return;
  }
  const modeLink = event.target.closest("[data-mode]");
  if (modeLink) {
    event.preventDefault();
    setMode(modeLink.dataset.mode);
  }
});

/* ---------------------------------------------------------------------- boot */

els.pages.textContent = `${INDEX_META.pageCount} pages`;
els.provenance.innerHTML =
  `index: <span class="mono">${INDEX_META.pageCount} pages</span> · hash <span class="mono">${escapeHtml(INDEX_META.contentHash)}</span> · built ${escapeHtml(INDEX_META.generatedAt)} from <a href="${INDEX_META.source}" target="_blank" rel="noreferrer">llms.txt</a>`;

renderSections();
renderExamples();
readUrl();

hasApi().then((deployed) => {
  if (!deployed) {
    els.provenance.innerHTML += ` · <span title="static deployment: search works, live ask needs the Pages Function">static mode</span>`;
  }
});
