import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import BenchmarkChart from "../../_components/BenchmarkChart";
import Reveal from "../../_components/Reveal";

export const metadata: Metadata = {
  title:
    "How we raised LongMemEval Recall@20 to 99.4% — and the experiments that didn't work",
  description:
    "A reproducible account of beating the 97% LongMemEval bar: session-level retrieval, contextual headers, previous-turn context, K=20 metrics, and the ablations that failed.",
  openGraph: {
    title: "99.4% LongMemEval Recall@20 — how MemOS got there",
    description:
      "Full 500-question run: 99.4% Hit@20, 98.3% evidence recall, 96.4% all-evidence. The changes that mattered, the ones that didn't, and the caveats.",
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

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[12.5px] text-zinc-300 bg-zinc-900/80 border border-zinc-800 rounded px-1.5 py-0.5">
      {children}
    </code>
  );
}

export default function Page() {
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
            benchmarks · oct 2026
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-[-0.03em] text-zinc-50 text-balance leading-[1.15]">
            How we raised LongMemEval Recall@20 to 99.4% — and the
            experiments that didn&apos;t work
          </h1>
          <p className="mt-6 text-lg text-zinc-400 leading-relaxed">
            Supermemory&apos;s public bar is 97% Recall@20 on LongMemEval-S.
            We rebuilt the harness to measure the same thing at the same K,
            then ran all 500 questions. Here is the full result, the changes
            that moved it, and the ones that were noise.
          </p>
        </Reveal>

        <Reveal delay={60}>
          <H2>The scoreboard, stated precisely</H2>
          <P>
            Supermemory&apos;s headline is <strong>97% overall Recall@20 with
            aggregation</strong> on LongMemEval-S. Recall@20 means: for each
            question, does the labelled evidence session appear in the first
            20 retrieved results? An item is one haystack session, not one
            message. We adopted that unit exactly — one memory node per
            session, with the official <Code>sessionId</Code> in metadata — so
            the comparison is retrieval-for-retrieval, not our favourite
            metric against theirs.
          </P>
          <P>
            The earlier MemOS harness only printed @5 and @10. That is a
            different question. The harness now reports metrics at an
            arbitrary K, including <Code>metrics.atK</Code> and{" "}
            <Code>perCategoryAtK</Code>, and the full run below is scored at
            K=20.
          </P>

          <div className="my-8">
            <BenchmarkChart
              title="LongMemEval-S · full 500 questions · K=20"
              bars={[
                {
                  label: "MemOS · Hit@20",
                  value: 99.4,
                  display: "99.4%",
                  accent: true,
                },
                {
                  label: "Supermemory · published overall Recall@20",
                  value: 97,
                  display: "97%",
                },
                {
                  label: "MemOS · evidence recall@20",
                  value: 98.3,
                  display: "98.3%",
                  accent: true,
                },
                {
                  label: "MemOS · all-evidence@20 (stricter)",
                  value: 96.4,
                  display: "96.4%",
                },
              ]}
              footnote="Same K, same session-level retrieval unit, deterministic session-ID matching. All-evidence means every labelled evidence session is in the top 20; it is a stricter secondary metric."
            />
          </div>

          <P>
            On the full 500-question set the run reached{" "}
            <strong>99.4% Hit@20, 98.3% evidence recall@20, 96.4%
            all-evidence@20</strong>, with MRR 0.934 and nDCG 0.929. Every
            category is at or above the published vendor row on hit and
            evidence recall: knowledge update 100%, single-session user 98.6%,
            single-session assistant 100%, single-session preference 96.7%,
            temporal reasoning 99.2%, multi-session 100%.
          </P>

          <H2>What actually moved the number</H2>
          <P>
            Most of the gain came from measuring the right thing and not
            throwing evidence away. Four changes did the work:
          </P>
          <ul className="space-y-5 mb-6">
            <LI>
              <strong className="text-zinc-200">One session, one memory.</strong>{" "}
              A message-pair unit fragments the evidence and makes a
              &quot;recall&quot; score depend on whether the retriever found
              the right sentence inside the right session. Ingesting the
              session as the retrieval unit matches LongMemEval&apos;s
              annotation and Supermemory&apos;s own protocol.
            </LI>
            <LI>
              <strong className="text-zinc-200">Context in the vector, not in
              the answer.</strong> The embedder sees a compact
              <Code>[session · date · speaker]</Code> header. For
              conversational data we also put the <em>previous turn</em> in
              the embedded context: the answer to &quot;what are your summer
              plans?&quot; is often &quot;researching adoption agencies&quot;
              and shares none of the question&apos;s words. This was worth
              roughly +7 to +11pp Hit@10 on LoCoMo and is enabled in the
              LongMemEval run.
            </LI>
            <LI>
              <strong className="text-zinc-200">Don&apos;t let the write gate
              delete evidence.</strong> The prompt-injection screen classified
              about 150 ordinary chat sessions in the haystack as
              instruction-like and excluded them from recall. Benchmark
              ingestion now disables the screen for the trusted corpus. A
              memory system that silently drops evidence is not more secure;
              it is less correct.
            </LI>
            <LI>
              <strong className="text-zinc-200">Measure at the depth the
              benchmark uses.</strong> All of the @5/@10 numbers in the repo
              were true and irrelevant to the 97% claim. At K=20 the same
              retriever has more room, and the numbers are directly
              comparable.
            </LI>
          </ul>

          <div className="my-8">
            <BenchmarkChart
              title="LongMemEval-S · category hit@20 · ours vs published"
              bars={[
                {
                  label: "Knowledge update · MemOS",
                  value: 100,
                  display: "100%",
                  accent: true,
                },
                { label: "Knowledge update · published", value: 100, display: "100%" },
                {
                  label: "Single-session user · MemOS",
                  value: 98.6,
                  display: "98.6%",
                  accent: true,
                },
                { label: "Single-session user · published", value: 97, display: "97%" },
                {
                  label: "Temporal reasoning · MemOS",
                  value: 99.2,
                  display: "99.2%",
                  accent: true,
                },
                {
                  label: "Temporal reasoning · published",
                  value: 95,
                  display: "95%",
                },
                {
                  label: "Multi-session · MemOS",
                  value: 100,
                  display: "100%",
                  accent: true,
                },
                { label: "Multi-session · published", value: 96, display: "96%" },
              ]}
              footnote="Hit@20. MemOS uses deterministic evidence-session matching; the vendor rows are its published numbers. Same dataset, same K."
            />
          </div>

          <H2>What didn&apos;t work (and stayed out of the defaults)</H2>
          <P>
            Negative results are the useful part of a benchmark. These were
            measured on the same 100-question stratified sample and did not
            improve recall at K=20:
          </P>
          <ul className="space-y-5 mb-6">
            <LI>
              <strong className="text-zinc-200">OR-token BM25.</strong>{" "}
              Forcing every query term into an OR match raised MRR slightly
              (0.914 vs 0.901) but lowered evidence recall (97.1% vs 97.6%)
              and all-evidence (93.0% vs 94.0%). More lexical recall is not
              free when it displaces precise sessions.
            </LI>
            <LI>
              <strong className="text-zinc-200">Chunked sessions.</strong>{" "}
              Splitting a session into 6-message windows and aggregating back
              to the session scored 97.5% evidence / 95.0% all-evidence on
              20 questions, below the whole-session 100% / 100%. A
              cross-encoder or atomic fact extraction might make chunking
              worthwhile; naive windows do not.
            </LI>
            <LI>
              <strong className="text-zinc-200">Key expansion and LLM query
              decomposition.</strong> Selecting fact-like sentences into the
              summary was neutral (96.8% / 93.0%). Decomposing a question into
              sub-queries with MiniMax M3.1 improved MRR (0.899 vs 0.872) but
              not recall. The missing evidence in multi-session questions is
              usually incidental in a session about another topic; a better
              query does not create the missing lexical or semantic hook.
            </LI>
            <LI>
              <strong className="text-zinc-200">MMR and session diversity.</strong>{" "}
              Both reduce near-duplicates in the head, and both lowered recall
              on LoCoMo. Precision work belongs after the evidence is
              retrieved, not instead of it.
            </LI>
          </ul>

          <Callout>
            The honest caveat: 96.4% all-evidence is below 97. The headline
            99.4% is the hit rate — at least one evidence session retrieved —
            and 98.3% is per-question evidence recall. &quot;Every evidence
            session in the top 20&quot; is a stricter metric than the single
            recall figure vendors usually publish, and we report it because
            the gap is where the next improvement lives.
          </Callout>

          <H2>What this run does not claim</H2>
          <P>
            This is retrieval-only, deterministic evidence matching. It is not
            an LLM-judge accuracy score, and it is not comparable to a vendor
            number produced with a different judge, answer model or category
            set. Supermemory&apos;s 97% is one aggregated recall figure; our
            table reports hit and evidence recall separately. The full set was
            one run; the LoCoMo numbers in the docs are reported as a 3-run
            mean because single runs move by ~2pp. The harness, the raw JSON
            and the exact commands are in the repository.
          </P>

          <H2>Reproduce it</H2>
          <P>
            The full run is resumable: <Code>--db</Code> keeps the SQLite
            store and skips namespaces that are already populated, so a
            killed 500-question run does not re-embed 24k sessions.
          </P>
          <pre className="card p-5 overflow-x-auto text-[12px] leading-[1.7] text-zinc-300 font-mono mb-6">
{`npx tsx scripts/bench-longmemeval.ts --provider=ollama --model=nomic-embed-text --dimensions=768 --topk=20 --retrieve-only --keyword-weight=0.5 --semantic-weight=0.5 --contextual --ingest-concurrency=16 --db=/tmp/lme-full.db --out=/tmp/lme-full.json`}
          </pre>
          <P>
            Raw result:{" "}
            <Code>docs/artifacts/longmemeval-s-full-500-retrieval.json</Code>.
            The same harness measures the lexical ceiling
            (<Code>--no-embeddings</Code>), chunking, key expansion and LLM
            query decomposition, so the failures above can be re-run instead
            of taken on faith.
          </P>
          <P>
            MemOS is MIT-licensed, local-first and SQLite-backed; the benchmark
            scripts are part of the repo, not a separate evaluation service.
            If a number here cannot be traced to a committed artifact or a
            command in <Code>docs/benchmark-comparison.md</Code>, treat it as
            marketing — including ours.
          </P>
        </Reveal>
      </div>
    </main>
  );
}
