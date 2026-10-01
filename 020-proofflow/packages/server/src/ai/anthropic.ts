import Anthropic from '@anthropic-ai/sdk';
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from './provider.js';

/**
 * Anthropic provider (official SDK). Structured output via output_config.format (JSON schema);
 * server-side refusal fallbacks are opted in ("default" routing) per current API guidance.
 * NOTE: this path is type-checked against @anthropic-ai/sdk but has not been exercised against the live API in this
 * development environment (no API key / no billing). See AI_ASSISTANCE.md.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  constructor(apiKey: string, private model = 'claude-opus-5-5') { this.client = new Anthropic({ apiKey: apiKey || undefined, maxRetries: 2, timeout: 120_000 }); }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 16_000,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema: req.jsonSchema } },
    });
    if (res.stop_reason === 'refusal') throw new Error('AI provider declined the request (refusal)');
    if (res.stop_reason === 'max_tokens') throw new Error('AI output truncated (max_tokens)');
    const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new Error('AI output was not valid JSON'); }
    return { json, model: res.model, inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens, raw: text };
  }
}
