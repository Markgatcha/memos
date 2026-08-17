import { Check, ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";
import GithubIcon from "../_components/GithubIcon";

export const metadata: Metadata = {
  title: "LLM Guardian — Token Optimization",
  description:
    "Token-cost guardian for LLM inference: Semantic Folding, VCM Sharding, Retain Pre-Filter, tool gating, prompt caching, and MemOS memory injection.",
};

const features = [
  "Semantic Folding — verbose text to entity-dense headlinese",
  "VCM Sharding — context skeletons with high-relevance shards",
  "Retain Pre-Filter — drops low-signal turns before folding",
  "Tool Gating — trims tool schemas to what the query needs",
  "Prompt Caching — stable prefixes + cache_control breakpoints",
  "MemOS memory injection — token-budgeted context packs",
  "Privacy Shield — PII redaction + injection blocking",
  "Budget enforcement — per-request, daily, and monthly limits",
];

const pipeline = [
  { step: "01", name: "retain pre-filter", note: "drop low-signal turns" },
  { step: "02", name: "tool gating", note: "trim tool schemas" },
  { step: "03", name: "semantic folding", note: "compress prose" },
  { step: "04", name: "memory injection", note: "MemOS context pack" },
  { step: "05", name: "vcm sharding", note: "relevance shards" },
  { step: "06", name: "prompt caching", note: "cache breakpoints" },
];

export default function Guardian() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="token optimization"
          title="LLM Guardian"
          subtitle="Token-cost guardian for LLM inference. Sits between your app and the provider — compressing prompts, injecting MemOS context packs, and enforcing token budgets, all locally."
        />

        <Reveal className="mb-12">
          <h2 className="text-sm font-medium text-zinc-200 mb-4">Quick start</h2>
          <div className="window">
            <div className="window-bar">
              <span className="window-dot" />
              <span className="window-dot" />
              <span className="window-dot" />
              <span className="window-title">terminal</span>
            </div>
            <div className="p-5 font-mono text-[13px] leading-7">
              <div>
                <span className="text-zinc-600 select-none">$ </span>
                <span className="text-zinc-100">npm install -g llm-guardian</span>
              </div>
              <div>
                <span className="text-zinc-600 select-none">$ </span>
                <span className="text-zinc-100">guardian start</span>
              </div>
              <div className="text-zinc-500">
                <span className="select-none">  </span>
                # OpenAI-compatible proxy on localhost — point your app at it
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal className="mb-12" delay={80}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            Optimization pipeline
          </h2>
          <div className="card overflow-hidden">
            <div className="divide-y divide-white/[0.05]">
              {pipeline.map((p) => (
                <div
                  key={p.step}
                  className="flex items-center gap-4 px-6 py-3.5 font-mono text-[13px]"
                >
                  <span className="text-zinc-600 tabular-nums">{p.step}</span>
                  <span className="text-zinc-200 flex-1">{p.name}</span>
                  <span className="text-zinc-500 text-xs hidden sm:inline">
                    {p.note}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal className="mb-12" delay={120}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">Key features</h2>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
            {features.map((f) => (
              <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-400">
                <Check size={15} className="text-zinc-500 mt-0.5 shrink-0" />
                {f}
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal className="mb-12" delay={160}>
          <div className="card p-7">
            <div className="kicker mb-4">compression</div>
            <p className="text-sm text-zinc-400 leading-relaxed mb-6 max-w-xl">
              The full pipeline on a typical agent conversation — raw prompt
              versus what actually reaches the provider.
            </p>
            <div className="space-y-3 max-w-sm">
              <div>
                <div className="flex justify-between font-mono text-[11px] text-zinc-500 mb-1.5">
                  <span>raw prompt</span>
                  <span className="tabular-nums">12,408 tok</span>
                </div>
                <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div className="h-full w-full rounded-full bg-zinc-600" />
                </div>
              </div>
              <div>
                <div className="flex justify-between font-mono text-[11px] text-zinc-500 mb-1.5">
                  <span>guardian-compressed</span>
                  <span className="tabular-nums text-emerald-500/90">2,767 tok</span>
                </div>
                <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div className="h-full w-[22%] rounded-full bg-emerald-500/80" />
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal delay={200}>
          <div className="flex flex-wrap gap-3">
            <a href="/docs" className="btn btn-primary">
              Read the docs
              <ArrowRight size={15} />
            </a>
            <a
              href="https://github.com/Markgatcha/llm-guardian"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
            >
              <GithubIcon size={15} />
              View on GitHub
            </a>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
