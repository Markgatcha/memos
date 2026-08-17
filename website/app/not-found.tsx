import { ArrowRight } from "lucide-react";

export default function NotFound() {
  return (
    <main className="min-h-screen grid place-items-center px-6">
      <div className="text-center max-w-md">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-600 mb-4">
          error 404
        </div>
        <h1 className="text-4xl md:text-5xl font-semibold tracking-[-0.04em] text-zinc-50">
          This page drifted out
          <br />
          <span className="text-fade">of context.</span>
        </h1>
        <p className="mt-5 text-zinc-400 leading-relaxed">
          The page you&apos;re looking for doesn&apos;t exist. For a memory
          layer, that&apos;s the one unforgivable error.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <a href="/" className="btn btn-primary">
            Back home
            <ArrowRight size={15} />
          </a>
          <a href="/docs" className="btn btn-secondary">
            Read the docs
          </a>
        </div>
      </div>
    </main>
  );
}
