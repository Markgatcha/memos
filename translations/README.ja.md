<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.svg" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>AIエージェントのための、ユニバーサルでローカルファーストな永続メモリレイヤー。</strong><br>
  あらゆるLLMに、再起動後も生き残る記憶を — クラウド不要、APIキー不要、ベンダーロックインなし。
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <b>日本語</b> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mem-os/sdk"><img src="https://img.shields.io/npm/v/@mem-os/sdk?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
  <a href="https://github.com/Markgatcha/memos/stargazers"><img src="https://img.shields.io/github/stars/Markgatcha/memos?style=flat-square" alt="Stars"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/demo-animated.svg" alt="MemOSデモ：記憶を保存し、プロセスを終了し、呼び出す — すべてローカル" width="720" />
</p>

<p align="center">
  <a href="https://context-core.dev/memos/"><strong>ウェブサイト</strong></a> ·
  <a href="https://memos.readthedocs.io"><strong>ドキュメント</strong></a> ·
  <a href="https://discord.gg/DyQGgPuueu"><strong>Discord</strong></a> ·
  <a href="https://x.com/Context_Core"><strong>Twitter/X</strong></a>
</p>

---

## なぜ MemOS なのか？

すべてのLLMは、会話が終了した瞬間にすべてを忘れてしまいます。MemOSはそれを変えます：

- **真のローカル** — 記憶は1つのSQLiteファイル（`~/.memos/memos.db`）に保存され、開く・コピー・バックアップ・削除が自由にできます。外部送信は一切ありません。
- **リストではなくグラフ** — 新しい記憶は関連する記憶と自動的にリンクされ、「テーマ」の検索で「ダークモード」の設定が見つかります。
- **時間を理解する** — 記憶には有効期間（`validFrom`/`validTo`）があり、古くなった情報は適切に失効します。
- **トークンを節約** — コンパクトなTOON形式は、JSONと比べてコンテキストトークンを約77.6%削減します。
- **完全に無料** — MITライセンス、有料プランなし、「グラフメモリは別料金」もなし。フォーク・改変・製品への組み込み自由。

## インストール

### npm（TypeScript / Node.js）

```bash
npm install @mem-os/sdk
```

### Python（ソースから）

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
pip install -e .
pip install -e ".[all]"   # オプション：LangChain + Ollama アダプター
```

### Docker

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
docker compose up -d
curl http://localhost:7400/health
```

## クイックスタート

```typescript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// 記憶を保存
await memos.store("ユーザーはダークモードを好む", { type: "preference" });

// 後で呼び出す — まったく新しいプロセスからでも
const results = await memos.search("ダークモード");
```

Python（HTTPサーバー）：

```bash
memos-server   # → http://localhost:7400
```

```python
import requests
requests.post("http://localhost:7400/api/mem/store",
              json={"content": "ユーザーはダークモードを好む", "type": "preference"})
```

## ベンチマーク

| ベンチマーク | MemOS | Mem0 |
|--------------|-------|------|
| BEAM-1M（recall @10） | **95.9%** | 64.1% |
| BEAM-1M ・時間推論 | **97.1%** | 16.3% |
| LoCoMo | 92.5 | 92.5 |
| LongMemEval | 94.4 | 94.4 |

100万トークン規模の長期会話履歴（BEAM-1M）において、MemOSはMem0を31.8ポイント上回るリコールを達成 — しかも完全にあなたのマシン上で動作します。短期ベンチマークでは同等：ローカル化による品質の犠牲はありません。

## 無料で、本当にオープンソース

MemOSはMITライセンスで完全に無料です — 使用、改変、セルフホスト、製品への組み込み、すべて自由。ホスティングプラットフォームも、使用量課金も、有料機能の囲い込みもありません。対照的にMem0のプラットフォームは月額$19からで、グラフメモリには月額$249のProプランが必要です — MemOSではそれが標準機能です。

## AI Trio

MemOSは、組み合わせ可能な3つの姉妹プロジェクトのひとつです：

| プロジェクト | 役割 |
|--------------|------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | MCPプロトコル、サーバーレジストリ、ツールルーティング |
| [memos](https://github.com/Markgatcha/memos) | セッションをまたぐグラフベースの永続メモリ |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | プロンプトを圧縮しメモリを注入するトークンコストガーディアン |

## リンク

- ウェブサイト：https://context-core.dev/memos/
- ドキュメント：https://memos.readthedocs.io
- Discord：https://discord.gg/DyQGgPuueu
- Twitter/X：https://x.com/Context_Core

## ⭐ スターの履歴

MemOSがあなたの問題を解決したら、スターをお願いします — 想像以上に助けになります。

<p align="center">
  <a href="https://star-history.com/#Markgatcha/memos&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/memos&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## ライセンス

[MIT](../LICENSE) — 帰属表示なしで、あらゆる目的に自由に使用できます。
