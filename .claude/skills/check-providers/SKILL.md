---
name: check-providers
description: Use when verifying which extraction tiers are wired and responding for the current env/keys — catches "cloud key not set" and tier-selection bugs fast.
---

# Check Providers

1. Report the selection state: which of VISION_PROVIDER / AWS_BEARER_TOKEN_BEDROCK are set (never
   print key values — presence only). Bedrock is the only cloud adapter; the Gemini/Claude-direct/
   OpenAI/Groq adapters were removed 2026-07-25 — their keys do nothing if set, say so if you see
   one in the env.
2. Mock: `pnpm eval --provider mock` (fast; must be 100%).
3. Local OCR: `pnpm spike:ocr` — confirm it extracts and note cold/warm latency vs the < 5 s budget.
4. Each configured cloud tier: run `pnpm eval --provider <name>` on ONE file if quota is a concern
   (edit nothing; just report). An auth error means the key is invalid — say so plainly.
5. Report a tier → status table: working / keyless-skip / error (with the friendly error, no secrets).
