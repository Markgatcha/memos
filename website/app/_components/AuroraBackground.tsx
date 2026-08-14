export default function AuroraBackground() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div className="aurora-blob blob-blue w-[42rem] h-[42rem] -top-64 -left-40" />
      <div className="aurora-blob blob-purple w-[38rem] h-[38rem] top-1/3 -right-52" />
      <div className="aurora-blob blob-green w-[32rem] h-[32rem] bottom-0 left-1/4" />
      <div className="grid-overlay absolute inset-0" />
    </div>
  );
}
