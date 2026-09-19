import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  CheckCircle2,
  HelpCircle,
  AlertTriangle,
  Clock,
  ArrowLeft,
  Check,
  Power,
  Activity,
} from 'lucide-react';
import {
  db,
  doc,
  collection,
  addDoc,
  serverTimestamp,
  onSnapshot,
} from '../lib/firebase';

type SignalType = 'got_it' | 'kinda' | 'lost';

interface DiagnosticQuestion {
  id?: string;
  question?: string;
  prompt?: string;
  title?: string;
  optionA?: string;
  optionB?: string;
  options?: string[];
  [key: string]: unknown;
}

export default function StudentView() {
  const { roomId } = useParams<{ roomId: string }>();

  // Cooldown rate limiting state (30 seconds)
  const [cooldownRemaining, setCooldownRemaining] = useState<number>(0);
  const cooldownTimerRef = useRef<number | null>(null);

  // Firestore session data, active topic & diagnostic question
  const [currentTopic, setCurrentTopic] = useState<string>('');
  const [isSessionEnded, setIsSessionEnded] = useState(false);
  const [activeDiagnostic, setActiveDiagnostic] = useState<DiagnosticQuestion | null>(null);
  const [answeredDiagnostics, setAnsweredDiagnostics] = useState<Set<string>>(new Set());
  const [submittingDiagnostic, setSubmittingDiagnostic] = useState(false);

  // Hold-to-confirm state for "Lost" button (1.2 seconds = 1200ms)
  const HOLD_DURATION_MS = 1200;
  const [holdProgress, setHoldProgress] = useState(0); // 0 to 100
  const [isHolding, setIsHolding] = useState(false);
  const holdStartTimeRef = useRef<number | null>(null);
  const holdAnimationRef = useRef<number | null>(null);
  const hasTriggeredHoldRef = useRef(false);
  const activeHoldPointerIdRef = useRef<number | null>(null);

  // Status feedback toast/banner
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  // Listen to the session document for status, topic, and diagnosticQuestion
  useEffect(() => {
    if (!roomId) return;

    const sessionDocRef = doc(db, 'sessions', roomId);
    const unsubscribe = onSnapshot(
      sessionDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data) {
            setIsSessionEnded(data.status === 'ended');
            if (data.currentTopic !== undefined) {
              setCurrentTopic(data.currentTopic || '');
            }

            if (data.diagnosticQuestion) {
              if (typeof data.diagnosticQuestion === 'string') {
                setActiveDiagnostic({
                  question: data.diagnosticQuestion,
                  optionA: data.optionA || 'Option A',
                  optionB: data.optionB || 'Option B',
                });
              } else {
                setActiveDiagnostic(data.diagnosticQuestion as DiagnosticQuestion);
              }
            } else {
              setActiveDiagnostic(null);
            }
          }
        } else {
          setActiveDiagnostic(null);
        }
      },
      (error) => {
        console.warn('Firestore session listener error:', error);
      }
    );

    return () => unsubscribe();
  }, [roomId]);

  // Cleanup in-flight hold animation on unmount
  useEffect(() => {
    return () => {
      if (holdAnimationRef.current) {
        cancelAnimationFrame(holdAnimationRef.current);
        holdAnimationRef.current = null;
      }
    };
  }, []);

  // Handle countdown interval for rate limiting
  useEffect(() => {
    if (cooldownRemaining > 0) {
      cooldownTimerRef.current = window.setTimeout(() => {
        setCooldownRemaining((prev) => Math.max(0, prev - 1));
      }, 1000);
    }
    return () => {
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current);
      }
    };
  }, [cooldownRemaining]);

  // Send Signal to subcollection "sessions/{roomId}/signals"
  const sendSignal = useCallback(
    async (value: SignalType) => {
      if (!roomId || cooldownRemaining > 0 || isSessionEnded) return;

      try {
        setCooldownRemaining(30);

        const label =
          value === 'got_it'
            ? '01 // GOT IT'
            : value === 'kinda'
              ? '02 // KINDA'
              : '03 // LOST';
        setFeedbackMessage(`SIGNAL RECORDED: ${label}`);
        setTimeout(() => setFeedbackMessage(null), 3000);

        await addDoc(collection(db, 'sessions', roomId, 'signals'), {
          value,
          timestamp: serverTimestamp(),
        });
      } catch (err) {
        console.error('Failed to submit signal:', err);
      }
    },
    [roomId, cooldownRemaining, isSessionEnded]
  );

  // Hold Logic for "Lost" Button
  const cancelHold = useCallback(() => {
    if (holdAnimationRef.current) {
      cancelAnimationFrame(holdAnimationRef.current);
      holdAnimationRef.current = null;
    }
    holdStartTimeRef.current = null;
    activeHoldPointerIdRef.current = null;
    setIsHolding(false);
    setHoldProgress(0);
    hasTriggeredHoldRef.current = false;
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (cooldownRemaining > 0 || isSessionEnded) return;
    if (e.button !== 0) return;
    if (activeHoldPointerIdRef.current !== null) return;

    cancelHold();
    activeHoldPointerIdRef.current = e.pointerId;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Fallback if setPointerCapture is unsupported
    }

    setIsHolding(true);
    hasTriggeredHoldRef.current = false;
    const startTime = performance.now();
    holdStartTimeRef.current = startTime;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(100, (elapsed / HOLD_DURATION_MS) * 100);
      setHoldProgress(progress);

      if (elapsed >= HOLD_DURATION_MS) {
        if (!hasTriggeredHoldRef.current) {
          hasTriggeredHoldRef.current = true;
          sendSignal('lost');
        }
        cancelHold();
      } else {
        holdAnimationRef.current = requestAnimationFrame(animate);
      }
    };

    holdAnimationRef.current = requestAnimationFrame(animate);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerId !== activeHoldPointerIdRef.current) return;
    if (!hasTriggeredHoldRef.current) {
      cancelHold();
    }
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerId !== activeHoldPointerIdRef.current) return;
    if (!hasTriggeredHoldRef.current) {
      cancelHold();
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerId !== activeHoldPointerIdRef.current) return;
    cancelHold();
  };

  // Submit diagnostic answer
  const handleDiagnosticAnswer = async (choice: 'A' | 'B') => {
    if (!roomId || !activeDiagnostic || submittingDiagnostic || isSessionEnded) return;

    try {
      setSubmittingDiagnostic(true);
      const diagnosticKey =
        activeDiagnostic.id ||
        activeDiagnostic.question ||
        JSON.stringify(activeDiagnostic);

      await addDoc(collection(db, 'sessions', roomId, 'diagnosticResponses'), {
        choice,
        timestamp: serverTimestamp(),
      });

      setAnsweredDiagnostics((prev) => new Set(prev).add(diagnosticKey));
      setFeedbackMessage(`RESPONSE RECORDED: OPTION ${choice}`);
      setTimeout(() => setFeedbackMessage(null), 3000);
    } catch (err) {
      console.error('Failed to submit diagnostic response:', err);
    } finally {
      setSubmittingDiagnostic(false);
    }
  };

  // Check if current active diagnostic was already answered by this student
  const activeDiagnosticKey = activeDiagnostic
    ? activeDiagnostic.id ||
      activeDiagnostic.question ||
      JSON.stringify(activeDiagnostic)
    : null;

  const showDiagnostic =
    activeDiagnostic &&
    activeDiagnosticKey &&
    !answeredDiagnostics.has(activeDiagnosticKey);

  // Circular progress math for SVG ring
  const circleRadius = 26;
  const circumference = 2 * Math.PI * circleRadius;
  const strokeDashoffset =
    circumference - (holdProgress / 100) * circumference;

  const optionAText =
    activeDiagnostic?.optionA ||
    (Array.isArray(activeDiagnostic?.options)
      ? activeDiagnostic.options[0]
      : 'Option A');
  const optionBText =
    activeDiagnostic?.optionB ||
    (Array.isArray(activeDiagnostic?.options)
      ? activeDiagnostic.options[1]
      : 'Option B');
  const questionTitle =
    activeDiagnostic?.question ||
    activeDiagnostic?.prompt ||
    activeDiagnostic?.title ||
    'Concept Diagnostic Question';

  return (
    <div className="min-h-screen w-full flex flex-col bg-[#0a0a0a] text-[#cdc4ba]">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="w-full px-6 sm:px-10 py-4 flex items-center justify-between border-b border-[#cdc4ba]/15 bg-[#0a0a0a] sticky top-0 z-30">
        <div className="flex items-center gap-4">
          <Link
            to="/"
            className="flex items-center gap-1.5 border border-[#cdc4ba]/20 hover:border-[#cdc4ba]/60 hover:bg-[#cdc4ba]/5 text-[#cdc4ba]/60 hover:text-[#cdc4ba] font-mono text-xs px-2.5 py-1.5 transition-all cursor-pointer"
            title="Exit Session"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">EXIT</span>
          </Link>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-[#cdc4ba]">CLASSPULSE</h1>
            <span className="eyebrow">STUDENT TERMINAL</span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {/* Status Badge */}
          <div className="flex items-center gap-1.5 border border-[#cdc4ba]/20 px-3 py-1.5 font-mono text-xs text-[#cdc4ba]/70">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isSessionEnded ? 'bg-[#cdc4ba]/30' : 'bg-[#cdc4ba] animate-pulse'
              }`}
            />
            <span>{isSessionEnded ? 'CONCLUDED' : 'LIVE'}</span>
          </div>

          {/* Room ID Badge */}
          <div className="flex items-center gap-1.5 border border-[#cdc4ba]/15 px-3 py-1.5 font-mono text-xs text-[#cdc4ba]/70">
            <span className="text-[#cdc4ba]/40 hidden xs:inline">ROOM:</span>
            <span className="text-[#cdc4ba] font-bold tracking-wider">{roomId || '---'}</span>
          </div>
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────────── */}
      <main className="w-full max-w-xl mx-auto flex-1 flex flex-col px-5 sm:px-8 py-8 sm:py-12 gap-8">
        {/* Feedback Transmission Banner */}
        {feedbackMessage && (
          <div className="border border-[#cdc4ba]/40 bg-[#cdc4ba]/10 px-4 py-3 font-mono text-xs text-[#cdc4ba] flex items-center justify-between gap-3 animate-in fade-in duration-150">
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 text-[#cdc4ba]" />
              <span>{feedbackMessage}</span>
            </div>
            <span className="text-[10px] text-[#cdc4ba]/40 uppercase tracking-wider font-mono">
              TRANSMITTED
            </span>
          </div>
        )}

        {/* Rate Limit Active Notice */}
        {cooldownRemaining > 0 && !isSessionEnded && (
          <div className="border border-[#cdc4ba]/20 bg-[#cdc4ba]/5 p-3.5 flex items-center justify-between font-mono text-xs text-[#cdc4ba]/70 animate-in fade-in">
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-[#cdc4ba]/50 animate-spin" />
              <span>TRANSMISSION THROTTLED</span>
            </div>
            <span className="font-mono text-[11px] text-[#cdc4ba]/50 border border-[#cdc4ba]/15 px-2 py-0.5">
              RESUMES IN {cooldownRemaining}S
            </span>
          </div>
        )}

        {/* Session Concluded State */}
        {isSessionEnded ? (
          <div className="border border-[#cdc4ba]/20 p-8 sm:p-12 flex flex-col items-center gap-4 text-center bg-[#0d0d0d] my-auto">
            <Power className="h-8 w-8 text-[#cdc4ba]/30" />
            <span className="eyebrow">SESSION CONCLUDED</span>
            <h2 className="text-xl font-normal tracking-tight text-[#cdc4ba]">
              Lecture Completed
            </h2>
            <p className="font-mono text-xs text-[#cdc4ba]/50 max-w-sm">
              The instructor has concluded this session. Responses are no longer being recorded for room {roomId}.
            </p>
            <Link
              to="/"
              className="mt-2 border border-[#cdc4ba]/30 hover:border-[#cdc4ba] hover:bg-[#cdc4ba]/5 text-[#cdc4ba] font-mono text-xs px-4 py-2 transition-all cursor-pointer"
            >
              RETURN TO OVERVIEW
            </Link>
          </div>
        ) : showDiagnostic ? (
          /* ────────────── DIAGNOSTIC QUESTION MODE ────────────── */
          <section className="flex flex-col gap-6 animate-in fade-in duration-200">
            <div className="border-b border-[#cdc4ba]/15 pb-4">
              <span className="eyebrow block mb-1">02 // CONCEPT DIAGNOSTIC</span>
              <div className="flex items-center gap-2 mt-1">
                <h2 className="text-xl font-normal tracking-tight text-[#cdc4ba]">
                  Instructor Concept Check
                </h2>
                <span className="font-mono text-[10px] border border-[#cdc4ba]/30 bg-[#cdc4ba]/10 text-[#cdc4ba] px-2 py-0.5 animate-pulse">
                  ACTION REQUIRED
                </span>
              </div>
              <p className="font-mono text-[11px] text-[#cdc4ba]/40 mt-1">
                Select an option below to submit your response to the live dossier
              </p>
            </div>

            {/* Question Container */}
            <div className="border border-[#cdc4ba]/20 p-5 sm:p-6 bg-[#0d0d0d] flex flex-col gap-3">
              <span className="eyebrow">DIAGNOSTIC QUESTION</span>
              <h3 className="text-base sm:text-lg font-medium text-[#cdc4ba] leading-relaxed">
                {questionTitle}
              </h3>
            </div>

            {/* Choices A & B */}
            <div className="flex flex-col gap-3">
              {/* Option A */}
              <button
                type="button"
                disabled={submittingDiagnostic}
                onClick={() => handleDiagnosticAnswer('A')}
                className="w-full p-4 sm:p-5 border border-[#cdc4ba]/20 hover:border-[#cdc4ba]/70 hover:bg-[#cdc4ba]/5 active:bg-[#cdc4ba]/10 disabled:opacity-40 text-left transition-all cursor-pointer flex items-start gap-4 group bg-[#0d0d0d]"
              >
                <span className="font-mono text-xs px-2.5 py-1 border border-[#cdc4ba]/40 group-hover:border-[#cdc4ba] text-[#cdc4ba] group-hover:bg-[#cdc4ba]/10 shrink-0">
                  A
                </span>
                <div className="flex-1">
                  <span className="eyebrow block mb-1 group-hover:text-[#cdc4ba]/60">
                    OPTION A
                  </span>
                  <p className="text-sm sm:text-base text-[#cdc4ba]/90 group-hover:text-[#cdc4ba] leading-relaxed">
                    {optionAText}
                  </p>
                </div>
              </button>

              {/* Option B */}
              <button
                type="button"
                disabled={submittingDiagnostic}
                onClick={() => handleDiagnosticAnswer('B')}
                className="w-full p-4 sm:p-5 border border-[#cdc4ba]/20 hover:border-[#cdc4ba]/70 hover:bg-[#cdc4ba]/5 active:bg-[#cdc4ba]/10 disabled:opacity-40 text-left transition-all cursor-pointer flex items-start gap-4 group bg-[#0d0d0d]"
              >
                <span className="font-mono text-xs px-2.5 py-1 border border-[#cdc4ba]/40 group-hover:border-[#cdc4ba] text-[#cdc4ba] group-hover:bg-[#cdc4ba]/10 shrink-0">
                  B
                </span>
                <div className="flex-1">
                  <span className="eyebrow block mb-1 group-hover:text-[#cdc4ba]/60">
                    OPTION B
                  </span>
                  <p className="text-sm sm:text-base text-[#cdc4ba]/90 group-hover:text-[#cdc4ba] leading-relaxed">
                    {optionBText}
                  </p>
                </div>
              </button>
            </div>

            <p className="font-mono text-[11px] text-[#cdc4ba]/30 text-center">
              Your response is recorded into the session metrics for immediate review.
            </p>
          </section>
        ) : (
          /* ────────────── COMPREHENSION PULSE MODE ────────────── */
          <section className="flex flex-col gap-6">
            <div className="border-b border-[#cdc4ba]/15 pb-4">
              <span className="eyebrow block mb-1">01 // COMPREHENSION TELEMETRY</span>
              <h2 className="text-xl font-normal tracking-tight text-[#cdc4ba]">
                Lecture Comprehension Pulse
              </h2>
              <p className="font-mono text-[11px] text-[#cdc4ba]/40 mt-1">
                Select your comprehension status to inform the instructor in real-time
              </p>
            </div>

            {/* Current Topic Context Card (if present) */}
            {currentTopic && (
              <div className="border border-[#cdc4ba]/15 p-4 flex items-center justify-between bg-[#0d0d0d]">
                <div className="truncate mr-3">
                  <span className="eyebrow block mb-0.5">CURRENT TOPIC</span>
                  <p className="font-mono text-xs text-[#cdc4ba] truncate">
                    {currentTopic}
                  </p>
                </div>
                <Activity className="h-3.5 w-3.5 text-[#cdc4ba]/40 animate-pulse shrink-0" />
              </div>
            )}

            {/* Three Signal Buttons */}
            <div className="flex flex-col gap-3.5">
              {/* Button 1: GOT IT */}
              <button
                type="button"
                disabled={cooldownRemaining > 0}
                onClick={() => sendSignal('got_it')}
                className="w-full border border-[#cdc4ba]/20 hover:border-[#cdc4ba]/70 hover:bg-[#cdc4ba]/5 active:bg-[#cdc4ba]/10 disabled:opacity-30 disabled:pointer-events-none p-5 text-left transition-all cursor-pointer bg-[#0d0d0d] flex items-center justify-between group"
              >
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 border border-[#cdc4ba]/20 group-hover:border-[#cdc4ba]/50 flex items-center justify-center shrink-0 font-mono text-xs text-[#cdc4ba]/60 group-hover:text-[#cdc4ba]">
                    01
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-mono text-lg font-semibold tracking-wider text-[#cdc4ba]">
                        GOT IT
                      </h3>
                      <span className="font-mono text-[10px] text-[#cdc4ba]/40 border border-[#cdc4ba]/15 px-1.5 py-0.5">
                        NOMINAL
                      </span>
                    </div>
                    <p className="font-mono text-xs text-[#cdc4ba]/40 mt-0.5">
                      Concept is clear · following along comfortably
                    </p>
                  </div>
                </div>
                <CheckCircle2 className="h-5 w-5 text-[#cdc4ba]/30 group-hover:text-[#cdc4ba]/70 transition-colors shrink-0" />
              </button>

              {/* Button 2: KINDA */}
              <button
                type="button"
                disabled={cooldownRemaining > 0}
                onClick={() => sendSignal('kinda')}
                className="w-full border border-[#cdc4ba]/20 hover:border-[#cdc4ba]/70 hover:bg-[#cdc4ba]/5 active:bg-[#cdc4ba]/10 disabled:opacity-30 disabled:pointer-events-none p-5 text-left transition-all cursor-pointer bg-[#0d0d0d] flex items-center justify-between group"
              >
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 border border-[#cdc4ba]/20 group-hover:border-[#cdc4ba]/50 flex items-center justify-center shrink-0 font-mono text-xs text-[#cdc4ba]/60 group-hover:text-[#cdc4ba]">
                    02
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-mono text-lg font-semibold tracking-wider text-[#cdc4ba]">
                        KINDA
                      </h3>
                      <span className="font-mono text-[10px] text-[#cdc4ba]/40 border border-[#cdc4ba]/15 px-1.5 py-0.5">
                        UNCERTAIN
                      </span>
                    </div>
                    <p className="font-mono text-xs text-[#cdc4ba]/40 mt-0.5">
                      Slightly shaky · need an example or brief recap
                    </p>
                  </div>
                </div>
                <HelpCircle className="h-5 w-5 text-[#cdc4ba]/30 group-hover:text-[#cdc4ba]/70 transition-colors shrink-0" />
              </button>

              {/* Button 3: LOST (Hold to confirm transmission) */}
              <div className="relative w-full">
                <button
                  type="button"
                  disabled={cooldownRemaining > 0}
                  onPointerDown={handlePointerDown}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerLeave}
                  onPointerCancel={handlePointerCancel}
                  className={`w-full relative overflow-hidden border p-5 text-left transition-all select-none touch-none cursor-pointer flex items-center justify-between ${
                    cooldownRemaining > 0
                      ? 'border-[#cdc4ba]/10 bg-[#0d0d0d] opacity-30 pointer-events-none'
                      : isHolding
                        ? 'border-[#cdc4ba] bg-[#cdc4ba]/10'
                        : 'border-[#cdc4ba]/30 hover:border-[#cdc4ba]/70 hover:bg-[#cdc4ba]/5 bg-[#0d0d0d]'
                  }`}
                  style={{ WebkitTouchCallout: 'none', userSelect: 'none' }}
                >
                  {/* Progress Fill Indicator */}
                  <div
                    className="absolute left-0 top-0 bottom-0 bg-[#cdc4ba]/15 transition-all duration-75 pointer-events-none"
                    style={{ width: `${holdProgress}%` }}
                  />

                  <div className="flex items-center gap-4 relative z-10">
                    <div
                      className={`h-10 w-10 border flex items-center justify-center shrink-0 font-mono text-xs transition-colors ${
                        isHolding
                          ? 'border-[#cdc4ba] text-[#cdc4ba] bg-[#cdc4ba]/10'
                          : 'border-[#cdc4ba]/20 text-[#cdc4ba]/60'
                      }`}
                    >
                      03
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-mono text-lg font-semibold tracking-wider text-[#cdc4ba]">
                          LOST
                        </h3>
                        <span
                          className={`font-mono text-[10px] border px-1.5 py-0.5 transition-colors ${
                            isHolding
                              ? 'border-[#cdc4ba] text-[#cdc4ba] bg-[#cdc4ba]/20'
                              : 'border-[#cdc4ba]/20 text-[#cdc4ba]/50'
                          }`}
                        >
                          {isHolding ? 'HOLDING...' : 'HOLD 1.2S'}
                        </span>
                      </div>
                      <p className="font-mono text-xs text-[#cdc4ba]/40 mt-0.5">
                        {isHolding
                          ? 'Keep holding to transmit signal...'
                          : 'Struggling with concept · press & hold to transmit'}
                      </p>
                    </div>
                  </div>

                  {/* Circular SVG Progress Ring */}
                  <div className="relative h-12 w-12 flex items-center justify-center shrink-0 z-10">
                    <svg className="h-12 w-12 -rotate-90 transform" viewBox="0 0 80 80">
                      {/* Track */}
                      <circle
                        cx="40"
                        cy="40"
                        r={circleRadius}
                        className="stroke-[#cdc4ba]/15"
                        strokeWidth="5"
                        fill="transparent"
                      />
                      {/* Progress */}
                      <circle
                        cx="40"
                        cy="40"
                        r={circleRadius}
                        className="stroke-[#cdc4ba] transition-all duration-75 ease-linear"
                        strokeWidth="5"
                        strokeDasharray={circumference}
                        strokeDashoffset={strokeDashoffset}
                        strokeLinecap="square"
                        fill="transparent"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center font-mono text-[10px] font-bold text-[#cdc4ba]">
                      {holdProgress > 0 ? (
                        `${Math.round(holdProgress)}%`
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-[#cdc4ba]/40" />
                      )}
                    </div>
                  </div>
                </button>
              </div>
            </div>

            {/* Protocol Explanation Note */}
            <div className="border border-[#cdc4ba]/10 p-4 font-mono text-[11px] text-[#cdc4ba]/40 flex items-start gap-3">
              <span className="border border-[#cdc4ba]/20 px-1.5 py-0.5 text-[10px] text-[#cdc4ba]/50 shrink-0">
                INFO
              </span>
              <span className="leading-relaxed">
                Signals are aggregated into a 60-second rolling telemetry window. A confusion spike (≥50%) prompts the instructor with auto-generated pedagogical analogies.
              </span>
            </div>
          </section>
        )}
      </main>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="border-t border-[#cdc4ba]/10 px-6 sm:px-10 py-4 flex items-center justify-between">
        <span className="font-mono text-[10px] text-[#cdc4ba]/30 tracking-wider">
          CLASSPULSE // STUDENT TERMINAL
        </span>
        {roomId && (
          <span className="font-mono text-[10px] text-[#cdc4ba]/30">
            SESSION {roomId}
          </span>
        )}
      </footer>
    </div>
  );
}
