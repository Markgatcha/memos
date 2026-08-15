export default function PageBackground() {
  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 dot-grid" />
      <div className="absolute inset-x-0 top-0 h-[420px] top-glow" />
    </div>
  );
}
