import Anthropic from '@anthropic-ai/sdk';
import { LLM } from '../lib/config.js';

/**
 * Thin wrapper around the Anthropic SDK.
 *
 * The API key lives only here, on the server. The browser never sees it and
 * never talks to Anthropic directly — the frontend's only upstream is our own
 * API.
 */

let client;

function getClient() {
  if (!LLM.enabled) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }
  if (!client) {
    client = new Anthropic({ apiKey: LLM.apiKey });
  }
  return client;
}

export const isLlmEnabled = () => LLM.enabled;

/**
 * Ask the model for JSON matching `schema`. Structured outputs mean we get a
 * parseable object back instead of prose we have to scrape, which removes a
 * whole class of malformed-generation failures before the validator even runs.
 *
 * @returns {Promise<{data: unknown, usage: object, stopReason: string}>}
 */
export async function generateJson({ system, prompt, schema, maxTokens, effort }) {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: LLM.model,
    max_tokens: maxTokens ?? LLM.maxTokens,
    system,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: effort ?? LLM.effort,
      format: { type: 'json_schema', schema },
    },
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(
      `Model declined the generation request (${response.stop_details?.category ?? 'unspecified'}).`,
    );
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Model output was truncated before the JSON was complete.');
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) throw new Error('Model returned no text content.');

  let data;
  try {
    data = JSON.parse(textBlock.text);
  } catch {
    throw new Error('Model output was not valid JSON despite the schema constraint.');
  }

  return { data, usage: response.usage, stopReason: response.stop_reason };
}
