/**
 * Pure x402 "exact" EVM signing helpers (meditation-pal-du9 Phase 2): no DOM, no
 * wallet, no network, so they're verifiable in isolation. Mirrors x402's
 * reference scheme (EIP-3009 TransferWithAuthorization) field-for-field so the
 * facilitator accepts the signature the wallet produces over this typed data.
 * The wallet/HTTP flow lives in x402-pay.ts.
 */

export type X402Network = 'base' | 'base-sepolia';

/** The `accepts[]` entry the server advertises in its 402 (subset we need). */
export interface X402Requirements {
    scheme: string;
    network: X402Network;
    /** USDC amount in atomic units (6 decimals), as a decimal string. */
    maxAmountRequired: string;
    payTo: string;
    /** USDC contract address (the EIP-712 verifyingContract). */
    asset: string;
    maxTimeoutSeconds: number;
    /** USDC's EIP-712 domain (name + version). */
    extra: { name: string; version: string };
}

export interface X402Authorization {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
}

export const CHAIN_ID: Record<X402Network, number> = { base: 8453, 'base-sepolia': 84532 };

/** USDC's contract per network, the same constants the server builds its
 *  challenge from (server/src/billing/x402.ts `USDC`). Pinned here too, so the
 *  app only ever asks a wallet to sign against the real token. */
export const USDC_ADDRESS: Record<X402Network, string> = {
    base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

/** Longest authorization window the app will sign. The server asks for 300 s. */
export const MAX_AUTHORIZATION_SECONDS = 600;

/**
 * Is this challenge the purchase the person clicked? Returns what is wrong
 * with it, or null.
 *
 * The 402's requirements come from the server, and the wallet signs what the
 * app builds from them: a bearer authorization to move `maxAmountRequired` of
 * `asset` to `payTo`. A wallet shows that as raw atomic units most people
 * can't read. So before anything reaches the wallet, the amount has to be the
 * pack's price, the token real USDC on a network we know, and the window
 * short. That leaves a wrong or hostile challenge able to take the price
 * that was agreed to, and nothing more. (The pay-to address can't be pinned
 * here: it is the server's configuration.)
 */
export function challengeProblem(req: X402Requirements, expectedUsdCents: number): string | null {
    if (req.scheme !== 'exact') return 'unsupported scheme';
    const usdc = USDC_ADDRESS[req.network];
    if (!usdc) return 'unknown network';
    if (typeof req.asset !== 'string' || req.asset.toLowerCase() !== usdc.toLowerCase()) return 'not USDC';
    // Atomic units: cents x 10^4 (USDC has 6 decimals). Compared as strings of
    // digits, so nothing is lost to a number conversion.
    if (!Number.isInteger(expectedUsdCents) || expectedUsdCents <= 0) return 'no price to check against';
    if (req.maxAmountRequired !== String(expectedUsdCents * 10_000)) return 'amount differs from the price';
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.payTo ?? '')) return 'malformed recipient';
    if (
        !Number.isInteger(req.maxTimeoutSeconds) ||
        req.maxTimeoutSeconds <= 0 ||
        req.maxTimeoutSeconds > MAX_AUTHORIZATION_SECONDS
    ) {
        return 'authorization window too long';
    }
    return null;
}

/** Random EIP-3009 nonce: 32 bytes, hex. */
export function randomNonce(): string {
    const b = crypto.getRandomValues(new Uint8Array(32));
    return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * The EIP-3009 transfer authorization for a pack purchase. `nowSec` / `nonce`
 * are injectable for tests. Matches x402's preparePaymentHeader: validAfter is
 * backdated 10 min for clock skew, validBefore is now + the server's timeout.
 */
export function buildAuthorization(
    req: X402Requirements,
    from: string,
    nowSec: number = Math.floor(Date.now() / 1000),
    nonce: string = randomNonce()
): X402Authorization {
    return {
        from,
        to: req.payTo,
        value: req.maxAmountRequired,
        validAfter: String(nowSec - 600),
        validBefore: String(nowSec + req.maxTimeoutSeconds),
        nonce,
    };
}

/** EIP-712 typed data for eth_signTypedData_v4. Declares EIP712Domain
 *  explicitly: raw JSON-RPC needs it, where viem would add it for you. */
export function buildTypedData(req: X402Requirements, authorization: X402Authorization) {
    return {
        types: {
            EIP712Domain: [
                { name: 'name', type: 'string' },
                { name: 'version', type: 'string' },
                { name: 'chainId', type: 'uint256' },
                { name: 'verifyingContract', type: 'address' },
            ],
            TransferWithAuthorization: [
                { name: 'from', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'validAfter', type: 'uint256' },
                { name: 'validBefore', type: 'uint256' },
                { name: 'nonce', type: 'bytes32' },
            ],
        },
        domain: {
            name: req.extra.name,
            version: req.extra.version,
            chainId: CHAIN_ID[req.network],
            verifyingContract: req.asset,
        },
        primaryType: 'TransferWithAuthorization' as const,
        message: authorization,
    };
}

/** The X-PAYMENT header value: base64(JSON(payment payload)). */
export function encodeXPayment(
    network: X402Network,
    authorization: X402Authorization,
    signature: string
): string {
    const payload = { x402Version: 1, scheme: 'exact', network, payload: { signature, authorization } };
    return btoa(JSON.stringify(payload));
}
