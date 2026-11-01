import type { Metadata } from "next";
import Reveal from "../../_components/Reveal";
import PageHeader from "../../_components/PageHeader";
import MemoryPlayground from "./MemoryPlayground";

export const metadata: Metadata = {
  title: "Memory Playground",
  description:
    "Store memories, restart the session, and recall them with citations. Preset results are recorded from the real MemOS SDK; everything else runs in your browser.",
};

export default function MemoryPlaygroundPage() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-5xl px-6 py-16 md:py-20">
        <PageHeader
          kicker="playground / memory"
          title="Store it. Restart. Recall it."
          subtitle="A local-first memory demo: add facts, restart the session, and watch them survive. Preset queries replay a trace recorded from the real SDK; arbitrary queries use a small browser scorer."
        />

        <Reveal className="mb-10">
          <MemoryPlayground />
        </Reveal>

        <Reveal>
          <div className="card p-6">
            <h2 className="text-sm font-medium text-zinc-100">
              What this demo does and does not prove
            </h2>
            <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-zinc-400">
              <li>
                It proves the shape of the workflow: store, persist across a
                restart, rank, cite, and build a token-budgeted pack.
              </li>
              <li>
                The recorded queries and packs come from MemOS 1.6.27 running
                over the same twelve memories — including the trust and
                provenance fields shown on each row.
              </li>
              <li>
                It is not a SQLite-in-the-browser build. Additions live in
                localStorage; the SDK&apos;s real store is SQLite on your
                machine.
              </li>
              <li>
                Arbitrary queries are ranked by a deliberately small lexical
                model so the page stays fast and dependency-free. The real
                engine fuses keyword and embedding retrieval.
              </li>
            </ul>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
