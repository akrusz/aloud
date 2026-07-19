/**
 * x402 credit-purchase channel (meditation-pal-du9). Same credit packs as
 * Stripe (billing/stripe.ts), paid in USDC on Base: ~0 commission, no
 * chargebacks, agent-native (an agent tops up with no card or redirect).
 *
 * No SDK, same ethos as billing/stripe.ts. This is a thin JSON/HTTP broker: it
 * builds the 402 "payment requirements", forwards the client's signed payment
 * to a FACILITATOR's /verify then /settle, and credits on success. All crypto
 * lives elsewhere - the payer's wallet signs the EIP-3009 authorization, the
 * facilitator verifies and settles on-chain. We never touch a private key or a
 * chain RPC, so no viem/web3 (that was ~500 transitive packages of `x402-hono`,
 * replaced here by `fetch`).
 *
 * TRUST / ORDERING: verify, then settle, and credit only after the facilitator
 * confirms settlement, keyed idempotently on the settlement tx hash (ledger /
 * idx_ledger_purchase_ref) so a replay can't double-credit.
 *
 * Degrades like Stripe: configured only when x402Enabled AND a pay-to address
 * are set; otherwise the buy route reports not-configured.
 */

import { Hono } from 'hono';
import { apiError, ERROR_STATUS } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { CREDIT_PACKS, packById, type CreditPack } from './stripe.js';
import { log } from '../logger.js';

/** The two Base networks we support. Mirrors config.x402Network. */
export type X402Network = 'base' | 'base-sepolia';

/** Per-network chain constants, verbatim from the x402 reference config so our
 *  hand-built payment requirements match what wallets and facilitators expect.
 *  USDC has 6 decimals; `eip712` is the token's EIP-712 domain, needed by the
 *  payer's wallet for a valid `transferWithAuthorization` signature. Wrong
 *  values mean clients can't sign, not that we'd accept bad payments. */
const USDC: Record<X402Network, { address: string; eip712: { name: string; version: string } }> = {
    base: {
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        eip712: { name: 'USD Coin', version: '2' },
    },
    'base-sepolia': {
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        eip712: { name: 'USD Coin', version: '2' },
    },
};

/** Facilitator base URLs. Testnet uses the keyless community facilitator;
 *  mainnet uses Coinbase's CDP facilitator, which needs a per-request auth JWT
 *  (see facilitatorAuthHeaders, deferred to du9 Phase 3). */
const FACILITATOR_URL: Record<X402Network, string> = {
    'base-sepolia': 'https://x402.org/facilitator',
    base: 'https://api.cdp.coinbase.com/platform/v2/x402',
};

const X402_VERSION = 1;
/** Full request path of the buy route, under the /cloud/v1/billing mount. */
const BUY_BASE = '/cloud/v1/billing/x402/buy';

export interface X402Settings {
    /** Base address that receives USDC (a dedicated treasury wallet, NOT the
     *  personal tip-jar address). */
    payTo: string;
    network: X402Network;
    /** Mainnet settles through the CDP facilitator (CDP keys + signed auth JWT);
     *  testnet uses the keyless x402.org facilitator. */
    useCdpFacilitator: boolean;
}

/** The x402 channel's effective settings, or undefined when not configured. */
export function x402Configured(deps: Deps): X402Settings | undefined {
    const { x402Enabled, x402PayToAddress, x402Network } = deps.config;
    if (!x402Enabled || !x402PayToAddress) return undefined;
    const network: X402Network = x402Network ?? 'base-sepolia';
    return { payTo: x402PayToAddress, network, useCdpFacilitator: network === 'base' };
}

// ---- Facilitator client (the whole "SDK", in ~2 fetches) --------------------

interface VerifyResponse {
    isValid: boolean;
    invalidReason?: string;
    payer?: string;
}
interface SettleResponse {
    success: boolean;
    transaction?: string;
    network?: string;
    payer?: string;
    errorReason?: string;
}

/** Facilitator auth headers. Testnet (x402.org) is keyless. Mainnet (CDP)
 *  requires a per-request Bearer JWT signed with the CDP API key (claims:
 *  sub=apiKeyId, iss='cdp', uris=['POST api.cdp.coinbase.com<path>'],
 *  ES256/EdDSA, short exp). Implement with `jose` (already a dep) + the CDP key
 *  in du9 Phase 3. Until then, refuse loudly so we never half-settle. */
async function facilitatorAuthHeaders(settings: X402Settings): Promise<Record<string, string>> {
    if (!settings.useCdpFacilitator) return {};
    throw new Error('x402 Base mainnet (CDP facilitator) is not wired yet — testnet only (du9 Phase 3)');
}

async function facilitatorPost(
    settings: X402Settings,
    op: 'verify' | 'settle',
    paymentPayload: unknown,
    paymentRequirements: unknown
): Promise<unknown> {
    const auth = await facilitatorAuthHeaders(settings);
    const res = await fetch(`${FACILITATOR_URL[settings.network]}/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`facilitator ${op} failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    return res.json();
}

// ---- Payment requirements + header codec ------------------------------------

/** The `accepts[]` entry advertised in the 402: what the client must pay and
 *  how. USDC ~= USD, so the pack's USD price is its USDC amount (atomic = cents
 *  × 10^4, since USDC has 6 decimals and a cent is 10^-2). */
function paymentRequirements(pack: CreditPack, settings: X402Settings, resource: string) {
    const usdc = USDC[settings.network];
    return {
        scheme: 'exact',
        network: settings.network,
        maxAmountRequired: String(pack.priceUsdCents * 10_000),
        resource,
        description: `aloud credits — ${pack.label}`,
        mimeType: 'application/json',
        payTo: settings.payTo,
        maxTimeoutSeconds: 300,
        asset: usdc.address,
        extra: usdc.eip712,
    };
}

/** X-PAYMENT is base64(JSON) of the client's signed payment payload. Decoded
 *  and forwarded to the facilitator verbatim; we never interpret its internals
 *  (signature/authorization), the facilitator does. */
function decodePaymentHeader(header: string): unknown {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

/** X-PAYMENT-RESPONSE is base64(JSON) of the settlement result: the client's
 *  on-chain receipt. */
function encodeSettleHeader(settle: SettleResponse): string {
    return Buffer.from(JSON.stringify(settle)).toString('base64');
}

// ---- Crediting (the money invariant) ----------------------------------------

export interface X402Credit {
    /** True only when a settled payment actually credited the account. */
    credited: boolean;
    credits?: number;
    creditsRemaining?: number;
}

/**
 * Credit an account for a SETTLED x402 payment. Idempotent on the settlement tx
 * hash (idx_ledger_purchase_ref), so a resubmitted settlement credits exactly
 * once. Returns `{ credited: false }` (a no-op) for an unsuccessful settlement
 * or an unknown pack; callers must treat that as "do not credit", never as
 * success. Exported so the money invariant is unit-testable without a live
 * facilitator.
 */
export async function creditFromSettlement(
    deps: Deps,
    accountId: string,
    packId: string | undefined,
    settle: { success: boolean; transaction?: string }
): Promise<X402Credit> {
    if (!settle.success || !settle.transaction) return { credited: false };
    const pack = packId ? packById(packId) : undefined;
    if (!pack) return { credited: false };
    // The volume discount is already baked into the pack's credits.
    await deps.ledger.purchase(accountId, pack.credits, `purchase:${pack.id}:x402:${settle.transaction}`);
    const creditsRemaining = await deps.ledger.balance(accountId);
    return { credited: true, credits: pack.credits, creditsRemaining };
}

// ---- Route ------------------------------------------------------------------

/** The x402 buy sub-app. Mounted at /x402 under billingRoutes, so its routes
 *  live at /cloud/v1/billing/x402/buy/:packId. */
export function x402Routes(deps: Deps, settings: X402Settings): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    app.post('/buy/:packId', requireAuth(deps), async (c) => {
        const pack = packById(c.req.param('packId'));
        if (!pack) {
            return c.json(apiError('bad_request', 'unknown packId'), ERROR_STATUS.bad_request);
        }
        const requirements = paymentRequirements(pack, settings, `${BUY_BASE}/${pack.id}`);

        // No payment yet: advertise requirements (HTTP 402). An x402 client
        // signs against this and retries with an X-PAYMENT header.
        const header = c.req.header('X-PAYMENT');
        if (!header) {
            return c.json(
                { x402Version: X402_VERSION, accepts: [requirements], error: 'X-PAYMENT header is required' },
                ERROR_STATUS.insufficient_credits
            );
        }

        let paymentPayload: unknown;
        try {
            paymentPayload = decodePaymentHeader(header);
        } catch {
            return c.json(
                { x402Version: X402_VERSION, accepts: [requirements], error: 'invalid X-PAYMENT header' },
                ERROR_STATUS.insufficient_credits
            );
        }

        // 1) Verify the signed authorization (no chain write yet).
        let verify: VerifyResponse;
        try {
            verify = (await facilitatorPost(settings, 'verify', paymentPayload, requirements)) as VerifyResponse;
        } catch (err) {
            log.error('x402 verify failed', { err: String(err), packId: pack.id });
            return c.json(apiError('provider_error', 'payment verification failed'), ERROR_STATUS.provider_error);
        }
        if (!verify.isValid) {
            return c.json(
                { x402Version: X402_VERSION, accepts: [requirements], error: verify.invalidReason ?? 'payment invalid' },
                ERROR_STATUS.insufficient_credits
            );
        }

        // 2) Settle (facilitator submits the EIP-3009 transfer on-chain).
        let settle: SettleResponse;
        try {
            settle = (await facilitatorPost(settings, 'settle', paymentPayload, requirements)) as SettleResponse;
        } catch (err) {
            log.error('x402 settle failed', { err: String(err), packId: pack.id });
            return c.json(apiError('provider_error', 'payment settlement failed'), ERROR_STATUS.provider_error);
        }
        if (!settle.success) {
            return c.json(
                { x402Version: X402_VERSION, accepts: [requirements], error: settle.errorReason ?? 'settlement failed' },
                ERROR_STATUS.insufficient_credits
            );
        }

        // 3) Settled → credit, idempotent on the tx hash.
        const account = c.get('account');
        const result = await creditFromSettlement(deps, account.id, pack.id, settle);
        c.header('X-PAYMENT-RESPONSE', encodeSettleHeader(settle));
        log.info('x402 purchase fulfilled', {
            accountId: account.id,
            credits: pack.credits,
            packId: pack.id,
            txHash: settle.transaction,
        });
        return c.json({ packId: pack.id, credits: pack.credits, creditsRemaining: result.creditsRemaining });
    });

    return app;
}
