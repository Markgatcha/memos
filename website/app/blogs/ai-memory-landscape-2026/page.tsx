import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import Reveal from "../../_components/Reveal";

export const metadata: Metadata = {
  title: "The 2026 agent-memory landscape — what we learned and what MemOS will adopt",
  description:
    "We researched the 2025–2026 AI memory wave: MemGPT/Letta, Mem0, Zep, HippoRAG 2, A-Mem, MIRIX, sleep-time compute, LongMemEval-V2, and the compression state of the art. Here's what it means for local-first memory — and the concrete roadmap for MemOS.",
  openGraph: {
    title: "The 2026 agent-memory landscape — ContextCore",
    description:
      "Five memory paradigms, a benchmark crisis, and a compression renaissance: research findings and a concrete roadmap for local-first agent memory.",
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

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-medium text-zinc-200 mt-8 mb-3">{children}</h3>
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

export default function MemoryLandscapePost() {
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
            research · sep 2026
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-[-0.03em] text-zinc-50 text-balance leading-[1.15]">
            The 2026 agent-memory landscape: what we learned, and what MemOS
            will adopt
          </h1>
          <p className="mt-6 text-lg text-zinc-400 leading-relaxed">
            We spent a week reading the 2025–2026 memory wave end to end — the
            academic papers, the vendor reports, the new benchmarks, and the
            compression literature. This post is the full briefing: what the
            field converged on, where the benchmarks are breaking, and the
            concrete list of what&apos;s coming to MemOS because of it.
          </p>
        </Reveal>

        <Reveal delay={60}>
          <H2>Five paradigms now define agent memory</H2>
          <P>
            The 2025–2026 research wave split into five identifiable camps.
            Every serious memory system you&apos;ll evaluate today descends
            from one of them, usually with the graph layer bolted on:
          </P>
          <ul className="space-y-5 mb-6">
            <LI>
              <strong className="text-zinc-200">Memory-as-OS (Letta/MemGPT).</strong>{" "}
              The original insight — page memory in and out of context like an
              operating system — aged well. Letta&apos;s 2026 benchmarking even
              argues a plain filesystem is surprisingly competitive, which is a
              useful corrective against over-engineering. Their{" "}
              <a
                href="https://arxiv.org/html/2504.13171v1"
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-300 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400"
              >
                sleep-time compute
              </a>{" "}
              paper is the more interesting contribution: agents that
              &quot;think&quot; offline about stored context before any query
              arrives cut test-time compute ~5× at equal accuracy.
            </LI>
            <LI>
              <strong className="text-zinc-200">Extract-and-retrieve (Mem0).</strong>{" "}
              An LLM extracts discrete facts from conversations, stores them,
              and retrieval fuses multiple signals — Mem0&apos;s 2026 state-of-the-industry
              report describes three parallel scoring passes (semantic, BM25,
              entity match) normalized into one fused score. Their published
              numbers: 92.5 on LoCoMo and 94.4 on LongMemEval at roughly
              ~6,900 tokens per query.
            </LI>
            <LI>
              <strong className="text-zinc-200">Temporal knowledge graphs (Zep/Graphiti).</strong>{" "}
              Model change over time as an evolving graph rather than
              replacement. Research-driven, and the reason Zep&apos;s temporal
              reasoning numbers look the way they do.
            </LI>
            <LI>
              <strong className="text-zinc-200">Neuroscience-inspired retrieval (HippoRAG 2).</strong>{" "}
              <a
                href="https://github.com/osu-nlp-group/hipporag"
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-300 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400"
              >
                &quot;From RAG to Memory&quot;
              </a>{" "}
              (ICML 2025) frames retrieval as non-parametric continual
              learning: a knowledge graph plus Personalized PageRank
              integrates factual, sense-making, and associative memory tasks —
              comprehensively beating standard RAG.
            </LI>
            <LI>
              <strong className="text-zinc-200">Self-organizing memory (A-Mem).</strong>{" "}
              <a
                href="https://arxiv.org/abs/2502.12110"
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-300 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400"
              >
                A-MEM
              </a>{" "}
              (NeurIPS 2025) applies the Zettelkasten method: memories generate
              their own contextual descriptions, link to related notes, and
              evolve as new memories arrive — the store restructures itself
              instead of sitting still.
            </LI>
          </ul>
          <P>
            Two more matter for completeness: MIRIX (six specialized memory
            types — core, episodic, semantic, procedural, resource, vault —
            with a meta-manager routing retrieval), and{" "}
            <strong className="text-zinc-300">MemTensor&apos;s MemOS</strong>{" "}
            (unrelated to us despite the shared name — their MemCube
            abstraction and &quot;LLM as kernel&quot; scheduling led to
            EverMemOS at ACL 2026). The 2026 trend line:{" "}
            <strong className="text-zinc-300">
              graph layers became table stakes
            </strong>{" "}
            (Mem0 added graph memory, Cognee is graph-centered, Graphiti went
            standalone), and offline consolidation is merging with memory
            formation.
          </P>
          <Callout>
            MemOS (ours) already ships the local-first versions of three of
            these ideas — a SQLite-native graph with temporal validity and
            trust scoring, hybrid retrieval, and TOON-packed context budgets.
            The gaps the research exposes are consolidation, richer pool
            structure, and retrieval upgrades — that&apos;s the roadmap below.
          </Callout>

          <H2>The platform vendors picked a side — and it favors tools</H2>
          <P>
            The consumer architectures diverged in a way Simon Willison
            documented nicely: ChatGPT preloads a server-side user profile
            into every conversation; Claude starts every session from a blank
            slate and consults memory on demand via a{" "}
            <a
              href="https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-300 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400"
            >
              file-based memory tool
            </a>{" "}
            — plain CRUD on files, combined with automatic context editing.
            OpenAI&apos;s own{" "}
            <a
              href="https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-300 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400"
            >
              Agents SDK cookbook
            </a>{" "}
            likewise treats memory as &quot;managing what&apos;s stored,
            recalled, and injected into working memory&quot; — an application
            concern, not a model feature. Neither vendor&apos;s memory is
            available as infrastructure.
          </P>
          <P>
            That&apos;s the structural opening local-first memory layers sit
            in: the platforms gave agents memory <em>tools</em>, and somebody
            has to implement the store behind the tool. Ours answers with a
            SQLite file you own, an MCP server any harness can mount, and a
            Claude Code plugin that injects context at session start.
          </P>

          <H2>The benchmarks are breaking — and that&apos;s informative</H2>
          <P>
            Three things happened to memory evaluation in 2026, and all three
            matter to how you should read anyone&apos;s leaderboard claims
            (including ours):
          </P>
          <ul className="space-y-5 mb-6">
            <LI>
              <strong className="text-zinc-200">LoCoMo is saturated and being gamed.</strong>{" "}
              With million-token context windows, naive &quot;dump everything
              in context&quot; solves most of it; at least one project claimed
              a 100% score, drawing justified community skepticism. A
              leaderboard number on LoCoMo no longer discriminates.
            </LI>
            <LI>
              <strong className="text-zinc-200">LongMemEval became the gold standard</strong>{" "}
              — the harder, six-category evaluation where the best published
              result sits around 94.4 (Mem0&apos;s April 2026 algorithm). And
              the scale cliff is real: Mem0&apos;s own BEAM results drop from
              64.1 at 1M tokens to 48.6 at 10M — a ~25-point fall that they
              correctly attribute to temporal abstraction. Long histories
              still break everyone.
            </LI>
            <LI>
              <strong className="text-zinc-200">LongMemEval-V2 changed the subject.</strong>{" "}
              The{" "}
              <a
                href="https://arxiv.org/html/2605.12493v1"
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-300 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400"
              >
                new benchmark
              </a>{" "}
              tests memory for <em>web agents</em> over 25M–115M-token
              environment trajectories — workflow knowledge and
              &quot;environment gotchas&quot; instead of chat recall. The
              results are humbling: naive RAG manages 38–51%, frontier
              parametric knowledge alone gets 14.1%, and the best system (a
              coding agent acting as memory controller over raw slices, event
              pools, and distilled runbook notes) reaches ~72.5%.
            </LI>
          </ul>
          <P>
            The V2 design lessons are the most actionable findings in the
            literature right now:
          </P>
          <ul className="list-disc pl-6 space-y-2.5 mb-6">
            <LI>
              <strong className="text-zinc-300">Store multiple granularities.</strong>{" "}
              Removing the raw-state pool crashed one system&apos;s accuracy
              from 0.661 to 0.286. Raw events, transition events, and
              distilled notes each earn their keep.
            </LI>
            <LI>
              <strong className="text-zinc-300">Distilled notes beat raw retrieval.</strong>{" "}
              Workflow documents (procedural notes) were the single most
              valuable addition in their ablations.
            </LI>
            <LI>
              <strong className="text-zinc-300">Multi-stream retrieval wins.</strong>{" "}
              Separate queries per memory pool, generated by an LLM
              controller, beat single-query RAG by a wide margin.
            </LI>
            <LI>
              <strong className="text-zinc-300">Evidence slicing helps reading.</strong>{" "}
              Radius-1 windows around key states substantially improve how
              well a model can use long traces.
            </LI>
          </ul>

          <H2>Token compression split into hard, soft, and agentic</H2>
          <P>
            The compression literature now cleanly divides into four families,
            and the split matters for what a local-first stack can adopt:
          </P>
          <ul className="space-y-5 mb-6">
            <LI>
              <strong className="text-zinc-200">Hard compression (token selection)</strong>{" "}
              is production-ready: the{" "}
              <a
                href="https://github.com/microsoft/llmlingua"
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-300 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400"
              >
                LLMLingua family
              </a>{" "}
              scores tokens with a small model and drops the low-information
              ones; LLMLingua-2 is 3–6× faster than its predecessors. RECOMP
              takes the text-level version of the same idea — compress
              retrieved documents into extractive or abstractive summaries
              before injection.
            </LI>
            <LI>
              <strong className="text-zinc-200">Soft compression (latent/gist tokens)</strong>{" "}
              reaches up to 26× (gist tokens) and 2026 added latent-space
              variants — K-Token Merging, CoLaR, LCLMs — but requires trained
              adapters and model cooperation. Not viable for a drop-in layer
              serving arbitrary models.
            </LI>
            <LI>
              <strong className="text-zinc-200">KV-cache compression</strong>{" "}
              (RocketKV, ChunkKV) compresses the cache instead of the prompt —
              orthogonal, inference-engine territory.
            </LI>
            <LI>
              <strong className="text-zinc-200">Agentic context compression</strong>{" "}
              is the hot 2026 survey topic: compressing observations and
              agent trajectories, not single prompts — exactly the failure
              mode LongMemEval-V2 exposes.
            </LI>
          </ul>
          <Callout>
            For a local-first memory layer, the practical recipe is hard
            compression + structured formats + budget-aware packing — no
            trained adapters required. That&apos;s why MemOS bets on compact
            TOON context packs (77.6% smaller than JSON at equal fidelity,
            verified in our{" "}
            <a
              href="/benchmarks"
              className="text-emerald-400/90 underline underline-offset-4 decoration-emerald-900 hover:decoration-emerald-500"
            >
              token-efficiency benchmarks
            </a>
            ) plus token-budgeted retrieval. LLMLingua-style filtering slots
            in cleanly as an optional stage; soft compression doesn&apos;t.
          </Callout>

          <H2>Retrieval quality has known, cheap upgrades</H2>
          <P>
            The most cited engineering result of the period is Anthropic&apos;s{" "}
            <a
              href="https://www.anthropic.com/engineering/contextual-retrieval"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-300 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400"
            >
              contextual retrieval
            </a>
            : prepend LLM-generated context to each chunk before embedding, and
            retrieval failures drop 35–49% — up to 67% when combined with
            reranking. Its mirror image is late chunking (embed the long
            context first, pool per chunk afterward). On the model side,
            Qwen3-Embedding-0.6B and Qwen3-Reranker-0.6B put 2025-MTEB-leading
            quality on a laptop, which matters to us specifically: the two-stage
            retrieve-then-rerank architecture everyone converges on no longer
            requires cloud APIs. And on the query side, the community consensus
            is that HyDE and multi-query expansion trade latency for recall
            with real but diminishing returns — worth having, cheap to toggle.
          </P>

          <H2>What&apos;s changing in MemOS</H2>
          <P>
            Everything below is scoped against our existing architecture
            (SQLite storage, hybrid keyword/semantic retrieval, graph edges
            with temporal validity and trust scores, TOON context packs, the
            MCP surface). Items 1–4 and 6 are <strong className="text-zinc-300">already
            shipped</strong> — pools, consolidation with decay-forgetting,
            entity-fused scoring, write-time enrichment, and multi-stream
            packs landed together with this post; the rest is scoped in
            priority order.
          </P>
          <H3>1. Multi-granularity pools (LongMemEval-V2&apos;s top lesson) — shipped ✅</H3>
          <P>
            Raw event memories, transition events (state A → state B), and
            distilled notes as three queryable pools inside one store. Today
            MemOS keeps one node stream plus graph relations; the V2 ablations
            show the note pool and event pool each carry independent accuracy.
            Our consolidation pass (below) is what feeds the note pool.
          </P>
          <H3>2. Sleep-time consolidation — shipped ✅</H3>
          <P>
            An idle-time job — think <code className="font-mono text-[13px] text-zinc-300">memos consolidate --while-idle</code>{" "}
            — that re-reads recent episodes, resolves contradictions (writing
            the superseded node&apos;s validTo instead of deleting — our
            temporal layer already models this), merges near-duplicates via
            the existing semantic-dedup path, distills procedural notes, and
            applies algorithmic forgetting with a decay curve. Letta&apos;s
            sleep-time compute shows this shift from query-time to idle-time
            is a Pareto improvement, and every ingredient already exists in
            the SDK.
          </P>
          <H3>3. Entity-linked fusion scoring — shipped ✅</H3>
          <P>
            Mem0&apos;s 2026 pivot is telling: they replaced a separate graph
            store with entities in a parallel collection that boost retrieval
            scores, at the cost of losing relation traversal. We don&apos;t
            have to make that trade — our graph already persists relations.
            The upgrade is fusing a third signal into scoring: entity-match
            (and eventually a bounded Personalized-PageRank expansion over
            graph neighbors, HippoRAG-style) alongside the existing keyword +
            semantic passes.
          </P>
          <H3>4. Contextual memory enrichment — shipped ✅</H3>
          <P>
            At write time, prepend a one-line LLM-generated context to each
            memory (&quot;this was stated while debugging the deploy
            pipeline&quot;) so embeddings carry situational meaning. This is
            the single best-attested retrieval upgrade in the literature
            (−35–49% failures), and with a local 0.6B model it stays
            fully offline.
          </P>
          <H3>5. Local default embedder + reranker</H3>
          <P>
            Make Qwen3-Embedding-0.6B + Qwen3-Reranker-0.6B the batteries-included
            local defaults (LFM2.5 and bge-reranker-v2-m3 remain supported).
            Both run on CPU/laptop GPU via llama.cpp, and the two-stage
            architecture is now the consensus quality floor.
          </P>
          <H3>6. Multi-stream retrieval — shipped ✅</H3>
          <P>
            When a context pack is requested, issue separate pool-specific
            queries (events / notes / procedures) and fuse — the V2 result
            that beat single-query RAG by ~20 points. Our context-pack API
            already owns the budget arithmetic; this changes where candidates
            come from, not the contract.
          </P>
          <H3>7. LLMLingua-style filtering as an opt-in stage</H3>
          <P>
            For aggressive token budgets, an optional hard-compression pass
            over the assembled pack, downstream of TOON packing. TELeR-style
            tiered summaries for tool outputs are in the same bucket — this
            composes with LLM Guardian&apos;s pipeline rather than
            duplicating it.
          </P>
          <H3>8. Benchmarks: scale, provenance, and the agentic turn</H3>
          <P>
            Three commitments. First, extend BEAM beyond 1M toward the 10M
            regime where everyone (us included) falls off a cliff — temporal
            abstraction is the honest frontier. Second, keep publishing
            provenance: our benchmark page now auto-regenerates a
            &quot;verified runs&quot; table from committed result JSONs, and
            LoCoMo&apos;s gaming episode is exactly why we&apos;ll keep doing
            that. Third, treat LongMemEval-V2 as the target shape for an
            agentic-memory eval: environment trajectories, workflow knowledge,
            gotcha recall — chat-recall benchmarks alone no longer prove an
            agent memory works.
          </P>

          <H2>The local-first thesis got stronger</H2>
          <P>
            The quiet pattern across everything we read: every technique that
            mattered in 2025–2026 — graph memory, two-stage rerank, contextual
            enrichment, consolidation, hard compression — works on small local
            models and a SQLite file. The cloud memory platforms&apos;
            structural advantages (hosted vector DBs, server-side profiles)
            turned out not to be where accuracy comes from. Accuracy comes
            from pipeline design, and the pipeline now fits on a laptop.
          </P>

          <H2>Sources</H2>
          <ul className="space-y-2 text-[13px] text-zinc-500 leading-relaxed">
            <li>
              ·{" "}
              <a href="https://mem0.ai/blog/state-of-ai-agent-memory-2026" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">Mem0 — State of AI Agent Memory 2026</a>{" "}
              (vendor-published; read with that in mind)
            </li>
            <li>
              ·{" "}
              <a href="https://arxiv.org/html/2605.12493v1" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">LongMemEval-V2 (arXiv 2605.12493)</a>
            </li>
            <li>
              ·{" "}
              <a href="https://arxiv.org/html/2504.13171v1" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">Sleep-time Compute (Letta + UC Berkeley, arXiv 2504.13171)</a>
            </li>
            <li>
              ·{" "}
              <a href="https://arxiv.org/abs/2502.14802" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">HippoRAG 2 — From RAG to Memory (ICML 2025)</a>
            </li>
            <li>
              ·{" "}
              <a href="https://arxiv.org/abs/2502.12110" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">A-MEM: Agentic Memory (NeurIPS 2025)</a>
            </li>
            <li>
              ·{" "}
              <a href="https://arxiv.org/abs/2507.07957" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">MIRIX: Multi-Agent Memory System</a>
            </li>
            <li>
              ·{" "}
              <a href="https://github.com/MemTensor/MemOS" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">MemTensor&apos;s MemOS (unrelated project, shared name)</a>
            </li>
            <li>
              ·{" "}
              <a href="https://www.anthropic.com/engineering/contextual-retrieval" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">Anthropic — Contextual Retrieval</a>
              {" "}·{" "}
              <a href="https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">Claude memory tool</a>
            </li>
            <li>
              ·{" "}
              <a href="https://simonwillison.net/2025/Sep/12/claude-memory/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">Simon Willison — Comparing Claude and ChatGPT memory</a>
            </li>
            <li>
              ·{" "}
              <a href="https://github.com/microsoft/llmlingua" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">Microsoft LLMLingua / LLMLingua-2</a>
              {" "}·{" "}
              <a href="https://arxiv.org/abs/2310.04408" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">RECOMP</a>
              {" "}·{" "}
              <a href="https://arxiv.org/abs/2304.08467" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">Gist tokens</a>
            </li>
            <li>
              ·{" "}
              <a href="https://arxiv.org/html/2506.05176v1" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">Qwen3 Embedding technical report</a>
            </li>
            <li>
              ·{" "}
              <a href="https://letta.com/blog/benchmarking-ai-agent-memory" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 decoration-zinc-700 hover:text-zinc-300">Letta — Benchmarking AI Agent Memory</a>
            </li>
          </ul>

          <div className="mt-14 pt-8 border-t border-white/[0.06]">
            <Link href="/memos" className="btn btn-primary">
              Try MemOS
              <ArrowLeft size={15} className="rotate-180" />
            </Link>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
