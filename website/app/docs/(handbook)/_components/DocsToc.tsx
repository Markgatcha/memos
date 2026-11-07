"use client";

import { useEffect, useState } from "react";

type Item = { id: string; text: string; level: number };

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export default function DocsToc() {
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState("");

  useEffect(() => {
    const article = document.querySelector("article.docs-prose");
    if (!article) return;
    const headings = Array.from(
      article.querySelectorAll("h2, h3"),
    ) as HTMLElement[];

    const next = headings.map((heading, index) => {
      if (!heading.id) {
        heading.id = slugify(heading.textContent || `section-${index}`);
      }
      return {
        id: heading.id,
        text: heading.textContent || "",
        level: heading.tagName === "H2" ? 2 : 3,
      };
    });
    setItems(next);

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) =>
              a.boundingClientRect.top - b.boundingClientRect.top,
          );
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      { rootMargin: "-96px 0px -68% 0px", threshold: [0, 1] },
    );

    headings.forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, []);

  if (items.length === 0) return <aside className="hidden xl:block" />;

  return (
    <aside className="hidden xl:block">
      <div className="sticky top-24">
        <p className="mono-label mb-3 !text-[10px] text-zinc-500">
          On this page
        </p>
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className={item.level === 3 ? "pl-3" : ""}>
              <a
                href={`#${item.id}`}
                className={`block text-[12px] leading-5 transition-colors ${
                  active === item.id
                    ? "text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {item.text}
              </a>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="mono-label mt-6 !text-[10px] text-zinc-600 hover:text-zinc-300"
        >
          Back to top
        </button>
      </div>
    </aside>
  );
}
