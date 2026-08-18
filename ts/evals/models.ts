/**
 * Candidate roster for the facilitation evals.
 *
 * Two groups: models aloud can bill today (they're in the cloud allowlist,
 * server/src/pricing/providers.ts) and models worth *considering* adding. The
 * second group is the point of the eval - a model only earns an allowlist entry
 * after it clears Phase 1 (protocol) and scores on Phase 2 (rubric.md).
 *
 * Landscape as of 2026-07-26. Re-check before trusting any "newest" claim here;
 * the field moved four times in July alone.
 */

export type EvalProvider = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama';

export interface EvalModel {
    id: string;
    /** Provider-native model id passed to the provider constructor. */
    model: string;
    provider: EvalProvider;
    /** In the cloud allowlist today. */
    shipped: boolean;
    /** Why it's in the roster - the hypothesis this model tests. */
    note: string;
}

export const ROSTER: EvalModel[] = [
    // --- Shipped: Anthropic -------------------------------------------------
    {
        id: 'fable-5',
        model: 'claude-fable-5',
        provider: 'anthropic',
        shipped: true,
        note: 'Top capability tier. Hypothesis: best at holding the felt-sense arc without rushing [NEXT]. Risk: thinking is always on, turns run long - watch latency.',
    },
    {
        id: 'opus-5',
        model: 'claude-opus-5',
        provider: 'anthropic',
        shipped: true,
        note: 'Released 2026-07-24. Expected default for exploration. Known bias: longer replies + scope expansion, both anti-facilitation. Steerable - see rubric note on conciseness.',
    },
    {
        id: 'sonnet-5',
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        shipped: true,
        note: 'The latency dark horse. If it holds the protocol, the quality gap may not justify Opus for a spoken turn loop.',
    },
    {
        id: 'haiku-4.5',
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        shipped: true,
        note: 'Sub-600ms TTFT tier. Floor case: how much facilitation quality does the fastest option actually cost?',
    },

    // --- Shipped: others ----------------------------------------------------
    {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        provider: 'openai',
        shipped: true,
        note: 'Strongest non-Anthropic entry already wired. GPT-5.6 shipped 2026-07-09.',
    },
    {
        id: 'gpt-5-nano',
        model: 'gpt-5-nano',
        provider: 'openai',
        shipped: true,
        note: 'Added 2026-08-13 as the price floor and the recap engine (utility flag). Shipped for summarization, NOT ear-tested as a facilitator - this run is the first look at whether it could ever hold the slot. Reasoning model pinned to effort minimal; watch latency and control tokens.',
    },
    {
        id: 'gemini-2.5-flash-lite',
        model: 'gemini-2.5-flash-lite',
        provider: 'google',
        shipped: true,
        note: 'Current cheap/fast tier. Likely superseded - see gemini-3.6-flash below.',
    },
    {
        id: 'kimi-k2',
        model: 'moonshotai/kimi-k2',
        provider: 'openrouter',
        shipped: true,
        note: 'Original K2 (July 2025). Kept as the open-weights baseline; K3 is the upgrade candidate.',
    },

    // --- Candidates: not yet in the allowlist -------------------------------
    {
        id: 'gemini-3.1-pro',
        model: 'gemini-3.1-pro',
        provider: 'google',
        shipped: false,
        note: 'BIGGEST GAP. aloud has no Google frontier model at all. Leads GPQA/ARC-AGI-2. Caveat: reported first-token latency is very high (~27s in one comparison) - may be disqualifying for a voice loop, which Phase 1 will settle.',
    },
    {
        id: 'gemini-3.6-flash',
        model: 'gemini-3.6-flash',
        provider: 'google',
        shipped: false,
        note: 'Released 2026-07-21. Direct upgrade path for the gemini-2.5-flash-lite slot.',
    },
    {
        id: 'kimi-k3',
        model: 'moonshotai/kimi-k3',
        provider: 'openrouter',
        shipped: false,
        note: 'Released 2026-07-16, 2.8T open-weight MoE, 1M context. Leads BrowseComp + GPQA among open weights. Upgrade candidate for the kimi-k2 slot.',
    },
    {
        id: 'kimi-k2.5',
        model: 'moonshotai/kimi-k2.5',
        provider: 'openrouter',
        shipped: false,
        note: 'IFEval leader (94.0). IFEval is the closest public proxy we have for control-token compliance, so this is a real Phase 1 contender despite not being a frontier model.',
    },
    {
        id: 'qwen-3.5',
        model: 'qwen/qwen-3.5',
        provider: 'openrouter',
        shipped: false,
        note: 'IFEval 92.6. Same rationale as kimi-k2.5. Also a plausible local/Ollama story.',
    },
    {
        id: 'grok-4.5',
        model: 'x-ai/grok-4.5',
        provider: 'openrouter',
        shipped: false,
        note: 'Released 2026-07-08. xAI has no presence in aloud. Include mainly to rule it in or out; house style may be badly matched to contemplative facilitation.',
    },
    {
        id: 'muse-spark-1.1',
        model: 'meta/muse-spark-1.1',
        provider: 'openrouter',
        shipped: false,
        note: 'Released 2026-07-09. Cheapest of the July drops and leads tool use. Cost is a minor concern here, so it earns a slot only if quality holds.',
    },
    {
        id: 'inkling',
        model: 'thinkingmachines/inkling',
        provider: 'openrouter',
        shipped: false,
        note: 'Thinking Machines, released 2026-07-15. Unknown quantity - worth one pass precisely because nobody has characterized its conversational register yet.',
    },

    // --- Candidates: local (Ollama desktop tiers) ---------------------------
    {
        id: 'qwen3.8-27b',
        model: 'qwen3.8:27b',
        provider: 'ollama',
        shipped: false,
        note: "Released 2026-08-13. Tests the gemma4:31b slot in DEFAULT_TIERS (providers.rs) - the only tier it can take, being dense 27B / ~18GB. Its headline gains are coding + long-horizon agentic, which is orthogonal to facilitation tone, so the hypothesis is narrow: does a day-one Ollama quant hold the control tokens as well as gemma4? Pull it first (`ollama pull qwen3.8:27b`); the provider sends think:false.",
    },
];

export const SHIPPED = ROSTER.filter((m) => m.shipped);
export const CANDIDATES = ROSTER.filter((m) => !m.shipped);
