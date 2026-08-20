<div dir="rtl">

<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.svg" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>طبقة ذاكرة دائمة، عالمية، ومحلية أولاً لوكلاء الذكاء الاصطناعي.</strong><br>
  امنح أي نموذج لغوي ذاكرة تنجو من إعادة التشغيل — بلا سحابة، بلا مفاتيح API، بلا احتكار من المورّد.
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <b>العربية</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mem-os/sdk"><img src="https://img.shields.io/npm/v/@mem-os/sdk?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
  <a href="https://github.com/Markgatcha/memos/stargazers"><img src="https://img.shields.io/github/stars/Markgatcha/memos?style=flat-square" alt="Stars"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/demo-animated.svg" alt="عرض MemOS: خزّن ذكرى، أوقف العملية، استرجعها — كل شيء محلي" width="720" />
</p>

<p align="center">
  <a href="https://context-core.dev/memos/"><strong>الموقع</strong></a> ·
  <a href="https://memos.readthedocs.io"><strong>التوثيق</strong></a> ·
  <a href="https://discord.gg/DyQGgPuueu"><strong>Discord</strong></a> ·
  <a href="https://x.com/Context_Core"><strong>Twitter/X</strong></a>
</p>

---

## لماذا MemOS؟

كل نموذج لغوي ينسى كل شيء لحظة انتهاء المحادثة. MemOS يغيّر ذلك:

- **محلي حقاً** — ذكرياتك تعيش في ملف SQLite واحد (`~/.memos/memos.db`) يمكنك فتحه ونسخه ونسخه احتياطياً وحذفه. لا شيء يغادر جهازك.
- **رسم بياني، لا قائمة** — الذكريات الجديدة ترتبط تلقائياً بالذكريات ذات الصلة؛ البحث عن «السمة» قد يجد تفضيلك لـ«الوضع الداكن».
- **يفهم الزمن** — الذكريات تحمل نوافذ صلاحية (`validFrom`/`validTo`)، فتنتهي المعلومات القديمة بأناقة.
- **يوفّر الرموز** — صيغة TOON المدمجة تقلّل رموز السياق بنحو 77.6% مقارنة بـ JSON.
- **مجاني فعلاً** — ترخيص MIT، بلا باقة مدفوعة، بلا «ذاكرة الرسم البياني مقابل رسوم إضافية». افرك المشروع وعدّله وأطلقه.

## التثبيت

### npm ‏(TypeScript / Node.js)

```bash
npm install @mem-os/sdk
```

### Python (PyPI)

اسم الحزمة على PyPI هو **`mem-os-sdk`** (مطابق لـ `@mem-os/sdk` على npm). وهي تغلّف SDK الخاص بـ TypeScript، لذا ستحتاج أيضا إلى Node.js 18+.

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

## البدء السريع

```typescript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// خزّن ذكرى
await memos.store("المستخدم يفضّل الوضع الداكن", { type: "preference" });

// استرجعها لاحقاً — حتى من عملية جديدة تماماً
const results = await memos.search("الوضع الداكن");
```

Python (خادم HTTP):

```bash
memos-server   # → http://localhost:7400
```

```python
import requests
requests.post("http://localhost:7400/api/mem/store",
              json={"content": "المستخدم يفضّل الوضع الداكن", "type": "preference"})
```

## معايير الأداء

| المعيار | MemOS | Mem0 |
|---------|-------|------|
| BEAM-1M ‏(recall @10) | **95.9%** | 64.1% |
| BEAM-1M · الاستدلال الزمني | **97.1%** | 16.3% |
| LoCoMo | 92.5 | 92.5 |
| LongMemEval | 94.4 | 94.4 |

على سجلات محادثات بمليون رمز (BEAM-1M)، يسترجع MemOS أكثر من Mem0 بـ 31.8 نقطة — وهو يعمل بالكامل على جهازك. في المعايير الأقصر، تعادل: المحلية لا تكلّف جودة.

## مجاني ومفتوح المصدر فعلاً

MemOS مرخّص بـ MIT ومجاني بالكامل — للاستخدام والتعديل والاستضافة الذاتية والشحن في منتجك. لا منصة مستضافة، ولا قياس استخدام، ولا ميزات مدفوعة مخفية. منصة Mem0 تبدأ من 19$ شهرياً وتتقاضى 249$ شهرياً مقابل ذاكرة الرسم البياني — وهي ميزة يتضمنها MemOS افتراضياً.

## ثلاثي الذكاء الاصطناعي (AI Trio)

MemOS واحد من ثلاثة مشاريع شقيقة تتكامل معاً:

| المشروع | الدور |
|---------|-------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | بروتوكول MCP وسجل الخوادم وتوجيه الأدوات |
| [memos](https://github.com/Markgatcha/memos) | ذاكرة دائمة قائمة على الرسم البياني عبر الجلسات |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | حارس تكلفة الرموز: يضغط الموجّهات ويحقن الذاكرة |

## الروابط

- الموقع: https://context-core.dev/memos/
- التوثيق: https://memos.readthedocs.io
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ سجل النجوم

إذا حلّ MemOS مشكلة لديك، فالنجمة تساعد أكثر مما تظن.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/memos&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/memos&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## الترخيص

[MIT](../LICENSE) — استخدمه في أي مكان ولأي غرض، دون الحاجة إلى نسب.

</div>
