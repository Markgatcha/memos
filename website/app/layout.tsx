import type { Metadata } from "next";
import "./globals.css";
import Navbar from "./_components/Navbar";
import AuroraBackground from "./_components/AuroraBackground";

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
      <body className="bg-[#050508] text-white antialiased">
        <AuroraBackground />
        <Navbar />
        {children}
      </body>
    </html>
  );
}
