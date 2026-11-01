import type { Metadata } from "next";
import { ArrowUpRight } from "lucide-react";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";
import changelog from "../../data/changelog.json";

export const metadata: Metadata = {
  title: "Changelog",
  description:
    "Release notes for MemOS: what shipped in each version, newest first.",
};

type Section = { title: string; items: string[] };
type Release = { version: string; date: string | null; sections: Section[] };

const releases = changelog.releases as Release[];

export default function Changelog() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <PageHeader
          kicker="changelog"
          title="Changelog"
          subtitle="What shipped, newest first. Generated from the repository's CHANGELOG.md so the site cannot drift from the code."
        />

        {releases.length === 0 ? (
          <p className="text-sm text-zinc-500">No releases recorded yet.</p>
        ) : (
          <div className="space-y-6">
            {releases.map((release, index) => (
              <Reveal key={`${release.version}-${release.date ?? ""}`}>
                <details
                  className="card group"
                  open={index === 0}
                >
                  <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4 px-6 py-4">
                    <span className="flex items-baseline gap-3">
                      <span className="font-mono text-sm text-zinc-100">
                        v{release.version}
                      </span>
                      {index === 0 && (
                        <span className="rounded-sm border border-white/[0.12] px-1.5 py-0.5 font-mono text-[9px] tracking-[0.02em] text-zinc-400">
                          latest
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-[11px] tabular-nums text-zinc-500">
                      {release.date ?? "—"}
                    </span>
                  </summary>
                  <div className="border-t border-white/[0.06] px-6 py-5">
                    {release.sections.map((section) => (
                      <section key={section.title} className="mb-6 last:mb-0">
                        <h3 className="font-mono text-[10px] tracking-[0.02em] text-zinc-500">
                          {section.title}
                        </h3>
                        <ul className="mt-3 space-y-2.5">
                          {section.items.map((item, i) => (
                            <li
                              key={i}
                              className="flex gap-2.5 text-[13px] leading-relaxed text-zinc-400"
                            >
                              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                </details>
              </Reveal>
            ))}
          </div>
        )}

        <p className="mt-10 text-xs leading-relaxed text-zinc-600">
          Unreleased work is tracked in the{" "}
          <a
            href="https://github.com/Markgatcha/memos/blob/main/CHANGELOG.md"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
          >
            repository changelog
            <ArrowUpRight size={11} />
          </a>
          .
        </p>
      </div>
    </main>
  );
}
