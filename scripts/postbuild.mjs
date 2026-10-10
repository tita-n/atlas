import { chmod } from 'node:fs/promises';

await chmod('dist/cli.js', 0o755);
