<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.svg" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>Couche de mémoire persistante, universelle et local-first pour agents IA.</strong><br>
  Donnez à n'importe quel LLM une mémoire qui survit aux redémarrages — sans cloud, sans clé API, sans verrouillage fournisseur.
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <b>Français</b> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mem-os/sdk"><img src="https://img.shields.io/npm/v/@mem-os/sdk?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
  <a href="https://github.com/Markgatcha/memos/stargazers"><img src="https://img.shields.io/github/stars/Markgatcha/memos?style=flat-square" alt="Stars"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/demo-animated.svg" alt="Démo MemOS : stocker un souvenir, tuer le processus, le rappeler — tout en local" width="720" />
</p>

<p align="center">
  <a href="https://context-core.dev/memos/"><strong>Site web</strong></a> ·
  <a href="https://memos.readthedocs.io"><strong>Docs</strong></a> ·
  <a href="https://discord.gg/DyQGgPuueu"><strong>Discord</strong></a> ·
  <a href="https://x.com/Context_Core"><strong>Twitter/X</strong></a>
</p>

---

## Pourquoi MemOS ?

Chaque LLM oublie tout dès que la conversation se termine. MemOS change ça :

- **Vraiment local** — vos souvenirs vivent dans un fichier SQLite (`~/.memos/memos.db`) que vous pouvez ouvrir, copier, sauvegarder ou supprimer. Rien ne quitte votre machine.
- **Un graphe, pas une liste** — les nouveaux souvenirs se lient automatiquement aux souvenirs apparentés ; chercher « thème » peut retrouver votre préférence « mode sombre ».
- **Comprend le temps** — les souvenirs portent des fenêtres de validité (`validFrom`/`validTo`), l'information obsolète expire proprement.
- **Économise des tokens** — le format compact TOON réduit les tokens de contexte d'environ 77,6 % par rapport au JSON.
- **Vraiment gratuit** — licence MIT, pas de niveau payant, pas de « mémoire graphe en option payante ». Forkez, modifiez, expédiez.

## Installation

### npm (TypeScript / Node.js)

```bash
npm install @mem-os/sdk
```

### Python (PyPI)

Le paquet sur PyPI s'appelle **`mem-os-sdk`** (comme `@mem-os/sdk` sur npm). Il encapsule le SDK TypeScript, donc Node.js 18+ est aussi requis.

```bash
pip install mem-os-sdk
pip install "mem-os-sdk[all]"   # + LangChain/Ollama adapters
```

### Docker

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
docker compose up -d
curl http://localhost:7400/health
```

## Démarrage rapide

```typescript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// Stocker un souvenir
await memos.store("L'utilisateur préfère le mode sombre", { type: "preference" });

// Le rappeler plus tard — même dans un tout nouveau processus
const results = await memos.search("mode sombre");
```

Python (serveur HTTP) :

```bash
memos-server   # → http://localhost:7400
```

```python
import requests
requests.post("http://localhost:7400/api/mem/store",
              json={"content": "L'utilisateur préfère le mode sombre", "type": "preference"})
```

## Benchmarks

| Benchmark | MemOS | Mem0 |
|-----------|-------|------|
| BEAM-1M (recall @10) | **95,9 %** | 64,1 % |
| BEAM-1M · raisonnement temporel | **97,1 %** | 16,3 % |
| LoCoMo | 92,5 | 92,5 |
| LongMemEval | 94,4 | 94,4 |

Sur des historiques de conversation d'un million de tokens (BEAM-1M), MemOS rappelle 31,8 points de plus que Mem0 — tout en tournant entièrement sur votre machine. Sur les benchmarks plus courts, égalité : le local ne coûte rien en qualité.

## Gratuit et open source, pour de vrai

MemOS est sous licence MIT et totalement gratuit — à utiliser, modifier, auto-héberger et intégrer dans vos produits. Pas de plateforme hébergée, pas de facturation à l'usage, pas de fonctionnalités cachées derrière un abonnement. La plateforme Mem0 démarre à 19 $/mois et facture 249 $/mois pour la mémoire graphe — une fonctionnalité incluse par défaut dans MemOS.

## L'AI Trio

MemOS est l'un des trois projets frères qui se combinent :

| Projet | Rôle |
|--------|------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | Protocole MCP, registre de serveurs et routage d'outils |
| [memos](https://github.com/Markgatcha/memos) | Mémoire persistante en graphe entre sessions |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | Gardien du coût en tokens : compresse les prompts et injecte la mémoire |

## Liens

- Site web : https://context-core.dev/memos/
- Docs : https://memos.readthedocs.io
- Discord : https://discord.gg/DyQGgPuueu
- Twitter/X : https://x.com/Context_Core

## ⭐ Historique des étoiles

Si MemOS résout un problème pour vous, une étoile aide plus que vous ne le pensez.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/memos&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/memos&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## Licence

[MIT](../LICENSE) — utilisez-le partout, pour n'importe quel usage, sans attribution requise.
