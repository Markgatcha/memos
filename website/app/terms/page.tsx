import type { Metadata } from "next";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "Terms of use for the ContextCore website and the MIT-licensed MemOS, Universal MCP Toolkit, and LLM Guardian software.",
};

const sections = [
  {
    title: "Software license",
    body: [
      "MemOS, Universal MCP Toolkit, and LLM Guardian are released under the MIT License. The license text in each repository governs your right to use, copy, modify, and distribute the code. Nothing on this website narrows those rights.",
      "The written content, diagrams, and design of this website are copyright ContextCore and may not be republished wholesale without permission. Short quotations with attribution are welcome.",
    ],
  },
  {
    title: "Use at your own risk",
    body: [
      "The software is provided \"as is\", without warranty of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement. You are responsible for testing it in your environment before relying on it.",
      "Memory systems can store incorrect, outdated, or sensitive information. Review what you store and what you inject into prompts. The software includes deletion and supersede tooling, but it cannot decide for you what should be retained.",
    ],
  },
  {
    title: "Benchmarks and documentation",
    body: [
      "Benchmark pages describe runs against public datasets and report the artifacts and settings behind each number. Results depend on models, hardware, dataset versions, and judging method, so they are evidence rather than a guarantee of performance on your workload.",
      "We correct claims that we cannot reproduce. If you find a mismatch between a documented figure and its artifact, please open an issue.",
    ],
  },
  {
    title: "Acceptable use",
    body: [
      "Do not use the software to violate law, to store data you have no right to process, or to attack systems you do not own. If you deploy the optional HTTP server beyond loopback, you are responsible for authentication, TLS, and access control.",
    ],
  },
  {
    title: "Third-party services and links",
    body: [
      "This site links to GitHub, npm, Discord, and other services. Their terms and availability are their own. We are not responsible for content or outages outside our repositories.",
    ],
  },
  {
    title: "Limitation of liability",
    body: [
      "To the maximum extent permitted by law, the maintainers are not liable for indirect, incidental, special, consequential, or punitive damages, or for lost data, profits, or business, arising from use of the software or this website.",
    ],
  },
  {
    title: "Changes",
    body: [
      "We may update these terms as the project evolves. The effective date below changes when we do, and material changes are noted in the repository.",
      "Effective date: November 1, 2026.",
    ],
  },
];

export default function Terms() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <PageHeader
          kicker="legal"
          title="Terms"
          subtitle="MIT-licensed software, evidence-backed benchmarks, and a clear limit on what we promise."
        />

        <div className="space-y-10">
          {sections.map((section) => (
            <Reveal key={section.title}>
              <section>
                <h2 className="text-lg font-medium tracking-[-0.01em] text-zinc-100">
                  {section.title}
                </h2>
                <div className="mt-3 space-y-3">
                  {section.body.map((paragraph) => (
                    <p
                      key={paragraph}
                      className="text-[14px] leading-relaxed text-zinc-400"
                    >
                      {paragraph}
                    </p>
                  ))}
                </div>
              </section>
            </Reveal>
          ))}
        </div>
      </div>
    </main>
  );
}
