export interface AgentConfig {
  name: string;
  systemPrompt: string;
  model: string;
  description: string;
}

export const agents: AgentConfig[] = [
  {
    name: 'Atlas',
    systemPrompt: 'You are Atlas, a helpful AI assistant. You help users with various tasks including answering questions, summarizing information, and organizing tasks. Be concise and helpful.',
    model: 'openai/gpt-4o-mini',
    description: 'General purpose AI assistant'
  },
  {
    name: 'Research',
    systemPrompt: 'You are Research, a summarizer agent. Your job is to summarize information and provide concise research answers.',
    model: 'openai/gpt-4o-mini',
    description: 'Summarizes information'
  },
  {
    name: 'Planner',
    systemPrompt: 'You are Planner, a triage agent. Your job is to extract todos, calendar events, and action items from text.',
    model: 'openai/gpt-4o-mini',
    description: 'Extracts todos and calendar events'
  }
];

export function getAgent(name: string): AgentConfig | undefined {
  return agents.find(a => a.name.toLowerCase() === name.toLowerCase());
}

export function listAgents(): AgentConfig[] {
  return agents;
}
