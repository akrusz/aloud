/**
 * Some open-weights models (Qwen 3, DeepSeek-R1) emit a <think>...</think>
 * block before the answer, or only its closing tag when the chat template put
 * the opening one in the prompt. Strip it so callers parse the reply (summary
 * line, YES/NO verdict, noting label), not the chain of thought.
 */
import { stripReasoning } from './reasoning.js';

export function stripThinkTags(text: string): string {
    return stripReasoning(text).trim();
}
