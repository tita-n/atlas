#!/usr/bin/env node
/**
 * A deterministic, scripted OpenAI-compatible provider for the Layer 2 harness.
 *
 * The point of Layer 2 is to exercise the REAL front-ends and the REAL gate, so
 * the model must emit genuine tool calls - not text that merely looks like one.
 * The old harness failed here in two ways worth naming, and this version fixes
 * both:
 *
 *   1. Its cells were graded on the transcript, which a text reply can spoof.
 *      Here every request is logged with the tools that were OFFERED, and the
 *      grader asserts a real `tool_calls` entry was produced.
 *   2. The script was read once at startup, so cells could not share a provider.
 *      Here the script file is re-read on every request, so one long-lived
 *      provider serves the whole matrix and the script is swapped per cell.
 *
 * The sequence is consumed one entry per request. An entry with `tool` produces
 * a tool call; anything else produces a final text answer, which ends the turn.
 */

import { createServer } from 'node:http';
import { appendFileSync, readFileSync, statSync } from 'node:fs';

const scriptPath = process.env['SCRIPT_FILE'] ?? '/harness/data/script.json';
const logPath = process.env['PROVIDER_LOG'] ?? '/harness/data/provider.log';
const port = Number(process.env['MOCK_PORT'] ?? 21800);

let turn = 0;
let lastMtime = -1;

function readScript() {
  try {
    return JSON.parse(readFileSync(scriptPath, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * The turn counter restarts whenever the script file changes.
 *
 * The provider is long-lived across the whole matrix; each cell writes its own
 * `script.json`. Without this reset, cell two would start at cell one's final
 * turn and silently fall through to the `{ text: 'done' }` default, which is
 * exactly the "the tool never ran" bug this harness exists to catch.
 */
function scriptChanged() {
  try {
    const mtime = statSync(scriptPath).mtimeMs;
    if (mtime !== lastMtime) {
      lastMtime = mtime;
      return true;
    }
  } catch {
    /* keep the old counter */
  }
  return false;
}

function log(entry) {
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    /* logging must never take the provider down */
  }
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      parsed = {};
    }
    // `turn` is per-request; a new script file (a new cell) resets it.
    if (scriptChanged()) turn = 0;
    const script = readScript();
    const step = script[turn] ?? { text: 'done' };
    turn += 1;
    const offered = (parsed.tools ?? [])
      .map((tool) => tool?.function?.name)
      .filter((name) => typeof name === 'string');
    log({ turn, offered, step, messages: (parsed.messages ?? []).length });

    const toolCall = step?.tool;
    if (toolCall) {
      const completion = {
        id: `mock-${turn}`,
        object: 'chat.completion',
        created: 0,
        model: parsed.model ?? 'mock',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: step.say ?? 'working',
              tool_calls: [
                {
                  id: `call_${turn}`,
                  type: 'function',
                  function: {
                    name: toolCall,
                    arguments: JSON.stringify(step.args ?? {}),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
      if (parsed.stream === true) {
        // OpenAI-compatible SSE: content delta first, then the tool_call
        // delta, then the finish chunk, then [DONE]. Without this the TUI's
        // stream parser sees no events and reports an empty reply.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish) =>
          `data: ${JSON.stringify({
            id: completion.id,
            object: 'chat.completion.chunk',
            created: 0,
            model: completion.model,
            choices: [{ index: 0, delta, finish_reason: finish ?? null }],
          })}\n\n`;
        if (step.say ?? 'working') res.write(chunk({ role: 'assistant', content: step.say ?? 'working' }));
        res.write(chunk({ tool_calls: [{ index: 0, id: `call_${turn}`, type: 'function', function: { name: toolCall, arguments: JSON.stringify(step.args ?? {}) } }] }));
        res.write(chunk({}, 'tool_calls'));
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completion));
      }
      return;
    }

    const textCompletion = {
      id: `mock-${turn}`,
      object: 'chat.completion',
      created: 0,
      model: parsed.model ?? 'mock',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: step?.text ?? 'done' },
          finish_reason: 'stop',
        },
      ],
    };
    if (parsed.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({
        id: textCompletion.id,
        object: 'chat.completion.chunk',
        created: 0,
        model: textCompletion.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: step?.text ?? 'done' }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: textCompletion.id,
        object: 'chat.completion.chunk',
        created: 0,
        model: textCompletion.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(textCompletion));
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`mock-provider on ${port}\n`);
});
