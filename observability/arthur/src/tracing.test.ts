import type { Mutable } from '@arizeai/openinference-genai/types';
import { SemanticConventions } from '@arizeai/openinference-semantic-conventions';
import { SpanType, TracingEventType } from '@mastra/core/observability';
import type { AnyExportedSpan } from '@mastra/core/observability';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenInferenceOTLPTraceExporter } from './openInferenceOTLPExporter';
import { ArthurExporter } from './tracing';

// Capture spans exported by the mocked OTLP exporter
const exportedSpans: any[] = [];

// Mock the OTLP exporter base class (used by OpenInferenceOTLPTraceExporter).
// Define `export` as a prototype method so subclass overrides still run.
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => {
  class MockOTLPTraceExporter {
    export(spans: any[], resultCallback?: (result: any) => void) {
      exportedSpans.push(...spans);
      if (resultCallback) resultCallback({});
    }
    shutdown() {
      return Promise.resolve();
    }
  }
  return { OTLPTraceExporter: MockOTLPTraceExporter };
});

// Mock resources API used by OtelExporter
vi.mock('@opentelemetry/resources', () => ({
  defaultResource: vi.fn().mockReturnValue({
    merge: vi.fn().mockReturnValue({}),
  }),
  resourceFromAttributes: vi.fn().mockReturnValue({
    merge: vi.fn().mockReturnValue({}),
  }),
}));

// Mock BatchSpanProcessor to immediately forward spans to the exporter
vi.mock('@opentelemetry/sdk-trace-base', () => {
  class MockBatchSpanProcessor {
    private exporter: any;
    constructor(exporter: any) {
      this.exporter = exporter;
    }
    onEnd(span: any) {
      this.exporter.export([span], () => {});
    }
    shutdown() {
      return Promise.resolve();
    }
  }
  return {
    BatchSpanProcessor: MockBatchSpanProcessor,
  };
});

describe('ArthurExporter', () => {
  let exporter: ArthurExporter | undefined;

  beforeEach(() => {
    exportedSpans.length = 0;
  });

  afterEach(async () => {
    if (exporter) {
      await exporter.shutdown();
      exporter = undefined;
    }
  });

  describe('Usage Metrics Conversion', () => {
    it('handles partial usage metrics gracefully', async () => {
      exporter = new ArthurExporter({
        endpoint: 'http://localhost:8080',
        apiKey: 'test-api-key',
        taskId: 'test-task',
      });

      const testSpan: Mutable<AnyExportedSpan> = {
        id: 'span-partial-usage',
        traceId: 'trace-partial-usage',
        type: SpanType.MODEL_GENERATION,
        name: 'Partial Usage Test',
        startTime: new Date(),
        endTime: new Date(),
        input: { text: 'test' },
        output: { text: 'response' },
        attributes: {
          model: 'gpt-4',
          provider: 'openai',
          usage: {
            // Only input tokens, no output tokens
            inputTokens: 100,
          },
        },
      } as unknown as AnyExportedSpan;

      await exporter.exportTracingEvent({
        type: TracingEventType.SPAN_ENDED,
        exportedSpan: testSpan,
      });

      expect(exportedSpans.length).toBe(1);
      const attrs = exportedSpans[0].attributes;

      // Input tokens should be present
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT]).toBe(100);

      // Output and total should NOT be present (undefined, not 0)
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_COMPLETION]).toBeUndefined();
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_TOTAL]).toBeUndefined();

      // Cache/reasoning/audio should not be present
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]).toBeUndefined();
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING]).toBeUndefined();
    });

    it('converts detailed usage metrics to OpenInference token count attributes', async () => {
      exporter = new ArthurExporter({
        endpoint: 'http://localhost:8080',
        apiKey: 'test-api-key',
        taskId: 'test-task',
      });

      const testSpan: Mutable<AnyExportedSpan> = {
        id: 'span-usage',
        traceId: 'trace-usage',
        type: SpanType.MODEL_GENERATION,
        name: 'Detailed Usage Test',
        startTime: new Date(),
        endTime: new Date(),
        input: { text: 'test' },
        output: { text: 'response' },
        attributes: {
          model: 'claude-3-opus',
          provider: 'anthropic',
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            inputDetails: {
              cacheRead: 80,
              cacheWrite: 20,
              audio: 10,
            },
            outputDetails: {
              reasoning: 30,
              audio: 5,
            },
          },
        },
      } as unknown as AnyExportedSpan;

      await exporter.exportTracingEvent({
        type: TracingEventType.SPAN_ENDED,
        exportedSpan: testSpan,
      });

      expect(exportedSpans.length).toBe(1);
      const attrs = exportedSpans[0].attributes;

      // Core token counts
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT]).toBe(100);
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_COMPLETION]).toBe(50);
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_TOTAL]).toBe(150);

      // Cache details
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]).toBe(80);
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]).toBe(20);

      // Reasoning tokens
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING]).toBe(30);

      // Audio tokens
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_AUDIO]).toBe(10);
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_COMPLETION_DETAILS_AUDIO]).toBe(5);
    });
  });

  describe('Legacy cache attribute fallback', () => {
    // Construct a synthetic post-SpanConverter OTel span so we can inject the
    // old non-spec attribute names directly. This simulates a downstream user
    // pinning an older @mastra/otel-exporter against the current @mastra/arthur.
    function makeSpan(extraAttrs: Record<string, any>) {
      return {
        name: 'test-span',
        kind: 0,
        spanContext: () => ({
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          traceFlags: 1,
          isRemote: false,
        }),
        parentSpanContext: undefined,
        startTime: [0, 0],
        endTime: [1, 0],
        status: { code: 0 },
        attributes: {
          'mastra.span.type': 'model_generation',
          'gen_ai.operation.name': 'chat',
          'gen_ai.system': 'anthropic',
          'gen_ai.request.model': 'claude-3-opus',
          'gen_ai.usage.input_tokens': 100,
          'gen_ai.usage.output_tokens': 50,
          ...extraAttrs,
        },
        links: [],
        events: [],
        duration: [1, 0],
        ended: true,
        resource: { attributes: {} },
        instrumentationScope: { name: 'test', version: '0.0.0' },
        droppedAttributesCount: 0,
        droppedEventsCount: 0,
        droppedLinksCount: 0,
      } as any;
    }

    it('falls back to legacy cached_input_tokens / cache_write_tokens when only legacy names are present', () => {
      const otlpExporter = new OpenInferenceOTLPTraceExporter({ url: 'http://test', headers: {} });
      const span = makeSpan({
        'gen_ai.usage.cached_input_tokens': 80,
        'gen_ai.usage.cache_write_tokens': 20,
      });

      otlpExporter.export([span], () => {});

      expect(exportedSpans.length).toBe(1);
      const attrs = exportedSpans[0].attributes;
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]).toBe(80);
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]).toBe(20);
    });

    it('prefers spec attribute names over legacy ones when both are present', () => {
      const otlpExporter = new OpenInferenceOTLPTraceExporter({ url: 'http://test', headers: {} });
      const span = makeSpan({
        'gen_ai.usage.cache_read.input_tokens': 80,
        'gen_ai.usage.cached_input_tokens': 999, // bogus legacy value
        'gen_ai.usage.cache_creation.input_tokens': 20,
        'gen_ai.usage.cache_write_tokens': 999, // bogus legacy value
      });

      otlpExporter.export([span], () => {});

      expect(exportedSpans.length).toBe(1);
      const attrs = exportedSpans[0].attributes;
      // Spec value wins, not 999
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]).toBe(80);
      expect(attrs[SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]).toBe(20);
    });
  });
});
