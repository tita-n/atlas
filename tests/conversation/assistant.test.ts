import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway directory for fixtures that need a real database file. */
function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'atlas-p4-'));
}

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/memory/database.js';
import {
  CorrectionsRepository,
  deriveTriggerTerms,
} from '../../src/memory/corrections-repository.js';
import {
  mergeMemories,
  rankCorrections,
  rankFacts,
} from '../../src/conversation/memory-retrieval.js';
import {
  ExecutionLedger,
  narrationForCommand,
  stripExecutionLeakage,
} from '../../src/conversation/narration.js';
import {
  buildTurnPrompt,
  NARRATION_RULE,
} from '../../src/conversation/system-prompt.js';
import { identitySection } from '../../src/identity/identity-block.js';
import {
  loadPersonality,
  DEFAULT_PERSONALITY,
} from '../../src/conversation/personality.js';
import { loadAssistantConfig } from '../../src/config/assistant-config.js';
import type { MemoryFact } from '../../src/memory/facts-repository.js';

function fact(content: string, daysAgo = 0): MemoryFact {
  const when = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return {
    id: Math.floor(Math.random() * 1000),
    content,
    category: null,
    createdAt: when,
    updatedAt: when,
    sourceMessageId: null,
  };
}

describe('trigger terms', () => {
  it('drops stop words and short noise', () => {
    const terms = deriveTriggerTerms('the quick brown fox is a very good fox');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('is');
    expect(terms).toContain('quick');
    // Duplicates collapse.
    expect(new Set(terms).size).toBe(terms.length);
  });
});

describe('memory retrieval', () => {
  it('selects the fact that matches the message', () => {
    const facts = [
      fact('The user deploys on Vercel', 1),
      fact('The user prefers Neovim as an editor', 30),
      fact('The user works in Pacific time', 2),
    ];
    const selected = rankFacts('which editor do I use?', facts, {
      alwaysRecent: 0,
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.text).toContain('Neovim');
  });

  it('does not inject the whole store every turn', () => {
    const facts = Array.from({ length: 40 }, (_, index) =>
      fact(`Fact number ${index} about topic ${index}`),
    );
    const selected = rankFacts('topic 7', facts, { limit: 4 });
    expect(selected.length).toBeLessThanOrEqual(4);
  });

  it('still offers a couple of recent facts with no keyword match', () => {
    const facts = [fact('Something unrelated and recent', 0)];
    const selected = rankFacts('completely different subject', facts, {
      alwaysRecent: 2,
    });
    expect(selected).toHaveLength(1);
  });
});

describe('corrections retrieval', () => {
  it('ranks by overlap and outranks plain facts', () => {
    const db = openDatabase(join(tmpDir(), 'atlas.db'));
    try {
      const repo = new CorrectionsRepository(db);
      repo.record({
        instruction: 'Never abbreviate the project name agora',
        triggerTerms: ['agora', 'project', 'name'],
      });
      repo.record({
        instruction: 'Never deploy on Fridays',
        triggerTerms: ['deploy', 'friday'],
      });

      const relevant = repo.relevant('rename the agora project please');
      expect(relevant).toHaveLength(1);
      expect(relevant[0]?.instruction).toContain('agora');

      const ranked = rankCorrections('when should I deploy', repo.list());
      expect(ranked[0]?.text).toContain('Fridays');
    } finally {
      db.close();
    }
  });

  it('survives a save and reload', () => {
    const dir = tmpDir();
    const first = openDatabase(join(dir, 'atlas.db'));
    const repo = new CorrectionsRepository(first);
    const id = repo.record({ instruction: 'Always use tabs, never spaces' });
    expect(repo.count()).toBe(1);
    first.close();

    const second = openDatabase(join(dir, 'atlas.db'));
    try {
      const reloaded = new CorrectionsRepository(second);
      expect(reloaded.getById(id)?.instruction).toBe(
        'Always use tabs, never spaces',
      );
      expect(reloaded.count()).toBe(1);
      expect(reloaded.list()[0]?.instruction).toBe(
        'Always use tabs, never spaces',
      );
    } finally {
      second.close();
    }
  });
});

describe('narration and execution separation', () => {
  it('keeps command output out of the narration', () => {
    const ledger = new ExecutionLedger();
    ledger.add({
      toolName: 'shell',
      command: 'df -h',
      ok: true,
      summary: 'done',
      detail: 'Filesystem  Size  Used\n/dev/sda1  100G  20G',
      durationMs: 12,
    });

    const narration = ledger.narrate();
    expect(narration).toBe('Done.');
    expect(narration).not.toContain('/dev/sda1');
    expect(narration).not.toContain('df -h');

    // The detail block keeps it, but separately.
    expect(ledger.detailBlock()).toContain('/dev/sda1');
  });

  it('summarises partial failure without leaking output', () => {
    const ledger = new ExecutionLedger();
    ledger.add({
      toolName: 'shell',
      command: 'ls',
      ok: true,
      summary: '',
      detail: 'a',
      durationMs: 1,
    });
    ledger.add({
      toolName: 'shell',
      command: 'id',
      ok: false,
      summary: '',
      detail: 'boom',
      durationMs: 1,
    });
    expect(ledger.narrate()).toBe('Done, 1 of 2 steps.');
    expect(ledger.narrate()).not.toContain('boom');
  });

  it('has no narration when nothing ran', () => {
    expect(new ExecutionLedger().narrate()).toBe('');
    expect(new ExecutionLedger().detailBlock()).toBe('');
  });

  it('strips leaked tool payloads from a reply', () => {
    const leaked = [
      'Checking that.',
      '```json',
      `{"tool_calls":[{"function":{"arguments":"${JSON.stringify({ command: 'rm -rf /' })}"}}]}`,
      '```',
      'Done.',
    ].join('\n');
    const cleaned = stripExecutionLeakage(leaked);
    expect(cleaned).not.toContain('rm -rf /');
    expect(cleaned).toContain('Checking that.');
    expect(cleaned).toContain('Done.');
  });

  it('strips reasoning headers', () => {
    const cleaned = stripExecutionLeakage(
      'Thinking: I should run ls\n\nAll good.',
    );
    expect(cleaned).not.toContain('I should run ls');
    expect(cleaned).toContain('All good.');
  });

  it('leaves an ordinary reply untouched', () => {
    expect(stripExecutionLeakage('Two plus two is four.')).toBe(
      'Two plus two is four.',
    );
  });

  it('produces a speakable verb, not the command', () => {
    expect(narrationForCommand('df -h')).toBe('Checking disk space on now.');
    expect(narrationForCommand('sudo rm -rf /tmp/x')).toBe('Deleting now.');
  });
});

describe('system prompt assembly', () => {
  it('includes personality, tools, corrections, and relevant facts', () => {
    const prompt = buildTurnPrompt({
      identity: identitySection(),
      personality: 'You are Atlas.',
      availableTools: ['shell'],
      corrections: ['Never abbreviate agora'],
      facts: ['Uses Neovim'],
    });
    expect(prompt).toContain('You are Atlas.');
    expect(prompt).toContain('shell');
    expect(prompt).toContain('Never abbreviate agora');
    expect(prompt).toContain('Uses Neovim');
    expect(prompt).toContain(NARRATION_RULE.split('\n')[0]);
  });

  it('omits empty sections entirely', () => {
    const prompt = buildTurnPrompt({
      identity: identitySection(),
      personality: 'You are Atlas.',
      availableTools: [],
    });
    expect(prompt).not.toContain('Corrections you must follow');
    expect(prompt).not.toContain('Known facts');
    expect(prompt).toContain('no tools available');
  });

  it('states there is exactly one tool and no memory tools', () => {
    const prompt = buildTurnPrompt({
      identity: identitySection(),
      personality: 'x',
      availableTools: ['shell'],
    });
    expect(prompt).toContain('complete list');
    expect(prompt).toMatch(/no other tools/);
  });
});

describe('personality block', () => {
  it('writes a default once and then keeps user edits', async () => {
    const dir = tmpDir();
    const path = join(dir, 'personality.md');

    const first = await loadPersonality(path);
    expect(first).toBe(DEFAULT_PERSONALITY.trim());

    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'My own voice.\n', 'utf8');
    const second = await loadPersonality(path);
    expect(second).toBe('My own voice.');
  });
});

describe('assistant config', () => {
  it('defaults to the interim safe-word mode', () => {
    expect(loadAssistantConfig({}, {}).textConfirmMode).toBe('safe-word');
  });

  it('allows hard-blocking dangerous commands instead', () => {
    expect(
      loadAssistantConfig({}, { ATLAS_TEXT_CONFIRM_MODE: 'block' })
        .textConfirmMode,
    ).toBe('block');
  });

  it('rejects an unknown mode rather than defaulting silently', () => {
    expect(() =>
      loadAssistantConfig({}, { ATLAS_TEXT_CONFIRM_MODE: 'maybe' }),
    ).toThrow();
  });

  it('honours the detail visibility flag', () => {
    expect(
      loadAssistantConfig({}, { ATLAS_SHOW_EXECUTION_DETAIL: '0' })
        .showExecutionDetail,
    ).toBe(false);
    expect(loadAssistantConfig({}, {}).showExecutionDetail).toBe(true);
  });
});

describe('memory merge', () => {
  it('de-duplicates across groups and honours the limit', () => {
    const merged = mergeMemories(
      [
        [
          { kind: 'correction' as const, text: 'Never do X', score: 2 },
          { kind: 'fact' as const, text: 'Fact one', score: 1 },
        ],
        [{ kind: 'fact' as const, text: 'never do x', score: 1 }],
      ],
      5,
    );
    expect(merged).toHaveLength(2);
  });
});
