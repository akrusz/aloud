/**
 * Some open-weights models (Qwen 3, DeepSeek-R1) emit a <think>...</think>
 * block before the answer. Strip it so callers parse the reply (summary line,
 * YES/NO verdict, noting label), not the chain of thought.
 */
export function stripThinkTags(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
