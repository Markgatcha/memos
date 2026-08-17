"use client";

import { useState } from "react";
import { Layers, Menu, X } from "lucide-react";
import GithubIcon from "./GithubIcon";

const links = [
  { href: "/memos", label: "MemOS" },
  { href: "/umt", label: "UMT" },
  { href: "/guardian", label: "Guardian" },
  { href: "/benchmarks", label: "Benchmarks" },
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
  { href: "/support", label: "Support" },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-base/70 backdrop-blur-xl">
      <nav className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5 group">
          <span className="w-7 h-7 rounded-md bg-zinc-100 text-zinc-950 grid place-items-center group-hover:bg-white transition-colors">
            <Layers size={14} strokeWidth={2.4} />
          </span>
          <span className="font-semibold tracking-tight text-[15px] text-zinc-100">
            ContextCore
          </span>
        </a>

        {/* Desktop links */}
        <div className="hidden md:flex items-center gap-6 text-sm">
          {links.slice(0, 5).map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              {l.label}
            </a>
          ))}
          <a
            href="https://github.com/Markgatcha/memos"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary !px-3 !py-1.5"
          >
            <GithubIcon size={15} />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </div>

        {/* Mobile toggle */}
        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="md:hidden w-9 h-9 grid place-items-center rounded-lg border border-white/10 text-zinc-300 hover:text-zinc-100 hover:border-white/20 transition-colors"
        >
          {open ? <X size={16} /> : <Menu size={16} />}
        </button>
      </nav>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden border-t border-white/[0.06] bg-base/95 backdrop-blur-xl">
          <div className="max-w-6xl mx-auto px-6 py-4 flex flex-col gap-1">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="py-2.5 text-sm text-zinc-300 hover:text-zinc-100 transition-colors"
              >
                {l.label}
              </a>
            ))}
            <a
              href="https://github.com/Markgatcha/memos"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="mt-2 btn btn-secondary w-fit !px-3 !py-1.5"
            >
              <GithubIcon size={15} />
              GitHub
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
