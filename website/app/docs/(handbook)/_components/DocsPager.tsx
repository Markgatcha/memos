import Link from "next/link";
import { ArrowLeft, ArrowRight, Pencil } from "lucide-react";
import { docHref, getNeighbors } from "@/lib/docs";

function editUrl(slug: string) {
  if (!slug) return "https://github.com/Markgatcha/memos/blob/main/website/content/docs/index.mdx";
  const path = slug.includes("/") ? `${slug}.mdx` : `${slug}/index.mdx`;
  return `https://github.com/Markgatcha/memos/blob/main/website/content/docs/${path}`;
}

export default function DocsPager({ slug }: { slug: string }) {
  const { previous, next } = getNeighbors(slug);

  return (
    <div className="mt-14 border-t border-white/[0.08] pt-6">
      <div className="grid gap-3 sm:grid-cols-2">
        {previous ? (
          <Link
            href={docHref(previous.slug)}
            className="card group p-4 transition-colors hover:border-white/20"
          >
            <span className="mono-label mb-1 flex items-center gap-1.5 !text-[10px] text-zinc-500">
              <ArrowLeft size={11} /> Previous
            </span>
            <span className="text-[13px] text-zinc-300 group-hover:text-zinc-100">
              {previous.title}
            </span>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link
            href={docHref(next.slug)}
            className="card group p-4 text-right transition-colors hover:border-white/20"
          >
            <span className="mono-label mb-1 flex items-center justify-end gap-1.5 !text-[10px] text-zinc-500">
              Next <ArrowRight size={11} />
            </span>
            <span className="text-[13px] text-zinc-300 group-hover:text-zinc-100">
              {next.title}
            </span>
          </Link>
        )}
      </div>

      <a
        href={editUrl(slug)}
        target="_blank"
        rel="noopener noreferrer"
        className="mono-label mt-6 inline-flex items-center gap-1.5 !text-[10px] text-zinc-600 hover:text-zinc-300"
      >
        <Pencil size={11} /> Edit this page on GitHub
      </a>
    </div>
  );
}
