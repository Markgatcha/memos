import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
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
