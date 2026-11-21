import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string): Promise<string> =>
  readFile(join(process.cwd(), 'src', path), 'utf8');

describe('assistant session construction boundary', () => {
  it('routes chat, TUI, bare interactive startup, and voice listen through the runtime', async () => {
    const [cli, tui, voice] = await Promise.all([
      source('cli.ts'),
      source('tui/run.tsx'),
      source('voice/cli.ts'),
    ]);
    expect(cli).toContain('createAssistantRuntime({');
    expect(cli).toContain('runTuiFrontEnd');
    expect(tui).toContain('createAssistantRuntime({');
    expect(voice).toContain('createAssistantRuntime({');
    expect(voice).toContain('export async function runVoiceListen');

    for (const [name, code] of [
      ['cli', cli],
      ['tui', tui],
      ['voice', voice],
    ] as const) {
      expect(code, `${name} must not create a Conversation directly`).not.toMatch(
        /new\s+Conversation\s*\(/,
      );
      expect(code, `${name} must not create AssistantSession directly`).not.toMatch(
        /createAssistantSession\s*\(/,
      );
      expect(code, `${name} must not construct a ConfirmationFlow directly`).not.toMatch(
        /new\s+ConfirmationFlow\s*\(/,
      );
    }
  });

  it('builds the gate and environment before the only assistant session factory call', async () => {
    const runtime = await source('conversation/assistant-runtime.ts');
    expect(runtime.match(/createGate\s*\(/g)).toHaveLength(1);
    expect(runtime.match(/resolveExecutionEnvironment\s*\(/g)).toHaveLength(1);
    expect(runtime.match(/createAssistantSession\s*\(/g)).toHaveLength(1);
    expect(runtime.indexOf('createGate(')).toBeLessThan(
      runtime.indexOf('createAssistantSession('),
    );
    expect(runtime.indexOf('resolveExecutionEnvironment(')).toBeLessThan(
      runtime.indexOf('createAssistantSession('),
    );
  });
});
