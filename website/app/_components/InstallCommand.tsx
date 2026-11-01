"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * One-line install command with a copy affordance. Kept as a client
 * component only because of the clipboard interaction; everything else
 * on the page stays static-export friendly.
 */
export default function InstallCommand({
  command,
  note,
  className = "",
}: {
  command: string;
  note?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — leave the command selectable instead */
    }
  };

  return (
    <div
      className={`group inline-flex max-w-full items-stretch border border-white/[0.1] bg-white/[0.025] ${className}`}
    >
      <code className="flex min-w-0 items-center gap-2 px-3 py-2 font-mono text-[11.5px] text-zinc-300">
        <span className="select-none text-zinc-600">$</span>
        <span className="truncate">{command}</span>
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy command: ${command}`}
        className="grid w-10 shrink-0 place-items-center border-l border-white/[0.08] text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
      >
        {copied ? (
          <Check size={13} className="text-zinc-100" />
        ) : (
          <Copy size={13} />
        )}
      </button>
      {note && (
        <span className="hidden items-center border-l border-white/[0.08] px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-600 sm:flex">
          {note}
        </span>
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? "Command copied to clipboard" : ""}
      </span>
    </div>
  );
}
