/**
 * Some open-weights models (Qwen 3, DeepSeek-R1, etc.) emit a
 * <think>...</think> reasoning block before the answer. Strip it so callers
 * read the actual reply (a summary line, a YES/NO verdict, a noting label)
 * instead of the chain of thought.
 */
export function stripThinkTags(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
