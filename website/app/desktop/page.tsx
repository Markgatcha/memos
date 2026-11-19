import type { Metadata } from "next";
import {
  Activity,
  ArrowRight,
  Eye,
  FileText,
  Gauge,
  GitBranch,
  Keyboard,
  Lock,
  Monitor,
} from "lucide-react";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";
import GithubIcon from "../_components/GithubIcon";

export const metadata: Metadata = {
  title: "MemOS Desktop — native memory explorer",
  description:
    "A native Rust/GPUI app for your MemOS SQLite store. Read-only SQLite reads, Today brief, Review queue, optional MCP writes & ingest, keyset pagination, search scopes, five graph modes, health, dream diff, 16 harnesses, and context preview.",
};

const features = [
  {
    icon: Monitor,
    title: "Native, not wrapped",
    text: "GPUI + bundled SQLite on warm obsidian surfaces. No Electron, WebView, or Node sidecar required to browse.",
  },
  {
    icon: Lock,
    title: "Read-only SQLite + opt-in MCP writes",
    text: "SQLITE_OPEN_READ_ONLY by default. Toggle Write mode (MCP) in Settings after schema preflight to create, supersede, forget, approve reviews, and ingest folders.",
  },
  {
    icon: FileText,
    title: "Receipts, timestamps & provenance",
    text: "Created, updated, last-read, and expiry times alongside trust, importance, causal lineage, and tamper-chain hashes — or an explicit “Never recalled” / “unsigned” state.",
  },
  {
    icon: GitBranch,
    title: "Five ways to see the graph",
    text: "Namespace, tag, entity, temporal, and contradiction modes with Fit view, ambient labels gated at 85% zoom, soft selected halo, and linked list hover.",
  },
  {
    icon: Activity,
    title: "Today brief, health & dream diff",
    text: "Daily Today digest across new, changed, expiring, contradicting, and attention-needed memories alongside the pinned Store card and tamper timeline.",
  },
  {
    icon: Keyboard,
    title: "Search scopes & keyboard first",
    text: "Promote type:, tag:, ns:, after:, and trust: prefixes into removable pills, paginate past 500 via SQL keysets, and navigate with j/k and Ctrl/Cmd+K.",
  },
  {
    icon: Gauge,
    title: "Small by design",
    text: "About an 18.8 MB GUI app (2.69 MB headless CLI) and ~32.5 MB RSS at 50k memories (750 paginated rows loaded). Virtualized list, capped graph, lazy detail.",
  },
  {
    icon: Eye,
    title: "What the AI sees",
    text: "Preview the exact citation block an agent receives for a memory or the current view, with a token estimate and copy.",
  },
];

const surfaces = [
  ["Store & list", "Pinned Store card, daily Today brief & Review queue views, 500 + 250 keyset pagination past 500, removable search-scope chips, 64/48 px density"],
  ["Detail", "Content, tags, entities, causal connections, contradictions, receipts, tabular Time block (Created / Updated / Last read / Reads / Validity), sticky header, copy citation"],
  ["Write & Ingest (MCP)", "Schema preflight, Ingest files/folders (memos_ingest), New memory composer, Edit (memos_supersede), Review approve/reject, Forget confirm, non-blocking retry banner"],
  ["Graph", "Namespace · tag · entity · temporal · contradictions, Fit view, ambient labels gated at 85% with 1 px halos, soft selected halo, linked list hover"],
  ["Warm glass surfaces", "Windows Mica backdrop, alpha command palette, popovers and dialogs with a 1 px top highlight and warm scrim; memory rows stay opaque for contrast"],
  ["Tools & Ops", "16-harness discovery (OpenCode 2.x/1.x, dsh, print-only badges), health fix cards, dream diff, context preview"],
];

const steps = [
  {
    step: "01",
    title: "Open the file",
    text: "Point it at ~/.memos/memos.db or pass --db. The app introspects the schema and opens read-only.",
  },
  {
    step: "02",
    title: "See what it knows",
    text: "Search, filter, and sort the store. Open a memory to read its receipts, contradictions, and connections.",
  },
  {
    step: "03",
    title: "Prove why",
    text: "Inspect the graph, the health score, the dream diff, and the exact context an agent would receive.",
  },
];

export default function Desktop() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-5xl px-6 py-16 md:py-20">
        <PageHeader
          kicker="native rust app · v0.1.0"
          title="MemOS Desktop"
          subtitle="A native explorer for your memory store. Opens SQLite strictly read-only through Rust/GPUI, with optional MCP writes when you enable them."
        />

        <Reveal className="mb-12">
          <div className="flex flex-wrap gap-3">
            <a
              href="https://github.com/Markgatcha/memos/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              Download
              <ArrowRight size={14} />
            </a>
            <a
              href="https://github.com/Markgatcha/memos/tree/main/apps/desktop-gpui"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
            >
              <GithubIcon size={14} />
              Source
            </a>
            <a href="/docs/memos/desktop" className="btn btn-secondary">
              Read the guide
            </a>
          </div>
        </Reveal>

        <Reveal className="mb-14" delay={40}>
          <div className="window">
            <div className="window-bar">
              <span className="window-dot" />
              <span className="window-dot" />
              <span className="window-dot" />
              <span className="window-title">powershell</span>
            </div>
            <div className="p-5 font-mono text-[13px] leading-7">
              <div>
                <span className="select-none text-zinc-600">$ </span>
                <span className="text-zinc-100">
                  cd apps/desktop-gpui && cargo run --release -- --db ~/.memos/memos.db
                </span>
              </div>
              <div className="text-zinc-500">
                <span className="select-none">  </span>
                # read-only SQLite · optional MCP writes · 18.8 MB binary
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal className="mb-14" delay={60}>
          <img
            src="/desktop/desktop-detail.png"
            alt="MemOS Desktop showing paginated memory list, search scopes, and Detail pane with receipts and tabular Time section"
            className="w-full rounded-lg border border-white/10"
            loading="lazy"
          />
          <p className="mt-3 text-xs text-zinc-600">
            Keyset-paginated memory list paired with Detail receipts, connections,
            technical metadata, and the tabular Time block.
          </p>
        </Reveal>

        <Reveal className="mb-14" delay={80}>
          <h2 className="section-title">Three questions, one surface</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {steps.map((s) => (
              <div key={s.step} className="card p-5">
                <div className="font-mono text-[10px] text-zinc-600">{s.step}</div>
                <h3 className="mt-3 text-sm font-medium text-zinc-200">{s.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">{s.text}</p>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal className="mb-14" delay={100}>
          <h2 className="section-title">Built for the whole store</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {features.map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.title} className="card p-5">
                  <Icon size={16} className="text-zinc-400" />
                  <h3 className="mt-3 text-sm font-medium text-zinc-200">{f.title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">{f.text}</p>
                </div>
              );
            })}
          </div>
        </Reveal>

        <Reveal className="mb-14" delay={120}>
          <h2 className="section-title">What the AI sees</h2>
          <p className="mb-5 max-w-2xl text-sm leading-relaxed text-zinc-500">
            Memory is only trustworthy if you can inspect the exact block an
            agent receives. The context preview renders the citations, content,
            and a token estimate for a single memory or the current filtered
            view — then copies it.
          </p>
          <img
            src="/desktop/desktop-context.png"
            alt="MemOS Desktop context preview showing the citation block an AI agent receives"
            className="w-full rounded-lg border border-white/10"
            loading="lazy"
          />
        </Reveal>

        <Reveal className="mb-14" delay={130}>
          <h2 className="section-title">Command palette, warm glass</h2>
          <p className="mb-5 max-w-2xl text-sm leading-relaxed text-zinc-500">
            The palette floats on a Mica-backed warm glass sheet with a 1 px
            highlight and a warm scrim. Memory rows and the graph stay opaque,
            so the glass frames the work instead of competing with it.
          </p>
          <img
            src="/desktop/desktop-palette.png"
            alt="MemOS Desktop command palette with warm translucent glass over the graph"
            className="w-full rounded-lg border border-white/10"
            loading="lazy"
          />
        </Reveal>

        <Reveal className="mb-14" delay={140}>
          <h2 className="section-title">Every surface</h2>
          <div className="card overflow-hidden">
            <div className="divide-y divide-white/[0.05]">
              {surfaces.map(([name, desc]) => (
                <div
                  key={name}
                  className="grid gap-2 px-5 py-4 md:grid-cols-[150px_1fr] md:items-baseline md:gap-6"
                >
                  <div className="font-mono text-[11px] text-zinc-400">{name}</div>
                  <div className="text-[13px] leading-relaxed text-zinc-500">{desc}</div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal className="mb-14" delay={160}>
          <img
            src="/desktop/desktop-graph.png"
            alt="MemOS Desktop namespace graph view across 96 nodes with warm low-chroma type colors"
            className="w-full rounded-lg border border-white/10"
            loading="lazy"
          />
          <p className="mt-3 text-xs text-zinc-600">
            Namespace mode: warm low-chroma type colors and ambient labels gated at 85% zoom,
            1 px text halos, soft selected ring halo, and padded 80% Fit view.
          </p>
        </Reveal>

        <Reveal className="mb-14" delay={165}>
          <h2 className="section-title">Daily triage, review queue &amp; document ingest</h2>
          <p className="mb-5 max-w-2xl text-sm leading-relaxed text-zinc-500">
            Catch up in the pure-SQLite Today brief across new and changed
            memories, with standing contradictions and attention items, then
            inspect pending agent proposals in the Review queue and chunk whole
            folders via MCP when Write mode is enabled.
          </p>
          <div className="mb-4">
            <img
              src="/desktop/desktop-today.png"
              alt="MemOS Desktop Today daily brief grouped into Expiring, Contradictions, and Needs attention sections"
              className="w-full rounded-lg border border-white/10"
              loading="lazy"
            />
            <p className="mt-2 text-xs text-zinc-600">
              Today brief grouping new, changed, expiring, contradicting, and attention-needed memories.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <img
                src="/desktop/desktop-review.png"
                alt="MemOS Desktop Review queue with confidence scores, reasons, and Approve/Reject actions"
                className="w-full rounded-lg border border-white/10"
                loading="lazy"
              />
              <p className="mt-2 text-xs text-zinc-600">
                Review queue: candidate inspection and gated Approve / Reject when Write mode (MCP) is on.
              </p>
            </div>
            <div>
              <img
                src="/desktop/desktop-ingest.png"
                alt="MemOS Desktop Ingest modal showing folder picker, presets, and live Added/Updated/Chunks counts"
                className="w-full rounded-lg border border-white/10"
                loading="lazy"
              />
              <p className="mt-2 text-xs text-zinc-600">
                Document and folder ingest via memos_ingest with live store refresh and chunk counts.
              </p>
            </div>
          </div>
        </Reveal>

        <Reveal className="mb-14" delay={170}>
          <h2 className="section-title">Opt-in MCP composer &amp; 16-harness detection</h2>
          <p className="mb-5 max-w-2xl text-sm leading-relaxed text-zinc-500">
            When you opt into Write mode (MCP) in Settings, creates, versioned
            edits, review approvals, folder ingest, and forgets route cleanly
            through the MemOS MCP stdio server. The Tools drawer checks 16 agents
            read-only without mutating global config files.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <img
                src="/desktop/desktop-composer.png"
                alt="MemOS Desktop multiline memory composer over MCP"
                className="w-full rounded-lg border border-white/10"
                loading="lazy"
              />
              <p className="mt-2 text-xs text-zinc-600">
                New memory composer routing writes via MemOS MCP.
              </p>
            </div>
            <div>
              <img
                src="/desktop/desktop-tools.png"
                alt="MemOS Desktop Tools modal showing 16 supported harnesses and OpenCode version disambiguation"
                className="w-full rounded-lg border border-white/10"
                loading="lazy"
              />
              <p className="mt-2 text-xs text-zinc-600">
                16-harness discovery separating OpenCode 2.x from legacy 1.x and flagging print-only targets.
              </p>
            </div>
          </div>
        </Reveal>

        <Reveal className="mb-14" delay={180}>
          <div className="card p-6">
            <h2 className="text-sm font-medium text-zinc-200">Read-only core, safe MCP writes</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
              Rust SQLite connections never mutate the database. Toggling
              Write mode (MCP) in Settings checks schema compatibility first,
              discovers local MemOS CLIs or falls back to npx, speaks MCP
              2026-07-28 (server/discover + _meta, with legacy 2025-11-25
              fallback), gates 42-tool views like Review and Ingest cleanly,
              and delegates writes through stdio so embeddings, provenance, and
              tamper logs stay intact.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <a href="/docs/memos/desktop" className="btn btn-secondary">
                Desktop guide
                <ArrowRight size={13} />
              </a>
              <a
                href="https://github.com/Markgatcha/memos/blob/main/apps/desktop-gpui/CHANGELOG.md"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary"
              >
                Changelog
              </a>
            </div>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
