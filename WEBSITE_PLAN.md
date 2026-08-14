# Website Plan: contextcore.dev (AI Trio Umbrella Site)

## Overview
Single umbrella website at `contextcore.dev` covering the AI Trio: MemOS, UMT, and LLM Guardian.
Acts as the org page for the trio, with links to Discord, GitHub, support, benchmarks, and extensive docs.

## Domain & Hosting (GitHub Student Pack)

Three providers available via Student Pack:
- **Name.com**: Free "select" domain with 25+ extensions (`.live`, `.studio`, `.software`, `.app`, `.dev`) — NOT `.io`
- **Namecheap**: Free `.me` domain for 1 year + free SSL cert
- **.TECH**: Free `.tech` domain for 1 year

### Recommended: `contextcore.dev`
- `.dev` is excellent for a developer tool site
- Google Chrome enforces HTTPS on `.dev` (security benefit)
- Available via Name.com Student Pack
- 1 year free, renewal ~$12/year

### Option B: `contextcore.tech`
- Also available via .TECH Student Pack
- 1 year free, renewal ~$25/year
- Still good for a tech-focused tool

### Option C: `contextcore.me`
- Available via Namecheap Student Pack
- Cheapest renewal (~$10/year)
- Less "professional" for org-level naming
- Free SSL cert included via Namecheap

## Stack
- **Framework**: Next.js 15 (static export via `next export`)
- **Styling**: Tailwind CSS (dark-themed to match MemOS aesthetic)
- **Deployment**: GitHub Pages (free via GitHub Student Pack)
- **Domain**: `contextcore.dev` via Name.com (Student Pack, 1 year free)

## Site Structure

### 1. Landing Page (/)
- Hero: "The Local-First AI Trio — Memory, Tools, and Cost Control for Agents"
- AI Trio overview with logos for MemOS, UMT, LLM Guardian
- Key stats: BEAM-1M 95.9%, 77.6% token savings, 100% local
- Badges for each repo: npm, PyPI, License, CI
- CTAs: "Read Docs", "View on GitHub", "Join Discord"

### 2. MemOS (/memos/)
- Overview: "Universal, local-first, persistent memory layer for AI agents"
- Quick start (npm install + basic usage)
- Features: Graph-native, Temporal validity, Compact TOON, Confidence scores
- Benchmarks: BEAM-1M 95.9%, LoCoMo 92.5, LongMemEval 94.4
- API reference (TypeScript + Python)
- MCP integration guide
- Link to github.com/Markgatcha/memos

### 3. UMT (/umt/)
- Overview: "Universal MCP Toolkit — MCP transport and tool registry"
- Quick start (npm install, link memos, list tools)
- Features: MCP discovery, tool routing, bridge caching, sessions
- Link to github.com/Markgatcha/universal-mcp-toolkit

### 4. LLM Guardian (/guardian/)
- Overview: "LLM cost guardian — prompt compression and token optimization"
- Quick start (npm install, add to agent workflow)
- Features: Prompt folding, TOON format injection, VCM sharding, trust-weighted retrieval
- Link to github.com/Markgatcha/llm-guardian

### 5. Documentation (/docs/)
- Unified API reference across all three repos
- AI Trio integration guide (how MemOS feeds Guardian via `ai.trio.memos.context-pack.v1`)
- MCP adapter documentation
- Context pack format specification (JSON, TOON, TOON-compact)
- Confidence score state machine docs
- Adapter ecosystem (Ollama, LangChain, CrewAI, OpenAI, Anthropic)

### 6. Benchmarks (/benchmarks/)
- Live benchmark results table (BEAM-1M, LoCoMo, LongMemEval)
- Comparison: MemOS vs Mem0 (95.9% vs 64.1% recall on BEAM-1M)
- Token savings comparison (JSON vs TOON vs TOON-compact: 70.3% vs 64.3%)
- Latency microbenchmarks (HNSW vector search, SQLite FTS5)

### 7. Blog (/blog/)
- "How MemOS Beats Mem0 on BEAM-1M" (95.9% recall)
- "Building Local-First AI Agents with the AI Trio"
- "Token-Efficient Memory: 77.6% Reduction with Compact TOON Format"
- "Confidence Scores: Reinforce, Revise, Supersede"
- "Mem0's 70x Latency Fix: Why Postgres Vectors Don't Scale"

### 8. Support (/support/)
- Discord widget (your Discord server invite)
- GitHub Issues links for each repo
- Email support contact
- FAQ

## GitHub Integration
- Auto-deploy on tag/release via GitHub Actions workflow
- `.github/workflows/deploy.yml` builds Next.js static export and pushes to `gh-pages`
- Free tier (GitHub Actions + Pages) covers all three repos

## SEO
- Sitemap.xml (Next.js built-in)
- robots.txt
- OpenGraph tags for each page
- Structured data for documentation pages
- Meta descriptions pulled from READMEs

## Timeline
- **Phase 1** (60 min): Next.js + Tailwind scaffold with landing page layout, deploy to GitHub Pages
- **Phase 2** (90 min): Write docs pages for each repo (MemOS, UMT, LLM Guardian)
- **Phase 3** (60 min): Benchmark pages + blog posts
- **Phase 4** (30 min): Discord widget + support page + GitHub Actions deploy
- **Phase 5** (60 min): SEO optimization + domain setup

## Naming Rationale
- **contextcore** = "context is core" — reflects that persistent memory is the foundational layer
- The three repos are "core services" of the local-first AI stack
- `contextcore.dev` is short, memorable, and works for all three repos
- `.dev` enforces HTTPS (security benefit for a developer tool)
- Discord server: `discord.gg/contextcore` (or similar)
