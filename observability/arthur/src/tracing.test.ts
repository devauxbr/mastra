import type { Mutable } from '@arizeai/openinference-genai/types';
import { SemanticConventions } from '@arizeai/openinference-semantic-conventions';
import { SpanType, TracingEventType } from '@mastra/core/observability';
import type { AnyExportedSpan } from '@mastra/core/observability';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
});
