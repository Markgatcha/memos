"use client";

import { useEffect, useState } from "react";
import GithubIcon from "./GithubIcon";

type StarButtonProps = {
  repo?: string;
  label?: string;
  className?: string;
};

/**
 * Live GitHub star-count pill. Fetches the count client-side so the static
 * export stays static; falls back gracefully when the API is rate-limited.
 */
export default function StarButton({
  repo = "Markgatcha/memos",
  label = "Star",
  className = "",
}: StarButtonProps) {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.stargazers_count != null) {
          setStars(data.stargazers_count);
        }
      })
      .catch(() => {
        /* rate-limited or offline — render without the count */
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  return (
    <a
      href={`https://github.com/${repo}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`btn btn-secondary ${className}`}
      aria-label={`${label} ${repo} on GitHub`}
    >
      <GithubIcon size={15} />
      <span>{label}</span>
      {stars != null && (
        <span className="ml-0.5 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-zinc-300">
          {stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : stars}
        </span>
      )}
    </a>
  );
}
