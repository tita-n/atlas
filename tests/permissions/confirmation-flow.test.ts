import { describe, expect, it, vi } from 'vitest';
import { ConfirmationFlow } from '../../src/permissions/confirmation-flow.js';
import type { LLMProvider } from '../../src/providers/provider.interface.js';
import type { RiskAssessment } from '../../src/permissions/risk-classifier.js';

const provider: LLMProvider = {
  name: 'mock',
  chatCompletion: vi.fn().mockResolvedValue({
    content: 'This changes system packages.',
    model: 'mock',
  }),
};

const askRisk = (tier: 0 | 1 | 2 | 3): RiskAssessment => ({
  tier,
  decision: tier === 1 ? 'deny' : tier === 2 ? 'ask' : 'allow',
  matchedRule: {
    id: 'test',
    pattern: '*',
    decision: tier === 2 ? 'ask' : 'allow',
    tier,
    description: 'test rule',
  },
  reason: 'test reason',
  requiresConfirmation: tier === 2,
  sudoSetupRequired: false,
});

describe('ConfirmationFlow', () => {
  it('does not call text confirmation for Tier 0', async () => {
    const confirmText = vi.fn().mockResolvedValue(true);
    const flow = new ConfirmationFlow({
      provider,
      model: 'mock',
      confirmText,
      wait: () => Promise.resolve(),
    });

    const result = await flow.review('ls', askRisk(0));
    expect(result.approved).toBe(true);
    expect(confirmText).not.toHaveBeenCalled();
  });

  it('blocks Tier 1 before explanation or confirmation', async () => {
    const confirmText = vi.fn().mockResolvedValue(true);
    const flowInstance = new ConfirmationFlow({
      provider,
      model: 'mock',
      confirmText,
      wait: () => Promise.resolve(),
    });
    const explain = vi.spyOn(flowInstance, 'explain');

    const result = await flowInstance.review('rm -rf /', askRisk(1));
    expect(result.approved).toBe(false);
    expect(result.confirmationRequested).toBe(false);
    expect(explain).not.toHaveBeenCalled();
    expect(confirmText).not.toHaveBeenCalled();
  });

  it('supports approve and deny paths for Tier 2', async () => {
    const approve = vi.fn().mockResolvedValue(true);
    const approvedFlow = new ConfirmationFlow({
      provider,
      model: 'mock',
      confirmText: approve,
      wait: () => Promise.resolve(),
    });
    const approved = await approvedFlow.review('dnf remove htop', askRisk(2));
    expect(approved.approved).toBe(true);
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ phrase: 'ATLAS CONFIRM' }),
    );

    const deny = vi.fn().mockResolvedValue(false);
    const deniedFlow = new ConfirmationFlow({
      provider,
      model: 'mock',
      confirmText: deny,
      wait: () => Promise.resolve(),
    });
    const denied = await deniedFlow.review('dnf remove htop', askRisk(2));
    expect(denied.approved).toBe(false);
  });
});

describe('explanation resilience', () => {
  it('still asks the user when the explanation model is unavailable', async () => {
    const failing: LLMProvider = {
      name: 'openai-compatible',
      chatCompletion: () => Promise.reject(new Error('provider offline')),
    };
    const asked: string[] = [];
    const notices: string[] = [];
    const flow = new ConfirmationFlow({
      provider: failing,
      model: 'm',
      confirmText: (request) => {
        asked.push(request.explanation);
        return Promise.resolve('deny');
      },
      onNotice: (message) => notices.push(message),
    });

    const outcome = await flow.review('npm run build', {
      tier: 2,
      decision: 'ask',
      requiresConfirmation: true,
      matchedRule: {
        id: 'ask-unknown-command',
        pattern: '*',
        decision: 'ask',
        tier: 2,
        description: 'Unknown command.',
      },
      reason: 'The command could not be safely classified.',
      sudoSetupRequired: false,
    });

    // The user is still asked, with a factual local summary.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('could not be safely classified');
    expect(asked[0]).toContain('npm run build');
    expect(outcome.approved).toBe(false);
    expect(notices.join(' ')).toMatch(/plain-language explanation/);
  });
});
