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
    <Reveal className="mb-12">
      <div className="kicker mb-4">{kicker}</div>
      <h1 className="text-4xl md:text-5xl font-semibold tracking-[-0.03em] text-zinc-50 mb-4 text-balance">
        {title}
      </h1>
      <p className="text-lg text-zinc-400 max-w-2xl leading-relaxed">{subtitle}</p>
    </Reveal>
  );
}
