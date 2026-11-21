# Step 3 audit-truthfulness dump
records: 226 (layer2 + layer2c)
audit rows: 226; records with no audit row: 0

## Outcome counts (observed from audit rows, per record)
- denied-by-floor: 36   (chat/confirm-everything=9 chat/unattended=9 tui/confirm-everything=9 tui/unattended=9)
- ran-in-sandbox: 174   (chat/confirm-everything=46 chat/unattended=46 tui/confirm-everything=41 tui/unattended=41)
- refused-degraded: 16   (chat/confirm-everything=4 chat/unattended=4 tui/confirm-everything=4 tui/unattended=4)

## Audit row kinds (decision | gate_path | outcome | backend)
- 6 x allowed | gate=auto-allow-sandboxed | outcome=failed | backend=bwrap | escalated=0
- 120 x allowed | gate=auto-allow-sandboxed | outcome=succeeded | backend=bwrap | escalated=0
- 2 x asked-approved | gate=text-safe-word | outcome=failed | backend=bwrap | escalated=0
- 46 x asked-approved | gate=text-safe-word | outcome=succeeded | backend=bwrap | escalated=0
- 36 x blocked | gate=denied-hard-floor | outcome=denied | backend=bwrap | escalated=0
- 16 x blocked | gate=refused-degraded | outcome=denied | backend=refusing | escalated=0

## Independent database cross-check: 210/210 per-cell audit databases compared with the embedded rows

## Shared-dir shadow reuse (explained, 16):
- atlas-C01-chat-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C01-chat-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C01-tui-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C01-tui-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C02-chat-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C02-chat-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C02-tui-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C02-tui-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C03-chat-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C03-chat-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C03-tui-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C03-tui-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C04-chat-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C04-chat-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C04-tui-confirm-everything: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json
- atlas-C04-tui-unattended: DB holds the later shadow run's row (matches the shadow record byte for byte); the main-body row is preserved in results-layer2.json

PROBLEMS: none — every record re-derives its own outcome, no
vocabulary gaps, no prediction mismatches, no escalation claims,
and every embedded row set matches its audit database byte for
byte (the shared C dirs hold their later shadow row — see above).
