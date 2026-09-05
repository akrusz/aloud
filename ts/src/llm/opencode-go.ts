/**
 * OpenCode Go (Zen) provider — OpenAI-compatible `/v1/chat/completions`
 * endpoint at `https://opencode.ai/zen/go/v1`. Models include MiniMax, Kimi,
 * GLM, DeepSeek, Qwen, MiMo, Hy3, and others.
 */

import type { OpenAIProviderOptions } from './openai.js';
import { OpenAIProvider } from './openai.js';

const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
const DEFAULT_MODEL = 'qwen3.6-plus';

export interface OpenCodeGoProviderOptions extends OpenAIProviderOptions {}

export class OpenCodeGoProvider extends OpenAIProvider {
    constructor(options: OpenCodeGoProviderOptions = {}) {
        super({
            ...options,
            baseUrl: options.baseUrl ?? OPENCODE_GO_BASE_URL,
            model: options.model ?? DEFAULT_MODEL,
        });
    }
}
