import OpenAI from 'openai';
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from './provider.js';

/**
 * OpenAI provider (official SDK, Responses API with a JSON-schema text format).
 * NOTE: type-checked against the installed `openai` package; not exercised against the live API in this environment.
 * Default model is configurable via PROOFFLOW_AI_MODEL (verify current model names in the official docs).
 */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  private client: OpenAI;
  constructor(apiKey: string, private model = 'gpt-5') { this.client = new OpenAI({ apiKey: apiKey || undefined, maxRetries: 2, timeout: 120_000 }); }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    const res = await this.client.responses.create({
      model: this.model,
      instructions: req.system,
      input: req.user,
      max_output_tokens: req.maxTokens ?? 16_000,
      text: { format: { type: 'json_schema', name: `proofflow_${req.feature}`, schema: req.jsonSchema, strict: false } },
    });
    const text = res.output_text;
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new Error('AI output was not valid JSON'); }
    return { json, model: res.model, inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens, raw: text };
  }
}
