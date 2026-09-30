/**
 * Local dashboard — a browser UI for the MemOS memory store.
 *
 * `memos dashboard` starts a local HTTP server (no external dependencies)
 * serving a single-page dashboard for browsing, searching, and visualizing
 * the memory graph. No MCP Apps host required.
 *
 * API:
 *   GET /api/memories?limit=50&offset=0  — list memories
 *   GET /api/search?q=...&limit=20        — search memories
 *   GET /api/memory/:id                   — get one memory
 *   GET /api/graph                        — graph nodes + edges
 *   GET /api/stats                        — store statistics
 *
 * @module @memos/dashboard
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { MemOS } from "./memory.js";

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MemOS Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1115; color: #e6e6e6; }
  header { background: #1a1d24; padding: 1rem 2rem; border-bottom: 1px solid #2a2e38; display: flex; align-items: center; gap: 1rem; }
  header h1 { font-size: 1.25rem; font-weight: 600; }
  header .badge { background: #2d6a4f; color: #fff; padding: 0.15rem 0.6rem; border-radius: 1rem; font-size: 0.75rem; }
  nav { display: flex; gap: 0.5rem; padding: 1rem 2rem; background: #14161b; border-bottom: 1px solid #2a2e38; }
  nav button { background: #23262e; color: #e6e6e6; border: 1px solid #2a2e38; padding: 0.5rem 1rem; border-radius: 0.375rem; cursor: pointer; }
  nav button.active { background: #2d6a4f; border-color: #2d6a4f; }
  nav button:hover { background: #2e323c; }
  nav button.active:hover { background: #2d6a4f; }
  main { padding: 2rem; max-width: 1200px; margin: 0 auto; }
  .search-bar { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
  .search-bar input { flex: 1; background: #1a1d24; border: 1px solid #2a2e38; color: #e6e6e6; padding: 0.75rem 1rem; border-radius: 0.375rem; font-size: 1rem; }
  .search-bar button { background: #2d6a4f; color: #fff; border: none; padding: 0.75rem 1.5rem; border-radius: 0.375rem; cursor: pointer; font-size: 1rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .stat-card { background: #1a1d24; border: 1px solid #2a2e38; border-radius: 0.5rem; padding: 1.25rem; }
  .stat-card .value { font-size: 2rem; font-weight: 700; color: #52b788; }
  .stat-card .label { color: #888; font-size: 0.875rem; margin-top: 0.25rem; }
  .memory-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .memory-card { background: #1a1d24; border: 1px solid #2a2e38; border-radius: 0.5rem; padding: 1rem 1.25rem; }
  .memory-card .meta { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 0.5rem; font-size: 0.8rem; color: #888; }
  .memory-card .type { background: #2a2e38; padding: 0.15rem 0.5rem; border-radius: 0.25rem; }
  .memory-card .content { line-height: 1.5; }
  .memory-card .id { font-family: monospace; font-size: 0.75rem; }
  #graph-canvas { width: 100%; height: 600px; background: #1a1d24; border: 1px solid #2a2e38; border-radius: 0.5rem; }
  .empty { text-align: center; color: #666; padding: 3rem; }
  .loading { text-align: center; color: #888; padding: 2rem; }
</style>
</head>
<body>
<header>
  <h1>MemOS Dashboard</h1>
  <span class="badge">local</span>
</header>
<nav>
  <button data-view="browse" class="active">Browse</button>
  <button data-view="search">Search</button>
  <button data-view="graph">Graph</button>
  <button data-view="stats">Stats</button>
</nav>
<main>
  <div id="view-browse">
    <div class="memory-list" id="memory-list"><div class="loading">Loading...</div></div>
  </div>
  <div id="view-search" style="display:none">
    <div class="search-bar">
      <input type="text" id="search-input" placeholder="Search memories...">
      <button onclick="doSearch()">Search</button>
    </div>
    <div class="memory-list" id="search-results"></div>
  </div>
  <div id="view-graph" style="display:none">
    <canvas id="graph-canvas"></canvas>
  </div>
  <div id="view-stats" style="display:none">
    <div class="stats" id="stats-grid"><div class="loading">Loading...</div></div>
  </div>
</main>
<script>
  const views = ["browse", "search", "graph", "stats"];
  document.querySelectorAll("nav button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("nav button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const view = btn.dataset.view;
      views.forEach(v => document.getElementById("view-" + v).style.display = v === view ? "block" : "none");
      if (view === "browse") loadMemories();
      if (view === "graph") loadGraph();
      if (view === "stats") loadStats();
    });
  });

  function memoryCard(m) {
    const date = m.createdAt ? new Date(m.createdAt).toLocaleString() : "";
    return '<div class="memory-card">' +
      '<div class="meta"><span class="type">' + esc(m.type || "note") + '</span>' +
      '<span class="id">' + esc((m.id || "").slice(0, 8)) + '</span>' +
      '<span>' + esc(date) + '</span></div>' +
      '<div class="content">' + esc(m.content || "") + '</div></div>';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  async function loadMemories() {
    const el = document.getElementById("memory-list");
    try {
      const r = await fetch("/api/memories?limit=50");
      const data = await r.json();
      el.innerHTML = data.memories.length
        ? data.memories.map(memoryCard).join("")
        : '<div class="empty">No memories yet. Use <code>memos store</code> to add some.</div>';
    } catch (e) { el.innerHTML = '<div class="empty">Failed to load: ' + esc(e.message) + '</div>'; }
  }

  async function doSearch() {
    const q = document.getElementById("search-input").value.trim();
    const el = document.getElementById("search-results");
    if (!q) { el.innerHTML = ""; return; }
    el.innerHTML = '<div class="loading">Searching...</div>';
    try {
      const r = await fetch("/api/search?q=" + encodeURIComponent(q) + "&limit=20");
      const data = await r.json();
      el.innerHTML = data.results.length
        ? data.results.map(x => memoryCard(x.node || x)).join("")
        : '<div class="empty">No results.</div>';
    } catch (e) { el.innerHTML = '<div class="empty">Search failed: ' + esc(e.message) + '</div>'; }
  }
  document.getElementById("search-input").addEventListener("keydown", e => {
    if (e.key === "Enter") doSearch();
  });

  async function loadGraph() {
    const canvas = document.getElementById("graph-canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = canvas.offsetWidth; canvas.height = 600;
    ctx.fillStyle = "#888"; ctx.font = "14px sans-serif";
    ctx.fillText("Loading graph...", 20, 30);
    try {
      const r = await fetch("/api/graph");
      const data = await r.json();
      drawGraph(ctx, canvas, data);
    } catch (e) {
      ctx.fillText("Failed: " + e.message, 20, 30);
    }
  }

  function drawGraph(ctx, canvas, data) {
    const nodes = data.nodes || [];
    const edges = data.edges || [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!nodes.length) {
      ctx.fillStyle = "#666"; ctx.fillText("No memories to graph.", 20, 30);
      return;
    }
    // Simple radial layout
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const radius = Math.min(cx, cy) - 60;
    const pos = {};
    nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / nodes.length;
      pos[n.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
    });
    // Edges
    ctx.strokeStyle = "#2a2e38"; ctx.lineWidth = 1;
    edges.forEach(e => {
      const a = pos[e.source] || pos[e.from], b = pos[e.target] || pos[e.to];
      if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    });
    // Nodes
    nodes.forEach(n => {
      const p = pos[n.id];
      ctx.fillStyle = "#52b788";
      ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = "#aaa"; ctx.font = "11px sans-serif";
      const label = (n.content || n.id || "").slice(0, 24);
      ctx.fillText(label, p.x + 12, p.y + 4);
    });
  }

  async function loadStats() {
    const el = document.getElementById("stats-grid");
    try {
      const r = await fetch("/api/stats");
      const s = await r.json();
      el.innerHTML =
        statCard(s.total ?? 0, "Total memories") +
        statCard(s.byType ? Object.keys(s.byType).length : 0, "Memory types") +
        statCard(s.edges ?? 0, "Graph edges");
    } catch (e) { el.innerHTML = '<div class="empty">Failed: ' + esc(e.message) + '</div>'; }
  }
  function statCard(value, label) {
    return '<div class="stat-card"><div class="value">' + value + '</div><div class="label">' + esc(label) + '</div></div>';
  }

  loadMemories();
</script>
</body>
</html>`;

export interface DashboardOptions {
  port?: number;
  open?: boolean;
}

/**
 * Start the local dashboard server.
 * Returns the server instance and the URL.
 */
export async function startDashboard(
  memos: MemOS,
  opts: DashboardOptions = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const port = opts.port ?? 0; // 0 = random available port

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // CORS for local dev
      res.setHeader("Access-Control-Allow-Origin", "*");
      const url = new URL(req.url ?? "/", `http://localhost`);

      try {
        // API routes
        if (url.pathname === "/api/memories") {
          const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
          const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
          const graph = await memos.getGraph();
          const nodes = graph.nodes ?? [];
          const memories = nodes.slice(offset, offset + limit);
          sendJson(res, { memories, total: nodes.length });
          return;
        }

        if (url.pathname === "/api/search") {
          const q = url.searchParams.get("q") ?? "";
          const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
          const results = q ? await memos.search(q, { limit }) : [];
          sendJson(res, { results, query: q });
          return;
        }

        if (url.pathname.startsWith("/api/memory/")) {
          const id = decodeURIComponent(
            url.pathname.slice("/api/memory/".length),
          );
          const node = await memos.retrieve(id);
          if (!node) {
            sendJson(res, { error: "not found" }, 404);
          } else {
            sendJson(res, { memory: node });
          }
          return;
        }

        if (url.pathname === "/api/graph") {
          const graph = await memos.getGraph();
          sendJson(res, {
            nodes: graph.nodes ?? [],
            edges: graph.edges ?? [],
          });
          return;
        }

        if (url.pathname === "/api/stats") {
          const graph = await memos.getGraph();
          const nodes = graph.nodes ?? [];
          const byType: Record<string, number> = {};
          for (const n of nodes) {
            const t = (n as any).type ?? "note";
            byType[t] = (byType[t] ?? 0) + 1;
          }
          sendJson(res, {
            total: nodes.length,
            byType,
            edges: (graph.edges ?? []).length,
          });
          return;
        }

        // Serve the dashboard HTML for all other routes
        if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(DASHBOARD_HTML);
          return;
        }

        sendJson(res, { error: "not found" }, 404);
      } catch (err) {
        sendJson(
          res,
          { error: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
