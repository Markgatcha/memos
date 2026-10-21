#!/usr/bin/env python3
"""Generate ContextCore visual assets via the local ComfyUI server.

Submits Qwen Image 2.1 Turbo txt2img jobs (8-step turbo schedule, ~52s each),
downloads the PNGs into website/public/ai/, and writes a manifest JSON that
records every prompt/seed so the batch can be reproduced.

Usage:
  python scripts/gen-assets.py            # generate any image not already in the manifest
  python scripts/gen-assets.py --force    # regenerate everything
  python scripts/gen-assets.py --list     # print the prompt table
"""

import argparse
import base64
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

SERVER = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "ai")
MANIFEST = os.path.join(OUT_DIR, "manifest.json")

# Shared style tail for the abstract architectural set. Kept identical across
# prompts so the set reads as one family: same palette, same line language.
STYLE_TAIL = (
    "abstract architectural concept art, flat layered cutout slabs of dark stone "
    "and glass, deep charcoal and obsidian palette with faint warm amber "
    "backlight glowing along the lower edges, clean geometric composition, "
    "soft volumetric depth, subtle film grain, minimalist, no text, no letters, "
    "no watermark, no people, no faces"
)

NEGATIVE = (
    "text, letters, words, watermark, signature, logo, blurry, low quality, "
    "jpeg artifacts, oversaturated, neon rainbow, bright daylight, cartoon, "
    "people, faces, hands, cluttered, busy, photo-realistic product shot"
)

# Each asset: prompt + aspect. Width/height chosen to match the slot it fills.
ASSETS = [
    {
        "id": "hero-layers",
        "file": "hero-layers.png",
        "prompt": (
            "Wide panoramic abstract composition: strata of translucent horizontal "
            "plates stacked with slight offsets, like the cross-section of a memory "
            "core, thin amber threads of light running between the layers"
        ),
        "width": 1536,
        "height": 640,
    },
    {
        "id": "hero-backdrop",
        "file": "hero-backdrop.png",
        "prompt": (
            "Ultra-wide minimal abstract backdrop: dark room with a single soft "
            "amber light source behind layered vertical stone slabs, deep shadows, "
            "lots of empty negative space at the top, atmospheric haze"
        ),
        "width": 2048,
        "height": 1024,
    },
    {
        "id": "stack-diagram",
        "file": "stack-diagram.png",
        "prompt": (
            "Three distinct architectural blocks side by side connected by thin "
            "glowing lines, each block a different height, like a diagram of a "
            "three-layer system rendered as abstract brutalist architecture, "
            "dramatic side lighting"
        ),
        "width": 1536,
        "height": 768,
    },
    {
        "id": "principle-veil",
        "file": "principle-veil.png",
        "prompt": (
            "Close-up abstract detail: edges of dark folded plates catching a thin "
            "amber rim light, geometric shadow play, shallow depth of field, "
            "quiet and contemplative mood, heavy vignette"
        ),
        "width": 1024,
        "height": 1024,
    },
    {
        "id": "cta-arch",
        "file": "cta-arch.png",
        "prompt": (
            "A solitary monolithic archway of dark stone with warm amber light "
            "pouring through the opening, symmetrical, vast dark space around it, "
            "cinematic and monumental, minimal, empty plaza in the foreground"
        ),
        "width": 1536,
        "height": 768,
    },
    {
        "id": "footer-strata",
        "file": "footer-strata.png",
        "prompt": (
            "Horizontal band of dark geological strata with hairline amber seams, "
            "very dark overall, mostly shadow, quiet texture for a footer band"
        ),
        "width": 2048,
        "height": 384,
    },
]


def http_json(method, url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def build_workflow(asset, seed):
    """API-format graph for Qwen Image 2.1 Turbo via GGUF.

    Wiring follows the model's reference template (the ComfyUI templates
    "Text to Image (Qwen Image 2.1)" subgraph), which differs from a vanilla
    SDXL/Flux graph in two ways that matter:

    - The text encoder node is ``TextEncodeQwenImage21``, NOT ``CLIPTextEncode``.
      This node emits *both* outputs (positive, negative) from one encode and
      takes a ``resolution`` for reference-image resizing. Using CLIPTextEncode
      produces prompt-independent noise — the conditioning never reaches the
      sampler — which looks like "success" on the server.
    - No ``ModelSamplingSD3`` shift node. The GGUF UNet goes straight into the
      sampler, euler/simple, 25 steps, cfg 1.
    """
    return {
        "453": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
                "type": "qwen_image",
            },
        },
        "454": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "qwen_image_2.1_vae_bf16.safetensors"},
        },
        "470": {
            "class_type": "UnetLoaderGGUF",
            "inputs": {"unet_name": "qwen-image-2.1-turbo-Q5_0.gguf"},
        },
        "456": {
            "class_type": "EmptyLatentImage",
            "inputs": {
                "width": asset["width"],
                "height": asset["height"],
                "batch_size": 1,
            },
        },
        "452": {
            "class_type": "TextEncodeQwenImage21",
            "inputs": {
                "clip": ["453", 0],
                "prompt": asset["prompt"] + ", " + STYLE_TAIL,
                "negative_prompt": asset.get("negative", NEGATIVE),
                "resolution": 1024,
                "images": [],
                "vae": ["454", 0],
            },
        },
        "458": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["470", 0],
                "seed": seed,
                "steps": 25,
                "cfg": 1,
                "sampler_name": "euler",
                "scheduler": "simple",
                "positive": ["452", 0],
                "negative": ["452", 1],
                "latent_image": ["456", 0],
                "denoise": 1.0,
            },
        },
        "457": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["458", 0], "vae": ["454", 0]},
        },
        "461": {
            "class_type": "SaveImage",
            "inputs": {"images": ["457", 0], "filename_prefix": "cc_" + asset["id"]},
        },
    }


def submit(asset, seed):
    payload = {"prompt": build_workflow(asset, seed), "client_id": "cc-assets"}
    resp = http_json("POST", f"{SERVER}/api/prompt", payload)
    return resp["prompt_id"]


def wait_for_output(prompt_id, timeout=900):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            history = http_json("GET", f"{SERVER}/history/{prompt_id}")
        except urllib.error.URLError:
            time.sleep(3)
            continue
        entry = history.get(prompt_id)
        if entry and entry.get("outputs"):
            return entry["outputs"]
        time.sleep(3)
    raise TimeoutError(f"prompt {prompt_id} did not finish within {timeout}s")


def download(outputs, dest):
    for node_out in outputs.values():
        images = node_out.get("images") or []
        for img in images:
            params = urllib.parse.urlencode(
                {"filename": img["filename"], "subfolder": img.get("subfolder", ""), "type": img.get("type", "output")}
            )
            url = f"{SERVER}/api/view?{params}"
            with urllib.request.urlopen(url, timeout=120) as resp:
                data = resp.read()
            with open(dest, "wb") as fh:
                fh.write(data)
            return len(data)
    return 0


import urllib.parse  # noqa: E402  (used by download())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="regenerate all assets")
    parser.add_argument("--list", action="store_true", help="print the prompt table")
    args = parser.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)

    existing = {}
    if os.path.exists(MANIFEST):
        with open(MANIFEST) as fh:
            existing = {a["id"]: a for a in json.load(fh).get("assets", [])}

    if args.list:
        for a in ASSETS:
            print(f"{a['id']:18s} {a['width']}x{a['height']}  {a['prompt'][:70]}...")
        return

    # Health check first.
    try:
        stats = http_json("GET", f"{SERVER}/system_stats")
    except Exception as exc:
        sys.exit(f"ComfyUI not reachable at {SERVER}: {exc}")
    print(f"ComfyUI {stats['system']['comfyui_version']} — server OK")

    results = []
    for i, asset in enumerate(ASSETS, 1):
        dest = os.path.join(OUT_DIR, asset["file"])
        already = existing.get(asset["id"], {})
        if os.path.exists(dest) and already and not args.force:
            print(f"[{i}/{len(ASSETS)}] {asset['id']} — cached ({os.path.getsize(dest)} bytes), skipping")
            results.append(already)
            continue

        seed = random.randint(1, 2**31 - 1)
        print(f"[{i}/{len(ASSETS)}] {asset['id']} — submitting (seed {seed})")
        t0 = time.time()
        try:
            pid = submit(asset, seed)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode()[:400]
            print(f"    submit failed: {exc.code} {body}")
            continue
        outputs = wait_for_output(pid)
        size = download(outputs, dest)
        elapsed = time.time() - t0
        print(f"    done in {elapsed:.0f}s — {asset['file']} ({size:,} bytes)")
        results.append(
            {
                "id": asset["id"],
                "file": asset["file"],
                "prompt": asset["prompt"],
                "negative": NEGATIVE,
                "seed": seed,
                "width": asset["width"],
                "height": asset["height"],
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "elapsed_s": round(elapsed, 1),
            }
        )

    manifest = {
        "model": "qwen-image-2.1-turbo-Q5_0.gguf",
        "vae": "qwen_image_2.1_vae_bf16.safetensors",
        "clip": "qwen3vl_8b_int8_convrot.safetensors",
        "encoder": "TextEncodeQwenImage21",
        "steps": 25,
        "cfg": 1,
        "scheduler": "euler/simple",
        "style_tail": STYLE_TAIL,
        "assets": results,
    }
    with open(MANIFEST, "w") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"\nmanifest -> {MANIFEST}")
    print(f"{len(results)}/{len(ASSETS)} assets ready")


if __name__ == "__main__":
    main()
