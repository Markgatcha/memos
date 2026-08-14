import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ContextCore — Local-First AI Trio for Memory, Tools, and Cost Control",
  description:
    "MemOS (persistent memory), UMT (MCP toolkit), and LLM Guardian (token optimization) — 100% local, zero cloud.",
  openGraph: {
    title: "ContextCore — Local-First AI Trio",
    description: "Memory, tools, and cost control for AI agents. 100% local.",
    url: "https://context-core.dev",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-[#0a0a0f] text-white antialiased">
        {children}
      </body>
    </html>
  );
}
