<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.svg" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>AI 에이전트를 위한 범용 로컬 우선 영구 메모리 레이어.</strong><br>
  모든 LLM에게 재시작 후에도 살아남는 기억을 — 클라우드 없음, API 키 없음, 벤더 종속 없음.
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <b>한국어</b> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mem-os/sdk"><img src="https://img.shields.io/npm/v/@mem-os/sdk?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
  <a href="https://github.com/Markgatcha/memos/stargazers"><img src="https://img.shields.io/github/stars/Markgatcha/memos?style=flat-square" alt="Stars"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/demo-animated.svg" alt="MemOS 데모: 기억 저장, 프로세스 종료, 다시 회상 — 전부 로컬" width="720" />
</p>

<p align="center">
  <a href="https://context-core.dev/memos/"><strong>웹사이트</strong></a> ·
  <a href="https://memos.readthedocs.io"><strong>문서</strong></a> ·
  <a href="https://discord.gg/DyQGgPuueu"><strong>Discord</strong></a> ·
  <a href="https://x.com/Context_Core"><strong>Twitter/X</strong></a>
</p>

---

## 왜 MemOS인가?

모든 LLM은 대화가 끝나는 순간 모든 것을 잊습니다. MemOS는 이를 바꿉니다:

- **진정한 로컬** — 기억은 하나의 SQLite 파일(`~/.memos/memos.db`)에 저장되며, 열고, 복사하고, 백업하고, 삭제할 수 있습니다. 외부 전송이 전혀 없습니다.
- **리스트가 아닌 그래프** — 새 기억은 관련 기억과 자동으로 연결되어, "테마"를 검색하면 "다크 모드" 설정을 찾을 수 있습니다.
- **시간을 이해함** — 기억에는 유효 기간(`validFrom`/`validTo`)이 있어 오래된 정보는 우아하게 만료됩니다.
- **토큰 절약** — 컴팩트 TOON 형식은 JSON 대비 컨텍스트 토큰을 약 77.6% 줄입니다.
- **완전 무료** — MIT 라이선스, 유료 등급 없음, "그래프 메모리는 추가 요금" 없음. 포크, 수정, 제품 탑재 모두 자유.

## 설치

### npm (TypeScript / Node.js)

```bash
npm install @mem-os/sdk
```

### Python (소스에서)

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
pip install -e .
pip install -e ".[all]"   # 선택: LangChain + Ollama 어댑터
```

### Docker

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
docker compose up -d
curl http://localhost:7400/health
```

## 빠른 시작

```typescript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// 기억 저장
await memos.store("사용자는 다크 모드를 선호함", { type: "preference" });

// 나중에 회상 — 완전히 새로운 프로세스에서도
const results = await memos.search("다크 모드");
```

Python (HTTP 서버):

```bash
memos-server   # → http://localhost:7400
```

```python
import requests
requests.post("http://localhost:7400/api/mem/store",
              json={"content": "사용자는 다크 모드를 선호함", "type": "preference"})
```

## 벤치마크

| 벤치마크 | MemOS | Mem0 |
|----------|-------|------|
| BEAM-1M (recall @10) | **95.9%** | 64.1% |
| BEAM-1M · 시간 추론 | **97.1%** | 16.3% |
| LoCoMo | 92.5 | 92.5 |
| LongMemEval | 94.4 | 94.4 |

백만 토큰 규모의 장기 대화 기록(BEAM-1M)에서 MemOS는 Mem0보다 31.8포인트 높은 리콜을 달성합니다 — 전적으로 사용자의 머신에서 실행되면서. 짧은 벤치마크에서는 동등: 로컬화해도 품질 손실은 없습니다.

## 무료이고, 진짜 오픈 소스

MemOS는 MIT 라이선스로 완전 무료입니다 — 사용, 수정, 셀프 호스팅, 제품 탑재 모두 가능. 호스팅 플랫폼도, 사용량 과금도, 유료 기능 숨기기도 없습니다. 대조적으로 Mem0 플랫폼은 월 $19부터 시작하며 그래프 메모리는 월 $249 Pro 플랜에서만 제공됩니다 — MemOS에는 기본으로 포함된 기능입니다.

## AI Trio

MemOS는 함께 구성할 수 있는 세 개의 자매 프로젝트 중 하나입니다:

| 프로젝트 | 역할 |
|----------|------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | MCP 프로토콜, 서버 레지스트리, 도구 라우팅 |
| [memos](https://github.com/Markgatcha/memos) | 세션을 아우르는 그래프 기반 영구 메모리 |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | 프롬프트를 압축하고 메모리를 주입하는 토큰 비용 가디언 |

## 링크

- 웹사이트: https://context-core.dev/memos/
- 문서: https://memos.readthedocs.io
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ 스타 히스토리

MemOS가 여러분의 문제를 해결했다면, 스타를 부탁드립니다 — 생각보다 큰 도움이 됩니다.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/memos&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/memos&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## 라이선스

[MIT](../LICENSE) — 출처 표기 없이 어떤 용도로든 자유롭게 사용할 수 있습니다.
