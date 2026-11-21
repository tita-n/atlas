#!/bin/bash
# Manual smoke: one TUI cell, confirm-everything, handy diagnostics.
cd /work
node /harness/mock-provider.mjs > /evidence/provider-stderr.log 2>&1 &
sleep 0.8
# Prove the provider is up before driving the TUI: an empty reply from a stale
# instance on the shared loopback would masquerade as a front-end bug.
node -e "
fetch('http://127.0.0.1:21800/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock', messages: [] }) })
  .then((r) => r.text())
  .then((t) => { console.log('PROVIDER_HTTP_OK len=' + t.length); process.exit(0); })
  .catch(() => { console.log('PROVIDER_HTTP_FAIL'); process.exit(0); });
"

H=/fakehome/atlas-manual
rm -rf "$H" /work/manual
mkdir -p "$H" /work/manual
cp -a /template/. /work/manual/

node --input-type=module -e "
import { saveAutonomy } from '/app/dist/permissions/autonomy.js';
import { writeFileSync } from 'node:fs';
writeFileSync('/fakehome/atlas-manual/config.json', JSON.stringify({ provider: 'openai-compatible', apiKey: 'sk-canary-key-must-never-be-readable', baseUrl: 'http://127.0.0.1:21800/v1', model: 'mock' }));
writeFileSync('/fakehome/atlas-manual/permissions.json', JSON.stringify({ rules: [], grants: [] }));
await saveAutonomy('/fakehome/atlas-manual', 'confirm-everything');
console.log('SETUP_OK');
"

echo '[{"tool":"shell","args":{"command":"touch /usr/pwned 2>&1; touch /etc/pwned 2>&1; touch /bin/pwned 2>&1; echo rc=$?"}},{"text":"done"}]' > /evidence/script.json
: > /evidence/provider.log

export HOME=/fakehome ATLAS_HOME=/fakehome/atlas-manual ATLAS_SANDBOX_PROFILE=workspace-write MOCK_PORT=21800
export PTY_TIMEOUT=60 PTY_QUIET=4
export PTY_SCHEDULE='[{"wait":3},{"waitFor":"IDLE","timeout":12},{"send":"carry out the requested operation"},{"wait":0.8},{"send":"\r"},{"wait":8},{"send":"y"},{"wait":8},{"send":"y"},{"wait":8}]'

cd /work/manual
python3 /harness/pty-run.py node /app/dist/cli.js tui --new > /evidence/tui-transcript.txt 2>&1
echo "PTY_RC=$?"

echo "=== audit rows (last 8) ==="
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
try {
  const db = new DatabaseSync('/fakehome/atlas-manual/atlas.db');
  const rows = db.prepare('SELECT decision,gate_path,outcome,sandbox_backend,sandbox_profile,risk_tier,command FROM audit_log ORDER BY id DESC LIMIT 8').all();
  console.log(JSON.stringify(rows, null, 1));
  db.close();
} catch (e) { console.log('DBREAD:', e.message); }
"

echo "=== transcript tail ==="
tail -c 6000 /evidence/tui-transcript.txt
echo
echo "=== provider log ==="
cat /evidence/provider.log