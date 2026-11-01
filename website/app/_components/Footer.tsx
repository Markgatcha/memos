import GithubIcon from "./GithubIcon";
import DiscordIcon from "./DiscordIcon";
import XIcon from "./XIcon";

const columns = [
  {
    title: "Products",
    links: [
      { label: "MemOS", href: "/memos" },
      { label: "Universal MCP Toolkit", href: "/umt" },
      { label: "LLM Guardian", href: "/guardian" },
      { label: "Playground", href: "/playground" },
      { label: "Memory Playground", href: "/playground/memory" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "Harness matrix", href: "/docs/install" },
      { label: "Architecture", href: "/docs/architecture" },
      { label: "Benchmarks", href: "/benchmarks" },
      { label: "Changelog", href: "/changelog" },
      { label: "Writing", href: "/blogs" },
      { label: "Support", href: "/support" },
    ],
  },
];

const community = [
  {
    label: "GitHub",
    href: "https://github.com/Markgatcha/memos",
    icon: GithubIcon,
  },
  {
    label: "Discord",
    href: "https://discord.gg/DyQGgPuueu",
    icon: DiscordIcon,
  },
  {
    label: "Twitter / X",
    href: "https://x.com/Context_Core",
    icon: XIcon,
  },
];

export default function Footer() {
  return (
    <footer className="border-t border-white/[0.08]">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-[1.5fr_1fr_1fr_1fr] md:gap-10">
          <div className="col-span-2 max-w-xs md:col-span-1">
            <a href="/" className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="grid h-7 w-7 place-items-center border border-white/20 font-serif text-[15px] leading-none text-ink"
              >
                C
              </span>
              <span className="text-[15px] font-medium tracking-[-0.02em] text-zinc-100">
                ContextCore
              </span>
            </a>
            <p className="mt-4 text-[13px] leading-relaxed text-zinc-500">
              Local-first memory, tooling, and cost control for AI agents.
              Open source, MIT licensed, and designed to keep working when the
              network doesn&apos;t.
            </p>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              <div className="mono-label mb-4">{col.title}</div>
              <ul className="space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <a
                      href={l.href}
                      className="text-[13px] text-zinc-500 transition-colors hover:text-zinc-100"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div>
            <div className="mono-label mb-4">Community</div>
            <ul className="space-y-2.5">
              {community.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-[13px] text-zinc-500 transition-colors hover:text-zinc-100"
                  >
                    <l.icon size={13} />
                    {l.label}
                  </a>
                </li>
              ))}
              <li>
                <a
                  href="/compare/memos-vs-mem0"
                  className="text-[13px] text-zinc-500 transition-colors hover:text-zinc-100"
                >
                  MemOS vs Mem0
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-white/[0.07] pt-5 font-mono text-[10px] tracking-[0.02em] text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 ContextCore</p>
          <p className="flex items-center gap-2 text-zinc-500">
            <span className="h-1 w-1 rounded-full bg-zinc-400" />
            all systems local
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <a href="/privacy" className="transition-colors hover:text-zinc-100">
              Privacy
            </a>
            <a href="/terms" className="transition-colors hover:text-zinc-100">
              Terms
            </a>
            <a href="/security" className="transition-colors hover:text-zinc-100">
              Security
            </a>
            <span>MIT license</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
