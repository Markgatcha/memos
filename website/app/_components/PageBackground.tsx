export default function PageBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      {/* A single architectural rule, not a glow or a particle field. */}
      <div className="absolute inset-y-0 left-1/2 w-px bg-white/[0.035]" />
      <div className="absolute inset-y-0 left-6 w-px bg-white/[0.02] md:left-10" />
    </div>
  );
}
