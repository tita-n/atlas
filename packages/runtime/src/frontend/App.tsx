import { useState, useEffect, useRef } from 'react';

const API_URL = '';

interface Agent {
  name: string;
  description: string;
}

interface Message {
  id: string;
  type: string;
  sender: string;
  content: string;
  timestamp: string;
}

interface ProviderStatus {
  primary: string;
  fallback: string | null;
}

interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number;
}

// Agent name colors for text/borders only - dots follow red=active, grey=idle rule
const AGENT_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  'Atlas': { bg: 'bg-red-900/50', border: 'border-red-500', text: 'text-red-400' },
  'Research': { bg: 'bg-orange-900/50', border: 'border-orange-500', text: 'text-orange-400' },
  'Planner': { bg: 'bg-purple-900/50', border: 'border-purple-500', text: 'text-purple-400' },
  'user': { bg: 'bg-gray-800', border: 'border-gray-600', text: 'text-gray-300' },
};

function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({ primary: 'none', fallback: null });
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [keyConnected, setKeyConnected] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [memoryCounts, setMemoryCounts] = useState<Record<string, number>>({ Atlas: 0, Research: 0, Planner: 0 });
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [selectedAgentMemories, setSelectedAgentMemories] = useState<any[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchAgents = async () => {
    try {
      const res = await fetch(`${API_URL}/agents`);
      const data = await res.json();
      setAgents(data.agents || []);
    } catch (e) {
      console.error("Failed to fetch agents", e);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API_URL}/history`);
      const data = await res.json();
      setMessages(data.history || []);
    } catch (e) {
      console.error("Failed to fetch history", e);
    }
  };

  const fetchMemoryStats = async () => {
    try {
      const res = await fetch(`${API_URL}/memory/stats`);
      const data = await res.json();
      setMemoryCounts(data.counts || {});
    } catch (e) {
      // Memory might not be initialized yet
    }
  };

  const fetchAgentMemories = async (agentName: string) => {
    try {
      const res = await fetch(`${API_URL}/memory/${agentName}`);
      const data = await res.json();
      setSelectedAgentMemories(data.memories || []);
    } catch (e) {
      console.error("Failed to fetch memories:", e);
    }
  };

  const checkConnection = async () => {
    try {
      const res = await fetch(`${API_URL}/health`);
      const data = await res.json();
      setProviderStatus({
        primary: data.primary || 'none',
        fallback: data.fallback || null
      });
      if (data.primary !== 'none') {
        setKeyConnected(true);
      }
    } catch (e) {
      setProviderStatus({ primary: 'none', fallback: null });
    }
  };

  const connectOpenRouter = async () => {
    if (!openrouterKey.trim()) return;
    setFetchingModels(true);
    try {
      // Save key to backend first
      await fetch(`${API_URL}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openrouterApiKey: openrouterKey })
      });

      // Fetch available models
      const res = await fetch(`${API_URL}/openrouter/models`);
      const data = await res.json();
      if (data.models) {
        setModels(data.models);

        // Auto-select a good default model
        const defaultModel = data.models.find((m: any) => 
          m.id.includes('gpt-4o-mini') || m.id.includes('gpt-4o') || m.id.includes('claude-3-haiku')
        );
        if (defaultModel) {
          setSelectedModel(defaultModel.id);
        } else if (data.models.length > 0) {
          setSelectedModel(data.models[0].id);
        }

        setKeyConnected(true);
        checkConnection();
      }
    } catch (error) {
      console.error("Failed to connect:", error);
    }
    setFetchingModels(false);
  };

  const saveSelectedModel = () => {
    if (selectedModel) {
      console.log('Saving model:', selectedModel);
      localStorage.setItem('atlas_openrouter_model', selectedModel);
      fetch(`${API_URL}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedModel })
      }).then(() => {
        console.log('Model saved successfully');
        setShowSettings(false);
        checkConnection();
      });
    }
  };

  const filteredModels = models.filter(m => 
    m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
    m.id.toLowerCase().includes(modelSearch.toLowerCase())
  );

  useEffect(() => {
    fetchAgents();
    fetchHistory();
    checkConnection();
    fetchMemoryStats();

    const savedKey = localStorage.getItem('atlas_openrouter_key');
    const savedModel = localStorage.getItem('atlas_openrouter_model');
    if (savedKey) setOpenrouterKey(savedKey);
    if (savedModel) setSelectedModel(savedModel);

    const interval = setInterval(() => {
      fetchHistory();
      checkConnection();
      fetchMemoryStats();
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isProcessing) return;

    setIsProcessing(true);
    const tempId = Date.now().toString();
    const tempMessage: Message = {
      id: tempId,
      type: 'user',
      sender: 'user',
      content: input,
      timestamp: new Date().toISOString()
    };
    setMessages(prev => [...prev, tempMessage]);
    setInput('');

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: tempMessage.content, sender: 'user' })
      });
      if (!res.ok) {
        const err = await res.json();
        console.error("Chat error:", err);
      }
    } catch (error) {
      console.error("Failed to send message", error);
    }
    setIsProcessing(false);
  };

  return (
    <div className="flex h-screen bg-black text-gray-100 font-mono">
      {/* Settings Overlay */}
      {showSettings && (
        <div 
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center"
          onClick={() => setShowSettings(false)}
        >
          <div 
            className="bg-gray-950 border border-red-500/50 rounded-lg p-6 w-[480px] shadow-lg shadow-red-500/20 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-red-400 tracking-wider">SETTINGS</h2>
              <button 
                onClick={() => setShowSettings(false)}
                className="text-gray-500 hover:text-red-400 transition"
              >
                ✕
              </button>
            </div>

            <div className="space-y-6">
              {/* Step 1: API Key */}
              <div>
                <label className="block text-xs text-red-400 mb-2 tracking-widest">STEP 1: OPENROUTER API KEY</label>
                <div className="flex space-x-2">
                  <input
                    type="password"
                    value={openrouterKey}
                    onChange={(e) => {
                      setOpenrouterKey(e.target.value);
                      localStorage.setItem('atlas_openrouter_key', e.target.value);
                      setKeyConnected(false);
                    }}
                    placeholder="sk-or-..."
                    className="flex-1 bg-black border border-gray-700 hover:border-red-500/50 focus:border-red-500 rounded px-3 py-2 text-sm text-gray-300 focus:outline-none transition"
                  />
                  <button
                    onClick={connectOpenRouter}
                    disabled={!openrouterKey.trim() || fetchingModels}
                    className={`px-4 py-2 rounded font-medium transition whitespace-nowrap ${
                      openrouterKey.trim() && !fetchingModels
                        ? 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-500/20'
                        : 'bg-gray-800 text-gray-600 cursor-not-allowed'
                    }`}
                  >
                    {fetchingModels ? 'CONNECTING...' : 'CONNECT'}
                  </button>
                </div>
                {keyConnected && (
                  <div className="text-xs text-green-400 mt-2 flex items-center space-x-1">
                    <span>●</span>
                    <span>Connected — {models.length} models available</span>
                  </div>
                )}
              </div>

              {/* Step 2: Model Selector */}
              <div className={`transition-opacity ${keyConnected ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                <label className="block text-xs text-red-400 mb-2 tracking-widest">STEP 2: SELECT MODEL</label>
                <div className="relative">
                  <input
                    type="text"
                    value={modelSearch}
                    onChange={(e) => {
                      setModelSearch(e.target.value);
                      setShowModelDropdown(true);
                    }}
                    onFocus={() => setShowModelDropdown(true)}
                    placeholder="Search models..."
                    className="w-full bg-black border border-gray-700 hover:border-red-500/50 focus:border-red-500 rounded px-3 py-2 text-sm text-gray-300 focus:outline-none transition"
                  />

                  {selectedModel && !showModelDropdown && (
                    <div className="mt-2 text-xs text-gray-400">
                      Selected: <span className="text-red-400">{selectedModel}</span>
                    </div>
                  )}

                  {showModelDropdown && models.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-gray-950 border border-gray-700 rounded-lg max-h-60 overflow-y-auto shadow-xl">
                      {filteredModels.map(model => (
                        <button
                          key={model.id}
                          onClick={() => {
                            setSelectedModel(model.id);
                            setModelSearch('');
                            setShowModelDropdown(false);
                          }}
                          className={`w-full text-left px-3 py-2 hover:bg-gray-800 transition ${
                            selectedModel === model.id ? 'bg-red-900/30 border-l-2 border-red-500' : ''
                          }`}
                        >
                          <div className="text-sm text-gray-300">{model.name}</div>
                          <div className="text-xs text-gray-600">
                            {model.id} • {model.contextLength > 0 ? `${(model.contextLength / 1000).toFixed(0)}k ctx` : 'N/A'}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Save Button */}
              <div className="pt-4 border-t border-gray-800">
                <button
                  onClick={saveSelectedModel}
                  disabled={!keyConnected}
                  className={`w-full px-4 py-2 rounded font-medium transition ${
                    keyConnected
                      ? 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-500/20'
                      : 'bg-gray-800 text-gray-600 cursor-not-allowed'
                  }`}
                >
                  SAVE CONFIGURATION
                </button>
              </div>

              {/* Status */}
              <div className="text-xs text-gray-500">
                <p>Provider: <span className={providerStatus.primary === 'none' ? 'text-gray-600' : 'text-green-400'}>
                  {providerStatus.primary || 'not configured'}
                </span></p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Memory Panel Overlay */}
      {showMemoryPanel && (
        <div 
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center"
          onClick={() => setShowMemoryPanel(false)}
        >
          <div 
            className="bg-gray-950 border border-red-500/50 rounded-lg p-6 w-[600px] shadow-lg shadow-red-500/20 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-red-400 tracking-wider">MEMORY</h2>
              <button 
                onClick={() => setShowMemoryPanel(false)}
                className="text-gray-500 hover:text-red-400 transition"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              {selectedAgentMemories.length === 0 ? (
                <div className="text-gray-500 text-sm">No memories stored yet</div>
              ) : (
                selectedAgentMemories.map((mem, idx) => (
                  <div key={idx} className="bg-gray-900 rounded p-3 border border-gray-800">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-red-400">{mem.agentName}</span>
                      <span className="text-xs text-gray-600">
                        {new Date(mem.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-sm text-gray-300">{mem.content}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Left Sidebar */}
      <div className="w-64 bg-gray-950 border-r border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-red-600 rounded flex items-center justify-center shadow-lg shadow-red-500/30">
                <span className="text-white font-bold text-sm">A</span>
              </div>
              <span className="text-lg font-bold tracking-wider text-red-400">ATLAS</span>
            </div>
            <button 
              onClick={() => setShowSettings(true)}
              className="text-gray-500 hover:text-red-400 transition p-1"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>

          <div className={`flex items-center space-x-2 text-xs ${
            providerStatus.primary !== 'none' ? 'text-green-400' : 'text-gray-500'
          }`}>
            <div className={`w-2 h-2 rounded-full ${
              providerStatus.primary !== 'none' ? 'bg-green-500 shadow-lg shadow-green-500/50' : 'bg-gray-600'
            }`}></div>
            <span className="tracking-widest">
              {providerStatus.primary === 'ollama' && 'LOCAL (OLLAMA)'}
              {providerStatus.primary === 'openrouter' && 'CLOUD (OPENROUTER)'}
              {providerStatus.primary === 'none' && 'NO PROVIDER'}
            </span>
          </div>
        </div>

        {/* Agent List */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="text-xs text-gray-600 tracking-widest mb-3 px-2">AGENTS</div>
          <div className="space-y-1">
            {agents.map(agent => {
              const colors = AGENT_COLORS[agent.name] || AGENT_COLORS['Atlas'];
              const active = isProcessing;
              const memoryCount = memoryCounts[agent.name] || 0;
              return (
                <div 
                  key={agent.name} 
                  className="group flex items-center space-x-3 p-2 rounded cursor-pointer transition hover:bg-gray-900"
                >
                  {/* Status: red=active, grey=idle */}
                  <div className={`w-2 h-2 rounded-full ${
                    active 
                      ? 'bg-red-500 shadow-lg shadow-red-500/50 animate-pulse' 
                      : 'bg-gray-600'
                  }`}></div>

                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium ${colors.text}`}>{agent.name}</div>
                    <div className="text-xs text-gray-600 truncate">{agent.description}</div>
                  </div>

                  {/* Memory Badge */}
                  <button
                    onClick={() => {
                      fetchAgentMemories(agent.name);
                      setShowMemoryPanel(true);
                    }}
                    className="text-xs bg-gray-800 hover:bg-gray-700 px-1.5 py-0.5 rounded border border-gray-700"
                    title={`${memoryCount} memories`}
                  >
                    {memoryCount > 0 ? `${memoryCount}` : '0'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="p-3 border-t border-gray-800">
          <div className="text-xs text-gray-700">
            <span className="text-gray-600">v1.0.0</span>
            <span className="mx-2">•</span>
            <span>Local-First</span>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-black">
        <div className="h-12 border-b border-gray-800 flex items-center px-4 bg-gray-950/50 backdrop-blur">
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 bg-red-600/20 rounded flex items-center justify-center">
              <span className="text-red-400 text-xs font-bold">A</span>
            </div>
            <span className="text-sm text-gray-400 tracking-wider">DASHBOARD</span>
          </div>
          <div className="ml-auto flex items-center space-x-4">
            <div className={`flex items-center space-x-2 text-xs ${
              providerStatus.primary !== 'none' ? 'text-green-400' : 'text-gray-600'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${
                providerStatus.primary !== 'none' ? 'bg-green-500' : 'bg-gray-600'
              }`}></div>
              <span>{
                providerStatus.primary === 'ollama' ? 'LOCAL INFERENCE' : 
                providerStatus.primary === 'openrouter' ? 'CLOUD API' :
                'NO PROVIDER — CONFIGURE IN SETTINGS'
              }</span>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="text-gray-700 text-6xl mb-4">◆</div>
                <div className="text-gray-600 text-sm tracking-widest">
                  {providerStatus.primary !== 'none' ? 'READY' : 'CONFIGURE A PROVIDER TO BEGIN'}
                </div>
                <div className="text-gray-700 text-xs mt-2">
                  {providerStatus.primary === 'none' 
                    ? 'Click the gear icon to set up OpenRouter' 
                    : 'Send a message to start'}
                </div>
              </div>
            </div>
          )}

          {messages.map((msg, index) => {
            const isUser = msg.type === 'user';
            const colors = AGENT_COLORS[isUser ? 'user' : msg.sender] || AGENT_COLORS['Atlas'];
            const isConsecutive = index > 0 && messages[index - 1].sender === msg.sender && !isUser;

            return (
              <div 
                key={msg.id} 
                className={`flex ${isUser ? 'justify-end' : 'justify-start'} ${isConsecutive ? 'mt-1' : 'mt-4'}`}
              >
                <div className={`max-w-[75%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
                  {!isUser && !isConsecutive && (
                    <div className={`flex items-center space-x-2 mb-1 px-1`}>
                      <div className="w-1.5 h-1.5 rounded-full bg-red-500"></div>
                      <span className={`text-xs ${colors.text} tracking-wider`}>{msg.sender.toUpperCase()}</span>
                    </div>
                  )}

                  <div className={`
                    ${isUser 
                      ? 'bg-gradient-to-r from-red-900/40 to-red-800/40 border-red-700/50' 
                      : `${colors.bg} ${colors.border} border`}
                    rounded-lg px-4 py-2.5 shadow-lg
                    ${isUser ? 'rounded-br-sm' : 'rounded-bl-sm'}
                  `}>
                    <div className="text-gray-200 leading-relaxed whitespace-pre-wrap">{msg.content}</div>
                  </div>

                  <div className="text-xs text-gray-700 mt-1 px-1">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-gray-800 bg-gray-950/80 backdrop-blur-sm p-4">
          <form onSubmit={handleSend} className="flex items-center space-x-3">
            <div className="flex-1 relative">
              <div className="absolute inset-0 bg-gradient-to-r from-red-900/20 to-transparent rounded"></div>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={providerStatus.primary !== 'none' ? "Enter command..." : "Configure provider first..."}
                disabled={providerStatus.primary === 'none'}
                className="relative w-full bg-black/50 border border-gray-800 hover:border-red-500/50 focus:border-red-500 rounded-lg px-4 py-3 text-gray-300 placeholder-gray-600 focus:outline-none transition shadow-inner disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600">
                <kbd className="text-xs px-1.5 py-0.5 bg-gray-900 rounded">↵</kbd>
              </div>
            </div>

            <button
              type="submit"
              disabled={!input.trim() || isProcessing || providerStatus.primary === 'none'}
              className={`
                px-6 py-3 rounded-lg font-medium tracking-wider transition-all
                ${input.trim() && !isProcessing && providerStatus.primary !== 'none'
                  ? 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-500/30' 
                  : 'bg-gray-900 text-gray-600 cursor-not-allowed'
                }
              `}
            >
              {isProcessing ? 'PROCESSING...' : 'TRANSMIT'}
            </button>
          </form>

          <div className="flex items-center justify-between mt-2 px-1">
            <div className="text-xs text-gray-700 flex items-center space-x-2">
              <span>◆</span>
              <span>Atlas v1.0.0</span>
            </div>
            <div className="text-xs text-gray-700">
              {messages.length} messages
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
