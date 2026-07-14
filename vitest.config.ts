import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Lásd tests/stubs/cloudflare-email.ts — enélkül a notify.ts nem tesztelhető
      // node alatt, és a levél MIME-szerkezete lefedetlen marad.
      'cloudflare:email': fileURLToPath(new URL('./tests/stubs/cloudflare-email.ts', import.meta.url))
    }
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
});
