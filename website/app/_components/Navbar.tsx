export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-[#050508]/70 backdrop-blur-xl">
      <nav className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2 group">
          <span className="w-2.5 h-2.5 rounded-full bg-gradient-to-r from-[#3b82f6] via-[#a855f7] to-[#22c55e] animate-glow" />
          <span className="font-semibold tracking-tight group-hover:text-white text-gray-200 transition">
            ContextCore
          </span>
        </a>
        <div className="flex items-center gap-5 text-sm">
          <a href="/memos" className="text-gray-400 hover:text-blue-400 transition">
            MemOS
          </a>
          <a href="/umt" className="text-gray-400 hover:text-purple-400 transition">
            UMT
          </a>
          <a href="/guardian" className="text-gray-400 hover:text-green-400 transition">
            Guardian
          </a>
          <a href="/benchmarks" className="hidden sm:inline text-gray-400 hover:text-white transition">
            Benchmarks
          </a>
          <a href="/docs" className="hidden sm:inline text-gray-400 hover:text-white transition">
            Docs
          </a>
          <a
            href="https://github.com/Markgatcha/memos"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost px-3 py-1.5 rounded-lg border border-white/10 text-gray-300 hover:text-white"
          >
            GitHub
          </a>
        </div>
      </nav>
    </header>
  );
}
