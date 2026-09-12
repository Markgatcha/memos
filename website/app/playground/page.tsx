import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";
import Playground from "./Playground";

export const metadata: Metadata = {
  title: "Semantic Folding Playground",
  description:
    "Paste a prompt and watch LLM Guardian's Semantic Folding engine compress it live, in your browser — the real algorithm, running locally. No upload, no API key.",
  openGraph: {
    title: "Semantic Folding Playground — ContextCore",
    description:
      "The real LLM Guardian folding engine running in your browser. Paste a prompt, watch it compress.",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
};

export default function PlaygroundPage() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="playground"
          title="Watch your prompt shrink."
          subtitle="This is LLM Guardian's actual Semantic Folding engine, compiled to run in your browser — not a mockup. Everything stays on this page; nothing is uploaded."
        />

        <Reveal className="mb-12">
          <Playground />
        </Reveal>

        <Reveal className="mb-12" delay={60}>
          <div className="card p-6 md:p-7">
            <h2 className="text-sm font-medium text-zinc-200 mb-3">
              What just happened
            </h2>
            <p className="text-[13px] text-zinc-400 leading-relaxed">
              Semantic Folding distills verbose prose into{" "}
              <span className="font-mono text-emerald-400">
                [ACTION:…][TARGET:…]
              </span>{" "}
              entity-dense headlinese, then keeps only the sentences that carry
              information the model can&apos;t infer — scoring each sentence
              for entities, actions, and semantic density, and never touching
              code blocks. Inside LLM Guardian the same engine runs before
              every request, alongside VCM Sharding, tool gating, and prompt
              caching, typically cutting total prompt tokens by 80–95%.
            </p>
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div className="flex flex-wrap gap-3">
            <Link href="/guardian" className="btn btn-primary">
              About LLM Guardian
              <ArrowRight size={15} />
            </Link>
            <a
              href="https://github.com/Markgatcha/llm-guardian"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
            >
              Read the source
            </a>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
