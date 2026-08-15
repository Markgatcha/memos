import { Layers } from "lucide-react";
import GithubIcon from "./GithubIcon";

export default function Navbar() {
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
        <div className="flex items-center gap-6 text-sm">
          <a href="/memos" className="text-zinc-400 hover:text-zinc-100 transition-colors">
            MemOS
          </a>
          <a href="/umt" className="text-zinc-400 hover:text-zinc-100 transition-colors">
            UMT
          </a>
          <a href="/guardian" className="text-zinc-400 hover:text-zinc-100 transition-colors">
            Guardian
          </a>
          <a href="/benchmarks" className="hidden md:inline text-zinc-400 hover:text-zinc-100 transition-colors">
            Benchmarks
          </a>
          <a href="/docs" className="hidden md:inline text-zinc-400 hover:text-zinc-100 transition-colors">
            Docs
          </a>
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
      </nav>
    </header>
  );
}
