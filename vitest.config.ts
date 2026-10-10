import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Sandboxes HOME and the ATLAS_* path variables so no test can touch the
    // developer's real ~/.atlas files.
    setupFiles: ['tests/setup.ts'],
  },
});
