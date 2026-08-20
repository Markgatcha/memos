<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.svg" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>Universelle, lokale-first persistente Speicherschicht für KI-Agenten.</strong><br>
  Gib jedem LLM ein Gedächtnis, das Neustarts überlebt — keine Cloud, keine API-Keys, kein Vendor-Lock-in.
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <b>Deutsch</b> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mem-os/sdk"><img src="https://img.shields.io/npm/v/@mem-os/sdk?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
  <a href="https://github.com/Markgatcha/memos/stargazers"><img src="https://img.shields.io/github/stars/Markgatcha/memos?style=flat-square" alt="Stars"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/demo-animated.svg" alt="MemOS-Demo: Erinnerung speichern, Prozess beenden, wieder abrufen — alles lokal" width="720" />
</p>

<p align="center">
  <a href="https://context-core.dev/memos/"><strong>Website</strong></a> ·
  <a href="https://memos.readthedocs.io"><strong>Doku</strong></a> ·
  <a href="https://discord.gg/DyQGgPuueu"><strong>Discord</strong></a> ·
  <a href="https://x.com/Context_Core"><strong>Twitter/X</strong></a>
</p>

---

## Warum MemOS?

Jedes LLM vergisst alles in dem Moment, in dem eine Konversation endet. MemOS ändert das:

- **Wirklich lokal** — deine Erinnerungen liegen in einer einzigen SQLite-Datei (`~/.memos/memos.db`), die du öffnen, kopieren, sichern oder löschen kannst. Nichts verlässt deinen Rechner.
- **Ein Graph, keine Liste** — neue Erinnerungen werden automatisch mit verwandten verknüpft; die Suche nach „Theme" findet deine „Dark Mode"-Präferenz.
- **Versteht Zeit** — Erinnerungen tragen Gültigkeitsfenster (`validFrom`/`validTo`), veraltete Informationen laufen sauber aus.
- **Spart Tokens** — das kompakte TOON-Format reduziert Kontext-Tokens um ~77,6 % gegenüber JSON.
- **Wirklich kostenlos** — MIT-Lizenz, keine Bezahlebene, kein „Graph-Gedächtnis kostet extra". Forken, ändern, ausliefern.

## Installation

### npm (TypeScript / Node.js)

```bash
npm install @mem-os/sdk
```

### Python (aus dem Quellcode)

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
pip install -e .
pip install -e ".[all]"   # optional: LangChain- + Ollama-Adapter
```

### Docker

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
docker compose up -d
curl http://localhost:7400/health
```

## Schnellstart

```typescript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// Erinnerung speichern
await memos.store("Benutzer bevorzugt Dark Mode", { type: "preference" });

// Später abrufen — sogar in einem brandneuen Prozess
const results = await memos.search("Dark Mode");
```

Python (HTTP-Server):

```bash
memos-server   # → http://localhost:7400
```

```python
import requests
requests.post("http://localhost:7400/api/mem/store",
              json={"content": "Benutzer bevorzugt Dark Mode", "type": "preference"})
```

## Benchmarks

| Benchmark | MemOS | Mem0 |
|-----------|-------|------|
| BEAM-1M (Recall @10) | **95,9 %** | 64,1 % |
| BEAM-1M · zeitliches Schließen | **97,1 %** | 16,3 % |
| LoCoMo | 92,5 | 92,5 |
| LongMemEval | 94,4 | 94,4 |

Auf Konversationsverläufen mit einer Million Tokens (BEAM-1M) erinnert MemOS 31,8 Punkte mehr als Mem0 — und läuft dabei komplett auf deinem Rechner. Bei kürzeren Benchmarks Gleichstand: lokal kostet keine Qualität.

## Kostenlos und wirklich Open Source

MemOS ist MIT-lizenziert und komplett kostenlos — nutzen, ändern, selbst hosten, im Produkt ausliefern. Keine gehostete Plattform, keine Nutzungsmessung, keine Bezahlschranke. Die Mem0-Plattform startet bei 19 $/Monat und berechnet 249 $/Monat für Graph-Gedächtnis — ein Feature, das MemOS standardmäßig enthält.

## Das AI Trio

MemOS ist eines von drei Schwesterprojekten, die zusammenpassen:

| Projekt | Rolle |
|---------|-------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | MCP-Protokoll, Server-Registry und Tool-Routing |
| [memos](https://github.com/Markgatcha/memos) | Graph-basiertes persistentes Gedächtnis über Sessions hinweg |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | Token-Kostenwächter: komprimiert Prompts und injiziert Erinnerungen |

## Links

- Website: https://context-core.dev/memos/
- Doku: https://memos.readthedocs.io
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ Star-Verlauf

Wenn MemOS dir ein Problem löst, hilft ein Stern mehr, als du denkst.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/memos&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/memos&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## Lizenz

[MIT](../LICENSE) — frei nutzbar für jeden Zweck, ohne Namensnennung.
