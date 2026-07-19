/**
 * "Pay with USDC" client (meditation-pal-du9 Phase 2). No viem/web3 in the
 * bundle: we talk to the injected EIP-1193 wallet (MetaMask, Coinbase Wallet)
 * directly, it signs, and we only build the EIP-712 typed data and base64 the
 * payload. Mirrors x402's reference `exact` EVM scheme (EIP-3009
 * TransferWithAuthorization) field-for-field so the facilitator accepts it.
 *
 * Flow: POST the buy endpoint with no payment, the 402 carries the payment
 * requirements, the wallet signs a transferWithAuthorization, re-POST with an
 * X-PAYMENT header, the server verifies + settles + credits. All cryptography
 * stays in the wallet, so a wrong field here only means the signature won't
 * verify (caught on testnet), never that funds move incorrectly.
 */

import { cloudUrl } from './cloud-base.js';
import { getCloudToken, clearCloudToken, ensureCloudToken } from './cloud-auth.js';
import {
    CHAIN_ID,
    buildAuthorization,
    buildTypedData,
    encodeXPayment,
    type X402Network,
    type X402Requirements,
} from './x402-sign.js';

/** EIP-1193 provider - the subset we use. */
interface Eip1193Provider {
    request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}
declare global {
    interface Window {
        ethereum?: Eip1193Provider;
    }
}

const CHAIN_PARAMS: Record<X402Network, Record<string, unknown>> = {
    base: {
        chainId: '0x2105',
        chainName: 'Base',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://mainnet.base.org'],
        blockExplorerUrls: ['https://basescan.org'],
    },
    'base-sepolia': {
        chainId: '0x14a34',
        chainName: 'Base Sepolia',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://sepolia.base.org'],
        blockExplorerUrls: ['https://sepolia.basescan.org'],
    },
};

/** A wallet rejection (EIP-1193 code 4001) or missing wallet, shown as friendly
 *  copy rather than a raw error. */
export class WalletError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WalletError';
    }
}

function injected(): Eip1193Provider {
    const eth = typeof window !== 'undefined' ? window.ethereum : undefined;
    if (!eth) {
        throw new WalletError(
            'No crypto wallet found. Install a wallet like MetaMask or Coinbase Wallet to pay with USDC.'
        );
    }
    return eth;
}

/** Switch the wallet to the target chain, adding it if the wallet doesn't know
 *  it (EIP-1193 code 4902). */
async function ensureChain(provider: Eip1193Provider, network: X402Network): Promise<void> {
    const chainIdHex = '0x' + CHAIN_ID[network].toString(16);
    try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
    } catch (err) {
        if ((err as { code?: number })?.code === 4902) {
            await provider.request({ method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS[network]] });
        } else {
            throw err;
        }
    }
}

/** EIP-1193 user-rejection. */
function isUserRejection(err: unknown): boolean {
    return (err as { code?: number })?.code === 4001;
}

export interface X402PurchaseResult {
    credits: number;
    creditsRemaining: number;
}

/**
 * Buy a pack with USDC via x402. Throws WalletError on a missing wallet or user
 * cancellation, or a friendly Error on a server/settlement failure.
 */
export async function payWithUsdc(packId: string): Promise<X402PurchaseResult> {
    let token = await getCloudToken();
    if (!token) throw new Error('Sign in to buy credits.');
    const url = cloudUrl(`/billing/x402/buy/${encodeURIComponent(packId)}`);
    let headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    // 1) Ask for the payment requirements (the server answers 402).
    let challenge = await fetch(url, { method: 'POST', headers });
    if (challenge.status === 401) {
        // Stale token: clear, re-mint once, retry, matching the LLM/TTS/STT
        // proxies' self-heal. ensureCloudToken throws CloudSignInRequiredError
        // on a hosted build with no live session, which surfaces as the modal's
        // error line.
        await clearCloudToken();
        token = await ensureCloudToken();
        headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
        challenge = await fetch(url, { method: 'POST', headers });
    }
    if (challenge.status !== 402) {
        if (challenge.ok) return (await challenge.json()) as X402PurchaseResult;
        throw new Error(
            challenge.status >= 500
                ? 'USDC payments are not available right now.'
                : `Couldn't start payment (${challenge.status}).`
        );
    }
    const req = ((await challenge.json()) as { accepts?: X402Requirements[] }).accepts?.[0];
    if (!req) throw new Error('The server did not return payment requirements.');

    // 2) Connect the wallet, switch to Base, sign the transfer authorization.
    const provider = injected();
    let from: string | undefined;
    let signature: string;
    try {
        const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
        from = accounts?.[0];
        if (!from) throw new WalletError('No wallet account was selected.');
        await ensureChain(provider, req.network);
        const authorization = buildAuthorization(req, from);
        signature = (await provider.request({
            method: 'eth_signTypedData_v4',
            params: [from, JSON.stringify(buildTypedData(req, authorization))],
        })) as string;

        // 3) Re-POST with the signed payment; the server verifies + settles + credits.
        const paid = await fetch(url, {
            method: 'POST',
            headers: { ...headers, 'X-PAYMENT': encodeXPayment(req.network, authorization, signature) },
        });
        if (!paid.ok) {
            const detail = (await paid.json().catch(() => ({}))) as { error?: string };
            throw new Error(detail.error ? `Payment failed: ${detail.error}` : `Payment failed (${paid.status}).`);
        }
        return (await paid.json()) as X402PurchaseResult;
    } catch (err) {
        if (isUserRejection(err)) throw new WalletError('Payment cancelled.');
        throw err;
    }
}
