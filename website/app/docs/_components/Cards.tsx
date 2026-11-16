import Link from "next/link";
import type { ReactNode } from "react";

export function Cards({
  children,
  cols = 2,
}: {
  children: ReactNode;
  cols?: 1 | 2 | 3;
}) {
  const grid =
    cols === 3
      ? "sm:grid-cols-2 lg:grid-cols-3"
      : cols === 1
        ? "grid-cols-1"
        : "sm:grid-cols-2";
  return <div className={`my-6 grid gap-3 ${grid}`}>{children}</div>;
}

export function Card({
  title,
  href,
  eyebrow,
  children,
}: {
  title: string;
  href?: string;
  eyebrow?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      {eyebrow && (
        <span className="mono-label mb-2 block !text-[10px] text-zinc-500">
          {eyebrow}
        </span>
      )}
      <span className="block text-[14px] font-medium text-zinc-100">{title}</span>
      {children && (
        <span className="mt-1.5 block text-[13px] leading-6 text-zinc-400">
          {children}
        </span>
      )}
    </>
  );

  if (!href) {
    return <div className="card p-4">{body}</div>;
  }

  const internal = href.startsWith("/");
  return (
    <Link
      href={href}
      className="card p-4 transition-colors hover:border-white/20"
      {...(internal ? {} : { target: "_blank", rel: "noopener noreferrer" })}
    >
      {body}
    </Link>
  );
}
