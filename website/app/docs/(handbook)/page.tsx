import type { Metadata } from "next";
import { DocBody } from "@/lib/mdx";
import DocsPager from "./_components/DocsPager";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Learn the AI Trio: persistent memory, MCP tooling, and token-cost control for AI agents. Start with a 60-second install, then go as deep as you need.",
};

export default function DocsHome() {
  return (
    <article className="docs-prose">
      <p className="mono-label mb-3 !text-[10px] text-zinc-500">
        docs / start here
      </p>
      <h1 className="display text-[2.6rem] leading-[1.05] text-zinc-50 sm:text-5xl md:text-[3.4rem]">
        Documentation
      </h1>
      <p className="lead">
        Three local-first tools that compose into one stack: memory, tools, and
        cost control. Start with a 60-second install, then go as deep as you
        need.
      </p>
      <DocBody slug="" />
      <DocsPager slug="" />
    </article>
  );
}
