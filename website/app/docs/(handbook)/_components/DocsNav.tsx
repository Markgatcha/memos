"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { Menu, Search, X } from "lucide-react";
import type { DocEntry, DocProduct } from "@/lib/docs";
import { docHref } from "@/lib/docs";

type Section = {
  id: DocProduct;
  label: string;
  blurb: string;
  items: DocEntry[];
};

function normalize(path: string) {
  return path.replace(/\/+$/, "") || "/";
}

export default function DocsNav({ sections }: { sections: Section[] }) {
  const pathname = normalize(usePathname() || "/docs");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) =>
          [item.title, item.description, ...(item.keywords ?? [])]
            .join(" ")
            .toLowerCase()
            .includes(q),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [query, sections]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="sticky top-20 z-30 mb-4 flex w-full items-center justify-between rounded-lg border border-white/10 bg-panel/90 px-4 py-3 text-left text-sm text-zinc-300 backdrop-blur lg:hidden"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {open ? <X size={15} /> : <Menu size={15} />}
          {open ? "Close docs menu" : "Browse docs"}
        </span>
        <span className="mono-label !text-[10px] text-zinc-500">
          {sections.reduce((total, section) => total + section.items.length, 0)} pages
        </span>
      </button>

      <aside className={`${open ? "block" : "hidden"} lg:block`}>
        <div className="lg:sticky lg:top-24">
          <div className="relative mb-5">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search docs"
              aria-label="Search docs"
              className="w-full rounded-md border border-white/10 bg-white/[0.03] py-2 pl-9 pr-3 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-accent/50"
            />
          </div>

          <nav aria-label="Docs" className="space-y-6">
            {filtered.map((section) => (
              <div key={section.id}>
                <p className="mono-label mb-2 !text-[10px] text-zinc-500">
                  {section.label}
                </p>
                <ul className="space-y-0.5 border-l border-white/[0.07]">
                  {section.items.map((item) => {
                    const href = docHref(item.slug);
                    const active = normalize(href) === pathname;
                    return (
                      <li key={item.slug || "index"}>
                        <Link
                          href={href}
                          onClick={() => setOpen(false)}
                          aria-current={active ? "page" : undefined}
                          className={`-ml-px block border-l py-1.5 pl-3 text-[13px] leading-5 transition-colors ${
                            active
                              ? "border-accent text-zinc-100"
                              : "border-transparent text-zinc-500 hover:border-white/20 hover:text-zinc-300"
                          }`}
                        >
                          {item.title}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="text-[13px] text-zinc-500">
                No pages match &ldquo;{query}&rdquo;.
              </p>
            )}
          </nav>

          <div className="mt-8 space-y-2 border-t border-white/[0.07] pt-4 text-[12px] text-zinc-500">
            <a
              href="https://github.com/Markgatcha/memos"
              target="_blank"
              rel="noopener noreferrer"
              className="block hover:text-zinc-300"
            >
              Source on GitHub
            </a>
            <a
              href="https://memos.readthedocs.io"
              target="_blank"
              rel="noopener noreferrer"
              className="block hover:text-zinc-300"
            >
              Full MemOS reference
            </a>
            <Link href="/support" className="block hover:text-zinc-300">
              Support
            </Link>
          </div>
        </div>
      </aside>
    </>
  );
}
