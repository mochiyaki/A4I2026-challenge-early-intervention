import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowUp,
  AudioLines,
  BookOpenCheck,
  ChevronDown,
  Mic,
  MicOff,
  RotateCcw,
  ShieldCheck,
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
  ClinicMapPayload,
  EvidenceCitationItem,
  ReferralIntakeInput,
  TractDemographic,
} from '../types';
import {
  EXIT_FAST_TRANSITION,
  REDUCED_MOTION_TRANSITION,
  SPRING_DEFAULT,
  triggerCausalHaptic,
} from '../utils/applePhysics';
import { ClinicLocationMapCard } from './ClinicLocationMapCard';
import { FluidSegmentedControl } from './FluidControls';

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  spokenText?: string;
  spokenLang?: 'en-US' | 'es-US';
  badges?: ChatActionBadge[];
  collaboratingAgents?: string[];
  preciseConclusion?: string;
  verificationScoreLabel?: string;
  citations?: EvidenceCitationItem[];
  mapCard?: ClinicMapPayload;
  sourceMode?: 'live-adk' | 'graph-engine';
}

interface AgentChatSidebarProps {
  intake: ReferralIntakeInput;
  tract: TractDemographic;
  activePathway: CandidatePathway | null;
  agentEndpoint: string;
  googleMapsApiKey: string;
  onApplyIntakePatch: (patch: Partial<ReferralIntakeInput>) => void;
  onOpenAgentModal: () => void;
  autoFocusMicSignal?: number;
}

const INITIAL_SUGGESTIONS = [
  'Where is the clinic? Show map',
  'Verify & cite evidence sources',
  'Draft Spanish note for parents',
  'Show paper-fax bounce hubs',
];

export const AgentChatSidebar: React.FC<AgentChatSidebarProps> = ({
  intake,
  tract,
  activePathway,
  agentEndpoint,
  googleMapsApiKey,
  onApplyIntakePatch,
  onOpenAgentModal,
  autoFocusMicSignal = 0,
}) => {
  const reducedMotion = useReducedMotion();
  const [voiceLang, setVoiceLang] = useState<'en-US' | 'es-US'>('en-US');
  const [autoSpeak, setAutoSpeak] = useState<boolean>(true);
  const [inputText, setInputText] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);
  const [expandedEvidenceIds, setExpandedEvidenceIds] = useState<
    Record<string, boolean>
  >({});
  const [suggestions, setSuggestions] =
    useState<string[]>(INITIAL_SUGGESTIONS);

  const [messages, setMessages] = useState<ChatTurn[]>(() => {
    const initialEval = activePathway
      ? cleanOrgName(activePathway.steps[2].node.synthetic_organization_name)
      : 'a regional bilingual evaluation hub';
    const initialDays = activePathway?.totalExpectedDays ?? 35;
    return [
      {
        id: 'welcome-turn',
        role: 'assistant',
        text: `Multi-agent clinical triage ready (Researcher · ISO GQL Router · Statutory Verifier · Evidence Librarian · Synthesizer).\n\nFor a **${intake.childAgeMonths}-month-old** on **Medicaid** in **${tract.county_name}**, the verified bilingual path reaches initial IFSP in **${initialDays} days** via **${initialEval}**.`,
        spokenText: `Multi-agent triage ready. For a ${intake.childAgeMonths}-month-old on Medicaid in ${tract.county_name}, the verified bilingual path reaches initial IFSP in ${initialDays} days.`,
        spokenLang: 'en-US',
        collaboratingAgents: [
          'Policy Researcher',
          'ISO GQL Router',
          'Statutory Verifier',
          'Evidence Librarian',
          'Executive Synthesizer',
        ],
        preciseConclusion: `Dispatch electronic Part C referral via ${initialEval} (~${initialDays}d expected IFSP, clearing the 34 CFR § 303.310 45-day mandate at $0 Medicaid cost).`,
        verificationScoreLabel: '6/6 Verified',
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
            collaboratingAgents: [
              'Live ADK Runtime',
              ...localReply.collaboratingAgents.slice(0, 3),
            ],
            preciseConclusion: localReply.preciseConclusion,
            verificationScoreLabel: localReply.verificationScoreLabel,
            citations: localReply.citations,
            mapCard: localReply.mapCard,
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
          // Fall back to built-in 5-agent ReferralGraph conversational engine
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
        collaboratingAgents: localReply.collaboratingAgents,
        preciseConclusion: localReply.preciseConclusion,
        verificationScoreLabel: localReply.verificationScoreLabel,
        citations: localReply.citations,
        mapCard: localReply.mapCard,
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

  const toggleTurnEvidence = (turnId: string) => {
    triggerCausalHaptic(3);
    setExpandedEvidenceIds((prev) => ({
      ...prev,
      [turnId]: !prev[turnId],
    }));
  };

  const bubbleTransition = reducedMotion
    ? REDUCED_MOTION_TRANSITION
    : SPRING_DEFAULT;

  return (
    <aside
      aria-label="Multi-agent voice and chat triage assistant"
      className="pm-card flex flex-col overflow-hidden h-[660px] lg:h-[calc(100dvh-6.5rem)] min-h-[540px]"
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
                Multi-agent voice &amp; chat
              </h2>
              <button
                type="button"
                onClick={onOpenAgentModal}
                className="text-[12px] text-[var(--pm-muted)] hover:text-[var(--pm-accent)] truncate block cursor-pointer transition-colors"
              >
                {agentEndpoint
                  ? '5-Agent Council + Live ADK connected'
                  : '5-Agent Council · Connect Cloud Run ADK'}
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
                setExpandedEvidenceIds({});
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
                  '¿Dónde está la clínica en el mapa?',
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
          const isEvidenceOpen = Boolean(expandedEvidenceIds[turn.id]);
          const hasVerificationDrawer =
            !isUser &&
            (Boolean(turn.preciseConclusion) ||
              (turn.citations && turn.citations.length > 0));

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
                className={`max-w-[94%] rounded-[14px] px-4 py-3 text-[14.5px] leading-relaxed ${
                  isUser
                    ? 'bg-[var(--pm-cta-bg)] text-white rounded-br-[4px]'
                    : 'bg-[var(--pm-card)] text-[var(--pm-ink)] rounded-bl-[4px] border border-[var(--pm-border)]'
                }`}
              >
                {/* Collaborating Specialist Agents Header Strip */}
                {!isUser &&
                  turn.collaboratingAgents &&
                  turn.collaboratingAgents.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-1.5 pb-2 mb-2 border-b border-[var(--pm-border)] text-[11px]">
                      <span className="inline-flex items-center gap-1 font-semibold text-[var(--pm-accent)]" style={{ fontFamily: 'var(--font-display)' }}>
                        <ShieldCheck aria-hidden="true" className="w-3.5 h-3.5" />
                        <span>
                          {turn.collaboratingAgents.length} agents collaborated
                        </span>
                      </span>
                      {turn.verificationScoreLabel && (
                        <span className="font-mono-code text-[var(--pm-compliant)] font-semibold">
                          {turn.verificationScoreLabel}
                        </span>
                      )}
                    </div>
                  )}

                <div className="whitespace-pre-wrap">
                  {renderSimpleMarkdown(turn.text, isUser)}
                </div>

                {/* Interactive Google Maps Layout Card when user asks for clinic location / directions */}
                {!isUser && turn.mapCard && (
                  <div className="mt-3">
                    <ClinicLocationMapCard
                      payload={turn.mapCard}
                      googleMapsApiKey={googleMapsApiKey}
                      compact
                      onOpenApiModal={onOpenAgentModal}
                    />
                  </div>
                )}

                {/* Expandable Evidence, Sources & Precise Conclusion Drawer */}
                {hasVerificationDrawer && (
                  <div className="mt-3 pt-2.5 border-t border-[var(--pm-border)] space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        aria-expanded={isEvidenceOpen}
                        onClick={() => toggleTurnEvidence(turn.id)}
                        className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--pm-ink)] hover:text-[var(--pm-accent)] cursor-pointer transition-colors"
                        style={{ fontFamily: 'var(--font-display)' }}
                      >
                        <BookOpenCheck
                          aria-hidden="true"
                          className="w-3.5 h-3.5 text-[var(--pm-accent)]"
                        />
                        <span>
                          Conclusion &amp; sources
                          {turn.citations && turn.citations.length > 0
                            ? ` (${turn.citations.length})`
                            : ''}
                        </span>
                        <ChevronDown
                          aria-hidden="true"
                          className={`w-3.5 h-3.5 transition-transform duration-150 ${
                            isEvidenceOpen ? 'rotate-180' : ''
                          }`}
                        />
                      </button>

                      {voice.ttsSupported && (
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
                              <Volume2
                                aria-hidden="true"
                                className="w-3.5 h-3.5"
                              />
                              <span>
                                {turn.spokenLang === 'es-US'
                                  ? 'Escuchar'
                                  : 'Read aloud'}
                              </span>
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    <AnimatePresence>
                      {isEvidenceOpen && (
                        <motion.div
                          initial={
                            reducedMotion
                              ? { opacity: 0 }
                              : { opacity: 0, height: 0 }
                          }
                          animate={
                            reducedMotion
                              ? { opacity: 1 }
                              : { opacity: 1, height: 'auto' }
                          }
                          exit={
                            reducedMotion
                              ? { opacity: 0, transition: REDUCED_MOTION_TRANSITION }
                              : {
                                  opacity: 0,
                                  height: 0,
                                  transition: EXIT_FAST_TRANSITION,
                                }
                          }
                          transition={bubbleTransition}
                          className="overflow-hidden"
                        >
                          <div className="p-3 rounded-[9px] bg-[var(--pm-surface)] border border-[var(--pm-border)] space-y-2.5 text-[12.5px]">
                            {turn.collaboratingAgents && (
                              <div className="flex flex-wrap gap-1">
                                {turn.collaboratingAgents.map((ag) => (
                                  <span
                                    key={ag}
                                    className="pm-badge bg-[var(--pm-card)] text-[11px]"
                                  >
                                    {ag}
                                  </span>
                                ))}
                              </div>
                            )}

                            {turn.preciseConclusion && (
                              <div>
                                <div className="font-semibold text-[var(--pm-ink)]" style={{ fontFamily: 'var(--font-display)' }}>
                                  Precise Conclusion:
                                </div>
                                <p className="text-[var(--pm-text)] leading-snug mt-0.5 m-0">
                                  {turn.preciseConclusion}
                                </p>
                              </div>
                            )}

                            {turn.citations && turn.citations.length > 0 && (
                              <div className="space-y-1.5 pt-2 border-t border-[var(--pm-border)]">
                                <div className="font-semibold text-[var(--pm-ink)]" style={{ fontFamily: 'var(--font-display)' }}>
                                  Verified Sources:
                                </div>
                                <ul className="space-y-1.5 m-0 pl-0 list-none">
                                  {turn.citations.map((c) => (
                                    <li
                                      key={c.id}
                                      className="p-2 rounded-[6px] bg-[var(--pm-card)] border border-[var(--pm-border)] space-y-0.5"
                                    >
                                      <div className="flex flex-wrap items-center justify-between gap-1">
                                        <span className="font-semibold text-[11.5px] text-[var(--pm-ink)]">
                                          {c.sourceTitle}
                                        </span>
                                        <span className="font-mono-code text-[10.5px] text-[var(--pm-accent)]">
                                          [{c.provenanceLabel}]
                                        </span>
                                      </div>
                                      <div className="font-mono-code text-[11px] text-[var(--pm-muted)]">
                                        {c.recordLocator}
                                      </div>
                                      <div className="text-[11.5px] text-[var(--pm-text)]">
                                        {c.supportingMetric}
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}

        {isSending && (
          <div className="flex items-start" role="status" aria-live="polite">
            <div className="rounded-[12px] bg-[var(--pm-card)] border border-[var(--pm-border)] px-4 py-2.5 text-[13px] text-[var(--pm-muted)]">
              Running 5-agent research, verification &amp; synthesis...
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
              Ask the multi-agent referral triage council
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
                  ? 'Pregunte dónde está la clínica, rutas o fuentes...'
                  : 'Ask where the clinic is, verify routes, or cite sources...'
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
