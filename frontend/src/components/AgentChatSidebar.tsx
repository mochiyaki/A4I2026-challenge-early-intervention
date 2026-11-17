import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowUp,
  AudioLines,
  Mic,
  MicOff,
  RotateCcw,
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
  'Compare compliant 45-day routes',
  'Check zero-vehicle transport options',
  'Draft Spanish note for parents',
  'Show paper-fax bounce hubs',
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
      : 'a regional bilingual evaluation hub';
    const initialDays = activePathway?.totalExpectedDays ?? 39;
    return [
      {
        id: 'welcome-turn',
        role: 'assistant',
        text: `Ask by voice or text to update intake filters or draft family notes.\n\nFor a **${intake.childAgeMonths}-month-old** on **Medicaid** in **${tract.county_name}**, the recommended bilingual path reaches initial IFSP in **${initialDays} days** via **${initialEval}**.`,
        spokenText: `Ask by voice or text to update intake filters. For a ${intake.childAgeMonths}-month-old on Medicaid in ${tract.county_name}, the recommended bilingual path reaches initial IFSP in ${initialDays} days.`,
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
          // Fall back to built-in ReferralGraph conversational engine
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

  const bubbleTransition = reducedMotion
    ? REDUCED_MOTION_TRANSITION
    : SPRING_DEFAULT;

  return (
    <aside
      aria-label="Voice and chat triage agent"
      className="ts-card flex flex-col overflow-hidden h-[640px] lg:h-[calc(100vh-6.25rem)] min-h-[540px]"
    >
      {/* Header — Flat opaque card top, solid Harbour Ink mark, 1px hairline */}
      <div className="px-5 pt-4 pb-3.5 border-b border-[rgba(29,37,48,0.1)] bg-white space-y-3 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative w-8 h-8 rounded-[8px] bg-[#1D2530] text-[#F3F1EC] flex items-center justify-center shrink-0">
              <AudioLines className="w-4 h-4" />
              {voice.isSpeaking && (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[#2C5877] ring-2 ring-white" />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="ts-h3 text-[16px] truncate">
                Voice and chat agent
              </h2>
              <button
                type="button"
                onClick={onOpenAgentModal}
                className="text-[12.5px] text-[#556070] hover:text-[#2C5877] truncate block cursor-pointer transition-colors"
              >
                {agentEndpoint
                  ? 'Connected to live ADK endpoint'
                  : 'Local ReferralGraph engine · Connect ADK'}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {voice.ttsSupported && (
              <button
                type="button"
                aria-label={autoSpeak ? 'Mute spoken replies' : 'Enable spoken replies'}
                title={
                  autoSpeak
                    ? 'Spoken replies on (click to mute)'
                    : 'Spoken replies muted (click to enable)'
                }
                onClick={() => {
                  triggerCausalHaptic(4);
                  if (autoSpeak) voice.stopSpeaking();
                  setAutoSpeak((v) => !v);
                }}
                className={`inline-flex items-center gap-1.5 min-h-[34px] px-2.5 py-1 rounded-[7px] text-[12.5px] font-medium border cursor-pointer transition-colors ${
                  autoSpeak
                    ? 'bg-[rgba(44,88,119,0.09)] border-[rgba(44,88,119,0.24)] text-[#2C5877]'
                    : 'bg-[#F8F7F4] border-[rgba(29,37,48,0.12)] text-[#556070]'
                }`}
              >
                {autoSpeak ? (
                  <>
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Audio on</span>
                  </>
                ) : (
                  <>
                    <VolumeX className="w-3.5 h-3.5" />
                    <span>Muted</span>
                  </>
                )}
              </button>
            )}

            <button
              type="button"
              aria-label="Reset conversation"
              title="Reset conversation"
              onClick={() => {
                voice.stopSpeaking();
                setSuggestions(INITIAL_SUGGESTIONS);
                setMessages((prev) => prev.slice(0, 1));
              }}
              className="w-[34px] h-[34px] rounded-[7px] bg-[#F8F7F4] hover:bg-[#E6E2D9] border border-[rgba(29,37,48,0.12)] text-[#556070] hover:text-[#1D2530] flex items-center justify-center cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="ts-label">Microphone language</span>
          <FluidSegmentedControl<'en-US' | 'es-US'>
            layoutId="voice-lang-pill"
            ariaLabel="Microphone recognition language"
            size="sm"
            options={[
              { value: 'en-US', label: 'English' },
              { value: 'es-US', label: 'Español' },
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

      {/* Live Audio-Reactive Listening Bar — Harbour Slate inverse ground (zero gradient slop) */}
      <AnimatePresence>
        {voice.isListening && (
          <motion.div
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={
              reducedMotion ? { opacity: 1 } : { opacity: 1, height: 'auto' }
            }
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={bubbleTransition}
            className="bg-[#18202A] text-[#F3F1EC] px-5 py-3 flex items-center justify-between gap-3 shrink-0 overflow-hidden border-b border-[rgba(243,241,236,0.12)]"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative w-8 h-8 flex items-center justify-center shrink-0">
                <span
                  style={{
                    transform: reducedMotion
                      ? 'scale(1)'
                      : `scale(${1 + voice.micLevel * 0.85})`,
                    opacity: 0.3 + voice.micLevel * 0.45,
                  }}
                  className="absolute inset-0 rounded-full bg-[#7FB3D5] transition-transform duration-75"
                />
                <span className="relative w-6 h-6 rounded-full bg-[#F3F1EC] text-[#18202A] flex items-center justify-center">
                  <Mic className="w-3.5 h-3.5" />
                </span>
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-medium">
                  {voiceLang === 'es-US'
                    ? 'Escuchando en español...'
                    : 'Listening for referral details...'}
                </div>
                <div className="text-[12px] text-[#9AA5B4] truncate">
                  {inputText ||
                    (voiceLang === 'es-US'
                      ? 'Ej.: "Niño de 20 meses con Medicaid sin auto"'
                      : 'Example: "20-month-old in California, Spanish, no car"')}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={voice.stopListening}
              className="px-3 py-1 rounded-[6px] bg-[#222C39] hover:bg-[#2E3B4C] border border-[rgba(243,241,236,0.2)] text-[12px] font-medium shrink-0 cursor-pointer transition-colors"
            >
              Stop
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Conversation Stream */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-4 bg-[#F8F7F4]"
      >
        {messages.map((turn) => {
          const isUser = turn.role === 'user';
          const isCurrentlySpeaking =
            voice.isSpeaking && voice.speakingId === turn.id;

          return (
            <motion.div
              key={turn.id}
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={bubbleTransition}
              className={`flex flex-col ${
                isUser ? 'items-end' : 'items-start'
              }`}
            >
              {!isUser && turn.badges && turn.badges.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {turn.badges.map((b) => (
                    <span key={b.label} className="ts-chip ts-chip-accent">
                      {b.label}
                    </span>
                  ))}
                </div>
              )}

              <div
                className={`max-w-[92%] rounded-[14px] px-4 py-3 text-[14px] leading-relaxed ${
                  isUser
                    ? 'bg-[#2C5877] text-white rounded-br-[4px]'
                    : 'bg-white text-[#1D2530] rounded-bl-[4px] border border-[rgba(29,37,48,0.11)]'
                }`}
              >
                <div className="whitespace-pre-wrap">
                  {renderSimpleMarkdown(turn.text, isUser)}
                </div>

                {!isUser && voice.ttsSupported && (
                  <div className="mt-2.5 pt-2 border-t border-[rgba(29,37,48,0.08)] flex items-center justify-between gap-2">
                    <span className="text-[11.5px] text-[#556070]">
                      {turn.sourceMode === 'live-adk'
                        ? 'Live ADK agent'
                        : 'ReferralGraph triage'}
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
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-[#2C5877] hover:underline cursor-pointer"
                    >
                      {isCurrentlySpeaking ? (
                        <>
                          <Square className="w-3 h-3 fill-current" />
                          <span>Stop audio</span>
                        </>
                      ) : (
                        <>
                          <Volume2 className="w-3.5 h-3.5" />
                          <span>
                            {turn.spokenLang === 'es-US'
                              ? 'Escuchar respuesta'
                              : 'Read aloud'}
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
            <div className="rounded-[12px] bg-white border border-[rgba(29,37,48,0.1)] px-4 py-2.5 text-[13px] text-[#556070]">
              Querying ReferralGraph...
            </div>
          </div>
        )}

        {voice.voiceError && (
          <div className="rounded-[10px] bg-[rgba(143,91,30,0.09)] border border-[rgba(143,91,30,0.25)] px-3.5 py-2.5 text-[13px] text-[#1D2530]">
            {voice.voiceError}
          </div>
        )}
      </div>

      {/* Prompt Chips + 44px Accessible Composer */}
      <div className="p-4 bg-white border-t border-[rgba(29,37,48,0.1)] space-y-3 shrink-0 no-print">
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
          {suggestions.map((chip) => (
            <button
              key={chip}
              type="button"
              onPointerDown={() => triggerCausalHaptic(3)}
              onClick={() => handleSend(chip, false)}
              className="shrink-0 px-3 py-1.5 rounded-[7px] bg-[#F8F7F4] hover:bg-[#E6E2D9] border border-[rgba(29,37,48,0.12)] text-[12.5px] font-medium text-[#1D2530] cursor-pointer transition-colors"
            >
              {chip}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend(inputText, false);
          }}
          className="flex items-center gap-2"
        >
          <button
            type="button"
            onClick={voice.toggleListening}
            disabled={!voice.isSupported}
            aria-label={
              voice.isListening ? 'Stop voice input' : 'Start voice input'
            }
            title={
              voice.isSupported
                ? voice.isListening
                  ? 'Stop voice input'
                  : 'Start voice input'
                : 'Voice input requires Chrome, Edge, or Safari'
            }
            className={`w-[44px] h-[44px] rounded-[9px] flex items-center justify-center shrink-0 cursor-pointer border transition-colors ${
              voice.isListening
                ? 'bg-[#B43E2F] border-[#B43E2F] text-white'
                : 'bg-[#F8F7F4] hover:bg-[#E6E2D9] border-[rgba(29,37,48,0.18)] text-[#1D2530]'
            } disabled:opacity-40`}
          >
            {voice.isListening ? (
              <MicOff className="w-4 h-4" />
            ) : (
              <Mic className="w-4 h-4 text-[#2C5877]" />
            )}
          </button>

          <div className="relative flex-1">
            <label htmlFor="agent-chat-input" className="sr-only">
              Ask the referral triage agent
            </label>
            <input
              id="agent-chat-input"
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={
                voiceLang === 'es-US'
                  ? 'Escriba su consulta o pulse el micrófono...'
                  : 'Ask about routes, wait times, or parent notes...'
              }
              className="ts-input pr-11"
            />
            <button
              type="submit"
              disabled={!inputText.trim() || isSending}
              aria-label="Send message"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-[7px] bg-[#2C5877] hover:bg-[#244963] text-white flex items-center justify-center disabled:opacity-30 cursor-pointer transition-colors"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </aside>
  );
};

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
          className={`font-mono-code text-[12.5px] px-1.5 py-0.5 rounded-[4px] ${
            isUser
              ? 'bg-white/20 text-white'
              : 'bg-[#F3F1EC] text-[#2C5877]'
          }`}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}
