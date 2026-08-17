import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import Navbar from "./_components/Navbar";
import PageBackground from "./_components/PageBackground";

export const metadata: Metadata = {
  title: {
    default:
      "ContextCore — Local-First AI Trio for Memory, Tools, and Cost Control",
    template: "%s — ContextCore",
  },
  description:
    "MemOS (persistent memory), UMT (MCP toolkit), and LLM Guardian (token optimization) — 100% local, zero cloud.",
  metadataBase: new URL("https://context-core.dev"),
  openGraph: {
    title: "ContextCore — Local-First AI Trio",
    description: "Memory, tools, and cost control for AI agents. 100% local.",
    url: "https://context-core.dev",
    type: "website",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="bg-base text-zinc-100 antialiased font-sans">
        <PageBackground />
        <Navbar />
        {children}
      </body>
    </html>
  );
}
