import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

// Tool types
export interface ToolCall {
  id: string;
  tool: string;
  input: Record<string, any>;
  timestamp: Date;
  status: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';
  result?: any;
  error?: string;
  executionTime?: number;
  autonomous: boolean;
  agentName: string;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  requiresApproval: boolean;
  execute: (input: Record<string, any>) => Promise<ToolResult>;
}

interface AuditEntry {
  id: string;
  timestamp: string;
  agentName: string;
  toolName: string;
  input: Record<string, any>;
  output: any;
  success: boolean;
  autonomous: boolean;
  executionTime: number;
}

// Project root directory for security
const PROJECT_ROOT = path.resolve(__dirname, '../..');
console.log('PROJECT_ROOT:', PROJECT_ROOT);

// Pending approvals store
const pendingApprovals: Map<string, ToolCall> = new Map();

// Audit log
const AUDIT_LOG_PATH = path.join(PROJECT_ROOT, 'data', 'tool_audit.json');

async function loadAuditLog(): Promise<AuditEntry[]> {
  try {
    const data = await fs.readFile(AUDIT_LOG_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveAuditEntry(entry: AuditEntry): Promise<void> {
  const log = await loadAuditLog();
  log.push(entry);
  if (log.length > 1000) log.shift();
  const dir = path.dirname(AUDIT_LOG_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(AUDIT_LOG_PATH, JSON.stringify(log, null, 2));
}

function validatePath(filePath: string, allowOutside: boolean = false): boolean {
  const resolved = path.resolve(PROJECT_ROOT, filePath);
  if (!allowOutside && !resolved.startsWith(PROJECT_ROOT)) {
    return false;
  }
  return true;
}

const ALLOWED_COMMANDS = ['ls', 'cat', 'mkdir', 'npm', 'node', 'git', 'cd', 'pwd', 'echo', 'dir'];

function validateCommand(command: string): boolean {
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0) return false;
  const cmd = path.basename(parts[0]);
  return ALLOWED_COMMANDS.includes(cmd);
}

// Tool definitions
export const tools: Map<string, ToolDefinition> = new Map();

tools.set('web_search', {
  name: 'web_search',
  description: 'Search the web using DuckDuckGo',
  requiresApproval: false,
  async execute(input: Record<string, any>): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const query = input.query as string;
      if (!query) throw new Error('Query is required');

      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const response = await fetch(url);
      const data = await response.json() as any;

      const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const htmlResponse = await fetch(htmlUrl);
      const html = await htmlResponse.text();

      const results: { title: string; snippet: string; url: string }[] = [];
      const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g;
      const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/g;

      let match;
      const links: string[] = [];
      const snippets: string[] = [];

      while ((match = linkRegex.exec(html)) !== null) {
        links.push(match[1].replace(/<\/?(?:a|b)[^>]*>/g, '').trim());
      }

      while ((match = snippetRegex.exec(html)) !== null) {
        snippets.push(match[1].replace(/<\/(?:a|b)[^>]*>/g, '').trim());
      }

      const titleRegex = /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/g;
      const titles: string[] = [];
      while ((match = titleRegex.exec(html)) !== null) {
        titles.push(match[1].replace(/<\/(?:a|b)[^>]*>/g, '').trim());
      }

      for (let i = 0; i < Math.min(titles.length, 5); i++) {
        results.push({
          title: titles[i] || '',
          snippet: snippets[i] || '',
          url: links[i] || ''
        });
      }

      const instantAnswer = data.AbstractText || data.Definition || '';
      const answerSource = data.AbstractSource || '';

      return {
        success: true,
        data: {
          query,
          instantAnswer: instantAnswer ? { text: instantAnswer, source: answerSource } : null,
          results: results.slice(0, 5),
          relatedTopics: (data.RelatedTopics || []).slice(0, 3).map((t: any) => ({
            text: t.Text,
            url: t.FirstURL
          }))
        },
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        executionTime: Date.now() - startTime
      };
    }
  }
});

tools.set('file_reader', {
  name: 'file_reader',
  description: 'Read contents of a file',
  requiresApproval: false,
  async execute(input: Record<string, any>): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const filePath = input.path as string;
      if (!filePath) throw new Error('File path is required');

      if (!validatePath(filePath)) {
        throw new Error('Access denied: path outside project directory');
      }

      const fullPath = path.resolve(PROJECT_ROOT, filePath);
      const stats = await fs.stat(fullPath);

      if (stats.isDirectory()) {
        throw new Error('Path is a directory, not a file');
      }

      if (stats.size > 1024 * 1024) {
        throw new Error('File too large (max 1MB)');
      }

      const ext = path.extname(filePath).toLowerCase();
      const supportedExts = ['.txt', '.md', '.json', '.ts', '.js', '.tsx', '.jsx', '.html', '.css', '.yaml', '.yml', '.toml', '.env'];
      if (!supportedExts.includes(ext)) {
        throw new Error(`Unsupported file type: ${ext}`);
      }

      const content = await fs.readFile(fullPath, 'utf-8');

      return {
        success: true,
        data: {
          path: filePath,
          content,
          size: stats.size,
          extension: ext,
          modified: stats.mtime.toISOString()
        },
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        executionTime: Date.now() - startTime
      };
    }
  }
});

tools.set('file_writer', {
  name: 'file_writer',
  description: 'Create or overwrite a file',
  requiresApproval: true,
  async execute(input: Record<string, any>): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const filePath = input.path as string;
      const content = input.content as string;

      if (!filePath) throw new Error('File path is required');
      if (content === undefined) throw new Error('Content is required');

      if (!validatePath(filePath)) {
        throw new Error('Access denied: path outside project directory');
      }

      const fullPath = path.resolve(PROJECT_ROOT, filePath);
      const dir = path.dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      const stats = await fs.stat(fullPath);

      return {
        success: true,
        data: {
          path: filePath,
          size: stats.size,
          created: stats.birthtime.toISOString(),
          modified: stats.mtime.toISOString()
        },
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        executionTime: Date.now() - startTime
      };
    }
  }
});

tools.set('terminal_command', {
  name: 'terminal_command',
  description: 'Execute a terminal command (whitelist: ls, cat, mkdir, npm, node, git, cd, pwd, echo, dir)',
  requiresApproval: true,
  async execute(input: Record<string, any>): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const command = input.command as string;
      const workingDir = input.workingDir as string || PROJECT_ROOT;

      if (!command) throw new Error('Command is required');

      if (!validateCommand(command)) {
        throw new Error(`Command not allowed. Whitelist: ${ALLOWED_COMMANDS.join(', ')}`);
      }

      const resolvedDir = path.resolve(PROJECT_ROOT, workingDir);
      if (!resolvedDir.startsWith(PROJECT_ROOT)) {
        throw new Error('Access denied: working directory outside project');
      }

      const { stdout, stderr } = await execAsync(command, {
        cwd: resolvedDir,
        timeout: 30000,
        maxBuffer: 1024 * 1024
      });

      return {
        success: true,
        data: {
          command,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          workingDir: resolvedDir
        },
        executionTime: Date.now() - startTime
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Command execution failed',
        data: {
          stdout: error.stdout?.trim() || '',
          stderr: error.stderr?.trim() || ''
        },
        executionTime: Date.now() - startTime
      };
    }
  }
});

export class ToolEngine {
  private pendingApprovals: Map<string, ToolCall> = new Map();

  generateId(): string {
    return `tool-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  getTool(name: string): ToolDefinition | undefined {
    return tools.get(name);
  }

  listTools(): ToolDefinition[] {
    return Array.from(tools.values());
  }

  async requestExecution(
    toolName: string,
    input: Record<string, any>,
    agentName: string,
    autonomous: boolean = false
  ): Promise<{ call: ToolCall; needsApproval: boolean }> {
    const tool = tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const call: ToolCall = {
      id: this.generateId(),
      tool: toolName,
      input,
      timestamp: new Date(),
      status: tool.requiresApproval ? 'pending' : 'approved',
      autonomous,
      agentName
    };

    if (tool.requiresApproval) {
      this.pendingApprovals.set(call.id, call);
      return { call, needsApproval: true };
    }

    const result = await this.executeTool(call);
    call.status = result.success ? 'completed' : 'failed';
    call.result = result.data;
    call.error = result.error;
    call.executionTime = result.executionTime;

    await saveAuditEntry({
      id: call.id,
      timestamp: new Date().toISOString(),
      agentName: call.agentName,
      toolName: call.tool,
      input: call.input,
      output: result.data,
      success: result.success,
      autonomous: call.autonomous,
      executionTime: result.executionTime || 0
    });

    return { call, needsApproval: false };
  }

  async approveTool(callId: string): Promise<ToolCall> {
    const call = this.pendingApprovals.get(callId);
    if (!call) {
      throw new Error(`No pending approval found for ID: ${callId}`);
    }

    call.status = 'approved';
    this.pendingApprovals.delete(callId);

    const result = await this.executeTool(call);
    call.status = result.success ? 'completed' : 'failed';
    call.result = result.data;
    call.error = result.error;
    call.executionTime = result.executionTime;

    await saveAuditEntry({
      id: call.id,
      timestamp: new Date().toISOString(),
      agentName: call.agentName,
      toolName: call.tool,
      input: call.input,
      output: result.data,
      success: result.success,
      autonomous: false,
      executionTime: result.executionTime || 0
    });

    return call;
  }

  async rejectTool(callId: string): Promise<ToolCall> {
    const call = this.pendingApprovals.get(callId);
    if (!call) {
      throw new Error(`No pending approval found for ID: ${callId}`);
    }

    call.status = 'rejected';
    this.pendingApprovals.delete(callId);

    await saveAuditEntry({
      id: call.id,
      timestamp: new Date().toISOString(),
      agentName: call.agentName,
      toolName: call.tool,
      input: call.input,
      output: { rejected: true },
      success: false,
      autonomous: false,
      executionTime: 0
    });

    return call;
  }

  getPendingApprovals(): ToolCall[] {
    return Array.from(this.pendingApprovals.values());
  }

  private async executeTool(call: ToolCall): Promise<ToolResult> {
    const tool = tools.get(call.tool);
    if (!tool) {
      return { success: false, error: 'Tool not found', executionTime: 0 };
    }

    try {
      return await tool.execute(call.input);
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        executionTime: 0
      };
    }
  }

  canExecuteAutonomously(toolName: string): boolean {
    const tool = tools.get(toolName);
    return tool ? !tool.requiresApproval : false;
  }
}

export const toolEngine = new ToolEngine();
