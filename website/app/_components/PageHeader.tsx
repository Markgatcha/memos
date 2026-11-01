import Reveal from "./Reveal";

export default function PageHeader({
  kicker,
  title,
  subtitle,
}: {
  kicker: string;
  title: string;
  subtitle: string;
}) {
  return (
    <Reveal className="mb-14">
      <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.08] pb-3">
        <span className="kicker">{kicker}</span>
        <span className="mono-label hidden sm:inline">
          local-first / MIT
        </span>
      </div>
      <h1 className="display mt-8 text-[2.6rem] text-zinc-50 sm:text-5xl md:text-6xl">
        {title}
      </h1>
      <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-zinc-400 md:text-base">
        {subtitle}
      </p>
    </Reveal>
  );
}
