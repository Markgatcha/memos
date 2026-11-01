import { ArrowRight, ArrowUpRight } from "lucide-react";
import type { Metadata } from "next";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";
import { posts } from "../../lib/posts";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Engineering notes on agent memory, benchmarks, retrieval, and local-first AI infrastructure.",
};

export default function Blog() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-4xl px-6 py-16 md:py-20">
        <PageHeader
          kicker="writing"
          title="Engineering notes."
          subtitle="Benchmarks, architecture, and the occasional post-mortem — written while building the local-first stack."
        />

        <div className="border-t border-white/[0.08]">
          {posts.map((p, i) => (
            <Reveal key={p.href} delay={i * 55}>
              <a
                href={p.href}
                {...(p.internal
                  ? {}
                  : { target: "_blank", rel: "noopener noreferrer" })}
                className="group grid gap-3 border-b border-white/[0.08] py-7 transition-colors hover:bg-white/[0.015] md:grid-cols-[132px_1fr_24px] md:items-start md:gap-8"
              >
                <div className="pt-1 font-mono text-[10px] tracking-[0.02em] text-zinc-500">
                  <div>{p.date}</div>
                  <div className="mt-1 text-zinc-500">{p.tag}</div>
                </div>
                <div>
                  <h2 className="max-w-2xl text-balance text-xl font-medium leading-snug tracking-[-0.025em] text-zinc-100 transition-colors group-hover:text-white">
                    {p.title}
                  </h2>
                  <p className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
                    {p.excerpt}
                  </p>
                  <span className="mt-4 inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.02em] text-zinc-500 transition-colors group-hover:text-zinc-200">
                    Read the post
                    <ArrowRight size={12} />
                  </span>
                </div>
                <ArrowUpRight
                  size={16}
                  aria-hidden
                  className="hidden text-zinc-500 transition-colors group-hover:text-zinc-200 md:mt-1 md:block"
                />
              </a>
            </Reveal>
          ))}
        </div>
      </div>
    </main>
  );
}
