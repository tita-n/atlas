import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Redirects every Atlas file path to a throwaway directory for the test run.
 *
 * Several components fall back to the real per-user paths
 * (`~/.atlas/permissions.json`, `~/.atlas/config.json`, `~/.atlas/atlas.db`)
 * when no explicit path is supplied. Without this guard a single test that
 * omits an explicit path would read or overwrite the developer's real files.
 */
const sandbox = mkdtempSync(join(tmpdir(), 'atlas-test-home-'));

process.env.HOME = sandbox;
process.env.ATLAS_PERMISSIONS_PATH = join(sandbox, 'permissions.json');
process.env.ATLAS_CONFIG_PATH = join(sandbox, 'config.json');
process.env.ATLAS_DB_PATH = join(sandbox, 'atlas.db');
