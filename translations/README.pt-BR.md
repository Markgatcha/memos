<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.svg" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>Camada de memória persistente, universal e local-first para agentes de IA.</strong><br>
  Dê a qualquer LLM uma memória que sobrevive a reinicializações — sem nuvem, sem chaves de API, sem lock-in de fornecedor.
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <b>Português</b> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mem-os/sdk"><img src="https://img.shields.io/npm/v/@mem-os/sdk?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
  <a href="https://github.com/Markgatcha/memos/stargazers"><img src="https://img.shields.io/github/stars/Markgatcha/memos?style=flat-square" alt="Stars"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/demo-animated.svg" alt="Demo do MemOS: armazene uma memória, mate o processo, recupere — tudo local" width="720" />
</p>

<p align="center">
  <a href="https://context-core.dev/memos/"><strong>Site</strong></a> ·
  <a href="https://memos.readthedocs.io"><strong>Docs</strong></a> ·
  <a href="https://discord.gg/DyQGgPuueu"><strong>Discord</strong></a> ·
  <a href="https://x.com/Context_Core"><strong>Twitter/X</strong></a>
</p>

---

## Por que MemOS?

Todo LLM esquece tudo no momento em que a conversa termina. O MemOS muda isso:

- **Realmente local** — suas memórias vivem em um único arquivo SQLite (`~/.memos/memos.db`) que você pode abrir, copiar, fazer backup ou excluir. Nada sai da sua máquina.
- **É um grafo, não uma lista** — novas memórias se conectam automaticamente às relacionadas; buscar "tema" pode encontrar sua preferência de "modo escuro".
- **Entende o tempo** — memórias têm janelas de validade (`validFrom`/`validTo`), então informações obsoletas expiram com elegância.
- **Economiza tokens** — o formato compacto TOON reduz ~77,6% dos tokens de contexto em comparação com JSON.
- **Grátis de verdade** — licença MIT, sem plano pago, sem "memória de grafo custa extra". Faça fork, modifique, distribua.

## Instalação

### npm (TypeScript / Node.js)

```bash
npm install @mem-os/sdk
```

### Python (a partir do código-fonte)

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
pip install -e .
pip install -e ".[all]"   # opcional: adaptadores LangChain + Ollama
```

### Docker

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
docker compose up -d
curl http://localhost:7400/health
```

## Início rápido

```typescript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// Armazenar uma memória
await memos.store("Usuário prefere modo escuro", { type: "preference" });

// Recuperá-la depois — mesmo em um processo totalmente novo
const results = await memos.search("modo escuro");
```

Python (servidor HTTP):

```bash
memos-server   # → http://localhost:7400
```

```python
import requests
requests.post("http://localhost:7400/api/mem/store",
              json={"content": "Usuário prefere modo escuro", "type": "preference"})
```

## Benchmarks

| Benchmark | MemOS | Mem0 |
|-----------|-------|------|
| BEAM-1M (recall @10) | **95,9%** | 64,1% |
| BEAM-1M · raciocínio temporal | **97,1%** | 16,3% |
| LoCoMo | 92,5 | 92,5 |
| LongMemEval | 94,4 | 94,4 |

Em históricos de conversa de um milhão de tokens (BEAM-1M), o MemOS recupera 31,8 pontos a mais que o Mem0 — rodando inteiramente na sua máquina. Nos benchmarks mais curtos, empate: ser local não custa qualidade.

## Grátis e open source de verdade

O MemOS tem licença MIT e é totalmente gratuito — para usar, modificar, auto-hospedar e distribuir no seu produto. Sem plataforma hospedada, sem medição de uso, sem recursos pagos escondidos. A plataforma Mem0 começa em US$ 19/mês e cobra US$ 249/mês pela memória de grafo — um recurso que o MemOS inclui por padrão.

## O AI Trio

O MemOS é um dos três projetos irmãos que se combinam:

| Projeto | Papel |
|---------|-------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | Protocolo MCP, registro de servidores e roteamento de ferramentas |
| [memos](https://github.com/Markgatcha/memos) | Memória persistente baseada em grafo entre sessões |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | Guardião de custo de tokens: comprime prompts e injeta memória |

## Links

- Site: https://context-core.dev/memos/
- Docs: https://memos.readthedocs.io
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ Histórico de estrelas

Se o MemOS resolve um problema seu, uma estrela ajuda mais do que você imagina.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/memos&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/memos&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## Licença

[MIT](../LICENSE) — use onde quiser, para qualquer finalidade, sem necessidade de atribuição.
