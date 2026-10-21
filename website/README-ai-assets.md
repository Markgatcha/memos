# Generated Visual Assets

The abstract architectural imagery on the site (currently the hero backdrop) is
generated locally with Qwen Image 2.1 Turbo on ComfyUI.

## Pipeline

Two scripts, in order:

```bash
# 1. Generate the PNGs (requires ComfyUI running at http://127.0.0.1:8188)
python scripts/gen-assets.py            # skips assets already in the manifest
python scripts/gen-assets.py --force    # regenerate everything
python scripts/gen-assets.py --list     # print the prompt table

# 2. Downscale + recompress the 2K sources to web widths
node scripts/optimize-ai-assets.js
```

`gen-assets.py` submits one job per asset (25 steps, euler/simple, cfg 1) and
writes `public/ai/manifest.json` recording every prompt, seed, and the graph
parameters, so any image can be reproduced exactly.

## Graph wiring (Qwen Image 2.1 Turbo GGUF)

The correct wiring differs from a vanilla SDXL/Flux graph in two ways that both
fail silently if you get them wrong:

- The text encoder node is **`TextEncodeQwenImage21`**, not `CLIPTextEncode`.
  This node emits both outputs (positive, negative) from one encode and takes a
  `resolution` input for reference-image resizing. Using `CLIPTextEncode`
  produces prompt-independent noise — the conditioning never reaches the sampler
  — and the server still reports success.
- **No `ModelSamplingSD3` shift node.** The GGUF UNet goes straight into the
  sampler, euler/simple, 25 steps, cfg 1.

Models required (all present in this ComfyUI install):

- `qwen-image-2.1-turbo-Q5_0.gguf` (diffusion_models)
- `qwen3vl_8b_int8_convrot.safetensors` (text_encoders, type `qwen_image`)
- `qwen_image_2.1_vae_bf16.safetensors` (vae)

## Assets

| id | file | use |
|----|------|-----|
| hero-backdrop | hero-backdrop.png | fixed page background, 28% opacity, masked to the top |
| hero-layers | hero-layers.png | reserved — layered strata close-up |
| stack-diagram | stack-diagram.png | reserved — three towers connected by light beams |
| principle-veil | principle-veil.png | reserved — dark folded plates, amber rim light |
| cta-arch | cta-arch.png | reserved — monolith archway with amber glow |
| footer-strata | footer-strata.png | reserved — dark geological band |

Assets marked "reserved" are generated and optimized but not yet placed in the
layout. They are safe to reference when a section needs imagery.

## Design intent

The set shares one style tail (flat layered cutouts, charcoal/obsidian palette,
faint amber backlight, no text, no people) so every image reads as one family.
The palette is deliberately narrow — deep charcoal with a single warm accent —
which matches the site's existing dark theme and keeps text contrast high.
