import React, { useState } from 'react';
import {
  Bot,
  PlugZap,
  Send,
  Server,
  Sparkles,
  X,
} from 'lucide-react';
import {
  AgentEndpointConfig,
  CandidatePathway,
  ReferralIntakeForm,
  TractDemographics,
} from '../types/partC';
import { askTriageAgent, ChatTurn } from '../services/adkClient';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  config: AgentEndpointConfig;
  onChangeConfig: (cfg: AgentEndpointConfig) => void;
  form: ReferralIntakeForm;
  tract: TractDemographics;
  recommendedPath: CandidatePathway;
  bounceTrapPath: CandidatePathway;
}

const JUDGE_PROMPT_CHIPS = [
  "Which <=45-day bilingual Medi-Cal pathway clears the clock for today's 20-month-old?",
  'Why does Coordinator Hub #11 look healthy in a flat spreadsheet yet cause >45d breaches?',
  "Why didn't you filter California tracts using limited_english_rate in the ACS table?",
  'Summarize our Post-Output Equity Audit and zero-vehicle travel guardrails.',
];

export const AgentCopilotDrawer: React.FC<Props> = ({
  isOpen,
  onClose,
  config,
  onChangeConfig,
  form,
  tract,
  recommendedPath,
  bounceTrapPath,
}) => {
  const [sessionId] = useState(() => `ca-triage-${Date.now()}`);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Ready to assist California Early Start triage. Ask me to trace multi-hop ISO GQL paths, diagnose Coordinator #11/#12 paper-fax bounce loops, or switch to your live deployed ADK / Cloud Run endpoint above.',
      sourceBadge: 'Local CA ReferralGraph Engine',
      timestamp: 'Ready',
    },
  ]);

  if (!isOpen) return null;

  const sendPrompt = async (promptText: string) => {
    const trimmed = promptText.trim();
    if (!trimmed || loading) return;
    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
      sourceBadge:
        config.mode === 'live_adk'
          ? 'Live ADK / Cloud Run Agent'
          : 'Local CA ReferralGraph Engine',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setTurns((prev) => [...prev, userTurn]);
    setInput('');
    setLoading(true);

    const res = await askTriageAgent({
      prompt: trimmed,
      config,
      sessionId,
      form,
      tract,
      recommendedPath,
      bounceTrapPath,
    });

    const botTurn: ChatTurn = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: res.errorNote ? `_${res.errorNote}_\n\n${res.reply}` : res.reply,
      sourceBadge: res.usedLiveEndpoint
        ? 'Live ADK / Cloud Run Agent'
        : 'Local CA ReferralGraph Engine',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setTurns((prev) => [...prev, botTurn]);
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-white h-full shadow-2xl border-l border-slate-200 flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-indigo-500/20 border border-indigo-400/30">
              <Bot className="w-5 h-5 text-indigo-300" />
            </div>
            <div>
              <h3 className="text-sm font-bold">ADK Triage & Network-Audit Agent</h3>
              <p className="text-[11px] text-slate-300 flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 rounded-full ${
                    config.mode === 'live_adk' ? 'bg-emerald-400' : 'bg-indigo-400'
                  }`}
                />
                {config.mode === 'live_adk'
                  ? `Live Endpoint: ${config.baseUrl}`
                  : 'Pre-loaded CA ReferralGraph Engine (Instant)'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowSettings((s) => !s)}
              className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium flex items-center gap-1"
            >
              <PlugZap className="w-3.5 h-3.5 text-amber-300" />
              Endpoint
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Collapsible Live ADK / Cloud Run Endpoint Settings */}
        {showSettings && (
          <div className="p-4 bg-indigo-50 border-b border-indigo-200 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-bold text-indigo-950 flex items-center gap-1.5">
                <Server className="w-3.5 h-3.5 text-indigo-700" />
                Agent Backend Mode (Swap Live URL Anytime)
              </span>
              <div className="flex rounded-lg overflow-hidden border border-indigo-300 bg-white">
                <button
                  type="button"
                  onClick={() => onChangeConfig({ ...config, mode: 'local_graph' })}
                  className={`px-2.5 py-1 font-semibold ${
                    config.mode === 'local_graph'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-700'
                  }`}
                >
                  Local CA Graph
                </button>
                <button
                  type="button"
                  onClick={() => onChangeConfig({ ...config, mode: 'live_adk' })}
                  className={`px-2.5 py-1 font-semibold ${
                    config.mode === 'live_adk'
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-700'
                  }`}
                >
                  Live ADK / Cloud Run
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2">
              <label className="block">
                <span className="text-[11px] font-semibold text-slate-700">
                  ADK API Server or Cloud Run URL (`adk api_server --allow_origins=*`)
                </span>
                <input
                  type="text"
                  value={config.baseUrl}
                  onChange={(e) =>
                    onChangeConfig({ ...config, baseUrl: e.target.value })
                  }
                  placeholder="http://localhost:8000 or https://ei-agent-xyz.a.run.app"
                  className="mt-1 w-full px-2.5 py-1.5 rounded border border-slate-300 bg-white font-mono text-xs"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[11px] font-semibold text-slate-700">
                    ADK App Name
                  </span>
                  <input
                    type="text"
                    value={config.appName}
                    onChange={(e) =>
                      onChangeConfig({ ...config, appName: e.target.value })
                    }
                    className="mt-1 w-full px-2.5 py-1.5 rounded border border-slate-300 bg-white font-mono text-xs"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-semibold text-slate-700">
                    Coordinator User ID
                  </span>
                  <input
                    type="text"
                    value={config.userId}
                    onChange={(e) =>
                      onChangeConfig({ ...config, userId: e.target.value })
                    }
                    className="mt-1 w-full px-2.5 py-1.5 rounded border border-slate-300 bg-white font-mono text-xs"
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Quick Judge Prompts */}
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
          <div className="text-[11px] font-semibold text-slate-500 mb-1.5 flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-indigo-600" />
            1-Click Coordinator & Judge Walkthrough Questions:
          </div>
          <div className="flex flex-wrap gap-1.5">
            {JUDGE_PROMPT_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => sendPrompt(chip)}
                className="text-left text-[11px] px-2.5 py-1 rounded-full bg-white border border-slate-300 hover:border-indigo-500 hover:text-indigo-700 text-slate-700 transition"
              >
                {chip}
              </button>
            ))}
          </div>
        </div>

        {/* Conversation Thread */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {turns.map((t) => (
            <div
              key={t.id}
              className={`flex flex-col ${
                t.role === 'user' ? 'items-end' : 'items-start'
              }`}
            >
              <div
                className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap ${
                  t.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-br-sm'
                    : 'bg-slate-100 text-slate-800 border border-slate-200 rounded-bl-sm'
                }`}
              >
                {t.content}
              </div>
              <span className="text-[10px] text-slate-400 mt-1 px-1">
                {t.role === 'assistant' ? `${t.sourceBadge} · ` : ''}
                {t.timestamp}
              </span>
            </div>
          ))}
          {loading && (
            <div className="text-xs text-slate-500 italic px-2">
              Traversing California ReferralGraph...
            </div>
          )}
        </div>

        {/* Input */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendPrompt(input);
          }}
          className="p-3 border-t border-slate-200 bg-white flex items-center gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about a tract, 45-day route, or bounce hub..."
            className="flex-1 px-3 py-2 rounded-xl border border-slate-300 text-xs focus:outline-none focus:border-indigo-600"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1"
          >
            <Send className="w-3.5 h-3.5" />
            Ask
          </button>
        </form>
      </div>
    </div>
  );
};
