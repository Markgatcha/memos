import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import Reveal from "../../_components/Reveal";

export const metadata: Metadata = {
  title: "We read every memory benchmark so you don't have to: LoCoMo and LongMemEval, honestly explained",
  description:
    "What LoCoMo and LongMemEval actually measure, why retrieval-only recall and LLM-judge accuracy are two different games, and the methodology traps — judge generosity, top-k gaming, category exclusions — that make memory leaderboards untrustworthy.",
  openGraph: {
    title: "Memory benchmarks, honestly explained — ContextCore",
    description:
      "Retrieval-only recall vs LLM-judge accuracy, judge generosity, top-k gaming, and excluded categories: what the memory leaderboard numbers actually mean.",
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

export default function BenchmarksExplainedPost() {
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
            benchmarks · sep 2026
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-[-0.03em] text-zinc-50 text-balance leading-[1.15]">
            We read every memory benchmark so you don&apos;t have to: LoCoMo
            and LongMemEval, honestly explained
          </h1>
          <p className="mt-6 text-lg text-zinc-400 leading-relaxed">
            Every memory vendor quotes a leaderboard number. Almost none of
            them quote it the same way. Here&apos;s what the two standard
            benchmarks actually measure — and the five methodology traps that
            make the numbers incomparable.
          </p>
        </Reveal>

        <Reveal delay={60}>
          <H2>What LoCoMo actually measures</H2>
          <P>
            <A href="https://github.com/snap-research/LoCoMo">LoCoMo</A>{" "}
            (Maharana et al., ACL 2024) is ten very long two-speaker
            conversations — the kind of meandering, months-long dialogue where
            a fact from session two matters in session thirty. Each
            conversation comes with QA pairs annotated by category{" "}
            <em>and</em> with the evidence spans that justify the answer, plus
            an event-summarization task.
          </P>
          <P>
            The slice everyone reports is 1,540 questions across five
            categories: single-hop, multi-hop, open-domain, temporal, and
            adversarial. The adversarial category is the interesting one —
            it&apos;s designed to punish systems that retrieve something
            plausible-but-wrong, and it&apos;s also the category most often
            quietly excluded from vendor scoreboards. Remember that; it comes
            back later.
          </P>

          <H2>What LongMemEval actually measures</H2>
          <P>
            <A href="https://arxiv.org/abs/2410.10813">LongMemEval</A> (Wu et
            al., ICLR 2025) is a different shape: 500 questions over roughly
            115K tokens of chat history — about 40 to 48 sessions per user —
            spanning six capability categories, plus 147 abstention questions
            where the correct answer is &quot;I don&apos;t know&quot; because
            the history genuinely doesn&apos;t contain it.
          </P>
          <P>
            Its official metric is end-to-end: the system retrieves memories,
            an LLM writes an answer from them, and GPT-4o judges whether the
            answer is correct. That judge step is doing a lot of hidden work,
            which brings us to the central confusion in this field.
          </P>

          <H2>Two different games with the same scoreboard</H2>
          <P>
            There are two completely different things people call a
            &quot;benchmark score,&quot; and they get conflated constantly:
          </P>
          <ul className="space-y-5 mb-6">
            <LI>
              <strong className="text-zinc-200">
                Retrieval-only scoring.
              </strong>{" "}
              Did the evidence surface? No LLM involved — just recall@5 or
              recall@10 against the annotated evidence spans. A plain
              BM25+vector hybrid hits around 95% recall@5 here. It measures the
              retriever and nothing else.
            </LI>
            <LI>
              <strong className="text-zinc-200">LLM-judge QA accuracy.</strong>{" "}
              The full pipeline: retrieve, generate an answer, let a judge
              model grade it. This measures the retriever <em>plus</em> the
              reader model <em>plus</em> the judge&apos;s mood. Mem0&apos;s
              self-reported 92.5 on LoCoMo and 94.4 on LongMemEval are this
              kind of number.
            </LI>
          </ul>
          <P>
            A 95% retrieval recall and a 94% judge accuracy sound comparable.
            They aren&apos;t. One is &quot;did we find the needle,&quot; the
            other is &quot;did a generous robot like our summary of the
            needle.&quot; When you see a leaderboard, the first question is
            always: which game was played?
          </P>

          <H2>The five methodology traps</H2>
          <P>
            Even within the same game, the numbers move for reasons that have
            nothing to do with memory quality:
          </P>
          <ul className="space-y-5 mb-6">
            <LI>
              <strong className="text-zinc-200">Judge generosity.</strong>{" "}
              LLM judges are lenient in ways that correlate with answer
              fluency, not correctness. Swap the judge or the grading prompt
              and the same system moves several points. Nobody publishes the
              prompt.
            </LI>
            <LI>
              <strong className="text-zinc-200">Top-k games.</strong>{" "}
              Retrieval recall is a function of k. One vendor&apos;s
              &quot;100%&quot; became 60.3% when a third party re-ran it at
              R@10 instead of a larger k. Always ask what k was.
            </LI>
            <LI>
              <strong className="text-zinc-200">Category exclusions.</strong>{" "}
              Remember LoCoMo&apos;s adversarial category? Mem0&apos;s
              published breakdown excludes hundreds of adversarial questions —
              the hardest slice, where systems hallucinate confident answers.
              Dropping the category where you&apos;re weakest is not a
              benchmark result; it&apos;s marketing.
            </LI>
            <LI>
              <strong className="text-zinc-200">Run noise.</strong>{" "}
              Re-runs of the same system on the same benchmark vary by about
              ±2 points. A &quot;+1.5pp improvement&quot; in a blog post is
              indistinguishable from luck. (One lever that <em>is</em> real:
              turning reranking on is worth about +3.4pp — more on that in a
              future post.)
            </LI>
            <LI>
              <strong className="text-zinc-200">The reader wall.</strong>{" "}
              Around 94% on LongMemEval, gains stop coming from retrieval at
              all — about 15 of the 500 gold answers are broken or ambiguous,
              so the ceiling is the benchmark&apos;s own noise floor.
            </LI>
          </ul>
          <P>
            The honest version of the leaderboard, with all of this priced in:
            Mem0 at 92.5/94.4 (self-reported, managed platform), Exa&apos;s
            M-1 at 96.4 on LongMemEval, EverMemOS at 93.05/83.00, MindMemOS at
            94.03 on LoCoMo — and then MemoryAgentBench, a harder neutral
            test from ICLR 2026, where Mem0 and Zep collapse to 21.1 and 24.0.
            Saturated benchmarks measure saturation, not utility.
          </P>
          <Callout>
            Zep&apos;s LoCoMo number deserves its own footnote: third parties
            have published corrections of both 75.14% and 58.44% against the
            claimed ~84%. When the re-runs disagree with each other, the
            leaderboard isn&apos;t a ranking — it&apos;s a rumor mill.
          </Callout>

          <H2>What we do instead</H2>
          <P>
            We can&apos;t fix the field&apos;s methodology, but we can refuse
            to play the game. For MemOS we commit to three things:
          </P>
          <ul className="space-y-5 mb-6">
            <LI>
              <strong className="text-zinc-200">Publish both numbers.</strong>{" "}
              Retrieval-only recall <em>and</em> end-to-end judge accuracy,
              labeled as what they are, with k, the judge model, and the
              grading prompt stated. No mixing.
            </LI>
            <LI>
              <strong className="text-zinc-200">Open the harness.</strong>{" "}
              Our benchmark scripts live in the repo (
              <span className="font-mono text-[13px] text-zinc-300">
                scripts/bench-locomo.ts
              </span>
              ,{" "}
              <span className="font-mono text-[13px] text-zinc-300">
                scripts/bench-longmemeval.ts
              </span>
              ) — anyone can re-run them and check our math.
            </LI>
            <LI>
              <strong className="text-zinc-200">
                Gate quality in CI, not in blog posts.
              </strong>{" "}
              We keep a golden corpus (36 facts, 24 queries) with a committed
              baseline — recall@5 0.9583, MRR 0.9444 — and CI fails if
              retrieval regresses more than 0.05. A benchmark you can&apos;t
              silently regress is worth more than a benchmark you scored high
              on once.
            </LI>
          </ul>
          <P>
            Leaderboards aren&apos;t going away, and we&apos;ll keep
            publishing our numbers on them. But the number we actually run the
            project by is the one in CI: does retrieval still work after every
            commit? Everything else is commentary.
          </P>
        </Reveal>
      </div>
    </main>
  );
}
