<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.svg" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>通用、本地优先的 AI 智能体持久记忆层。</strong><br>
  让任何 LLM 拥有重启后依然存在的记忆 —— 无需云端、无需 API 密钥、无供应商锁定。
</p>

<p align="center">
  <a href="../README.md">English</a> · <b>简体中文</b> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mem-os/sdk"><img src="https://img.shields.io/npm/v/@mem-os/sdk?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
  <a href="https://github.com/Markgatcha/memos/stargazers"><img src="https://img.shields.io/github/stars/Markgatcha/memos?style=flat-square" alt="Stars"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/demo-animated.svg" alt="MemOS 演示：存储记忆、终止进程、重新召回 —— 全部本地" width="720" />
</p>

<p align="center">
  <a href="https://context-core.dev/memos/"><strong>网站</strong></a> ·
  <a href="https://memos.readthedocs.io"><strong>文档</strong></a> ·
  <a href="https://discord.gg/DyQGgPuueu"><strong>Discord</strong></a> ·
  <a href="https://x.com/Context_Core"><strong>Twitter/X</strong></a>
</p>

---

## 为什么选择 MemOS？

每个 LLM 在对话结束的那一刻就会忘记一切。MemOS 改变了这一点：

- **真正本地化** —— 记忆存储在一个 SQLite 文件中（`~/.memos/memos.db`），你可以打开、复制、备份或删除它。没有任何数据上传。
- **图结构，而非列表** —— 新记忆会自动与相关记忆建立链接，搜索"主题"可以找到你的"深色模式"偏好。
- **理解时间** —— 记忆带有有效期（`validFrom`/`validTo`），过时的信息会优雅地失效。
- **节省 token** —— 紧凑的 TOON 格式比 JSON 减少约 77.6% 的上下文 token。
- **完全免费** —— MIT 许可证，无付费层级，无"图记忆需额外付费"。可以分叉、修改、商用。

## 安装

### npm（TypeScript / Node.js）

```bash
npm install @mem-os/sdk
```

### Python（从源码安装）

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
pip install -e .
pip install -e ".[all]"   # 可选：LangChain + Ollama 适配器
```

### Docker

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
docker compose up -d
curl http://localhost:7400/health
```

## 快速开始

```typescript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// 存储记忆
await memos.store("用户偏好深色模式", { type: "preference" });

// 之后召回 —— 即使在全新的进程中
const results = await memos.search("深色模式");
```

Python（HTTP 服务器）：

```bash
memos-server   # → http://localhost:7400
```

```python
import requests
requests.post("http://localhost:7400/api/mem/store",
              json={"content": "用户偏好深色模式", "type": "preference"})
```

## 基准测试

| 基准 | MemOS | Mem0 |
|------|-------|------|
| BEAM-1M（recall @10） | **95.9%** | 64.1% |
| BEAM-1M · 时间推理 | **97.1%** | 16.3% |
| LoCoMo | 92.5 | 92.5 |
| LongMemEval | 94.4 | 94.4 |

在百万 token 级的长期对话历史（BEAM-1M）上，MemOS 的召回率比 Mem0 高 31.8 个百分点 —— 而且完全运行在你自己的机器上。在较短的基准测试上两者持平：本地化不会带来质量损失。

## 免费且真正开源

MemOS 采用 MIT 许可，完全免费 —— 使用、修改、自托管、商用均可。没有托管平台、没有用量计费、没有付费墙。相比之下，Mem0 的平台起价 $19/月，图记忆功能需要 $249/月的 Pro 套餐 —— 而这是 MemOS 默认包含的功能。

## AI 三件套

MemOS 是三个可组合的姊妹项目之一：

| 项目 | 角色 |
|------|------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | MCP 协议、服务器注册表与工具路由 |
| [memos](https://github.com/Markgatcha/memos) | 跨会话的图结构持久记忆 |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | 压缩提示词、注入记忆切片的 token 成本守卫 |

## 链接

- 网站：https://context-core.dev/memos/
- 文档：https://memos.readthedocs.io
- Discord：https://discord.gg/DyQGgPuueu
- Twitter/X：https://x.com/Context_Core

## ⭐ Star 趋势

如果 MemOS 解决了你的问题，请点一颗星 —— 这比你想的更有帮助。

<p align="center">
  <a href="https://star-history.com/#Markgatcha/memos&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/memos&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## 许可证

[MIT](../LICENSE) —— 可自由用于任何用途，无需署名。
