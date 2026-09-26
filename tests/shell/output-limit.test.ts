import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_LINE_CHARS,
  DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  maxToolOutputChars,
  truncateToolOutput,
} from '../../src/shell/output-limit.js';

describe('tool output truncation', () => {
  it('leaves small output untouched', () => {
    const result = truncateToolOutput('hello\nworld');
    expect(result.text).toBe('hello\nworld');
    expect(result.truncated).toBe(false);
    expect(result.keptChars).toBe(result.originalChars);
  });

  it('caps large output instead of storing all of it', () => {
    const huge = 'x'.repeat(500_000);
    const result = truncateToolOutput(huge);

    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(500_000);
    expect(result.text.length).toBeLessThanOrEqual(
      DEFAULT_MAX_TOOL_OUTPUT_CHARS + 200,
    );
  });

  it('keeps both the head and the tail of the output', () => {
    const head = 'FIRST-LINE\n';
    const tail = '\nLAST-LINE';
    const result = truncateToolOutput(`${head}${'a'.repeat(200_000)}${tail}`);

    expect(result.text).toContain('FIRST-LINE');
    expect(result.text).toContain('LAST-LINE');
  });

  it('marks the cut and explains how to read the rest', () => {
    // Many short lines, so the total budget is what applies rather than the
    // per-line clamp.
    const many = Array.from({ length: 40_000 }, () => 'bbbbbbbbbb').join('\n');
    const result = truncateToolOutput(many);
    expect(result.text).toContain('[output truncated by Atlas]');
    expect(result.text).toMatch(/kept \d+ of \d+ allowed/);
    expect(result.text).toContain('head');
  });

  it('reports a per-line cut without pretending the whole result is kept', () => {
    const result = truncateToolOutput('b'.repeat(200_000));
    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/\[\+\d+ chars on this line\]/);
  });

  it('clamps a single very long line so minified files cannot dominate', () => {
    const line = 'y'.repeat(50_000);
    const result = truncateToolOutput(line);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('chars on this line');
    expect(result.text.length).toBeLessThan(line.length);
  });

  it('honours an explicit budget', () => {
    const result = truncateToolOutput('z'.repeat(50_000), { maxChars: 5_000 });
    expect(result.text.length).toBeLessThanOrEqual(5_200);
  });

  it('never returns more than the line cap for normal line counts', () => {
    const many = Array.from({ length: 50 }, () => 'q'.repeat(100)).join('\n');
    const result = truncateToolOutput(many);
    for (const line of result.text.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(DEFAULT_MAX_LINE_CHARS);
    }
  });
});

describe('maxToolOutputChars', () => {
  it('defaults when unset', () => {
    expect(maxToolOutputChars({})).toBe(DEFAULT_MAX_TOOL_OUTPUT_CHARS);
  });

  it('reads a valid override', () => {
    expect(maxToolOutputChars({ ATLAS_MAX_TOOL_OUTPUT_CHARS: '5000' })).toBe(
      5000,
    );
  });

  it('ignores nonsense and absurdly small values', () => {
    expect(maxToolOutputChars({ ATLAS_MAX_TOOL_OUTPUT_CHARS: 'abc' })).toBe(
      DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    );
    expect(maxToolOutputChars({ ATLAS_MAX_TOOL_OUTPUT_CHARS: '10' })).toBe(
      DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    );
    expect(maxToolOutputChars({ ATLAS_MAX_TOOL_OUTPUT_CHARS: '' })).toBe(
      DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    );
  });
});
