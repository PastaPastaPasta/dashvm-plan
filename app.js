(() => {
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const STATUS_LABEL = {not_started:"Not started", blocked:"Blocked", in_progress:"In progress", in_review:"In review", ready_for_humans:"Awaiting humans", merged:"Merged", attention:"Needs attention", external:"External PR", manual:"Manual"};
const STATUS_ORDER = ["in_progress","in_review","ready_for_humans","attention","merged","external","manual","not_started","blocked"];
let D = null, tasksById = {}, selected = null, view = "board", filters = {q:"", group:"all", release:"all", status:"all"};
let cam = {x: 40, y: 40, k: 1}, layout = {}, edgeMode = "selected";

async function load() {
  const r = await fetch("data.json?t=" + Date.now(), {cache: "no-store"});
  D = await r.json();
  D.tasks.forEach(t => tasksById[t.id] = t);
  render();
  const age = (Date.now() - Date.parse(D.generated_at)) / 60000;
  const f = $("#freshness");
  f.textContent = "updated " + rel(D.generated_at);
  f.className = "sync-pill " + (age < 45 ? "fresh" : "stale");
  f.title = D.generated_at + " (tick " + (D.last_tick || "never") + ")";
}
function rel(ts) {
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (m < 1) return "just now"; if (m < 60) return m + " min ago"; const h = Math.round(m / 60);
  if (h < 48) return h + " h ago"; return Math.round(h / 24) + " d ago";
}
function siteStatus(t) { return t.site_status; }
function matches(t) {
  const q = filters.q.trim().toLowerCase();
  if (q && !(t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || (t.workstream||"").toLowerCase().includes(q) || t.modules.join(" ").toLowerCase().includes(q))) return false;
  if (filters.group !== "all" && t.workstream !== filters.group) return false;
  if (filters.release !== "all" && t.release_target !== filters.release) return false;
  if (filters.status !== "all" && siteStatus(t) !== filters.status) return false;
  return true;
}
function render() {
  $("#subtitle").textContent = `${D.tasks.length} tasks · ${D.deps.length} dependencies · ${D.packages_count} workstreams · runner ${D.runner.max_active} active, stacking ${D.runner.stack_depth ? "on" : "off"}`;
  const counts = {}; D.tasks.forEach(t => counts[siteStatus(t)] = (counts[siteStatus(t)] || 0) + 1);
  $("#overview-counts").innerHTML = STATUS_ORDER.filter(s => counts[s]).map(s => `<div><b>${counts[s]}</b><span><i class="dot ${s}"></i>${STATUS_LABEL[s]}</span></div>`).join("");
  $("#legend").innerHTML = STATUS_ORDER.map(s => `<span><i class="dot ${s}"></i>${STATUS_LABEL[s]}</span>`).join("");
  const rel_ = {}; D.tasks.forEach(t => rel_[t.release_target] = (rel_[t.release_target] || 0) + 1);
  $("#release-summary").innerHTML = `<span><b>Completion targets</b></span>` + Object.entries(rel_).sort().map(([k, v]) => `<span><b>${k}</b>: ${v}</span>`).join("") +
    `<span>· cost to date <b>$${D.cost_total}</b></span><span>· ${D.quota || ""}</span>`;
  const active = D.tasks.filter(t => t.lane);
  $("#active-strip").innerHTML = active.length ? `<span><b>Running now</b></span>` + active.map(t => `<span class="chip" data-id="${t.id}"><i class="dot ${siteStatus(t)}"></i><span class="mono">${t.id}</span> ${t.lane.lane} #${t.lane.attempt} · ${rel(t.lane.started_at)}</span>`).join("") : `<span class="secondary">No lane running.</span>`;
  $("#active-strip").querySelectorAll(".chip").forEach(c => c.onclick = () => select(c.dataset.id));
  const gf = $("#group-filter"); gf.innerHTML = `<option value="all">All workstreams</option>` + D.workstreams.map(w => `<option value="${w.id}">${w.id} · ${esc(w.title)}</option>`).join("");
  gf.value = filters.group;
  $("#status-filter").innerHTML = `<option value="all">All statuses</option>` + STATUS_ORDER.map(s => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("");
  $("#status-filter").value = filters.status;
  $("#plan-meta").textContent = `${D.deps.length} dependencies · ${D.waivers_count} waived · last tick ${D.last_tick ? rel(D.last_tick) : "never"}`;
  $("#count-board").textContent = D.tasks.length; $("#count-cap").textContent = Object.keys(D.capabilities).length;
  $("#footer-caption").textContent = `Generated ${D.generated_at}`;
  renderBoard(); renderDeps(); renderTable(); renderCaps(); renderActivity(); applyFilters();
}
function applyFilters() {
  let n = 0;
  document.querySelectorAll(".node").forEach(el => { const ok = matches(tasksById[el.dataset.id]); el.classList.toggle("dim", !ok); if (ok) n++; });
  document.querySelectorAll("#table-rows tr.rowlink").forEach(el => { el.hidden = !matches(tasksById[el.dataset.id]); });
  const any = filters.q || filters.group !== "all" || filters.release !== "all" || filters.status !== "all";
  $("#match-count").textContent = any ? `${n} of ${D.tasks.length} tasks` : `${D.tasks.length} tasks`;
  $("#reset-filters").hidden = !any;
}
/* ---------- board ---------- */
function renderBoard() {
  const groups = $("#board-groups"), nodes = $("#board-nodes"); groups.innerHTML = ""; nodes.innerHTML = ""; layout = {};
  const W = 210, H = 96, GAPX = 14, GAPY = 12, COLS = 3, PAD = 12, HEAD = 66, GGAP = 26;
  const byWs = {}; D.workstreams.forEach(w => byWs[w.id] = []);
  D.tasks.forEach(t => (byWs[t.workstream] = byWs[t.workstream] || []).push(t));
  const order = D.workstreams.map(w => w.id).filter(id => byWs[id] && byWs[id].length);
  // 4 columns of workstream groups, packed by height
  const colX = [0, 0, 0, 0].map((_, i) => i * (COLS * (W + GAPX) + 2 * PAD + GGAP)), colY = [0, 0, 0, 0];
  order.forEach(wsId => {
    const ts = byWs[wsId], rows = Math.ceil(ts.length / COLS), gh = HEAD + rows * (H + GAPY) + PAD, gw = COLS * (W + GAPX) + 2 * PAD - GAPX;
    const c = colY.indexOf(Math.min(...colY)), gx = colX[c], gy = colY[c]; colY[c] += gh + GGAP;
    const w = D.workstreams.find(x => x.id === wsId);
    const g = document.createElement("div"); g.className = "group"; g.style.cssText = `left:${gx}px;top:${gy}px;width:${gw}px;height:${gh}px`;
    g.innerHTML = `<h3>${wsId} <span class="secondary">${esc(w ? w.title : "")}</span></h3><div class="gsub">${w ? w.target : ""} · ${ts.length} tasks · <a href="https://github.com/dashpay/platform/issues/${w ? w.issue : ""}" target="_blank">#${w ? w.issue : ""}</a></div>`;
    groups.appendChild(g);
    ts.forEach((t, i) => {
      const x = gx + PAD + (i % COLS) * (W + GAPX), y = gy + HEAD + Math.floor(i / COLS) * (H + GAPY); layout[t.id] = {x, y, w: W, h: H};
      const n = document.createElement("div"); n.className = `node st-${siteStatus(t)}`; n.dataset.id = t.id; n.style.cssText = `left:${x}px;top:${y}px;height:${H}px`;
      n.innerHTML = `<div class="nid">${t.id}</div><div class="ntitle">${esc(t.title)}</div><div class="nmeta"><span>${STATUS_LABEL[siteStatus(t)]}${t.lane ? " · " + t.lane.lane : ""}</span><span>${t.release_target}</span></div>`;
      n.onclick = (e) => { e.stopPropagation(); select(t.id); };
      nodes.appendChild(n);
    });
  });
  const worldW = Math.max(...colX) + COLS * (W + GAPX) + 2 * PAD, worldH = Math.max(...colY);
  $("#world").style.width = worldW + "px"; $("#world").style.height = worldH + "px";
  const svg = $("#board-edges"); svg.setAttribute("width", worldW); svg.setAttribute("height", worldH);
  $("#board-caption").textContent = `${D.tasks.length} tasks · ${order.length} workstreams`;
  drawEdges(); fitBoard();
}
function drawEdges() {
  const svg = $("#board-edges"); svg.innerHTML = `<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--muted)"/></marker></defs>`;
  if (edgeMode === "none") return;
  const edges = edgeMode === "all" ? D.deps : D.deps.filter(e => selected && (e.pre === selected || e.task === selected));
  edges.forEach(e => {
    const a = layout[e.pre], b = layout[e.task]; if (!a || !b) return;
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`);
    p.setAttribute("class", "edge" + (e.evidence === "explicit" ? " explicit" : "") + (e.waived ? " waived" : "")); p.setAttribute("marker-end", "url(#arr)");
    svg.appendChild(p);
  });
}
function applyCam() { $("#world").style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.k})`; $("#zoom-label").textContent = Math.round(cam.k * 100) + "%"; }
function fitBoard() { const b = $("#board").getBoundingClientRect(), w = $("#world").offsetWidth, h = $("#world").offsetHeight; cam.k = Math.min((b.width - 40) / w, (b.height - 40) / h, 1); cam.x = (b.width - w * cam.k) / 2; cam.y = 20; applyCam(); }
function focusTask() { const l = selected && layout[selected]; if (!l) return; const b = $("#board").getBoundingClientRect(); cam.k = 1; cam.x = b.width / 2 - (l.x + l.w / 2); cam.y = b.height / 2 - (l.y + l.h / 2); applyCam(); }
(function boardInteractions() {
  const board = $("#board"); let drag = null;
  board.addEventListener("mousedown", e => { if (e.target.closest(".node,button,select")) return; drag = {x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y}; board.classList.add("dragging"); });
  window.addEventListener("mousemove", e => { if (!drag) return; cam.x = drag.cx + e.clientX - drag.x; cam.y = drag.cy + e.clientY - drag.y; applyCam(); });
  window.addEventListener("mouseup", () => { drag = null; board.classList.remove("dragging"); });
  board.addEventListener("wheel", e => { e.preventDefault(); const r = board.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, k = Math.min(2.5, Math.max(.12, cam.k * (e.deltaY < 0 ? 1.1 : .9))); cam.x = mx - (mx - cam.x) * k / cam.k; cam.y = my - (my - cam.y) * k / cam.k; cam.k = k; applyCam(); }, {passive: false});
  $("#zoom-in").onclick = () => { cam.k = Math.min(2.5, cam.k * 1.2); applyCam(); }; $("#zoom-out").onclick = () => { cam.k = Math.max(.12, cam.k / 1.2); applyCam(); };
  $("#zoom-label").onclick = () => { cam.k = 1; applyCam(); }; $("#fit-board").onclick = fitBoard; $("#focus-task").onclick = focusTask;
  $("#edge-mode").onchange = e => { edgeMode = e.target.value; drawEdges(); };
  board.addEventListener("click", e => { if (!e.target.closest(".node")) { /* keep selection */ } });
})();
/* ---------- selection / inspector ---------- */
function select(id) {
  selected = id; document.querySelectorAll(".node").forEach(n => n.classList.toggle("selected", n.dataset.id === id));
  drawEdges(); renderInspector(); $("#deps-task").value = id; renderDepsGraph();
}
function prLink(t) { return t.pr ? `<a href="${t.pr.url}" target="_blank">${t.pr.repo.split("/")[1]}#${t.pr.number}</a>` : ""; }
function renderInspector() {
  const t = tasksById[selected]; if (!t) { $("#inspector").hidden = true; $("#work-area").classList.remove("with-inspector"); return; }
  $("#inspector").hidden = false; $("#work-area").classList.add("with-inspector");
  const deps = D.deps.filter(e => e.task === t.id).map(e => `<a href="#" data-sel="${e.pre}" class="mono">${e.pre}</a>${e.waived ? " (waived)" : ""}<span class="secondary"> ${tasksById[e.pre] ? STATUS_LABEL[siteStatus(tasksById[e.pre])] : ""}</span>`).join(", ") || "none";
  const enables = D.deps.filter(e => e.pre === t.id).map(e => `<a href="#" data-sel="${e.task}" class="mono">${e.task}</a>`).join(", ") || "none";
  const pr = t.pr ? `${prLink(t)} ${t.pr.draft ? "(draft)" : ""}<br><span class="secondary">CI ${t.pr.ci_green === true ? "green" : t.pr.ci_green === false ? "not green" : "unknown"} · thepastaclaw ${t.pr.pastaclaw_approved ? "approved" : "not yet"} · unresolved threads ${t.pr.unresolved ?? "?"}${t.pr.gate ? " · gate: " + esc(t.pr.gate) : ""}</span>` : "none";
  const hist = (t.history || []).slice(-8).reverse().map(h => `<div class="hist">${h.at.replace("T", " ").replace("Z", "")} <b>${h.to}</b>${h.reason ? " · " + esc(h.reason) : ""}</div>`).join("");
  const parts = (t.parts || []).length ? `<dt>Parts</dt><dd>${t.parts.map(p => `${p.n}. ${esc(p.title || "")} <span class="pill">${p.status}</span>${p.pr ? ` <a href="${p.pr}" target="_blank">PR</a>` : ""}`).join("<br>")}</dd>` : "";
  $("#task-detail").innerHTML = `<div class="detail"><span class="pill st ${siteStatus(t)}">${STATUS_LABEL[siteStatus(t)]}</span> <span class="pill">${t.status}</span> <span class="pill">${t.tier}</span> <span class="pill">${t.release_target}</span>
  <h3><span class="mono">${t.id}</span></h3><p>${esc(t.title)}</p>
  <dl><dt>Workstream</dt><dd>${t.workstream} · <a href="https://github.com/dashpay/platform/issues/${t.workstream_issue}#task-${t.id.toLowerCase()}" target="_blank">#${t.workstream_issue}</a></dd>
  <dt>Modules</dt><dd class="mono">${t.modules.join(", ")}</dd>
  <dt>DIPs</dt><dd>${(t.dips || []).map(d => D.dips[d] ? `<a href="https://github.com/dashpay/dips/pull/190/files" target="_blank" title="${esc(D.dips[d].title)}">${d}</a>` : d).join(", ") || "none"}</dd>
  <dt>Branch</dt><dd class="mono">${t.branch || "-"} ← ${t.base_branch || "-"}</dd>
  <dt>Lane</dt><dd>${t.lane ? `${t.lane.lane} #${t.lane.attempt} since ${rel(t.lane.started_at)}` : "none"} · attempts ${JSON.stringify(t.attempts || {})}</dd>
  <dt>Pull request</dt><dd>${pr}</dd>${parts}
  <dt>Depends on</dt><dd>${deps}</dd><dt>Enables</dt><dd>${enables}</dd>
  <dt>Cost</dt><dd>$${t.cost_usd || 0}</dd></dl>
  ${t.plan_summary || t.plan_file ? `<div class="plan-row"><span class="eyebrow">PLAN</span>${t.plan_file ? `<button id="open-plan" data-file="${t.plan_file}" data-id="${t.id}">View full plan</button>` : ""}</div>${t.plan_summary ? `<div class="box clamp" id="plan-box">${esc(t.plan_summary)}</div><button class="text-button" id="plan-more">Show summary in full</button>` : ""}` : ""}
  ${t.review_summary ? `<span class="eyebrow">REVIEW</span><div class="box">consensus ${t.review_summary.consensus} · ${t.review_summary.findings} findings · ${t.review_summary.rounds} rounds${(t.review_summary.open || []).length ? "\nopen: " + esc(JSON.stringify(t.review_summary.open)) : ""}</div>` : ""}
  ${(t.notes || []).length ? `<span class="eyebrow">NOTES</span><div class="box">${t.notes.map(esc).join("\n")}</div>` : ""}
  <span class="eyebrow">ACCEPTANCE</span><div class="box">${esc(t.acceptance || "")}</div>
  <span class="eyebrow">HISTORY</span>${hist || '<div class="hist">no transitions yet</div>'}</div>`;
  $("#task-detail").querySelectorAll("[data-sel]").forEach(a => a.onclick = e => { e.preventDefault(); select(a.dataset.sel); });
  const more = $("#plan-more"); if (more) more.onclick = () => { $("#plan-box").classList.toggle("clamp"); more.textContent = $("#plan-box").classList.contains("clamp") ? "Show summary in full" : "Collapse summary"; };
  const open = $("#open-plan"); if (open) open.onclick = () => openPlan(open.dataset.id, open.dataset.file);
}
/* ---------- full plan modal ---------- */
async function openPlan(id, file) {
  const t = tasksById[id];
  $("#modal-title").textContent = `${id} · ${t ? t.title : ""}`;
  $("#modal-raw").href = file;
  $("#modal-body").innerHTML = '<p class="secondary">Loading plan…</p>';
  $("#modal").hidden = false; document.body.style.overflow = "hidden";
  try {
    const r = await fetch(file + "?t=" + Date.now()); if (!r.ok) throw new Error(r.status);
    $("#modal-body").innerHTML = md(await r.text()); $("#modal-body").scrollTop = 0;
  } catch (e) { $("#modal-body").innerHTML = `<p class="secondary">Could not load ${esc(file)} (${esc(String(e.message || e))}). The plan is published after the tick that captured it.</p>`; }
}
function closeModal() { $("#modal").hidden = true; document.body.style.overflow = ""; }
$("#modal-close").onclick = closeModal; $("#modal").onclick = e => { if (e.target === $("#modal")) closeModal(); };
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function md(src) {
  const lines = src.replace(/\r/g, "").split("\n"); const out = []; let i = 0;
  const flushPara = p => { if (p.length) out.push(`<p>${inline(p.join(" "))}</p>`); p.length = 0; };
  let para = [];
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { flushPara(para); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { flushPara(para); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(l)) { flushPara(para); out.push("<hr>"); i++; continue; }
    if (/^\|/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara(para); const cells = r => r.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`); continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      flushPara(para); const ordered = /\d/.test(li[2]); const tag = ordered ? "ol" : "ul"; const items = []; const baseIndent = li[1].length;
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m && m[1].length <= baseIndent) { items.push(m[3]); i++; }
        else if (lines[i].trim() && (m ? m[1].length > baseIndent : /^\s+/.test(lines[i]))) { items[items.length - 1] += "\n" + lines[i].trim(); i++; }
        else break;
      }
      out.push(`<${tag}>${items.map(x => `<li>${inline(x).replace(/\n/g, "<br>")}</li>`).join("")}</${tag}>`); continue;
    }
    if (/^>\s?/.test(l)) { flushPara(para); const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue; }
    if (!l.trim()) { flushPara(para); i++; continue; }
    para.push(l); i++;
  }
  flushPara(para); return out.join("\n");
}
$("#close-inspector").onclick = () => { selected = null; document.querySelectorAll(".node.selected").forEach(n => n.classList.remove("selected")); drawEdges(); renderInspector(); };
/* ---------- dependencies view ---------- */
function renderDeps() {
  const sel = $("#deps-task"); sel.innerHTML = D.tasks.map(t => `<option value="${t.id}">${t.id} · ${esc(t.title.slice(0, 70))}</option>`).join("");
  sel.onchange = () => { selected = sel.value; renderInspector(); renderDepsGraph(); };
  if (!selected) selected = D.tasks.find(t => t.lane)?.id || D.tasks[0].id; sel.value = selected; renderDepsGraph();
}
function renderDepsGraph() {
  const t = tasksById[selected]; if (!t) return;
  const pre = D.deps.filter(e => e.task === t.id), post = D.deps.filter(e => e.pre === t.id);
  $("#deps-summary").innerHTML = `<p><span class="mono">${t.id}</span> ${esc(t.title)} · <span class="pill st ${siteStatus(t)}">${STATUS_LABEL[siteStatus(t)]}</span> · ${pre.length} prerequisites, ${post.length} dependents, ${t.transitive_dependents} transitive.</p>`;
  const svg = $("#deps-graph"), W = 1100, colH = Math.max(pre.length, post.length, 1) * 64 + 40; svg.setAttribute("viewBox", `0 0 ${W} ${colH}`); svg.style.height = Math.min(700, colH) + "px";
  const node = (id, x, y, center) => { const tt = tasksById[id]; return `<g class="mpm-node ${center ? "center" : ""}" data-sel="${id}" transform="translate(${x},${y})"><rect width="300" height="52" rx="8"/><rect width="5" height="52" rx="2" class="st-${siteStatus(tt)}" style="fill:var(--${{in_progress:"info",in_review:"warn",merged:"ok",attention:"bad",external:"purple",manual:"purple"}[siteStatus(tt)] || "grey"})"/><text x="14" y="20" class="mono" style="fill:var(--accent)">${id}</text><text x="14" y="40" class="sub">${esc(tt.title.slice(0, 44))}${tt.title.length > 44 ? "…" : ""}</text></g>`; };
  let s = `<defs><marker id="arr2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--muted)"/></marker></defs>`;
  const cy = colH / 2 - 26; s += node(t.id, 400, cy, true);
  pre.forEach((e, i) => { const y = 20 + i * 64; s += `<path class="edge ${e.evidence === "explicit" ? "explicit" : ""} ${e.waived ? "waived" : ""}" marker-end="url(#arr2)" d="M320,${y + 26} C360,${y + 26} 360,${cy + 26} 400,${cy + 26}"/>` + node(e.pre, 20, y); });
  post.forEach((e, i) => { const y = 20 + i * 64; s += `<path class="edge ${e.evidence === "explicit" ? "explicit" : ""}" marker-end="url(#arr2)" d="M700,${cy + 26} C740,${cy + 26} 740,${y + 26} 780,${y + 26}"/>` + node(e.task, 780, y); });
  svg.innerHTML = s; svg.querySelectorAll("[data-sel]").forEach(g => g.onclick = () => { selected = g.dataset.sel; $("#deps-task").value = selected; renderInspector(); renderDepsGraph(); document.querySelectorAll(".node").forEach(n => n.classList.toggle("selected", n.dataset.id === selected)); drawEdges(); });
}
/* ---------- table ---------- */
function renderTable() {
  const rows = D.tasks.slice().sort((a, b) => STATUS_ORDER.indexOf(siteStatus(a)) - STATUS_ORDER.indexOf(siteStatus(b)) || b.transitive_dependents - a.transitive_dependents);
  $("#table-note").textContent = "sorted by status, then by how many tasks each unblocks";
  $("#table-rows").innerHTML = `<table><thead><tr><th>Task</th><th>Status</th><th>Workstream</th><th>Target</th><th>Base</th><th>Lane</th><th>PR</th><th>Unblocks</th><th>Cost</th></tr></thead><tbody>` +
    rows.map(t => `<tr class="rowlink" data-id="${t.id}"><td><span class="mono">${t.id}</span><br><span class="secondary">${esc(t.title.slice(0, 110))}${t.title.length > 110 ? "…" : ""}</span></td><td><span class="pill st ${siteStatus(t)}">${STATUS_LABEL[siteStatus(t)]}</span><br><span class="secondary">${t.status}</span></td><td>${t.workstream}</td><td>${t.release_target}</td><td class="mono">${t.base_branch || ""}</td><td>${t.lane ? `${t.lane.lane} #${t.lane.attempt}` : ""}</td><td>${prLink(t)}</td><td>${t.transitive_dependents}</td><td>$${t.cost_usd || 0}</td></tr>`).join("") + "</tbody></table>";
  $("#table-rows").querySelectorAll("tr.rowlink").forEach(r => r.onclick = () => select(r.dataset.id));
}
/* ---------- capabilities ---------- */
let capSel = null;
function renderCaps() {
  const caps = Object.values(D.capabilities); const groups = [...new Set(caps.map(c => c.group))].sort();
  $("#cap-group").innerHTML = `<option value="all">All capability groups</option>` + groups.map(g => `<option>${esc(g)}</option>`).join("");
  const draw = () => { const q = $("#cap-search").value.toLowerCase(), g = $("#cap-group").value;
    $("#cap-list").innerHTML = caps.filter(c => (g === "all" || c.group === g) && (!q || (c.id + " " + c.title).toLowerCase().includes(q))).map(c => `<div class="cap-item ${capSel === c.id ? "active" : ""}" data-cap="${c.id}"><span class="cid">${c.id}</span>${esc(c.title)}<br><span class="secondary">${(c.tasks || []).join(", ")}</span></div>`).join("");
    $("#cap-list").querySelectorAll(".cap-item").forEach(el => el.onclick = () => { capSel = el.dataset.cap; draw(); showCap(); }); };
  $("#cap-search").oninput = draw; $("#cap-group").onchange = draw; draw(); showCap();
}
function showCap() { const c = D.capabilities[capSel]; if (!c) { $("#cap-detail").innerHTML = `<p class="secondary">Select a capability. 110 families: 108 inspected native capabilities and 2 external primitives, from the issue's capability appendices.</p>`; return; }
  const taskStatus = (c.tasks || []).map(id => tasksById[id] ? `<a href="#" data-sel="${id}" class="mono">${id}</a> <span class="pill st ${siteStatus(tasksById[id])}">${STATUS_LABEL[siteStatus(tasksById[id])]}</span>` : id).join(" · ");
  $("#cap-detail").innerHTML = `<span class="eyebrow">${esc(c.group)}</span><h2><span class="mono">${c.id}</span> ${esc(c.title)}</h2><p>${taskStatus}</p><p class="secondary">profile ${c.profile || "?"} · surface ${c.surface || "?"} · ${c.status || ""} · modules ${(c.modules || []).join(", ")}</p><pre>${esc(c.body || "")}</pre>`;
  $("#cap-detail").querySelectorAll("[data-sel]").forEach(a => a.onclick = e => { e.preventDefault(); select(a.dataset.sel); showView("board"); focusTask(); }); }
/* ---------- activity ---------- */
function renderActivity() {
  $("#attention").innerHTML = (D.attention || []).map(a => `<div class="item"><b>${esc(a.kind)}</b> <span class="mono">${esc(a.task)}</span> · ${esc(a.detail)}${a.options && a.options.length ? `<br><span class="secondary">${a.options.map(esc).join(" · ")}</span>` : ""}</div>`).join("") || `<p class="secondary">No open attention items.</p>`;
  $("#activity-note").textContent = `${D.events.length} most recent events`;
  $("#activity-rows").innerHTML = `<table><thead><tr><th>When</th><th>Task</th><th>Event</th><th>Detail</th></tr></thead><tbody>` + D.events.map(e => `<tr${e.task && tasksById[e.task] ? ` class="rowlink" data-id="${e.task}"` : ""}><td class="mono">${e.at.replace("T", " ").replace("Z", "")}</td><td class="mono">${esc(e.task || "")}</td><td>${esc(e.kind)}</td><td>${esc(e.detail)}</td></tr>`).join("") + "</tbody></table>";
  $("#activity-rows").querySelectorAll("tr.rowlink").forEach(r => r.onclick = () => { select(r.dataset.id); });
}
/* ---------- tabs, filters, theme ---------- */
function showView(v) { view = v; document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === v)); document.querySelectorAll(".view").forEach(s => s.hidden = s.id !== "view-" + v); location.hash = v; if (v === "board") fitBoard(); }
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => showView(b.dataset.view));
$("#task-search").oninput = e => { filters.q = e.target.value; applyFilters(); };
$("#group-filter").onchange = e => { filters.group = e.target.value; applyFilters(); };
$("#release-filter").onchange = e => { filters.release = e.target.value; applyFilters(); };
$("#status-filter").onchange = e => { filters.status = e.target.value; applyFilters(); };
$("#reset-filters").onclick = () => { filters = {q: "", group: "all", release: "all", status: "all"}; $("#task-search").value = ""; $("#group-filter").value = "all"; $("#release-filter").value = "all"; $("#status-filter").value = "all"; applyFilters(); };
$("#theme").onclick = () => { const h = document.documentElement; h.dataset.theme = h.dataset.theme === "dark" ? "light" : "dark"; localStorage.setItem("theme", h.dataset.theme); };
document.documentElement.dataset.theme = localStorage.getItem("theme") || "dark";
load().then(() => { const h = location.hash.replace("#", ""); if (["board", "deps", "table", "cap", "activity"].includes(h)) showView(h); else fitBoard(); const q = new URLSearchParams(location.search).get("task"); if (q && tasksById[q]) { select(q); focusTask(); } });
setInterval(load, 5 * 60 * 1000);
})();
