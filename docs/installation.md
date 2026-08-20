# Installation

Let's get MemOS running on your machine. Pick your path below — every one of them ends with the same thing: a memory layer that works entirely offline.

!!! info "What you'll need"
    - **TypeScript path:** Node.js 18+ and npm
    - **Python path:** Python 3.10+ and pip
    - **Docker path:** Docker and Docker Compose
    - About 5 minutes and zero API keys

## Option 1 — npm (TypeScript / Node.js)

The fastest way in if you live in JavaScript.

**Step 1. Install the SDK**

```bash
npm install @mem-os/sdk
```

**Step 2. Create your first memory**

Drop this into a file called `memory.mjs`:

```javascript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

await memos.store("MemOS was installed on a Tuesday", { type: "fact" });
const results = await memos.search("when was MemOS installed?");
console.log(results[0].node.content);
```

**Step 3. Run it**

```bash
node memory.mjs
# → MemOS was installed on a Tuesday
```

**Step 4. Believe it**

Run it again. And again. The memory is still there every time — it's in `~/.memos/memos.db`, a plain SQLite file you own.

## Option 2 — Python (from source)

The Python package is installed from source right now, which has a nice side effect: you always get exactly what's on `main`.

**Step 1. Clone the repo**

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
```

**Step 2. Install in editable mode**

```bash
pip install -e .
```

Want the framework adapters too? Grab them in one go:

```bash
pip install -e ".[langchain]"   # LangChain adapter
pip install -e ".[ollama]"      # Ollama adapter
pip install -e ".[all]"         # both of the above
```

**Step 3. Start the memory server**

```bash
memos-server
# → Listening on http://localhost:7400
```

**Step 4. Store and recall**

From another terminal:

```bash
curl -X POST http://localhost:7400/api/mem/store \
  -H "Content-Type: application/json" \
  -d '{"content": "User prefers dark mode", "type": "preference"}'

curl -X POST http://localhost:7400/api/mem/search \
  -H "Content-Type: application/json" \
  -d '{"query": "dark mode", "limit": 5}'
```

Or from Python:

```python
import requests

BASE = "http://localhost:7400/api/mem"
requests.post(f"{BASE}/store", json={"content": "User prefers dark mode", "type": "preference"})
print(requests.post(f"{BASE}/search", json={"query": "dark mode", "limit": 5}).json())
```

**Step 5. Check the health endpoint**

```bash
curl http://localhost:7400/health
```

If you get JSON back, you're running.

## Option 3 — Docker

For when you'd rather not install anything at all.

**Step 1. Clone and start**

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos
docker compose up -d
```

**Step 2. Verify**

```bash
curl http://localhost:7400/health
```

**Step 3. Explore**

The interactive API docs are at [http://localhost:7400/docs](http://localhost:7400/docs) — a nice way to poke at every endpoint without writing code.

To stop: `docker compose down`. Your memories survive in the mounted volume.

## Verifying your install

Whichever path you took, this is the moment of truth:

1. Store a memory.
2. **Restart the process** (or the container).
3. Search for it.

If step 3 finds it, MemOS is working. That's the whole promise — memory that survives restarts.

## Troubleshooting

**`memos-server: command not found`**
The pip install didn't put scripts on your PATH. Try `python -m server.main` from the repo root, or reinstall with `pip install -e .` inside a virtualenv.

**Port 7400 already in use**
Something else is on that port. Set a different one via the `MEMOS_PORT` environment variable: `MEMOS_PORT=7500 memos-server`.

**Search returns nothing right after storing**
Embeddings are generated locally on first store — give it a beat, and check that the store call returned a node ID. If you're using the embedding-backed search, the local model downloads once on first use.

**Windows path issues**
MemOS works fine on Windows, but if your database ends up somewhere unexpected, point `MEMOS_DB_PATH` at a file you control: `MEMOS_DB_PATH=C:\data\memos.db memos-server`. By default it lives at `~/.memos/memos.db`.

## Where to next?

- [API Reference](api-reference.md) — every method, documented
- [Adapters](adapters.md) — hook MemOS into Ollama, LangChain, or CrewAI
- [Back to home](index.md)
