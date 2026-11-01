# Adapters

Adapters bridge MemOS with AI frameworks. They handle memory retrieval (injecting context before a model call) and memory storage (extracting facts from conversations).

## Available adapters

| Adapter | Import | Framework | Language |
|---------|--------|-----------|----------|
| OpenAI | `@mem-os/sdk/openai` | OpenAI Chat Completions | TypeScript |
| Anthropic | `@mem-os/sdk/anthropic` | Anthropic Messages | TypeScript |
| Vercel AI SDK | `@mem-os/sdk/vercel` | Vercel AI SDK v5+ (`ai`) | TypeScript |
| Ollama | `adapters/ollama.py` | Ollama | Python |
| LangChain | `adapters/langchain.py` | LangChain | Python |
| CrewAI | `adapters/crewai.py` | CrewAI | Python |

The TypeScript adapters have **no hard dependency** on their framework —
they emit structurally compatible tool/message shapes, so you only install
the framework you actually call. The Python adapters talk to a running
MemOS HTTP server rather than the Node SDK.

## Ollama adapter

Automatic memory for Ollama chat completions. Memories are injected into the system prompt and user messages are optionally stored as new memories.

### Installation

```bash
# From the repo root (the Python package installs from source)
pip install -e ".[ollama]"
# Make sure Ollama and MemOS server are running
```

### Usage

```python
from memos.adapters.ollama import OllamaMemory

# Create adapter
chat = OllamaMemory(model="llama3")
await chat.init()

# Chat — memories are automatically injected and extracted
response = await chat.chat("I prefer dark mode in all my apps")
# → MemOS stores "I prefer dark mode in all my apps" as a memory

response = await chat.chat("What theme do I like?")
# → MemOS retrieves the dark mode memory and injects it into context
# → Model responds: "You prefer dark mode."

# Manual memory operations
chat.remember("User's name is Alice", type="fact")
results = chat.recall("user name")
chat.forget(some_memory_id)

# Stream responses
async for token in chat.chat_stream("Tell me a story"):
    print(token, end="")
```

### Configuration

```python
from memos.adapters.ollama import OllamaMemory, OllamaConfig

config = OllamaConfig(
    base_url="http://localhost:11434",  # Ollama server
    model="llama3",  # Model name
    memos_url="http://localhost:7400",  # MemOS server
    max_context_memories=5,  # Max memories in system prompt
    auto_store=True,  # Auto-store user messages
    store_threshold=20,  # Min message length to store
)

chat = OllamaMemory(config=config)
```

## LangChain adapter

Drop-in `BaseMemory` implementation for LangChain chains and agents.

### Installation

```bash
# From the repo root
pip install -e ".[langchain]"
```

### Usage

```python
from langchain_openai import ChatOpenAI
from langchain.chains import ConversationChain
from memos.adapters.langchain import MemOSMemory

# Create memory
memory = MemOSMemory()

# Use with any LangChain chain
chain = ConversationChain(llm=ChatOpenAI(), memory=memory)

result = chain.invoke({"input": "I prefer dark mode"})
result = chain.invoke({"input": "What theme do I like?"})
# → Chain recalls "dark mode" from MemOS

# Manual operations
memory.remember("User's name is Alice", type="fact")
results = memory.recall("user name")
memory.forget(some_memory_id)
```

### Configuration

```python
memory = MemOSMemory(
    memos_url="http://localhost:7400",
    max_context_memories=5,
    auto_extract_facts=True,
    min_message_length=15,
    return_messages=True,  # Return BaseMessage objects or strings
)
```

## Vercel AI SDK adapter

Memory tools and context injection for the [Vercel AI SDK](https://ai-sdk.dev)
(`ai` package, v5+). Exposes MemOS as AI SDK tools plus a system-prompt
context builder.

### Installation

```bash
npm install @mem-os/sdk ai
```

### Usage

```ts
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { createVercelMemory } from "@mem-os/sdk/vercel";

const { plugin } = await createVercelMemory({ dbPath: "./my-app.db" });

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools: plugin.tools,
  prompt: "What theme do I prefer?",
});
```

`plugin.tools` exposes three tools, already in AI SDK 5 shape
(`description` / `inputSchema` / `execute` — v4's `parameters` is gone):

| Tool | What it does |
|------|--------------|
| `search_memories` | Recall relevant facts and preferences before answering |
| `store_memory` | Persist a durable fact the model decided to keep |
| `forget_memory` | Delete a memory by id |

Schemas are real Zod schemas (`zod` is already a MemOS dependency), so the
SDK validates model-generated arguments before `execute` runs — a malformed
tool call is rejected rather than reaching your memory store.

### Injecting context instead of tools

Some prompts are better served by context than by tool calls. Build a
system-prompt block with `getMemoryContext`, which optionally extracts and
stores facts from the conversation first:

```ts
const context = await plugin.getMemoryContext(messages);
const { text } = await generateText({
  model: openai("gpt-4o"),
  system: context ? `${context}\n\nYou are a helpful assistant.` : undefined,
  messages,
});
```

It returns `""` when nothing relevant was found, so it is safe to
concatenate unconditionally.

### Configuration

```ts
const { plugin } = await createVercelMemory({
  dbPath: "./my-app.db",
  plugin: {
    maxContextMemories: 5,   // memories injected / returned per search
    autoExtractFacts: true,  // extract facts from conversations automatically
    minConfidence: 0.6,      // minimum confidence for an extracted fact
    minMessageLength: 15,    // ignore very short messages when extracting
    namespace: "default",    // namespace to store/search in
  },
});
```

## Building a custom adapter

See [CONTRIBUTING.md](https://github.com/Markgatcha/memos/blob/main/CONTRIBUTING.md) for the full adapter template and checklist.

The core pattern is:

1. **Before model call**: Search MemOS for relevant memories → inject into system prompt
2. **After model call**: Optionally store user input as a new memory
3. **Error handling**: If MemOS is unreachable, degrade gracefully (no memory, not an error)

```python
class MyAdapter:
    def __init__(self, memos_url="http://localhost:7400"):
        self.memos_url = memos_url

    def get_memories(self, query: str, limit: int = 5) -> list[dict]:
        """Retrieve relevant memories for injection."""
        import requests

        resp = requests.post(
            f"{self.memos_url}/api/mem/search", json={"query": query, "limit": limit}
        )
        return resp.json()

    def store_memory(self, content: str, **kwargs) -> dict:
        """Store a new memory."""
        import requests

        resp = requests.post(f"{self.memos_url}/api/mem/store", json={"content": content, **kwargs})
        return resp.json()
```
