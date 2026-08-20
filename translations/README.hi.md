<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.svg" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>हर AI एजेंट के लिए सार्वभौमिक, लोकल-फर्स्ट, स्थायी मेमोरी लेयर।</strong><br>
  किसी भी LLM को ऐसी याददाश्त दें जो रीस्टार्ट के बाद भी बनी रहे — न क्लाउड, न API कुंजी, न वेंडर लॉक-इन।
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <b>हिन्दी</b> · <a href="README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mem-os/sdk"><img src="https://img.shields.io/npm/v/@mem-os/sdk?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
  <a href="https://github.com/Markgatcha/memos/stargazers"><img src="https://img.shields.io/github/stars/Markgatcha/memos?style=flat-square" alt="Stars"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/demo-animated.svg" alt="MemOS डेमो: मेमोरी सेव करें, प्रोसेस बंद करें, वापस याद करें — सब कुछ लोकल" width="720" />
</p>

<p align="center">
  <a href="https://context-core.dev/memos/"><strong>वेबसाइट</strong></a> ·
  <a href="https://memos.readthedocs.io"><strong>डॉक्स</strong></a> ·
  <a href="https://discord.gg/DyQGgPuueu"><strong>Discord</strong></a> ·
  <a href="https://x.com/Context_Core"><strong>Twitter/X</strong></a>
</p>

---

## MemOS क्यों?

हर LLM बातचीत खत्म होते ही सब कुछ भूल जाता है। MemOS इसे बदलता है:

- **सचमुच लोकल** — आपकी यादें एक ही SQLite फ़ाइल (`~/.memos/memos.db`) में रहती हैं, जिसे आप खोल, कॉपी, बैकअप या डिलीट कर सकते हैं। कुछ भी आपके मशीन से बाहर नहीं जाता।
- **लिस्ट नहीं, ग्राफ़** — नई यादें संबंधित यादों से अपने आप जुड़ जाती हैं; "थीम" खोजने पर आपकी "डार्क मोड" पसंद मिल सकती है।
- **समय को समझता है** — यादों में वैधता अवधि (`validFrom`/`validTo`) होती है, इसलिए पुरानी जानकारी सुचारू रूप से समाप्त हो जाती है।
- **टोकन बचाता है** — कॉम्पैक्ट TOON फ़ॉर्मैट JSON की तुलना में ~77.6% कम कॉन्टेक्स्ट टोकन लेता है।
- **पूरी तरह मुफ़्त** — MIT लाइसेंस, कोई पेड टियर नहीं, "ग्राफ़ मेमोरी के लिए अतिरिक्त शुल्क" नहीं। फ़ोर्क करें, बदलें, शिप करें।

## इंस्टॉलेशन

### npm (TypeScript / Node.js)

```bash
npm install @mem-os/sdk
```

### Python (सोर्स से)

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
pip install -e .
pip install -e ".[all]"   # वैकल्पिक: LangChain + Ollama एडाप्टर
```

### Docker

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
docker compose up -d
curl http://localhost:7400/health
```

## क्विक स्टार्ट

```typescript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// एक याद सेव करें
await memos.store("उपयोगकर्ता डार्क मोड पसंद करता है", { type: "preference" });

// बाद में याद करें — बिल्कुल नए प्रोसेस से भी
const results = await memos.search("डार्क मोड");
```

Python (HTTP सर्वर):

```bash
memos-server   # → http://localhost:7400
```

```python
import requests
requests.post("http://localhost:7400/api/mem/store",
              json={"content": "उपयोगकर्ता डार्क मोड पसंद करता है", "type": "preference"})
```

## बेंचमार्क

| बेंचमार्क | MemOS | Mem0 |
|-----------|-------|------|
| BEAM-1M (recall @10) | **95.9%** | 64.1% |
| BEAM-1M · कालानुक्रमिक तर्क | **97.1%** | 16.3% |
| LoCoMo | 92.5 | 92.5 |
| LongMemEval | 94.4 | 94.4 |

दस लाख टोकन की लंबी बातचीत (BEAM-1M) पर MemOS, Mem0 से 31.8 अंक अधिक रिकॉल करता है — और वह भी पूरी तरह आपके मशीन पर चलते हुए। छोटे बेंचमार्क पर दोनों बराबर हैं: लोकल होने से गुणवत्ता की कोई कीमत नहीं चुकानी पड़ती।

## मुफ़्त और सचमुच ओपन सोर्स

MemOS MIT लाइसेंस के तहत पूरी तरह मुफ़्त है — इस्तेमाल करें, बदलें, सेल्फ-होस्ट करें, अपने प्रोडक्ट में शिप करें। न कोई होस्टेड प्लेटफ़ॉर्म, न उपयोग की गिनती, न छिपे हुए पेड फ़ीचर। Mem0 का प्लेटफ़ॉर्म $19/माह से शुरू होता है और ग्राफ़ मेमोरी के लिए $249/माह लेता है — जो फ़ीचर MemOS में डिफ़ॉल्ट रूप से शामिल है।

## AI Trio

MemOS तीन सहयोगी प्रोजेक्ट्स में से एक है जो साथ में काम करते हैं:

| प्रोजेक्ट | भूमिका |
|-----------|--------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | MCP प्रोटोकॉल, सर्वर रजिस्ट्री और टूल राउटिंग |
| [memos](https://github.com/Markgatcha/memos) | सेशनों के बीच ग्राफ़-आधारित स्थायी मेमोरी |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | टोकन-लागत रक्षक: प्रॉम्प्ट सिकोड़ता है और मेमोरी जोड़ता है |

## लिंक

- वेबसाइट: https://context-core.dev/memos/
- डॉक्स: https://memos.readthedocs.io
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ स्टार इतिहास

अगर MemOS आपकी कोई समस्या हल करता है, तो एक स्टार दें — यह आपकी सोच से ज़्यादा मदद करता है।

<p align="center">
  <a href="https://star-history.com/#Markgatcha/memos&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/memos&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## लाइसेंस

[MIT](../LICENSE) — बिना किसी श्रेय के, किसी भी उद्देश्य के लिए स्वतंत्र रूप से उपयोग करें।
