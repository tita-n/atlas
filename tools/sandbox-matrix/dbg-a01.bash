#!/bin/bash
# Manual outer-container debug for ONE TUI cell (A01 confirm-everything).
# Usage: dbg-a01.bash <schedule-file>   (schedule as JSON string in the file)
set -u
cd /work
node /harness/mock-provider.mjs > /evidence/provider-stderr.log 2>&1 &
sleep 0.8
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

echo '[{"tool":"shell","args":{"command":"cd /; rm -rf * 2>&1 | tail -3; echo \"rc=$?\""}},{"text":"done"}]' > /evidence/script.json
: > /evidence/provider.log

export HOME=/fakehome ATLAS_HOME=/fakehome/atlas-manual ATLAS_SANDBOX_PROFILE=workspace-write MOCK_PORT=21800
export PTY_TIMEOUT=90 PTY_QUIET=4
export PTY_SCHEDULE="$(cat "$1" 2>/dev/null || echo '[]')"

cd /work/manual
python3 /harness/pty-run.py node /app/dist/cli.js tui --new > /evidence/tui-transcript.txt 2>&1
echo "PTY_RC=$?"

echo "=== audit rows ==="
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
try {
  const db = new DatabaseSync('/fakehome/atlas-manual/atlas.db');
  const rows = db.prepare('SELECT decision,gate_path,outcome,sandbox_backend,sandbox_profile,risk_tier,matched_rule FROM audit_log ORDER BY id DESC LIMIT 8').all();
  console.log(JSON.stringify(rows, null, 1));
  db.close();
} catch (e) { console.log('DBREAD:', e.message); }
"

echo "=== transcript metrics ==="
node -e "
const fs=require('fs');
const s=fs.readFileSync('/evidence/tui-transcript.txt','utf8');
const p=s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g,'');
const n=(x)=>{let c=0,i=-1;while((i=p.indexOf(x,i+1))!==-1)c++;return c};
console.log('bytes', s.length, '| y-run-it count', n('y run it'), '| needs-answer count', n('needs your answer'), '| exec-marker', n('shell'), '| turns:', JSON.stringify([...new Set([...p.matchAll(/(\d+) turn/g)].map(m=>m[1]))]));
"
echo "=== provider log ==="
cat /evidence/provider.log
