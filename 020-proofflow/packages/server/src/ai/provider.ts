/**
 * AI plane provider abstraction.
 * The AI plane only produces *suggestions*; it never writes test results, baselines or Expected values directly.
 */
export interface AiCompletionRequest {
  feature: string;
  system: string;
  user: string;
  /** JSON schema the model must satisfy; providers use structured output when supported and we always validate again. */
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
}
export interface AiCompletionResult { json: unknown; model: string; inputTokens?: number; outputTokens?: number; raw?: string; }

export interface AiProvider {
  readonly name: string;
  complete(req: AiCompletionRequest): Promise<AiCompletionResult>;
}

export class AiDisabledError extends Error { constructor() { super('AI assistance is disabled (PROOFFLOW_AI_PROVIDER=none or organization setting)'); } }

/** Provider used when AI is off: every call throws and nothing is sent anywhere. */
export class NoneProvider implements AiProvider {
  readonly name = 'none';
  async complete(): Promise<AiCompletionResult> { throw new AiDisabledError(); }
}

/** Deterministic provider for tests and offline demos. Counts calls so tests can assert "no provider call when AI is off". */
export class MockProvider implements AiProvider {
  readonly name = 'mock';
  calls: AiCompletionRequest[] = [];
  constructor(private responder: (req: AiCompletionRequest) => unknown = defaultMockResponder) {}
  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    this.calls.push(req);
    return { json: this.responder(req), model: 'mock-1', inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: 200 };
  }
}

export function defaultMockResponder(req: AiCompletionRequest): unknown {
  switch (req.feature) {
    case 'scenario_draft':
      return { drafts: [
        { title: '正常系: 有効な入力で完了できる', steps: [{ type: 'navigate', url: '/' }, { type: 'assert_element', target: { role: 'heading' }, state: 'visible' }], expected: null, expectedSource: 'unspecified', priority: 'p1', tags: ['happy-path'], rationale: 'ユーザー要求の主フロー' },
        { title: '異常系: 必須項目未入力でエラー表示', steps: [{ type: 'navigate', url: '/' }, { type: 'click', target: { role: 'button', name: 'Submit' } }, { type: 'assert_text', text: 'required', match: 'contains' }], expected: null, expectedSource: 'unspecified', priority: 'p2', tags: ['validation'], rationale: '必須チェック' },
        { title: 'モバイル: 主要 CTA が画面内に表示される', steps: [{ type: 'set_viewport', width: 390, height: 664 }, { type: 'navigate', url: '/' }, { type: 'assert_no_horizontal_scroll' }, { type: 'responsive_check' }], expected: null, expectedSource: 'unspecified', priority: 'p2', tags: ['mobile'], rationale: 'モバイル表示' },
      ], gaps: ['仕様に記載のない期待値は「要確認」とした'] };
    case 'failure_summary':
      return { whatFailed: 'mock summary', step: null, browser: null, request: null, reproductionHints: [], rootCause: { confidence: 'unknown', statement: 'insufficient evidence (mock)' }, suggestedSeverity: 'medium' };
    case 'defect_draft':
      return { title: 'mock defect draft', severity: 'medium', priority: 'p2', reproduction: '1. open page', expected: 'works', actual: 'fails', evidenceNotes: [] };
    case 'selector_repair':
      return { candidates: [{ target: { role: 'button', name: 'Submit' }, confidence: 0.6, reason: 'mock' }] };
    case 'test_gap':
      return { gaps: [{ title: 'mock gap', reason: 'mock', priority: 'p3' }] };
    case 'exploratory_notes':
      return { summary: 'mock summary', findings: [], candidateDefects: [] };
    default:
      return {};
  }
}
