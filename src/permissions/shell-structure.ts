import { homedir } from 'node:os';
import {
  parse,
  type AssignmentPrefix,
  type ArithmeticExpression,
  type Command,
  type Node,
  type ParsedScript,
  type Redirect,
  type Word,
  type WordPart,
} from 'unbash';

/**
 * Expands a leading `~` and the `$HOME` / `${HOME}` forms to a literal path.
 *
 * Only these forms are expanded. Every other variable, command substitution,
 * and arithmetic expansion is left unresolved on purpose so that it can never
 * be baked into a permission grant.
 */
export function expandHome(value: string): string {
  const home = homedir();
  if (value === '~') return home;
  if (value.startsWith('~/')) return `${home}/${value.slice(2)}`;
  return value.replace(/\$\{HOME\}|\$HOME\b/g, home);
}

/** One simple command extracted from a shell structure. */
export interface ShellCommandSegment {
  /** Exact source slice for the simple command. */
  readonly source: string;
  /** Statically resolved executable basename, when one exists. */
  readonly executable: string | null;
  /** Statically resolved executable path exactly as written. */
  readonly executablePath: string | null;
  /** Static argv tokens, or null when an argument is dynamic. */
  readonly argv: string[] | null;
  /** Whether an executable name exists and is statically resolved. */
  readonly executableKnown: boolean;
  /** Whether the command writes to a file or file-like target. */
  readonly hasFileWriteRedirect: boolean;
  /**
   * Environment assignments prefixed to the command, e.g. `PATH=/tmp:$PATH`.
   *
   * These change which binary runs, or how the shell parses the command, so a
   * segment that carries one can never be approved without asking.
   */
  readonly envPrefixes: readonly string[];
}

/** Extracted commands plus a conservative flag for syntax we cannot traverse. */
export interface ShellStructure {
  /** Simple command segments in source order. */
  readonly commands: readonly ShellCommandSegment[];
  /** Whether any syntax could not be safely traversed. */
  readonly unknown: boolean;
  /** Nested scripts discovered in substitutions or process substitution. */
  readonly nestedScripts: readonly ParsedScript[];
}

class Extractor {
  readonly #source: string;
  readonly #commands: ShellCommandSegment[] = [];
  readonly #nestedScripts: ParsedScript[] = [];
  #unknown = false;

  public constructor(source: string) {
    this.#source = source;
  }

  public extract(script: ParsedScript): ShellStructure {
    if ((script.errors?.length ?? 0) > 0) this.#unknown = true;
    for (const statement of script.commands) this.#statement(statement);
    return {
      commands: [...this.#commands],
      unknown: this.#unknown,
      nestedScripts: [...this.#nestedScripts],
    };
  }

  #statement(statement: ParsedScript['commands'][number]): void {
    this.#node(statement.command);
    this.#redirects(statement.redirects);
    if (statement.redirects.length > 0) this.#unknown = true;
  }

  #node(node: Node): void {
    switch (node.type) {
      case 'Command':
        this.#command(node);
        return;
      case 'Pipeline':
        if (node.negated === true || node.time === true) this.#unknown = true;
        for (const command of node.commands) this.#node(command);
        return;
      case 'AndOr':
        for (const command of node.commands) this.#node(command);
        return;
      case 'If':
        this.#compoundList(node.clause);
        this.#compoundList(node.then);
        if (node.else !== undefined) this.#node(node.else);
        return;
      case 'For':
        for (const word of node.wordlist) this.#word(word);
        this.#compoundList(node.body);
        return;
      case 'ArithmeticFor':
        this.#nestedArithmetic(node.initialize);
        this.#nestedArithmetic(node.test);
        this.#nestedArithmetic(node.update);
        this.#compoundList(node.body);
        return;
      case 'While':
        this.#compoundList(node.clause);
        this.#compoundList(node.body);
        return;
      case 'Select':
        for (const word of node.wordlist) this.#word(word);
        this.#compoundList(node.body);
        return;
      case 'Function':
        this.#node(node.body);
        this.#redirects(node.redirects);
        return;
      case 'Coproc':
        this.#node(node.body);
        this.#redirects(node.redirects);
        return;
      case 'Case':
        this.#word(node.word);
        for (const item of node.items) {
          for (const pattern of item.pattern) this.#word(pattern);
          this.#compoundList(item.body);
        }
        return;
      case 'TestCommand':
        this.#testExpression(node.expression);
        this.#unknown = true;
        return;
      case 'ArithmeticCommand':
        this.#nestedArithmetic(node.expression);
        this.#unknown = true;
        return;
      case 'Subshell':
      case 'BraceGroup':
        this.#compoundList(node.body);
        return;
      case 'CompoundList':
        this.#compoundList(node);
        return;
      default:
        this.#unknown = true;
    }
  }

  #compoundList(node: Extract<Node, { type: 'CompoundList' }>): void {
    for (const statement of node.commands) this.#statement(statement);
  }

  #command(command: Command): void {
    this.#commandWords(command.name, command.prefix, command.suffix);
    this.#redirects(command.redirects);
    const source = this.#source.slice(command.pos, command.end).trim();
    if (source === '') {
      this.#unknown = true;
      return;
    }
    const executableName = this.#staticWord(command.name);
    const executable = executableName?.split('/').at(-1) ?? null;
    const staticArguments = command.suffix.map((word) =>
      this.#staticWord(word),
    );
    let argv: string[] | null = null;
    if (
      executableName !== undefined &&
      staticArguments.every((value): value is string => value !== undefined)
    ) {
      argv = [executableName, ...staticArguments];
    }
    this.#commands.push({
      source,
      executable,
      executablePath: executableName ?? null,
      argv,
      executableKnown:
        command.name === undefined || executableName !== undefined,
      hasFileWriteRedirect: command.redirects.some((redirect) =>
        this.#isFileWriteRedirect(redirect),
      ),
      envPrefixes: command.prefix.map((assignment) =>
        this.#staticAssignment(assignment),
      ),
    });
  }

  /**
   * Renders an env assignment prefix.
   *
   * A dynamic value is represented as a sentinel so the segment is still
   * recognised as carrying a prefix, without pretending to know its value.
   */
  #staticAssignment(assignment: AssignmentPrefix): string {
    if (assignment.name === undefined) return '<dynamic-env-assignment>';
    const value =
      assignment.value === undefined
        ? ''
        : (this.#staticWord(assignment.value) ?? '<dynamic>');
    return `${assignment.name}=${value}`;
  }

  #commandWords(
    name: Word | undefined,
    prefixes: Command['prefix'],
    suffix: readonly Word[],
  ): void {
    this.#word(name);
    for (const assignment of prefixes) {
      this.#word(assignment.value);
      this.#parts(assignment.indexParts);
      for (const word of assignment.array ?? []) this.#word(word);
    }
    for (const word of suffix) this.#word(word);
  }

  #staticWord(word: Word | undefined): string | undefined {
    if (word === undefined) return undefined;
    const parts = word.parts;
    if (parts === undefined || parts.length === 0) return word.value;
    const rendered = this.#renderStaticParts(parts);
    return rendered;
  }

  /**
   * Renders a statically known word, expanding only $HOME and ${HOME}.
   *
   * Those two are expanded because the value is stable for the running user,
   * which lets an exact-argv grant be bound and matched later. Every other
   * expansion stays unresolved so it can never be silently baked into a grant.
   */
  #renderStaticParts(parts: readonly WordPart[]): string | undefined {
    let out = '';
    for (const part of parts) {
      switch (part.type) {
        case 'Literal':
          out += expandHome(part.value);
          continue;
        case 'SingleQuoted':
        case 'AnsiCQuoted':
          out += part.value;
          continue;
        case 'DoubleQuoted':
        case 'LocaleString': {
          const inner = this.#renderStaticParts(part.parts);
          if (inner === undefined) return undefined;
          out += inner;
          continue;
        }
        case 'SimpleExpansion': {
          // The unbraced $VAR form. Only $HOME is safe to resolve.
          if (part.text === '$HOME') {
            out += homedir();
            continue;
          }
          return undefined;
        }
        case 'ParameterExpansion': {
          // Only a bare $HOME / ${HOME} is safe to resolve. Anything using a
          // default, substring, length, indirection, or replacement operator
          // stays unresolved so it can never enter a grant.
          const isBareHome =
            part.parameter === 'HOME' &&
            part.indirect !== true &&
            part.length !== true &&
            part.operator === undefined &&
            part.operand === undefined &&
            part.slice === undefined &&
            part.replace === undefined &&
            (part.indexParts === undefined || part.indexParts.length === 0);
          if (!isBareHome) return undefined;
          out += homedir();
          continue;
        }
        default:
          return undefined;
      }
    }
    return out;
  }

  #word(word: Word | undefined): void {
    if (word === undefined) return;
    this.#parts(word.parts);
  }

  #parts(parts: readonly WordPart[] | undefined): void {
    for (const part of parts ?? []) this.#part(part);
  }

  #part(part: WordPart): void {
    switch (part.type) {
      case 'DoubleQuoted':
      case 'LocaleString':
        for (const child of part.parts) this.#part(child);
        return;
      case 'CommandExpansion':
      case 'ProcessSubstitution':
        this.#nested(part.script);
        return;
      case 'ArithmeticExpansion':
        this.#nestedArithmetic(part.expression);
        return;
      case 'ParameterExpansion':
        this.#parts(part.indexParts);
        this.#word(part.operand);
        this.#word(part.slice?.offset);
        this.#word(part.slice?.length);
        this.#word(part.replace?.pattern);
        this.#word(part.replace?.replacement);
        return;
      case 'ExtendedGlob':
      case 'BraceExpansion':
        this.#parts(part.parts);
        return;
      case 'Literal':
      case 'SingleQuoted':
      case 'AnsiCQuoted':
      case 'SimpleExpansion':
        return;
      default:
        this.#unknown = true;
    }
  }

  #testExpression(
    expression: Extract<Node, { type: 'TestCommand' }>['expression'],
  ): void {
    switch (expression.type) {
      case 'TestUnary':
        this.#word(expression.operand);
        return;
      case 'TestBinary':
        this.#word(expression.left);
        this.#word(expression.right);
        return;
      case 'TestLogical':
        this.#testExpression(expression.left);
        this.#testExpression(expression.right);
        return;
      case 'TestNot':
        this.#testExpression(expression.operand);
        return;
      case 'TestGroup':
        this.#testExpression(expression.expression);
        return;
      default:
        this.#unknown = true;
    }
  }

  #nestedArithmetic(expression: ArithmeticExpression | undefined): void {
    if (expression === undefined) {
      this.#unknown = true;
      return;
    }
    switch (expression.type) {
      case 'ArithmeticCommandExpansion':
        this.#nested(expression.script);
        return;
      case 'ArithmeticWord':
        this.#parts(expression.parts);
        return;
      case 'ArithmeticBinary':
        this.#nestedArithmetic(expression.left);
        this.#nestedArithmetic(expression.right);
        return;
      case 'ArithmeticUnary':
        this.#nestedArithmetic(expression.operand);
        return;
      case 'ArithmeticTernary':
        this.#nestedArithmetic(expression.test);
        this.#nestedArithmetic(expression.consequent);
        this.#nestedArithmetic(expression.alternate);
        return;
      case 'ArithmeticGroup':
        this.#nestedArithmetic(expression.expression);
        return;
      default:
        this.#unknown = true;
    }
  }

  #isFileWriteRedirect(redirect: Redirect): boolean {
    if (!['>', '>>', '>|', '<>', '&>', '&>>'].includes(redirect.operator)) {
      return false;
    }
    if (redirect.target === undefined) return true;
    if (/^\d+$/.test(redirect.target.value)) return false;
    // Discarding a stream to /dev/null creates no file and touches no data.
    if (expandHome(redirect.target.value) === '/dev/null') return false;
    return !redirect.target.parts?.some(
      (part) => part.type === 'ProcessSubstitution',
    );
  }

  #redirects(redirects: readonly Redirect[]): void {
    for (const redirect of redirects) {
      if (redirect.operator.startsWith('<<')) this.#unknown = true;
      this.#word(redirect.target);
      this.#word(redirect.body);
    }
  }

  #nested(script: ParsedScript | undefined): void {
    if (script === undefined) {
      this.#unknown = true;
      return;
    }
    if ((script.errors?.length ?? 0) > 0) this.#unknown = true;
    this.#nestedScripts.push(script);
  }
}

/** Decomposes Bash source into exact simple-command slices and nested scripts. */
export function extractShellStructure(source: string): ShellStructure {
  return extractParsedShellStructure(parse(source), source);
}

/** Decomposes an already parsed script while preserving its source positions. */
export function extractParsedShellStructure(
  script: ParsedScript,
  source: string,
): ShellStructure {
  return new Extractor(source).extract(script);
}
