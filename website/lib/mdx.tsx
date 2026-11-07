import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { Callout } from "@/app/docs/_components/Callout";
import { Card, Cards } from "@/app/docs/_components/Cards";
import { getDoc } from "@/lib/docs";

function sourcePath(slug: string) {
  if (!slug) return path.join(process.cwd(), "content", "docs", "index.mdx");
  const relative = slug.includes("/") ? `${slug}.mdx` : `${slug}/index.mdx`;
  return path.join(process.cwd(), "content", "docs", relative);
}

function Anchor({
  href = "",
  children,
  ...props
}: ComponentPropsWithoutRef<"a"> & { children?: ReactNode }) {
  if (href.startsWith("/") || href.startsWith("#")) {
    return (
      <Link href={href} {...props}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}

const components = {
  a: Anchor,
  Callout,
  Card,
  Cards,
};

export function DocBody({ slug }: { slug: string }) {
  const entry = getDoc(slug);
  if (!entry) return null;

  const source = fs.readFileSync(sourcePath(slug), "utf8");

  return (
    <MDXRemote
      source={source}
      components={components}
      options={{
        mdxOptions: {
          remarkPlugins: [remarkGfm],
          rehypePlugins: [rehypeSlug],
        },
      }}
    />
  );
}
