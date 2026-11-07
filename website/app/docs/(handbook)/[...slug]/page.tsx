import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { docs, getDoc, getNeighbors, products } from "@/lib/docs";
import { DocBody } from "@/lib/mdx";
import DocsPager from "../_components/DocsPager";

type Props = { params: Promise<{ slug: string[] }> };

export function generateStaticParams() {
  return docs
    .filter((doc) => doc.slug)
    .map((doc) => ({ slug: doc.slug.split("/") }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const entry = getDoc(slug.join("/"));
  if (!entry) return {};
  return {
    title: entry.title,
    description: entry.description,
  };
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const key = slug.join("/");
  const entry = getDoc(key);
  if (!entry) notFound();

  const product = products.find((item) => item.id === entry.product);
  const { previous } = getNeighbors(key);

  return (
    <article className="docs-prose">
      <nav
        aria-label="Breadcrumb"
        className="mono-label mb-3 !text-[10px] text-zinc-500"
      >
        <a href="/docs" className="hover:text-zinc-300">
          docs
        </a>
        <span className="px-1.5">/</span>
        <span className="text-zinc-400">{product?.label ?? entry.product}</span>
        {previous && (
          <>
            <span className="px-1.5">/</span>
            <span className="text-zinc-600">{entry.title}</span>
          </>
        )}
      </nav>
      <h1 className="display text-[2.35rem] leading-[1.08] text-zinc-50 sm:text-[2.8rem]">
        {entry.title}
      </h1>
      <p className="lead">{entry.description}</p>
      <DocBody slug={key} />
      <DocsPager slug={key} />
    </article>
  );
}
