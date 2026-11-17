import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowUp,
  AudioLines,
  Mic,
  MicOff,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  runConversationalGraphAgent,
  type ChatActionBadge,
} from '../engine/conversationalAgent';
import { cleanOrgName } from '../engine/graphTriageEngine';
import { useVoiceAgent } from '../hooks/useVoiceAgent';
import { queryLiveAgent } from '../services/agentClient';
import type {
  CandidatePathway,
  ReferralIntakeInput,
  TractDemographic,
} from '../types';
import {
  REDUCED_MOTION_TRANSITION,
  SPRING_DEFAULT,
  triggerCausalHaptic,
} from '../utils/applePhysics';
import { FluidSegmentedControl } from './FluidControls';

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  spokenText?: string;
  spokenLang?: 'en-US' | 'es-US';
  badges?: ChatActionBadge[];
  sourceMode?: 'live-adk' | 'graph-engine';
}

interface AgentChatSidebarProps {
  intake: ReferralIntakeInput;
  tract: TractDemographic;
  activePathway: CandidatePathway | null;
  agentEndpoint: string;
  onApplyIntakePatch: (patch: Partial<ReferralIntakeInput>) => void;
  onOpenAgentModal: () => void;
  autoFocusMicSignal?: number;
}

const INITIAL_SUGGESTIONS = [
  'Which path clears 45 days here?',
  'What if the family has no car?',
  'Draft Spanish note for parents',
  'Why do paper-fax hubs bounce?',
];

export const AgentChatSidebar: React.FC<AgentChatSidebarProps> = ({
  intake,
  tract,
  activePathway,
  agentEndpoint,
  onApplyIntakePatch,
  onOpenAgentModal,
  autoFocusMicSignal = 0,
}) => {
  const reducedMotion = useReducedMotion();
  const [voiceLang, setVoiceLang] = useState<'en-US' | 'es-US'>('en-US');
  const [autoSpeak, setAutoSpeak] = useState<boolean>(true);
  const [inputText, setInputText] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);
  const [suggestions, setSuggestions] =
    useState<string[]>(INITIAL_SUGGESTIONS);

  const [messages, setMessages] = useState<ChatTurn[]>(() => {
    const initialEval = activePathway
      ? cleanOrgName(activePathway.steps[2].node.synthetic_organization_name)
      : 'a regional bilingual hub';
    const initialDays = activePathway?.totalExpectedDays ?? 39;
    return [
      {
        id: 'welcome-turn',
        role: 'assistant',
        text: `Hi! Ask me anything by **voice or text**—no need to dig through charts.\n\nRight now for a **${intake.childAgeMonths}-month-old** on **Medicaid** in **${tract.county_name}**, the fastest bilingual path clears the 45-day clock in **${initialDays} days** via **${initialEval}**.`,
        spokenText: `Ask me anything by voice or text. Right now for a ${intake.childAgeMonths}-month-old on Medicaid in ${tract.county_name}, the fastest bilingual path clears the 45-day clock in ${initialDays} days.`,
        spokenLang: 'en-US',
        sourceMode: 'graph-engine',
      },
    ];
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const intakeRef = useRef(intake);
  intakeRef.current = intake;
  const autoSpeakRef = useRef(autoSpeak);
  autoSpeakRef.current = autoSpeak;
  const endpointRef = useRef(agentEndpoint);
  endpointRef.current = agentEndpoint;

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: reducedMotion ? 'auto' : 'smooth',
        });
      }
    });
  }, [reducedMotion]);

  const submitQueryRef = useRef<(q: string, viaVoice?: boolean) => void>(() => {});

  const voice = useVoiceAgent({
    voiceLang,
    onInterimTranscript: (liveText) => {
      setInputText(liveText);
    },
    onFinalTranscript: (finalText) => {
      setInputText('');
      submitQueryRef.current(finalText, true);
    },
  });

  const handleSend = useCallback(
    async (rawQuery: string, triggeredByVoice = false) => {
      const trimmed = rawQuery.trim();
      if (!trimmed || isSending) return;

      voice.stopSpeaking();
      setInputText('');
      const userTurn: ChatTurn = {
        id: `u-${Date.now()}`,
        role: 'user',
        text: trimmed,
      };
      setMessages((prev) => [...prev, userTurn]);
      setIsSending(true);
      scrollToBottom();

      // Always run local NLU + Graph Engine so natural-language profile edits (state, age, no car, language) sync immediately
      const localReply = runConversationalGraphAgent(
        trimmed,
        intakeRef.current
      );
      if (localReply.intakePatch) {
        onApplyIntakePatch(localReply.intakePatch);
      }

      const liveUrl = endpointRef.current;
      if (liveUrl) {
        try {
          const effective = {
            ...intakeRef.current,
            ...(localReply.intakePatch ?? {}),
          };
          const liveRes = await queryLiveAgent(liveUrl, effective, trimmed);
          const turnId = `a-${Date.now()}`;
          const assistantTurn: ChatTurn = {
            id: turnId,
            role: 'assistant',
            text: liveRes.summaryMarkdown,
            spokenText: liveRes.summaryMarkdown.slice(0, 360),
            spokenLang: localReply.spokenLang,
            badges: localReply.appliedBadges,
            sourceMode: 'live-adk',
          };
          setMessages((prev) => [...prev, assistantTurn]);
          setSuggestions(localReply.suggestedFollowUps);
          if (triggeredByVoice || autoSpeakRef.current) {
            voice.speak(
              assistantTurn.spokenText || assistantTurn.text,
              localReply.spokenLang,
              turnId
            );
          }
          setIsSending(false);
          scrollToBottom();
          return;
        } catch {
          // Gracefully fall back to built-in ReferralGraph conversational engine
        }
      }

      const turnId = `a-${Date.now()}`;
      const assistantTurn: ChatTurn = {
        id: turnId,
        role: 'assistant',
        text: localReply.markdown,
        spokenText: localReply.spokenText,
        spokenLang: localReply.spokenLang,
        badges: localReply.appliedBadges,
        sourceMode: 'graph-engine',
      };

      setMessages((prev) => [...prev, assistantTurn]);
      setSuggestions(localReply.suggestedFollowUps);
      setIsSending(false);
      scrollToBottom();

      if (triggeredByVoice || autoSpeakRef.current) {
        voice.speak(localReply.spokenText, localReply.spokenLang, turnId);
      }
    },
    [isSending, onApplyIntakePatch, scrollToBottom, voice]
  );

  submitQueryRef.current = handleSend;

  useEffect(() => {
    if (autoFocusMicSignal > 0 && !voice.isListening) {
      voice.startListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocusMicSignal]);

  const bubbleSpring = reducedMotion
    ? REDUCED_MOTION_TRANSITION
    : SPRING_DEFAULT;

  return (
    <aside
      aria-label="Voice and Chat Triage Agent"
      className="apple-card flex flex-col overflow-hidden h-[640px] lg:h-[calc(100vh-6.25rem)] min-h-[540px]"
    >
      {/* Top Copilot Header */}
      <div className="px-4 pt-4 pb-3 border-b border-black/[0.06] bg-white/90 space-y-2.5 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative w-8 h-8 rounded-full bg-gradient-to-b from-[#14B8A6] to-[#0F766E] text-white flex items-center justify-center shrink-0 shadow-[0_2px_8px_rgba(13,148,136,0.3)]">
              <AudioLines className="w-4 h-4" />
              {voice.isSpeaking && (
                <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-white" />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="apple-title text-[15px] font-semibold text-[#1D1D1F] truncate">
                Ask Triage Agent
              </h2>
              <button
                type="button"
                onClick={onOpenAgentModal}
                className="text-[11px] text-[#515154] hover:text-[#0F766E] truncate block cursor-pointer"
              >
                {agentEndpoint
                  ? '● Connected to Live ADK'
                  : '● ReferralGraph Voice & Chat'}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Auto-Speak Voice Output Toggle */}
            {voice.ttsSupported && (
              <button
                type="button"
                title={
                  autoSpeak
                    ? 'Voice replies ON (click to mute)'
                    : 'Voice replies muted (click to enable)'
                }
                onClick={() => {
                  triggerCausalHaptic(5);
                  if (autoSpeak) voice.stopSpeaking();
                  setAutoSpeak((v) => !v);
                }}
                className={`apple-pressable inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold cursor-pointer ${
                  autoSpeak
                    ? 'bg-[#0D9488]/12 text-[#0F766E]'
                    : 'bg-[#F2F2F7] text-[#86868B]'
                }`}
              >
                {autoSpeak ? (
                  <>
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Voice</span>
                  </>
                ) : (
                  <>
                    <VolumeX className="w-3.5 h-3.5" />
                    <span>Muted</span>
                  </>
                )}
              </button>
            )}

            {/* Reset Conversation */}
            <button
              type="button"
              title="Clear chat"
              onClick={() => {
                voice.stopSpeaking();
                setSuggestions(INITIAL_SUGGESTIONS);
                setMessages((prev) => prev.slice(0, 1));
              }}
              className="apple-pressable w-7 h-7 rounded-full bg-[#F2F2F7] text-[#515154] hover:text-[#1D1D1F] flex items-center justify-center cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Voice Agent Language Selector + Live Voice Banner */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[#515154]">
            Speak or type in plain language:
          </span>
          <FluidSegmentedControl<'en-US' | 'es-US'>
            layoutId="voice-lang-pill"
            size="sm"
            options={[
              { value: 'en-US', label: 'EN Mic' },
              { value: 'es-US', label: 'ES Mic' },
            ]}
            value={voiceLang}
            onChange={(lang) => {
              setVoiceLang(lang);
              if (lang === 'es-US') {
                setSuggestions([
                  '¿Qué ruta cumple los 45 días?',
                  'Escribe la nota para los padres',
                  'La familia no tiene auto',
                ]);
              } else {
                setSuggestions(INITIAL_SUGGESTIONS);
              }
            }}
          />
        </div>
      </div>

      {/* Live Fluid Listening Banner (60fps 1:1 Mic Level Feedback) */}
      <AnimatePresence>
        {voice.isListening && (
          <motion.div
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={
              reducedMotion ? { opacity: 1 } : { opacity: 1, height: 'auto' }
            }
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={bubbleSpring}
            className="bg-gradient-to-r from-[#0F766E] to-[#0D9488] text-white px-4 py-3 flex items-center justify-between gap-3 shrink-0 overflow-hidden"
          >
            <div className="flex items-center gap-3 min-w-0">
              {/* 60fps Audio-Reactive Orb */}
              <div className="relative w-8 h-8 flex items-center justify-center shrink-0">
                <span
                  style={{
                    transform: reducedMotion
                      ? 'scale(1)'
                      : `scale(${1 + voice.micLevel * 0.9})`,
                    opacity: 0.35 + voice.micLevel * 0.45,
                  }}
                  className="absolute inset-0 rounded-full bg-white/40 transition-transform duration-75"
                />
                <span className="relative w-6 h-6 rounded-full bg-white text-[#0F766E] flex items-center justify-center shadow-xs">
                  <Mic className="w-3.5 h-3.5" />
                </span>
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold">
                  {voiceLang === 'es-US'
                    ? 'Escuchando en español...'
                    : 'Listening... speak naturally'}
                </div>
                <div className="text-[11px] text-teal-100 truncate">
                  {inputText ||
                    (voiceLang === 'es-US'
                      ? 'Ej: "Bebé de 20 meses con Medicaid sin auto"'
                      : 'Try: "20-month-old in Texas, Spanish, no car"')}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={voice.stopListening}
              className="apple-pressable px-2.5 py-1 rounded-full bg-white/20 hover:bg-white/30 text-[11px] font-semibold shrink-0 cursor-pointer"
            >
              Done
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Scrollable Conversation Stream */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3.5 bg-[#FAFAFC]"
      >
        {messages.map((turn) => {
          const isUser = turn.role === 'user';
          const isCurrentlySpeaking =
            voice.isSpeaking && voice.speakingId === turn.id;

          return (
            <motion.div
              key={turn.id}
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              transition={bubbleSpring}
              className={`flex flex-col ${
                isUser ? 'items-end' : 'items-start'
              }`}
            >
              {/* Live Dashboard Sync Pills */}
              {!isUser && turn.badges && turn.badges.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {turn.badges.map((b) => (
                    <span
                      key={b.label}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#0D9488]/12 text-[#0F766E] text-[10.5px] font-semibold"
                    >
                      <Sparkles className="w-2.5 h-2.5" />
                      {b.label}
                    </span>
                  ))}
                </div>
              )}

              <div
                className={`max-w-[92%] rounded-[18px] px-3.5 py-2.5 text-[13px] leading-relaxed ${
                  isUser
                    ? 'bg-[#0D9488] text-white rounded-br-[6px] shadow-[0_2px_6px_rgba(13,148,136,0.22)]'
                    : 'bg-white text-[#1D1D1F] rounded-bl-[6px] shadow-[0_1px_3px_rgba(0,0,0,0.06),0_0_0_0.5px_rgba(15,23,42,0.08)]'
                }`}
              >
                <div className="whitespace-pre-wrap">
                  {renderSimpleMarkdown(turn.text, isUser)}
                </div>

                {/* Per-Message Speak / Stop Control */}
                {!isUser && voice.ttsSupported && (
                  <div className="mt-2 pt-1.5 border-t border-black/[0.05] flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium text-[#86868B]">
                      {turn.sourceMode === 'live-adk'
                        ? 'Live ADK Agent'
                        : 'ReferralGraph Triage'}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        triggerCausalHaptic(4);
                        if (isCurrentlySpeaking) {
                          voice.stopSpeaking();
                        } else {
                          voice.speak(
                            turn.spokenText || turn.text,
                            turn.spokenLang || 'en-US',
                            turn.id
                          );
                        }
                      }}
                      className="apple-pressable inline-flex items-center gap-1 text-[11px] font-semibold text-[#0F766E] hover:underline cursor-pointer"
                    >
                      {isCurrentlySpeaking ? (
                        <>
                          <Square className="w-3 h-3 fill-current" />
                          <span>Stop</span>
                        </>
                      ) : (
                        <>
                          <Volume2 className="w-3 h-3" />
                          <span>
                            {turn.spokenLang === 'es-US'
                              ? 'Escuchar'
                              : 'Read Aloud'}
                          </span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}

        {isSending && (
          <div className="flex items-start">
            <div className="rounded-[16px] bg-white px-3.5 py-2.5 text-xs text-[#515154] shadow-[0_1px_3px_rgba(0,0,0,0.05)]">
              Traversing ReferralGraph...
            </div>
          </div>
        )}

        {voice.voiceError && (
          <div className="rounded-[12px] bg-amber-500/12 px-3 py-2 text-[11.5px] text-amber-950">
            {voice.voiceError}
          </div>
        )}
      </div>

      {/* Quick One-Tap Prompt Suggestions + Input Bar */}
      <div className="p-3 bg-white border-t border-black/[0.06] space-y-2.5 shrink-0 no-print">
        {/* Suggested Question Pills */}
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
          {suggestions.map((chip) => (
            <button
              key={chip}
              type="button"
              onPointerDown={() => triggerCausalHaptic(4)}
              onClick={() => handleSend(chip, false)}
              className="apple-pressable shrink-0 px-2.5 py-1 rounded-full bg-[#F2F2F7] hover:bg-[#E6E6EC] text-[11px] font-medium text-[#1D1D1F] cursor-pointer"
            >
              {chip}
            </button>
          ))}
        </div>

        {/* Composer + Prominent Voice Orb */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend(inputText, false);
          }}
          className="flex items-center gap-2"
        >
          {/* Voice Agent Mic Button */}
          <button
            type="button"
            onClick={voice.toggleListening}
            disabled={!voice.isSupported}
            title={
              voice.isSupported
                ? voice.isListening
                  ? 'Stop voice input'
                  : 'Speak to Triage Agent'
                : 'Voice input requires Chrome, Edge, or Safari'
            }
            className={`apple-pressable relative w-10 h-10 rounded-full flex items-center justify-center shrink-0 cursor-pointer ${
              voice.isListening
                ? 'bg-rose-600 text-white shadow-[0_0_0_4px_rgba(225,29,72,0.18)]'
                : 'bg-[#F2F2F7] text-[#1D1D1F] hover:bg-[#E5E5EA]'
            } disabled:opacity-40`}
          >
            {voice.isListening ? (
              <MicOff className="w-4 h-4" />
            ) : (
              <Mic className="w-4 h-4 text-[#0D9488]" />
            )}
          </button>

          <div className="relative flex-1">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={
                voiceLang === 'es-US'
                  ? 'Pregunte o pulse el micrófono...'
                  : 'Ask straight away or tap mic...'
              }
              className="w-full rounded-full bg-[#F2F2F7] pl-3.5 pr-10 py-2.5 text-[13px] text-[#1D1D1F] placeholder:text-[#86868B] focus:outline-none focus:bg-white focus:shadow-[inset_0_0_0_1.5px_#0D9488] transition"
            />
            <button
              type="submit"
              disabled={!inputText.trim() || isSending}
              aria-label="Send message"
              className="apple-pressable absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-[#0D9488] text-white flex items-center justify-center disabled:opacity-30 cursor-pointer"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </aside>
  );
};

/**
 * Lightweight inline formatter for **bold** and `code` spans inside chat bubbles.
 */
function renderSimpleMarkdown(text: string, isUser: boolean): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={i}
          className={`font-mono-code text-[11.5px] px-1 py-0.5 rounded ${
            isUser ? 'bg-white/20 text-white' : 'bg-[#F2F2F7] text-[#0F766E]'
          }`}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}
