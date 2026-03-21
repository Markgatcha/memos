# Adapters

Adapters bridge MemOS with AI frameworks. They handle memory retrieval (injecting context before a model call) and memory storage (extracting facts from conversations).

## Available adapters

| Adapter | File | Framework | Language |
|---------|------|-----------|----------|
| Ollama | `adapters/ollama.py` | Ollama | Python |
| LangChain | `adapters/langchain.py` | LangChain | Python |

## Ollama adapter

Automatic memory for Ollama chat completions. Memories are injected into the system prompt and user messages are optionally stored as new memories.

### Installation

```bash
pip install memos
# Make sure Ollama and MemOS server are running
```

### Usage

```python
from adapters.ollama import OllamaMemory

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
from adapters.ollama import OllamaMemory, OllamaConfig

config = OllamaConfig(
    base_url="http://localhost:11434",   # Ollama server
    model="llama3",                       # Model name
    memos_url="http://localhost:7400",    # MemOS server
    max_context_memories=5,               # Max memories in system prompt
    auto_store=True,                      # Auto-store user messages
    store_threshold=20,                   # Min message length to store
)

chat = OllamaMemory(config=config)
```

## LangChain adapter

Drop-in `BaseMemory` implementation for LangChain chains and agents.

### Installation

```bash
pip install memos langchain langchain-openai
```

### Usage

```python
from langchain_openai import ChatOpenAI
from langchain.chains import ConversationChain
from adapters.langchain import MemOSMemory

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
    return_messages=True,    # Return BaseMessage objects or strings
)
```

## Building a custom adapter

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full adapter template and checklist.

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
        resp = requests.post(f"{self.memos_url}/api/mem/search", json={
            "query": query, "limit": limit
        })
        return resp.json()

    def store_memory(self, content: str, **kwargs) -> dict:
        """Store a new memory."""
        import requests
        resp = requests.post(f"{self.memos_url}/api/mem/store", json={
            "content": content, **kwargs
        })
        return resp.json()
```
