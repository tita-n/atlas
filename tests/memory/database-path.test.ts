import { describe, expect, it } from 'vitest';

import { resolveDatabasePath } from '../../src/memory/database.js';

describe('resolveDatabasePath', () => {
  it('keeps the database under the configured Atlas home', () => {
    expect(
      resolveDatabasePath(undefined, {
        HOME: '/operator-home',
        ATLAS_HOME: '/isolated-atlas-home',
      }),
    ).toBe('/isolated-atlas-home/atlas.db');
  });

  it('prefers an explicit database path over the Atlas home', () => {
    expect(
      resolveDatabasePath('/explicit/state.db', {
        HOME: '/operator-home',
        ATLAS_HOME: '/isolated-atlas-home',
        ATLAS_DB_PATH: '/environment/state.db',
      }),
    ).toBe('/explicit/state.db');
  });

  it('supports an isolated database override and falls back to HOME otherwise', () => {
    expect(
      resolveDatabasePath(undefined, {
        HOME: '/operator-home',
        ATLAS_DB_PATH: '/isolated/state.db',
      }),
    ).toBe('/isolated/state.db');
    expect(resolveDatabasePath(undefined, { HOME: '/operator-home' })).toBe(
      '/operator-home/.atlas/atlas.db',
    );
  });
});
