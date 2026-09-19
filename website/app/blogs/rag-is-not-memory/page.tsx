import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import Reveal from "../../_components/Reveal";

export const metadata: Metadata = {
  title: "RAG is not memory: what the leaderboards teach about hybrid retrieval",
  description:
    "The ablations are in: BM25+vector beats either alone, reranking is worth +3.4pp, and entity linking boosts recall. Why memory retrieval is evidence assembly, not ranking — and how MemOS does it locally.",
  openGraph: {
    title: "RAG is not memory — ContextCore",
    description:
      "Hybrid retrieval lessons from the memory leaderboards: multi-signal fusion, entity linking, and why retrieval is evidence assembly, not ranking.",
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

export default function RagIsNotMemoryPost() {
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
            retrieval · sep 2026
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-[-0.03em] text-zinc-50 text-balance leading-[1.15]">
            RAG is not memory: what the leaderboards teach about hybrid
            retrieval
          </h1>
          <p className="mt-6 text-lg text-zinc-400 leading-relaxed">
            Everyone bolted a vector database onto their agent and called it
            memory. The benchmark ablations tell a more specific story — about
            which signals actually matter, and why retrieving memories is a
            different job than retrieving documents.
          </p>
        </Reveal>

        <Reveal delay={60}>
          <H2>The +9pp ablation that settled it</H2>
          <P>
            The single most replicated finding in memory retrieval: dense
            vectors alone lose to dense + sparse. Adding BM25 keyword search
            alongside vector similarity is worth roughly nine points of
            recall on memory benchmarks — not because keyword search is
            smarter, but because the two signals fail differently. Vectors
            miss exact names, dates, and rare terms; keyword search misses
            paraphrase. Memories are full of both: &quot;my sister&quot; in
            one session is &quot;Maria&quot; in another, and only one of your
            two retrievers will catch each phrasing.
          </P>
          <P>
            This is why the serious systems all run multi-signal retrieval
            now. Mem0&apos;s 2026 pipeline fuses three parallel passes —
            semantic, BM25, and entity match — into one normalized score.
            Zep fuses cosine similarity, BM25, and graph traversal. The
            consensus first stage is hybrid dense + sparse, full stop.
          </P>

          <H2>Reranking: the cheapest +3.4pp in the field</H2>
          <P>
            The second robust finding: a cross-encoder rerank over the fused
            candidates is worth about three and a half points, and it&apos;s
            the rare improvement that&apos;s both large and boring. The
            first stage is optimized for recall — don&apos;t miss anything.
            The reranker is optimized for precision — put the right thing on
            top. Splitting those two jobs across two stages beats any single
            ranker trying to do both, and the reranker only ever sees a few
            dozen candidates, so it&apos;s cheap.
          </P>
          <P>
            If you take one engineering lesson from this post: turn reranking
            on before you tune anything else. It outperforms most embedding
            model upgrades at a fraction of the effort.
          </P>

          <H2>Entities: the signal everyone underuses</H2>
          <P>
            The third signal — entity linking — is the one most DIY memory
            systems skip, and it&apos;s where the biggest headroom is.
            Resolving &quot;my sister,&quot; &quot;Maria,&quot; and
            &quot;she&quot; to one entity, then boosting memories attached to
            the entities in the query, consistently lifts recall beyond what
            dense+sparse achieves alone. It&apos;s the bridge between the
            vector world and the graph world: entities are what let retrieval
            follow relationships instead of just matching text.
          </P>
          <Callout>
            Memory retrieval is evidence assembly, not ranking. A document
            search returns the best page; a memory query must assemble a
            case — the fact, its provenance, its validity window, and the
            entities that connect it to the question. Optimize for assembly
            and the ranking takes care of itself.
          </Callout>

          <H2>Why documents and memories need different retrieval</H2>
          <P>
            RAG retrieves documents: self-contained, authored once, ranked by
            relevance to a standalone query. Memories are none of those
            things. They&apos;re fragments — half a sentence from March that
            only makes sense next to a correction from June. They contradict
            each other across time. They reference entities by nickname. A
            ranker trained on document relevance will happily return the
            March fragment without the June correction, because it
            doesn&apos;t know the correction exists.
          </P>
          <P>
            That&apos;s the real argument of this post: the failure mode of
            treating memory as RAG isn&apos;t low recall, it&apos;s confident
            staleness. You retrieve the right-shaped memory from the wrong
            time, the LLM answers fluently, and nobody notices. Temporal
            validity filtering and contradiction edges aren&apos;t
            embellishments — they&apos;re what make the difference between a
            search engine and a memory.
          </P>

          <H2>Our stack, concretely</H2>
          <P>
            Here&apos;s how MemOS instantiates the consensus, locally, with
            no API key:
          </P>
          <ul className="space-y-5 mb-6">
            <LI>
              <strong className="text-zinc-200">FTS5 first.</strong>{" "}
              SQLite&apos;s full-text search is the keyword leg — fast, local,
              and free. It catches the names, dates, and exact terms that
              vectors fumble.
            </LI>
            <LI>
              <strong className="text-zinc-200">Embeddings as boost.</strong>{" "}
              Dense vectors (nomic-embed-text via Ollama, or BGE-family
              models) add the semantic leg for paraphrase. Optional and
              local — the system works without them, just less forgiving of
              rewording.
            </LI>
            <LI>
              <strong className="text-zinc-200">Entity-fused scoring.</strong>{" "}
              Query entities resolve against the memory graph, and memories
              attached to matched entities get boosted — the bridge from text
              matching to relationship following.
            </LI>
            <LI>
              <strong className="text-zinc-200">Trust-weighted.</strong>{" "}
              Every memory carries a trust score from provenance and
              corroboration, and it multiplies into the final ranking. A
              high-similarity memory from an unreliable source should lose to
              a medium-similarity one that&apos;s been corroborated twice.
            </LI>
          </ul>
          <P>
            And because retrieval quality is the thing we refuse to regress,
            it&apos;s gated in CI: a golden corpus with a committed baseline
            (recall@5 0.9583, MRR 0.9444), failing the build on drops. The
            leaderboard numbers are nice. The CI gate is the product.
          </P>
        </Reveal>
      </div>
    </main>
  );
}
