"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Layers, Menu, X } from "lucide-react";
import GithubIcon from "./GithubIcon";

const links = [
  { href: "/memos", label: "MemOS", group: "product" },
  { href: "/umt", label: "UMT", group: "product" },
  { href: "/guardian", label: "Guardian", group: "product" },
  { href: "/benchmarks", label: "Benchmarks", group: "resource" },
  { href: "/docs", label: "Docs", group: "resource" },
  { href: "/playground", label: "Playground", group: "resource", wide: true },
  { href: "/blogs", label: "Blog", group: "resource" },
];

const secondary = [
  { href: "/support", label: "Support" },
  { href: "/compare/memos-vs-mem0", label: "Compare" },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() || "/";

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-canvas/95 backdrop-blur-xl">
      <nav
        aria-label="Primary"
        className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-6"
      >
        <a
          href="/"
          className="group flex shrink-0 items-center gap-2.5"
          aria-label="ContextCore home"
        >
          <span className="grid h-7 w-7 place-items-center rounded-sm bg-ink text-canvas transition-colors group-hover:bg-white">
            <Layers size={15} strokeWidth={2.2} />
          </span>
          <span className="text-[15px] font-medium tracking-[-0.02em] text-zinc-100">
            ContextCore
          </span>
        </a>

        <div className="hidden items-center gap-4 md:flex xl:gap-6">
          {links.map((l) => {
            const active = isActive(l.href);
            return (
              <a
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`relative py-2 text-[13px] transition-colors ${
                  l.wide ? "hidden lg:inline" : ""
                } ${
                  active
                    ? "text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-200"
                }`}
              >
                {l.label}
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-0 -bottom-[1px] h-px bg-zinc-200"
                  />
                )}
              </a>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <a
            href="https://github.com/Markgatcha/memos"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary hidden !px-3 !py-2 sm:inline-flex"
            aria-label="ContextCore on GitHub"
          >
            <GithubIcon size={14} />
            <span>GitHub</span>
          </a>

          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((v) => !v)}
            className="grid h-9 w-9 place-items-center border border-white/12 text-zinc-300 transition-colors hover:border-white/25 hover:text-white md:hidden"
          >
            {open ? <X size={16} /> : <Menu size={16} />}
          </button>
        </div>
      </nav>

      {open && (
        <div
          id="mobile-menu"
          className="border-t border-white/[0.07] bg-canvas/95 backdrop-blur-xl md:hidden"
        >
          <div className="mx-auto flex max-w-6xl flex-col px-6 py-4">
            <div className="mono-label pb-2 pt-1">Products</div>
            {links
              .filter((l) => l.group === "product")
              .map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="border-b border-white/[0.05] py-2.5 text-sm text-zinc-300 transition-colors hover:text-white"
                >
                  {l.label}
                </a>
              ))}
            <div className="mono-label pb-2 pt-5">Resources</div>
            {[...links.filter((l) => l.group === "resource"), ...secondary].map(
              (l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="border-b border-white/[0.05] py-2.5 text-sm text-zinc-300 transition-colors hover:text-white"
                >
                  {l.label}
                </a>
              )
            )}
            <a
              href="https://github.com/Markgatcha/memos"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="btn btn-secondary mt-5 w-fit"
            >
              <GithubIcon size={14} />
              GitHub
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
