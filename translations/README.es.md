<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.svg" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>Capa de memoria persistente, universal y local-first para agentes de IA.</strong><br>
  Dale a cualquier LLM una memoria que sobrevive reinicios — sin nube, sin claves API, sin dependencia de proveedores.
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <b>Español</b> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mem-os/sdk"><img src="https://img.shields.io/npm/v/@mem-os/sdk?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
  <a href="https://github.com/Markgatcha/memos/stargazers"><img src="https://img.shields.io/github/stars/Markgatcha/memos?style=flat-square" alt="Stars"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/demo-animated.svg" alt="Demo de MemOS: guarda un recuerdo, mata el proceso, recupéralo — todo local" width="720" />
</p>

<p align="center">
  <a href="https://context-core.dev/memos/"><strong>Sitio web</strong></a> ·
  <a href="https://memos.readthedocs.io"><strong>Docs</strong></a> ·
  <a href="https://discord.gg/DyQGgPuueu"><strong>Discord</strong></a> ·
  <a href="https://x.com/Context_Core"><strong>Twitter/X</strong></a>
</p>

---

## ¿Por qué MemOS?

Cada LLM olvida todo en el momento en que termina la conversación. MemOS lo cambia:

- **Realmente local** — tus recuerdos viven en un archivo SQLite (`~/.memos/memos.db`) que puedes abrir, copiar, respaldar o borrar. Nada sale de tu máquina.
- **Es un grafo, no una lista** — los recuerdos nuevos se enlazan automáticamente con los relacionados; buscar "tema" puede encontrar tu preferencia de "modo oscuro".
- **Entiende el tiempo** — los recuerdos tienen ventanas de validez (`validFrom`/`validTo`), así la información obsoleta expira con elegancia.
- **Ahorra tokens** — el formato compacto TOON reduce ~77,6% los tokens de contexto frente a JSON.
- **Gratis de verdad** — licencia MIT, sin nivel de pago, sin "la memoria de grafo cuesta extra". Haz fork, modifica, distribuye.

## Instalación

### npm (TypeScript / Node.js)

```bash
npm install @mem-os/sdk
```

### Python (PyPI)

El paquete en PyPI se llama **`mem-os-sdk`** (igual que `@mem-os/sdk` en npm). Envuelve el SDK de TypeScript, así que también necesitas Node.js 18+.

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

## Inicio rápido

```typescript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// Guardar un recuerdo
await memos.store("El usuario prefiere el modo oscuro", { type: "preference" });

// Recuperarlo después — incluso en un proceso nuevo
const results = await memos.search("modo oscuro");
```

Python (servidor HTTP):

```bash
memos-server   # → http://localhost:7400
```

```python
import requests
requests.post("http://localhost:7400/api/mem/store",
              json={"content": "El usuario prefiere el modo oscuro", "type": "preference"})
```

## Benchmarks

| Benchmark | MemOS | Mem0 |
|-----------|-------|------|
| BEAM-1M (recall @10) | **95,9%** | 64,1% |
| BEAM-1M · razonamiento temporal | **97,1%** | 16,3% |
| LoCoMo | 92,5 | 92,5 |
| LongMemEval | 94,4 | 94,4 |

En historiales de conversación de un millón de tokens y meses de duración (BEAM-1M), MemOS recuerda 31,8 puntos más que Mem0 — funcionando completamente en tu máquina. En benchmarks más cortos hay empate: ser local no cuesta calidad.

## Gratis y open source de verdad

MemOS tiene licencia MIT y es completamente gratuito — para usar, modificar, auto-alojar y distribuir en tu producto. No hay plataforma alojada, ni medición de uso, ni funciones de pago. La plataforma de Mem0 cuesta desde $19/mes y cobra $249/mes por la memoria de grafo — una función que MemOS incluye por defecto.

## El AI Trio

MemOS es uno de tres proyectos hermanos que se combinan:

| Proyecto | Rol |
|----------|-----|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | Protocolo MCP, registro de servidores y enrutado de herramientas |
| [memos](https://github.com/Markgatcha/memos) | Memoria persistente basada en grafo entre sesiones |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | Guardián de costes de tokens: comprime prompts e inyecta memoria |

## Enlaces

- Sitio web: https://context-core.dev/memos/
- Docs: https://memos.readthedocs.io
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ Historial de estrellas

Si MemOS resuelve un problema para ti, la estrella ayuda más de lo que crees.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/memos&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/memos&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## Licencia

[MIT](../LICENSE) — úsalo donde quieras, para cualquier propósito, sin atribución requerida.
