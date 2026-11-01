import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Spectral } from "next/font/google";
import "./globals.css";
import Navbar from "./_components/Navbar";
import PageBackground from "./_components/PageBackground";
import Footer from "./_components/Footer";

const spectral = Spectral({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-spectral",
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default:
      "ContextCore — Local-first AI memory, tools, and cost control",
    template: "%s — ContextCore",
  },
  description:
    "MemOS (persistent memory), UMT (MCP toolkit), and LLM Guardian (token optimization) — three local-first tools. One SQLite file, zero cloud calls, no API keys required.",
  metadataBase: new URL("https://context-core.dev"),
  applicationName: "ContextCore",
  openGraph: {
    title: "ContextCore — The local-first stack for AI agents",
    description:
      "Persistent memory, MCP tooling, and token-cost control. 100% local, open source, no accounts.",
    url: "https://context-core.dev",
    siteName: "ContextCore",
    type: "website",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
};

export const viewport: Viewport = {
  themeColor: "#10140f",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${spectral.variable} ${plexSans.variable} ${plexMono.variable}`}
    >
      <body className="min-h-screen bg-canvas font-sans text-zinc-100 antialiased">
        <noscript>
          <style>{`.reveal{opacity:1 !important;transform:none !important}`}</style>
        </noscript>
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <PageBackground />
        <Navbar />
        <div id="main-content" tabIndex={-1}>{children}</div>
        <Footer />
      </body>
    </html>
  );
}
