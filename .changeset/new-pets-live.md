---
'@mastra/otel-exporter': patch
'@mastra/arize': patch
'@mastra/arthur': patch
---

Renamed the cache-token OTel attributes emitted by `@mastra/otel-exporter` to match the OpenTelemetry GenAI semantic conventions registry:

- `gen_ai.usage.cached_input_tokens` → `gen_ai.usage.cache_read.input_tokens`
- `gen_ai.usage.cache_write_tokens` → `gen_ai.usage.cache_creation.input_tokens`

`gen_ai.usage.input_tokens` is unchanged — still the total prompt-token count, with the cache attributes as subsets per spec. `@mastra/arize` and `@mastra/arthur` now read the spec names first and fall back to the legacy ones, so cache metrics keep flowing through the OpenInference translation during mixed-version rollouts.

**Action required**: if you have dashboards, alerts, or queries keyed off the old attribute names, update them to the spec names. Spec-compliant backends (current Langfuse Cloud, Phoenix, generic OTLP collectors) recognize only the new names.

Bump level pending maintainer review — see [#15962](https://github.com/mastra-ai/mastra/issues/15962) for the discussion.
