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
        id: 'fable-5.2',
        model: 'claude-fable-5-2',
        provider: 'anthropic',
        shipped: true,
        note: 'Top capability tier at $8/$40 (the curated Fable since Nov 2026; 5.1 moved to the expanded list). Same request surface as 5.1: thinking always on, pinned to effort low. Not yet run through Phase 1/2 here.',
    },
    {
        id: 'fable-5.1',
        model: 'claude-fable-5-1',
        provider: 'anthropic',
        shipped: false,
        note: 'The curated Fable from Sept to Nov 2026, off the picker since, kept for A/B against 5.2. Hypothesis: best at holding the felt-sense arc without rushing [NEXT]. Risk: thinking is always on, turns run long - watch latency.',
    },
    {
        id: 'fable-5',
        model: 'claude-fable-5',
        provider: 'anthropic',
        shipped: false,
        note: 'Predecessor, kept for A/B against 5.1. Same price, same tokenizer.',
    },
    {
        id: 'opus-5.5',
        model: 'claude-opus-5-5',
        provider: 'anthropic',
        shipped: true,
        note: 'Default since 2026-09-22 at $4/$20. Thinking always on, pinned to effort low.',
    },
    {
        id: 'opus-5',
        model: 'claude-opus-5',
        provider: 'anthropic',
        shipped: false,
        note: 'Released 2026-07-24. Off the picker (Nov 2026): a good coder but a low point for prose. Known bias: longer replies + scope expansion, both anti-facilitation. Steerable - see rubric note on conciseness.',
    },
    {
        id: 'sonnet-5.5',
        model: 'claude-sonnet-5-5',
        provider: 'anthropic',
        shipped: true,
        note: 'Replaced Sonnet 5 in the allowlist (Oct 2026), same $2/$10. The latency dark horse: thinking off via between_tools. If it holds the protocol, the quality gap may not justify Opus for a spoken turn loop.',
    },
    {
        id: 'sonnet-5',
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        shipped: false,
        note: 'Predecessor, kept for A/B against 5.5. Same price, same tokenizer.',
    },
    {
        id: 'haiku-5.5',
        model: 'claude-haiku-5-5',
        provider: 'anthropic',
        shipped: true,
        note: 'Took the budget slot and the background calls from 4.5 (Oct 2026) at a tenth of the price. Thinking on by default, disabled here (opt-out). Floor case: how much facilitation quality does the fastest option actually cost?',
    },
    {
        id: 'haiku-4.5',
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        shipped: false,
        note: 'Predecessor. Off the picker; still priced for installed builds that name it. Sub-600ms TTFT.',
    },

    // --- Shipped: others ----------------------------------------------------
    {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        provider: 'openai',
        shipped: false,
        note: 'GPT-5.6 shipped 2026-07-09. Off the picker (Nov 2026): GPT-6 Sol is cheaper and better.',
    },
    {
        id: 'gpt-5.6-terra',
        model: 'gpt-5.6-terra',
        provider: 'openai',
        shipped: true,
        note: '5.6 mid tier; expanded for en, curated on the zh shortlist.',
    },
    {
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        provider: 'openai',
        shipped: false,
        note: 'Off the picker (Nov 2026); had been kept for its different voice from 5.6 Sol.',
    },
    {
        id: 'gpt-6-sol',
        model: 'gpt-6-sol',
        provider: 'openai',
        shipped: true,
        note: 'Added 2026-09-22 at $2/$10, well under 5.6 Sol, and took its curated slot and the zh default the same day. Mirrors the meditator more than 5.6 Sol; wordier (median 13 words).',
    },
    {
        id: 'gpt-6-luna',
        model: 'gpt-6-luna',
        provider: 'openai',
        shipped: true,
        note: 'Added 2026-09-22 (expanded), the 6 family small tier at $0.10/$0.50.',
    },
    {
        id: 'gpt-5-nano',
        model: 'gpt-5-nano',
        provider: 'openai',
        shipped: true,
        note: 'Added 2026-08-13 as the price floor and the recap engine (utility flag). Shipped for summarization, NOT ear-tested as a facilitator - this run is the first look at whether it could ever hold the slot. Reasoning model pinned to effort minimal; watch latency and control tokens.',
    },
    {
        id: 'gemini-3.5-flash-lite',
        model: 'gemini-3.5-flash-lite',
        provider: 'google',
        shipped: true,
        note: 'Took the Google slot from 2.5 Flash Lite (Oct 2026). GA 2026-07-21, $0.30/$2.50: no longer the price floor.',
    },
    {
        id: 'gemini-2.5-flash-lite',
        model: 'gemini-2.5-flash-lite',
        provider: 'google',
        shipped: false,
        note: 'Predecessor, kept for A/B against 3.5. Google now serves 2.5 only to keys that have used it.',
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
        id: 'gemini-3.8-flash',
        model: 'gemini-3.8-flash',
        provider: 'google',
        shipped: false,
        note: "Google's recommended replacement for 3.6/3.7 Flash (Nov 2026). $0.75/$3.75 promo to 2026-12-31, then $1.50/$7.50 list (cache read $0.15).",
    },
    {
        id: 'gemini-4-hydrogen',
        model: 'gemini-4-hydrogen',
        provider: 'google',
        shipped: false,
        note: 'Released 2026-11-12, the fast tier of Gemini 4 at $1.50/$7.50 (cache read $0.075), no promo. Hypothesis: a real Google midrange voice at Sonnet 5.5 money, if the reasoning floor keeps it quick.',
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

    // --- Local (Ollama desktop tiers) ---------------------------------------
    {
        id: 'qwen3.5-4b',
        model: 'qwen3.5:4b',
        provider: 'ollama',
        // In DEFAULT_TIERS, but `shipped` means the cloud allowlist: a default
        // run must not need a local daemon.
        shipped: false,
        note: 'The smallest desktop tier (DEFAULT_TIERS in providers.rs, "Acceptable"). The follows-the-letter case: where a prompt rule points the wrong way, this model goes there. Pull it first (`ollama pull qwen3.5:4b`).',
    },
    {
        id: 'gemma4-26b',
        model: 'gemma4:26b',
        provider: 'ollama',
        shipped: false,
        note: 'The "Good" desktop tier, auto-recommended from 24GB. ~18GB download; loads ~22GB.',
    },
    {
        id: 'qwen3.8-27b',
        model: 'qwen3.8:27b',
        provider: 'ollama',
        shipped: false,
        note: "Released 2026-08-13. Tests the gemma4:31b slot in DEFAULT_TIERS (providers.rs) - the only tier it can take, being dense 27B / ~18GB. Its headline gains are coding + long-horizon agentic, which is orthogonal to facilitation tone, so the hypothesis is narrow: does a day-one Ollama quant hold the control tokens as well as gemma4? Pull it first (`ollama pull qwen3.8:27b`); the provider sends think:false.",
    },
    {
        id: 'gemma4-e4b',
        model: 'gemma4:e4b',
        provider: 'ollama',
        shipped: false,
        note: 'The "Decent" desktop tier until 2026-11-14, when gemma4:12b took it. 92% here, the fastest first turn of the local models, but terse to the point of cold (median 7 words) and it answered a danger line with a silence bid.',
    },
    {
        id: 'gemma4-12b',
        model: 'gemma4:12b',
        provider: 'ollama',
        shipped: false,
        note: 'The "Decent" desktop tier since 2026-11-14 (auto-recommended from 16GB; needs Ollama 0.31.0). Beat e4b on protocol (94% vs 92%), on stepping out unaided (10/15 vs 6/15) and on a blind tone read (12 fixtures to 6), and sat near gemma4:26b in a three-way. The cost: it reads the system prompt at ~200 tokens/s on an M3 Pro, so a session\'s first reply takes ~9s more than e4b\'s.',
    },
    {
        id: 'bonsai-2-27b',
        model: 'bonsai-2:27b',
        provider: 'ollama',
        shipped: false,
        note: "PrismML's ~2-bit compression of Qwen3.8-27B, 8.3GB: a 27B that fits a 16GB machine. Rejected 2026-11-14. think:false holds and the control tokens mostly do, but 3 replies in 81 were broken ('[', '[G RE P]', a leaked stage direction: the no-stray-bracket check), a blind three-way put it last on 13 of 27 fixtures, and the first turn took 19s of prompt processing on an M3 Pro.",
    },
    {
        id: 'bonsai-2-9b',
        model: 'bonsai-2:9b',
        provider: 'ollama',
        shipped: false,
        note: 'The small Bonsai, 3.2GB, base model unstated. Tried for the qwen3.5:4b slot 2026-11-14 and not adopted: level on protocol (91% vs 90%) and on a blind tone read (13 fixtures to 11), slower to a first reply (3.8s vs 2.0s).',
    },
    {
        id: 'qwen3.6-35b',
        model: 'qwen3.6:35b',
        provider: 'ollama',
        shipped: false,
        note: 'Mixture-of-experts, ~3B active per token, 23GB. Tried against gemma4:26b 2026-11-14 and not adopted: 93% to 98%, stage moves 6/12 to 12/12, stepping out unaided 7/15 to 14/15, for 6GB more memory. In zh the two were close to interchangeable on 8 turns, with Qwen keeping more of the meditator\'s colloquial words.',
    },
];

export const SHIPPED = ROSTER.filter((m) => m.shipped);
export const CANDIDATES = ROSTER.filter((m) => !m.shipped);
