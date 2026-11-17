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
  EXIT_FAST_TRANSITION,
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
      className="pm-card flex flex-col overflow-hidden h-[620px] lg:h-[calc(100dvh-6.5rem)] min-h-[520px]"
    >
      {/* Header */}
      <div className="px-5 pt-4 pb-3.5 border-b border-[var(--pm-border)] bg-[var(--pm-card)] space-y-3 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative w-9 h-9 rounded-[9px] bg-[var(--pm-cta-bg)] text-white flex items-center justify-center shrink-0">
              <AudioLines aria-hidden="true" className="w-4 h-4" />
              {voice.isSpeaking && (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[var(--pm-compliant)] ring-2 ring-[var(--pm-card)]" />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="pm-h3 text-[16px] truncate">
                Bilingual voice &amp; chat agent
              </h2>
              <button
                type="button"
                onClick={onOpenAgentModal}
                className="text-[12px] text-[var(--pm-muted)] hover:text-[var(--pm-accent)] truncate block cursor-pointer transition-colors"
              >
                {agentEndpoint
                  ? 'Connected to live ADK endpoint'
                  : 'Local ReferralGraph engine · Connect ADK'}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {voice.ttsSupported && (
              <button
                type="button"
                aria-label={
                  autoSpeak ? 'Mute spoken replies' : 'Enable spoken replies'
                }
                aria-pressed={autoSpeak}
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
                className={`inline-flex items-center gap-1.5 min-h-[38px] sm:min-h-[34px] px-2.5 py-1 rounded-[8px] text-[12px] font-semibold border cursor-pointer touch-manipulation transition-colors ${
                  autoSpeak
                    ? 'bg-[var(--pm-accent-soft)] border-[var(--pm-accent-border)] text-[var(--pm-accent)]'
                    : 'bg-[var(--pm-surface)] border-[var(--pm-border)] text-[var(--pm-muted)]'
                }`}
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {autoSpeak ? (
                  <>
                    <Volume2 aria-hidden="true" className="w-3.5 h-3.5" />
                    <span>Audio on</span>
                  </>
                ) : (
                  <>
                    <VolumeX aria-hidden="true" className="w-3.5 h-3.5" />
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
              className="w-[38px] h-[38px] sm:w-[34px] sm:h-[34px] rounded-[8px] bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border)] text-[var(--pm-muted)] hover:text-[var(--pm-ink)] flex items-center justify-center cursor-pointer touch-manipulation transition-colors"
            >
              <RotateCcw aria-hidden="true" className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[12.5px] font-medium text-[var(--pm-muted)]">
            Recognition language
          </span>
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

      {/* Live Audio-Reactive Listening Bar */}
      <AnimatePresence>
        {voice.isListening && (
          <motion.div
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={
              reducedMotion ? { opacity: 1 } : { opacity: 1, height: 'auto' }
            }
            exit={
              reducedMotion
                ? { opacity: 0, transition: REDUCED_MOTION_TRANSITION }
                : { opacity: 0, height: 0, transition: EXIT_FAST_TRANSITION }
            }
            transition={bubbleTransition}
            className="bg-[#0F172A] text-[#F8FAFC] px-5 py-3 flex items-center justify-between gap-3 shrink-0 overflow-hidden border-b border-[rgba(248,250,252,0.14)]"
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
                  className="absolute inset-0 rounded-full bg-[#38BDF8] transition-transform duration-75"
                />
                <span className="relative w-6 h-6 rounded-full bg-[#F8FAFC] text-[#0F172A] flex items-center justify-center">
                  <Mic aria-hidden="true" className="w-3.5 h-3.5" />
                </span>
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold">
                  {voiceLang === 'es-US'
                    ? 'Escuchando en español...'
                    : 'Listening for referral details...'}
                </div>
                <div className="text-[12px] text-[#94A3B8] truncate">
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
              className="min-h-[34px] px-3 py-1 rounded-[7px] bg-[#1E293B] hover:bg-[#334155] border border-[rgba(248,250,252,0.22)] text-[12px] font-semibold shrink-0 cursor-pointer transition-colors"
            >
              Stop
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Conversation Stream */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-4 bg-[var(--pm-surface)]"
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
                    <span key={b.label} className="pm-badge pm-badge-accent">
                      {b.label}
                    </span>
                  ))}
                </div>
              )}

              <div
                className={`max-w-[92%] rounded-[14px] px-4 py-3 text-[14.5px] leading-relaxed ${
                  isUser
                    ? 'bg-[var(--pm-cta-bg)] text-white rounded-br-[4px]'
                    : 'bg-[var(--pm-card)] text-[var(--pm-ink)] rounded-bl-[4px] border border-[var(--pm-border)]'
                }`}
              >
                <div className="whitespace-pre-wrap">
                  {renderSimpleMarkdown(turn.text, isUser)}
                </div>

                {!isUser && voice.ttsSupported && (
                  <div className="mt-2.5 pt-2 border-t border-[var(--pm-border)] flex items-center justify-between gap-2">
                    <span className="text-[11.5px] text-[var(--pm-muted)]">
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
                      className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--pm-accent)] hover:underline cursor-pointer"
                    >
                      {isCurrentlySpeaking ? (
                        <>
                          <Square
                            aria-hidden="true"
                            className="w-3 h-3 fill-current"
                          />
                          <span>Stop audio</span>
                        </>
                      ) : (
                        <>
                          <Volume2 aria-hidden="true" className="w-3.5 h-3.5" />
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
          <div className="flex items-start" role="status" aria-live="polite">
            <div className="rounded-[12px] bg-[var(--pm-card)] border border-[var(--pm-border)] px-4 py-2.5 text-[13px] text-[var(--pm-muted)]">
              Querying ReferralGraph...
            </div>
          </div>
        )}

        {voice.voiceError && (
          <div
            role="alert"
            className="rounded-[10px] bg-[var(--pm-warning-soft)] border border-[var(--pm-warning-border)] px-3.5 py-2.5 text-[13px] text-[var(--pm-ink)]"
          >
            {voice.voiceError}
          </div>
        )}
      </div>

      {/* Prompt Chips + 44px Accessible Composer (IME-Safe) */}
      <div className="p-4 bg-[var(--pm-card)] border-t border-[var(--pm-border)] space-y-3 shrink-0 no-print">
        <div className="flex gap-2 overflow-x-auto pb-0.5 no-scrollbar">
          {suggestions.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => {
                triggerCausalHaptic(3);
                handleSend(chip, false);
              }}
              className="shrink-0 min-h-[36px] px-3 py-1.5 rounded-[8px] bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border)] text-[12.5px] font-semibold text-[var(--pm-ink)] cursor-pointer touch-manipulation transition-colors"
              style={{ fontFamily: 'var(--font-display)' }}
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
          className="flex items-center gap-2.5"
        >
          <button
            type="button"
            onClick={voice.toggleListening}
            disabled={!voice.isSupported}
            aria-label={
              voice.isListening ? 'Stop voice input' : 'Start voice input'
            }
            aria-pressed={voice.isListening}
            title={
              voice.isSupported
                ? voice.isListening
                  ? 'Stop voice input'
                  : 'Start voice input'
                : 'Voice input requires Chrome, Edge, or Safari'
            }
            className={`w-[44px] h-[44px] rounded-[10px] flex items-center justify-center shrink-0 cursor-pointer touch-manipulation border transition-colors ${
              voice.isListening
                ? 'bg-[var(--pm-danger)] border-[var(--pm-danger)] text-white'
                : 'bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border-[var(--pm-border-strong)] text-[var(--pm-ink)]'
            } disabled:opacity-40`}
          >
            {voice.isListening ? (
              <MicOff aria-hidden="true" className="w-4 h-4" />
            ) : (
              <Mic aria-hidden="true" className="w-4 h-4 text-[var(--pm-accent)]" />
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
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.nativeEvent.isComposing) {
                  e.preventDefault();
                }
              }}
              placeholder={
                voiceLang === 'es-US'
                  ? 'Escriba su consulta o pulse el micrófono...'
                  : 'Ask about routes, wait times, or parent notes...'
              }
              className="pm-input pr-12"
            />
            <button
              type="submit"
              disabled={!inputText.trim() || isSending}
              aria-label="Send message"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-[8px] bg-[var(--pm-cta-bg)] hover:bg-[var(--pm-cta-hover)] text-white flex items-center justify-center disabled:opacity-30 cursor-pointer touch-manipulation transition-colors"
            >
              <ArrowUp aria-hidden="true" className="w-4 h-4" />
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
        <strong key={i} className="font-bold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={i}
          className={`font-mono-code text-[12.5px] px-1.5 py-0.5 rounded-[5px] ${
            isUser
              ? 'bg-white/20 text-white'
              : 'bg-[var(--pm-surface)] text-[var(--pm-accent)]'
          }`}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}
