# Model Routing

**Status:** Tier 0 (deterministic code) implemented in Phase 1 — intent resolution, routing, grounding and verification make 0 model calls. Tiers 1–4 (Laya, Qwen, vision, API) are Phase 3/4. The single authoritative model configuration (`resolveActiveModel`) exists from Phase 0.

## Scope

Code → Laya MLX → Qwen 7B (Ollama) → API gateway → handover. No silent model substitution; availability checked before execution.

## References

- Spec §18–21
- Spec §54 Model settings
- Plan §21–22
