import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowDefs,
  DBox,
  DCaption,
  DNote,
  Figure,
  HArrow,
  MONO,
  VArrow,
} from "../../_components/Diagram";
import Reveal from "../../_components/Reveal";

export const metadata: Metadata = {
  title: "The frontier stopped deleting: ADD-only memory and the end of overwrite",
  description:
    "Mem0, Graphiti, and the rest of the field converged on the same idea in 2026: never delete or overwrite memories — append, invalidate, and keep history. Why it happened, and how MemOS implements it locally.",
  openGraph: {
    title: "The frontier stopped deleting — ContextCore",
    description:
      "ADD-only extraction, bi-temporal invalidation, and version timelines: why 2026's memory systems never overwrite, and how to do it on a laptop.",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
};

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xl md:text-2xl font-semibold tracking-[-0.02em] text-zinc-50 mt-12 mb-5 text-balance">
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[15px] text-zinc-400 leading-[1.8] mb-5">{children}</p>
  );
}

function LI({ children }: { children: React.ReactNode }) {
  return (
    <li className="text-[14px] text-zinc-400 leading-[1.75] mb-2.5 pl-1">
      {children}
    </li>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="card p-5 md:p-6 my-8 border-emerald-500/20">
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-emerald-400/90 mb-2.5">
        takeaway
      </div>
      <div className="text-[14px] text-zinc-300 leading-[1.75]">{children}</div>
    </div>
  );
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-zinc-300 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400"
    >
      {children}
    </a>
  );
}

function WritePathDiagram() {
  return (
    <Figure
      kicker="figure · move the hard decision to the best moment"
      viewBox="0 0 640 300"
      label="Diagram comparing the old write path, where an LLM makes an irreversible ADD, UPDATE or DELETE decision at write time, with the add-only write path, where every observation is appended and contradictions are resolved at read time."
    >
      <ArrowDefs id="wp-arr" />
      <DCaption x={16} y={22}>
        {"old write path · decide with partial info"}
      </DCaption>
      <DBox x={16} y={34} w={288} lines={["new observation"]} />
      <VArrow x={160} y1={94} y2={108} marker="wp-arr" />
      <polygon
        points="160,112 304,140 160,168 16,140"
        fill="#141417"
        stroke="rgba(251,191,36,0.45)"
        strokeWidth={1}
      />
      <text
        x={160}
        y={140}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fcd34d"
        fontSize={12}
        fontFamily={MONO}
      >
        {"LLM: ADD / UPDATE / DELETE?"}
      </text>
      <VArrow x={160} y1={172} y2={186} marker="wp-arr" />
      <DBox x={16} y={190} w={288} lines={["irreversible write"]} tone="amber" />
      <DNote x={16} y={268} fill="#fcd34d">
        {"every UPDATE bets you'll never need the old version"}
      </DNote>

      <DCaption x={336} y={22}>
        {"add-only · decide at read time"}
      </DCaption>
      <DBox x={336} y={34} w={288} lines={["new observation"]} />
      <VArrow x={480} y1={94} y2={108} marker="wp-arr" />
      <DBox x={336} y={112} w={288} lines={["single-pass ADD"]} tone="emerald" />
      <VArrow x={480} y1={172} y2={186} marker="wp-arr" />
      <DBox
        x={336}
        y={190}
        w={288}
        lines={["version chain grows"]}
        tone="emerald"
      />
      <DNote x={336} y={260}>
        {"contradictions resolved at read time,"}
      </DNote>
      <DNote x={336} y={276}>
        {"with the query in hand"}
      </DNote>
    </Figure>
  );
}

function VersionTimeline() {
  return (
    <Figure
      kicker="figure · invalidate, don't delete"
      viewBox="0 0 640 380"
      label="Timeline diagram comparing mutate-in-place memory, where Alice works at Acme is overwritten by Alice works at Globex and history is lost, with add-only memory, where version 1 keeps a validity window from March to June, version 2 opens from June onward, and a contradicts edge links them."
    >
      <ArrowDefs id="vt-arr" />
      <line x1={96} y1={40} x2={600} y2={40} stroke="#3f3f46" strokeWidth={1.5} />
      {[
        { x: 150, label: "mar" },
        { x: 350, label: "jun" },
        { x: 560, label: "now" },
      ].map((t) => (
        <g key={t.label}>
          <line
            x1={t.x}
            y1={34}
            x2={t.x}
            y2={46}
            stroke="#52525b"
            strokeWidth={1.5}
          />
          <text
            x={t.x}
            y={28}
            textAnchor="middle"
            fill="#71717a"
            fontSize={11}
            fontFamily={MONO}
            letterSpacing={1}
          >
            {t.label}
          </text>
        </g>
      ))}

      <DCaption x={16} y={102}>
        {"mutate-in-place"}
      </DCaption>
      <DBox x={96} y={112} w={180} lines={["Alice @ Acme"]} tone="ghost" />
      <line x1={108} y1={122} x2={264} y2={154} stroke="#f87171" strokeWidth={2} />
      <line x1={108} y1={154} x2={264} y2={122} stroke="#f87171" strokeWidth={2} />
      <HArrow x1={280} x2={296} y={140} marker="vt-arr" />
      <DBox x={300} y={112} w={180} lines={["Alice @ Globex"]} />
      <DNote x={96} y={196} fill="#f87171">
        {"✕ overwritten — “where did Alice work in March?” is unanswerable"}
      </DNote>

      <DCaption x={16} y={236}>
        {"add-only · invalidate, don't delete"}
      </DCaption>
      <DBox x={96} y={246} w={220} lines={["v1 · Alice @ Acme"]} />
      <rect
        x={96}
        y={308}
        width={220}
        height={6}
        rx={3}
        fill="rgba(16,185,129,0.55)"
      />
      <text
        x={96}
        y={328}
        fill="#6ee7b7"
        fontSize={11}
        fontFamily={MONO}
        letterSpacing={1}
      >
        {"t_valid  mar → jun"}
      </text>
      <DBox x={336} y={246} w={220} lines={["v2 · Alice @ Globex"]} />
      <rect
        x={336}
        y={308}
        width={220}
        height={6}
        rx={3}
        fill="rgba(16,185,129,0.55)"
      />
      <text
        x={336}
        y={328}
        fill="#6ee7b7"
        fontSize={11}
        fontFamily={MONO}
        letterSpacing={1}
      >
        {"t_valid  jun → now"}
      </text>
      <path
        d="M 440 240 C 400 206, 262 206, 222 240"
        fill="none"
        stroke="#a1a1aa"
        strokeWidth={1.5}
        strokeDasharray="5 4"
        markerEnd="url(#vt-arr)"
      />
      <text
        x={331}
        y={231}
        textAnchor="middle"
        fill="#a1a1aa"
        fontSize={11}
        fontFamily={MONO}
        letterSpacing={1}
      >
        {"contradicts"}
      </text>
      <DNote x={96} y={360}>
        {"“where did Alice work in March?” → validity filter → v1"}
      </DNote>
    </Figure>
  );
}

export default function AddOnlyMemoryPost() {
  return (
    <main className="min-h-screen">
      <div className="max-w-3xl mx-auto px-6 py-16 md:py-20">
        <Reveal>
          <Link
            href="/blogs"
            className="font-mono text-xs text-zinc-500 hover:text-zinc-300 transition-colors inline-flex items-center gap-1.5 mb-8"
          >
            <ArrowLeft size={13} /> all posts
          </Link>
          <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-zinc-500 mb-4">
            architecture · sep 2026
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-[-0.03em] text-zinc-50 text-balance leading-[1.15]">
            The frontier stopped deleting: ADD-only memory and the end of
            overwrite
          </h1>
          <p className="mt-6 text-lg text-zinc-400 leading-relaxed">
            In 2026, the best memory systems independently converged on the
            same design: never update, never delete — append new memories and
            invalidate old ones. Here&apos;s why overwrite was a mistake, and
            what replaces it.
          </p>
        </Reveal>

        <Reveal delay={60}>
          <H2>The old world: extract, update, delete</H2>
          <P>
            The first generation of agent memory worked like a database row.
            The agent learned something new about you, the system extracted a
            fact, and then it had to decide: is this a new fact, an update to
            an old fact, or a deletion? Mem0&apos;s original pipeline made
            exactly this three-way call on every write — ADD, UPDATE, or
            DELETE — and the LLM had to get the classification right, every
            time, from a single conversation turn.
          </P>
          <P>
            It didn&apos;t. Updates merged facts that shouldn&apos;t have been
            merged. Deletions fired on ambiguous phrasing. And worst of all,
            every overwrite destroyed information: once &quot;Alice works at
            Acme&quot; was updated to &quot;Alice works at Globex,&quot; the
            system could no longer answer &quot;where did Alice work in
            March?&quot; The write path was making irreversible decisions
            with partial information — the exact thing a memory system should
            never do.
          </P>

          <H2>April 2026: Mem0 stops updating</H2>
          <P>
            The break came from{" "}
            <A href="https://arxiv.org/pdf/2504.19413">Mem0&apos;s 2026
            update</A>: the pipeline switched to single-pass ADD-only
            extraction. No UPDATE. No DELETE. Every observation becomes a new
            memory, and contradictions are resolved at <em>retrieval</em>{" "}
            time — when the system has the query, the full context, and the
            strongest reason to care about which version is current.
          </P>
          <P>
            This is the right division of labor. At write time you have the
            least information and the most pressure to decide quickly; at
            read time you have the most information and a concrete question
            to answer. Moving the hard decision from the worst moment to the
            best moment is the whole insight.
          </P>
          <WritePathDiagram />

          <H2>Zep&apos;s version: invalidate, don&apos;t delete</H2>
          <P>
            The graph camp arrived at the same place from a different
            direction. <A href="https://arxiv.org/pdf/2501.13956">Graphiti</A>{" "}
            (the engine behind Zep) gives every edge a bi-temporal validity
            window — <span className="font-mono text-[13px] text-zinc-300">t_valid</span> and{" "}
            <span className="font-mono text-[13px] text-zinc-300">t_invalid</span>.
            When Alice changes jobs, the old edge isn&apos;t deleted; its
            validity window is closed and a new edge opens. Contradictions
            invalidate rather than destroy.
          </P>
          <P>
            The payoff is temporal queries. &quot;Where does Alice work
            now?&quot; filters to edges valid today. &quot;Where did she work
            in March?&quot; filters to edges valid in March. A system that
            deletes can answer the first question; only a system that keeps
            history can answer the second. Temporal reasoning is the hardest
            slice of every memory benchmark — and it&apos;s unanswerable by
            construction if you overwrite.
          </P>
          <VersionTimeline />
          <Callout>
            Premature consolidation destroys information. Every UPDATE is a
            bet that you&apos;ll never need the old version. The field spent
            two years losing that bet before it stopped making it.
          </Callout>

          <H2>What this looks like in MemOS</H2>
          <P>
            We implemented the convergent design locally, in SQLite, with no
            cloud service involved:
          </P>
          <ul className="space-y-5 mb-6">
            <LI>
              <strong className="text-zinc-200">Typed edges.</strong>{" "}
              Memories link through typed relations —{" "}
              <span className="font-mono text-[13px] text-zinc-300">relates_to</span>,{" "}
              <span className="font-mono text-[13px] text-zinc-300">supports</span>,{" "}
              <span className="font-mono text-[13px] text-zinc-300">contradicts</span> —
              so a superseded fact isn&apos;t edited in place; it gains a{" "}
              <span className="font-mono text-[13px] text-zinc-300">contradicts</span>{" "}
              edge to its replacement. Both versions survive, with provenance.
            </LI>
            <LI>
              <strong className="text-zinc-200">Version timeline.</strong>{" "}
              <span className="font-mono text-[13px] text-zinc-300">memos history &lt;id&gt;</span>{" "}
              (and the{" "}
              <span className="font-mono text-[13px] text-zinc-300">memos_history</span>{" "}
              MCP tool) walks the full lineage of a memory — every version,
              when it changed, and why. Nothing is ever truly gone.
            </LI>
            <LI>
              <strong className="text-zinc-200">Retain pre-filter.</strong>{" "}
              Since we never delete, the write path needs a bouncer instead:
              incoming observations are scored on length, signal density,
              action verbs, and novelty, and anything below threshold never
              pays for an embedding round-trip. Append-only doesn&apos;t mean
              append-everything.
            </LI>
          </ul>

          <H2>The twist: never deleting is a local-first luxury</H2>
          <P>
            Here&apos;s the part the vendors won&apos;t advertise: ADD-only
            memory is expensive to store. Every contradiction kept is tokens
            on disk and vectors in an index, forever. For a cloud platform
            charging per stored token, history is a cost center — which is
            exactly why the managed services were the last to give up
            deletion.
          </P>
          <P>
            Local-first flips the economics. A SQLite file on your disk holds
            years of memories for effectively zero marginal cost, and
            retrieval filters by validity window before the LLM ever sees the
            stale versions. The architecture the research converged on is one
            that only makes economic sense when you own the storage. That was
            always the bet behind MemOS: the best memory design and the
            cheapest memory deployment are the same design, as long as the
            disk is yours.
          </P>
        </Reveal>
      </div>
    </main>
  );
}
