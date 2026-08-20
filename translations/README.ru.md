<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.svg" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>Универсальный локальный слой постоянной памяти для ИИ-агентов.</strong><br>
  Дайте любому LLM память, которая переживает перезапуски — без облака, без API-ключей, без привязки к вендору.
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <b>Русский</b> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mem-os/sdk"><img src="https://img.shields.io/npm/v/@mem-os/sdk?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
  <a href="https://github.com/Markgatcha/memos/stargazers"><img src="https://img.shields.io/github/stars/Markgatcha/memos?style=flat-square" alt="Stars"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/demo-animated.svg" alt="Демо MemOS: сохранить воспоминание, убить процесс, вспомнить — всё локально" width="720" />
</p>

<p align="center">
  <a href="https://context-core.dev/memos/"><strong>Сайт</strong></a> ·
  <a href="https://memos.readthedocs.io"><strong>Документация</strong></a> ·
  <a href="https://discord.gg/DyQGgPuueu"><strong>Discord</strong></a> ·
  <a href="https://x.com/Context_Core"><strong>Twitter/X</strong></a>
</p>

---

## Почему MemOS?

Каждый LLM забывает всё в момент окончания разговора. MemOS это меняет:

- **По-настоящему локальный** — ваши воспоминания хранятся в одном файле SQLite (`~/.memos/memos.db`), который можно открыть, скопировать, сохранить в резервную копию или удалить. Ничего не покидает вашу машину.
- **Это граф, а не список** — новые воспоминания автоматически связываются с похожими; поиск «тема» может найти ваше предпочтение «тёмный режим».
- **Понимает время** — у воспоминаний есть окна действия (`validFrom`/`validTo`), устаревшая информация корректно истекает.
- **Экономит токены** — компактный формат TOON сокращает токены контекста примерно на 77,6% по сравнению с JSON.
- **Полностью бесплатный** — лицензия MIT, без платных тарифов, без «графовая память за доплату». Форкайте, меняйте, встраивайте в продукты.

## Установка

### npm (TypeScript / Node.js)

```bash
npm install @mem-os/sdk
```

### Python (PyPI)

Пакет на PyPI называется **`mem-os-sdk`** (как `@mem-os/sdk` на npm). Он оборачивает TypeScript SDK, поэтому также нужен Node.js 18+.

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

## Быстрый старт

```typescript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// Сохранить воспоминание
await memos.store("Пользователь предпочитает тёмный режим", { type: "preference" });

// Вспомнить позже — даже в совершенно новом процессе
const results = await memos.search("тёмный режим");
```

Python (HTTP-сервер):

```bash
memos-server   # → http://localhost:7400
```

```python
import requests
requests.post("http://localhost:7400/api/mem/store",
              json={"content": "Пользователь предпочитает тёмный режим", "type": "preference"})
```

## Бенчмарки

| Бенчмарк | MemOS | Mem0 |
|----------|-------|------|
| BEAM-1M (recall @10) | **95,9%** | 64,1% |
| BEAM-1M · временные рассуждения | **97,1%** | 16,3% |
| LoCoMo | 92,5 | 92,5 |
| LongMemEval | 94,4 | 94,4 |

На истории разговоров в миллион токенов (BEAM-1M) MemOS вспоминает на 31,8 пункта больше, чем Mem0 — и работает целиком на вашей машине. На коротких бенчмарках паритет: локальность не стоит качества.

## Бесплатно и по-настоящему open source

MemOS распространяется под лицензией MIT и полностью бесплатен — используйте, изменяйте, размещайте у себя, встраивайте в продукты. Без хостинговой платформы, без учёта использования, без платных функций. Платформа Mem0 стоит от $19/мес, а графовая память — $249/мес (тариф Pro); в MemOS она включена по умолчанию.

## AI Trio

MemOS — один из трёх родственных проектов, которые сочетаются друг с другом:

| Проект | Роль |
|--------|------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | Протокол MCP, реестр серверов и маршрутизация инструментов |
| [memos](https://github.com/Markgatcha/memos) | Графовая постоянная память между сессиями |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | Страж стоимости токенов: сжимает промпты и внедряет память |

## Ссылки

- Сайт: https://context-core.dev/memos/
- Документация: https://memos.readthedocs.io
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ История звёзд

Если MemOS решает вашу проблему — поставьте звезду, это помогает больше, чем кажется.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/memos&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/memos&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## Лицензия

[MIT](../LICENSE) — свободное использование для любых целей, без указания авторства.
