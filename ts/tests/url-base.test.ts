/**
 * Locks the two URL helpers' prefixing. These compute every fetch URL in the
 * UI, and a regression here (e.g. a double /v1/v1 prefix) silently 404s in the
 * browser while typecheck and the Hono server tests stay green — exactly the
 * gap that let an early /cloud/v1/v1 bug through. So assert the prefix directly.
 *
 * With no base configured (the test env sets neither window.__ALOUD_API_BASE__
 * nor VITE_ALOUD_CLOUD_URL), both helpers return root-relative paths.
 */
import { describe, it, expect } from 'vitest';
import { appUrl } from '../ui/src/app-base.js';
import { cloudUrl } from '../ui/src/cloud-base.js';

describe('appUrl (app backend, /app/v1)', () => {
    it('prepends the versioned app prefix to a sub-path', () => {
        expect(appUrl('/system-info')).toBe('/app/v1/system-info');
        expect(appUrl('/models/openai')).toBe('/app/v1/models/openai');
        expect(appUrl('/ollama/pull')).toBe('/app/v1/ollama/pull');
    });

    it('does not double up the version segment', () => {
        expect(appUrl('/providers')).not.toContain('/v1/v1');
    });
});

describe('cloudUrl (hosted service, /cloud/v1)', () => {
    it('prepends the versioned cloud prefix to a sub-path', () => {
        expect(cloudUrl('/me/models')).toBe('/cloud/v1/me/models');
        expect(cloudUrl('/llm/complete')).toBe('/cloud/v1/llm/complete');
        expect(cloudUrl('/auth/dev')).toBe('/cloud/v1/auth/dev');
    });

    it('does not double up the version segment', () => {
        expect(cloudUrl('/tts')).not.toContain('/v1/v1');
    });
});
