import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Sandboxes HOME and the ATLAS_* path variables so no test can touch the
    // developer's real ~/.atlas files.
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Explicit, because a bare `tsc` run leaves compiled .js copies beside the
    // .ts sources and vitest then collects both: the suite appears to double in
    // size and the reported count stops meaning anything. `include` above is
    // the real guard; this one makes the intent impossible to miss.
    exclude: [
      '**/node_modules/**',
      'dist/**',
      'tests/**/*.js',
      'tests/**/*.d.ts',
    ],
  },
});
