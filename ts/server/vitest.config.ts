import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Mirror the @aloud/core path alias from tsconfig.json. tsx reads tsconfig
// paths at runtime, but Vite/Vitest needs its own resolve.alias. Most-specific
// subpaths first.
export default defineConfig({
    resolve: {
        alias: {
            '@aloud/core/facilitation': fileURLToPath(
                new URL('../src/facilitation/index.ts', import.meta.url)
            ),
            '@aloud/core/llm': fileURLToPath(new URL('../src/llm/index.ts', import.meta.url)),
            '@aloud/core': fileURLToPath(new URL('../src/index.ts', import.meta.url)),
        },
    },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
});
