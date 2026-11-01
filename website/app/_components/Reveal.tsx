import type { ReactNode } from "react";

type RevealProps = {
  children: ReactNode;
  delay?: number;
  className?: string;
};

/**
 * Layout wrapper kept for call-site compatibility. The old scroll-triggered
 * fade is intentionally gone: a page that animates every section into view
 * reads as a template, and the content is already legible without it.
 */
export default function Reveal({ children, className = "" }: RevealProps) {
  return <div className={className}>{children}</div>;
}
