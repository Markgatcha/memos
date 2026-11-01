import type { Metadata } from "next";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "How ContextCore handles data: the website has no accounts, cookies, or analytics, and MemOS keeps your memory in local SQLite.",
};

const sections = [
  {
    title: "The short version",
    body: [
      "ContextCore builds local-first software. MemOS stores your memories in a SQLite file on your own machine. The website is a static marketing and documentation site with no accounts, no cookies, and no analytics.",
    ],
  },
  {
    title: "What this website collects",
    body: [
      "We do not add cookies, analytics scripts, advertising pixels, or fingerprinting to this site. There is no sign-up form and no newsletter that captures your address.",
      "Like any website, requests reach a hosting provider, which may process standard technical metadata such as IP address, user agent, and timestamp under its own policy. We do not combine that metadata with any profile.",
    ],
  },
  {
    title: "What the software stores",
    body: [
      "MemOS writes memories, sessions, and graph links to a local SQLite database. The default location is ~/.memos/memos.db (or the path in MEMOS_DB_PATH). Nothing is uploaded to us or to any third party.",
      "The optional HTTP server binds to 127.0.0.1 by default. When you set MEMOS_API_KEY, every route except /health, /docs, /redoc, and /openapi.json requires a bearer token. If you expose the server beyond loopback, you are responsible for TLS and network access control.",
      "The token-savings counters shown by memos stats are in-process, local counters. They are not transmitted anywhere.",
    ],
  },
  {
    title: "Document ingestion",
    body: [
      "When you ingest a file or folder, the tool reads only the paths you name and writes derived chunks to your local database. It does not follow URLs or call external services.",
    ],
  },
  {
    title: "Third-party services",
    body: [
      "Installing packages through npm, browsing this site on GitHub Pages or another host, or joining our Discord involves third parties that operate under their own privacy policies. We do not control those services.",
    ],
  },
  {
    title: "Your control over data",
    body: [
      "Because storage is local, you remain the controller. Delete individual memories with memos forget, delete a namespace with the CLI, or remove the SQLite file to erase everything. Uninstalling the package does not remove your database; delete the file yourself if you want it gone.",
    ],
  },
  {
    title: "Children",
    body: [
      "The software and website are developer tools and are not directed at children under 13.",
    ],
  },
  {
    title: "Changes and contact",
    body: [
      "If this policy changes, we will update the date below and note the change in the repository. Questions can go to the maintainer through GitHub or the Discord community.",
      "Effective date: November 1, 2026.",
    ],
  },
];

export default function Privacy() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <PageHeader
          kicker="legal"
          title="Privacy"
          subtitle="No accounts, no tracking on this site, and no data leaving your machine when you use MemOS."
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
