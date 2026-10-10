/**
 * Minimal syntax highlighting for fenced code in the detail panel.
 *
 * Deliberately small and dependency-free: it recognizes comments, strings,
 * numbers, and a handful of shell keywords. That is enough to make command
 * blocks scannable without pulling a full grammar engine into a terminal app.
 *
 * When color is unavailable it returns the plain tokens unchanged, so the
 * structure of the text never depends on highlighting being present.
 */

export type TokenKind =
  'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'operator';

export interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'return',
  'export',
  'local',
  'echo',
  'cd',
  'set',
  'unset',
  'exit',
  'source',
]);

/** Finds fenced code blocks in mixed narration/detail text. */
export interface CodeBlock {
  readonly language: string;
  readonly code: string;
}

/**
 * Extracts ``` fenced blocks.
 *
 * An unterminated fence is returned as a block too, so half-written detail
 * still renders rather than disappearing.
 */
export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const fence = /```([a-zA-Z0-9_+-]*)\n?/g;
  let open: RegExpExecArray | null;
  while ((open = fence.exec(text)) !== null) {
    const language = open[1] ?? '';
    const bodyStart = open.index + open[0].length;
    const close = text.indexOf('```', bodyStart);
    if (close === -1) {
      blocks.push({ language, code: text.slice(bodyStart) });
      break;
    }
    blocks.push({ language, code: text.slice(bodyStart, close) });
    fence.lastIndex = close + 3;
  }
  return blocks;
}

/**
 * Tokenizes one line of shell-ish text.
 *
 * Handles the quoting forms that actually appear in executed commands:
 * single quotes (fully literal), double quotes (partial interpolation), and
 * `$(...)`/backtick substitution.
 */
export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let buffer = '';
  let i = 0;

  const flush = (kind: TokenKind = 'plain'): void => {
    if (buffer !== '') {
      tokens.push({ kind, value: buffer });
      buffer = '';
    }
  };

  while (i < line.length) {
    const rest = line.slice(i);

    // Comment to end of line.
    if (rest.startsWith('#')) {
      flush();
      tokens.push({ kind: 'comment', value: rest });
      return tokens;
    }

    // Single-quoted string: fully literal.
    if (line[i] === "'") {
      flush();
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? line.length : end;
      tokens.push({
        kind: 'string',
        value: line.slice(i, stop + (end === -1 ? 0 : 1)),
      });
      i = stop + (end === -1 ? 0 : 1);
      continue;
    }

    // Double-quoted string, tolerating `$(` inside.
    if (line[i] === '"') {
      flush();
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === '`') {
          const tick = line.indexOf('`', j + 1);
          j = tick === -1 ? line.length : tick + 1;
          continue;
        }
        if (line.startsWith('$(', j)) {
          const close = line.indexOf(')', j);
          j = close === -1 ? line.length : close + 1;
          continue;
        }
        if (line[j] === '"') break;
        j += 1;
      }
      tokens.push({
        kind: 'string',
        value: line.slice(i, Math.min(j + 1, line.length)),
      });
      i = Math.min(j + 1, line.length);
      continue;
    }

    // Command substitution.
    if (line.startsWith('$(', i) || line[i] === '`') {
      flush();
      const opener = line[i];
      const close = line.indexOf(
        opener === '`' ? '`' : ')',
        i + (opener === '`' ? 1 : 2),
      );
      const stop = close === -1 ? line.length : close + 1;
      tokens.push({ kind: 'operator', value: line.slice(i, stop) });
      i = stop;
      continue;
    }

    // Variable reference: $NAME, ${NAME}, or $1.
    if (line[i] === '$' || (line[i] === '{' && line[i + 1] === '$')) {
      flush();
      if (line[i] === '{') {
        const end = line.indexOf('}', i);
        const stop = end === -1 ? i + 1 : end + 1;
        tokens.push({ kind: 'operator', value: line.slice(i, stop) });
        i = stop;
      } else {
        const named = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest.slice(1));
        const positional = /^\d+/.exec(rest.slice(1));
        const length = named?.[0]?.length ?? positional?.[0]?.length ?? 1;
        tokens.push({ kind: 'operator', value: line.slice(i, i + length) });
        i += length;
      }
      continue;
    }

    // Number.
    const num = /^\d+(\.\d+)?/.exec(rest);
    if (num !== null && num[0] !== '') {
      flush();
      tokens.push({ kind: 'number', value: num[0] });
      i += num[0].length;
      continue;
    }

    // Word, which may be a keyword or an operator.
    const word = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(rest);
    if (word !== null && word[0] !== '') {
      const bare = word[0];
      flush();
      tokens.push({
        kind: SHELL_KEYWORDS.has(bare) ? 'keyword' : 'plain',
        value: bare,
      });
      i += bare.length;
      continue;
    }

    if (/^[|&;<>()]/.test(rest)) {
      flush();
      const op = rest[0] ?? '';
      tokens.push({ kind: 'operator', value: op });
      i += 1;
      continue;
    }

    const char = line[i];
    if (char === undefined) break;
    buffer += char;
    i += 1;
  }

  flush();
  return tokens;
}

export function tokenize(code: string): Token[] {
  const lines = code.split('\n');
  const out: Token[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push({ kind: 'plain', value: '\n' });
    out.push(...tokenizeLine(line));
  });
  return out;
}

/** Whether a language is one this highlighter understands. */
export function supportsLanguage(language: string): boolean {
  const l = language.toLowerCase();
  return ['', 'sh', 'bash', 'shell', 'zsh', 'console', 'text'].includes(l);
}
