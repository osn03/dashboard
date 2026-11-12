// OpenAI (ChatGPT models) as an alternative brain for the assistant.
// It plugs in behind the same `Llm` interface the assistant already uses, so the tools,
// validation, proposals and confirmation rules are identical for both providers.
//
// Uses the Responses API (current GPT-6 models require it for tool calling):
//   https://developers.openai.com/api/docs/guides/function-calling
//  - tools: { type: 'function', name, description, parameters, strict }
//  - the model's output items (function_call and reasoning items) are passed back unchanged
//    on the next request, followed by { type: 'function_call_output', call_id, output }
//  - store: false keeps the conversation from being stored at OpenAI; reasoning items are
//    then carried in encrypted form (include: ['reasoning.encrypted_content']).
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { Llm } from './assistant';

/** The part of the OpenAI client this adapter needs (lets tests supply a stand-in). */
export interface OpenAIResponses {
  create(params: OpenAI.Responses.ResponseCreateParamsNonStreaming): Promise<OpenAI.Responses.Response>;
}

/** Private marker block: the raw OpenAI output of an assistant turn, replayed on the next request. */
interface CarriedItems {
  type: 'openai_items';
  items: OpenAI.Responses.ResponseOutputItem[];
}

export function openAiLlm(responses: OpenAIResponses): Llm {
  return {
    async create(params) {
      const system = typeof params.system === 'string' ? params.system : (params.system ?? []).map((b) => b.text).join('\n\n');
      const input: OpenAI.Responses.ResponseInputItem[] = [];
      for (const m of params.messages) {
        if (typeof m.content === 'string') {
          input.push({ role: m.role, content: m.content });
          continue;
        }
        // A user turn with attached images: text and image parts in one message.
        const parts: OpenAI.Responses.ResponseInputContent[] = [];
        for (const block of m.content as unknown as (Anthropic.Beta.BetaContentBlockParam | CarriedItems)[]) {
          if (m.role === 'user' && block.type === 'text') parts.push({ type: 'input_text', text: block.text });
          else if (m.role === 'user' && block.type === 'image' && block.source.type === 'base64') {
            parts.push({ type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}`, detail: 'auto' });
          } else if (block.type === 'openai_items') input.push(...toResponseInputItems(block.items));
          else if (block.type === 'tool_result') {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
            input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.is_error ? `ERROR: ${text}` : text });
          }
          // Text and tool_use blocks of earlier assistant turns are already inside the carried items.
        }
        if (parts.length) input.push({ role: 'user', content: parts });
      }

      const res = await responses.create({
        model: params.model,
        instructions: system,
        input,
        tools: (params.tools ?? []).map((t) => {
          const tool = t as Anthropic.Beta.BetaTool;
          // Not strict: several tool fields are optional. Every input is validated by the app before use.
          return { type: 'function' as const, name: tool.name, description: tool.description ?? '', parameters: tool.input_schema as Record<string, unknown>, strict: false };
        }),
        max_output_tokens: params.max_tokens,
        store: false,
        include: ['reasoning.encrypted_content'],
      });

      const content: unknown[] = [{ type: 'openai_items', items: res.output } satisfies CarriedItems];
      let refused = false;
      let calls = 0;
      for (const item of res.output) {
        if (item.type === 'message') {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) content.push({ type: 'text', text: part.text });
            if (part.type === 'refusal') {
              refused = true;
              content.push({ type: 'text', text: part.refusal });
            }
          }
        } else if (item.type === 'function_call') {
          calls++;
          let args: unknown;
          try {
            args = JSON.parse(item.arguments || '{}');
          } catch {
            args = { invalid_json: true }; // fails validation and is reported back to the model
          }
          content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: args });
        }
      }
      const stop_reason = calls ? 'tool_use' : refused ? 'refusal' : res.status === 'incomplete' ? 'max_tokens' : 'end_turn';
      return {
        id: res.id, type: 'message', role: 'assistant', model: res.model, content, stop_reason,
        usage: { input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 },
      } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
}
