import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  CheckCircle,
  HelpCircle,
  AlertTriangle,
  Clock,
  Sparkles,
  ArrowLeft,
  ThumbsUp,
  Meh,
  Frown,
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

  // Firestore session data & diagnostic question
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
  // Tracks which pointer (finger/mouse) currently owns the hold gesture,
  // so a second touch landing on the button mid-hold can't cancel or
  // complete a hold it didn't start.
  const activeHoldPointerIdRef = useRef<number | null>(null);

  // Status feedback toast/banner
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  // Listen to the session document for diagnosticQuestion
  useEffect(() => {
    if (!roomId) return;

    const sessionDocRef = doc(db, 'sessions', roomId);
    const unsubscribe = onSnapshot(
      sessionDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data && data.diagnosticQuestion) {
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

  // Make sure an in-flight hold animation can't keep running (and calling
  // setState / sendSignal) after this component unmounts, e.g. if the
  // student navigates away mid-hold.
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
      if (!roomId || cooldownRemaining > 0) return;

      try {
        // Start 30s cooldown immediately
        setCooldownRemaining(30);

        const label =
          value === 'got_it' ? 'Got It' : value === 'kinda' ? 'Kinda' : 'Lost';
        setFeedbackMessage(`Sent: ${label}`);
        setTimeout(() => setFeedbackMessage(null), 3000);

        await addDoc(collection(db, 'sessions', roomId, 'signals'), {
          value,
          timestamp: serverTimestamp(),
        });
      } catch (err) {
        console.error('Failed to submit signal:', err);
      }
    },
    [roomId, cooldownRemaining]
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
    if (cooldownRemaining > 0) return;
    // Only handle primary pointer (e.g. left click or single touch), and
    // ignore a second finger landing on the button while a hold is
    // already in progress from a different pointer.
    if (e.button !== 0) return;
    if (activeHoldPointerIdRef.current !== null) return;

    cancelHold();
    activeHoldPointerIdRef.current = e.pointerId;

    // Explicitly capture the pointer to this button. Without this, some
    // browsers stop delivering pointermove/pointerup to the button (or
    // fire pointerleave) as soon as a touch drifts even slightly outside
    // its bounds, which made the hold cancel unreliably depending on the
    // device. Capturing keeps every subsequent event for this pointer
    // routed here until pointerup/pointercancel, regardless of where the
    // finger physically is.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture isn't available in every environment (e.g. some
      // test/browser combos) - the hold still works, just falls back to
      // relying on pointerleave for off-button cancellation.
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
    // With setPointerCapture in place, pointerleave now reliably means
    // "this pointer physically left the button" rather than firing early
    // due to touch hit-testing quirks - so cancelling here is safe and
    // predictable across browsers.
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
    if (!roomId || !activeDiagnostic || submittingDiagnostic) return;

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

      // Mark this diagnostic question as answered so view reverts to default
      setAnsweredDiagnostics((prev) => new Set(prev).add(diagnosticKey));
      setFeedbackMessage(`Option ${choice} submitted!`);
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
  const circleRadius = 36;
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
    'Quick Diagnostic Question';

  return (
    <div className="min-h-screen w-full flex flex-col bg-slate-950 text-white select-none overflow-x-hidden">
      {/* Top Navigation Bar */}
      <header className="px-5 py-4 flex items-center justify-between border-b border-slate-900/80 bg-slate-950/60 backdrop-blur-md sticky top-0 z-20">
        <Link
          to="/"
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Exit</span>
        </Link>
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="font-mono text-xs font-semibold tracking-wider text-slate-300">
            ROOM: {roomId || '---'}
          </span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-md w-full mx-auto p-5 flex flex-col justify-center">
        {/* Feedback Banner */}
        {feedbackMessage && (
          <div className="mb-4 py-2.5 px-4 rounded-xl bg-indigo-600/90 text-white text-center text-sm font-medium shadow-lg animate-in fade-in slide-in-from-top-2 duration-200">
            {feedbackMessage}
          </div>
        )}

        {/* Diagnostic Question Mode */}
        {showDiagnostic ? (
          <div className="w-full bg-slate-900 border-2 border-indigo-500/40 rounded-3xl p-6 shadow-2xl shadow-indigo-500/10 flex flex-col items-center text-center animate-in zoom-in-95 duration-200">
            <div className="h-12 w-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center mb-4">
              <Sparkles className="h-6 w-6 animate-pulse" />
            </div>

            <span className="text-xs uppercase tracking-widest text-indigo-400 font-bold mb-2">
              Teacher Asked
            </span>
            <h2 className="text-xl font-bold text-white mb-6 leading-snug">
              {questionTitle}
            </h2>

            <div className="w-full flex flex-col gap-4">
              {/* Option A Button */}
              <button
                type="button"
                disabled={submittingDiagnostic}
                onClick={() => handleDiagnosticAnswer('A')}
                className="w-full min-h-[72px] p-4 bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] disabled:opacity-50 text-white rounded-2xl font-bold text-lg flex items-center justify-start gap-4 transition-all shadow-lg shadow-indigo-600/20 cursor-pointer text-left"
              >
                <div className="h-10 w-10 shrink-0 rounded-xl bg-indigo-950/60 border border-indigo-400/30 flex items-center justify-center text-base font-extrabold text-indigo-200">
                  A
                </div>
                <span className="flex-1 break-words leading-tight">{optionAText}</span>
              </button>

              {/* Option B Button */}
              <button
                type="button"
                disabled={submittingDiagnostic}
                onClick={() => handleDiagnosticAnswer('B')}
                className="w-full min-h-[72px] p-4 bg-slate-800 hover:bg-slate-700 active:scale-[0.98] disabled:opacity-50 border border-slate-700 text-white rounded-2xl font-bold text-lg flex items-center justify-start gap-4 transition-all shadow-lg cursor-pointer text-left"
              >
                <div className="h-10 w-10 shrink-0 rounded-xl bg-slate-900 border border-slate-600 flex items-center justify-center text-base font-extrabold text-slate-200">
                  B
                </div>
                <span className="flex-1 break-words leading-tight">{optionBText}</span>
              </button>
            </div>

            <p className="text-xs text-slate-400 mt-6">
              Select one option to submit your response
            </p>
          </div>
        ) : (
          /* Default 3-Button Pulse Mode */
          <div className="w-full flex flex-col gap-4">
            <div className="text-center mb-2">
              <h2 className="text-2xl font-black tracking-tight text-white">
                How's the pace?
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Tap to give real-time feedback to your instructor
              </p>
            </div>

            {/* Rate Limiting Notice / Timer */}
            {cooldownRemaining > 0 && (
              <div className="py-2 px-4 rounded-xl bg-slate-900/90 border border-slate-800 flex items-center justify-center gap-2 text-indigo-400 text-xs font-semibold animate-in fade-in">
                <Clock className="h-4 w-4 animate-spin" />
                <span>You can respond again in {cooldownRemaining}s</span>
              </div>
            )}

            {/* Button 1: "Got It" (Green) */}
            <button
              type="button"
              disabled={cooldownRemaining > 0}
              onClick={() => sendSignal('got_it')}
              className="w-full h-24 sm:h-28 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none text-white rounded-3xl font-extrabold text-2xl flex items-center justify-between px-7 shadow-xl shadow-emerald-950/40 transition-all cursor-pointer"
            >
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-2xl bg-emerald-700/60 flex items-center justify-center">
                  <ThumbsUp className="h-7 w-7 text-emerald-100" />
                </div>
                <div className="text-left">
                  <div className="text-2xl sm:text-3xl leading-none">Got It</div>
                  <div className="text-xs text-emerald-200/80 font-normal mt-1">
                    Clear & following well
                  </div>
                </div>
              </div>
              <CheckCircle className="h-6 w-6 text-emerald-300 opacity-60" />
            </button>

            {/* Button 2: "Kinda" (Yellow/Amber) */}
            <button
              type="button"
              disabled={cooldownRemaining > 0}
              onClick={() => sendSignal('kinda')}
              className="w-full h-24 sm:h-28 bg-amber-600 hover:bg-amber-500 active:bg-amber-700 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none text-white rounded-3xl font-extrabold text-2xl flex items-center justify-between px-7 shadow-xl shadow-amber-950/40 transition-all cursor-pointer"
            >
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-2xl bg-amber-700/60 flex items-center justify-center">
                  <Meh className="h-7 w-7 text-amber-100" />
                </div>
                <div className="text-left">
                  <div className="text-2xl sm:text-3xl leading-none">Kinda</div>
                  <div className="text-xs text-amber-200/80 font-normal mt-1">
                    Slightly shaky on concepts
                  </div>
                </div>
              </div>
              <HelpCircle className="h-6 w-6 text-amber-300 opacity-60" />
            </button>

            {/* Button 3: "Lost" (Red with 1.2s Hold Confirmation & SVG Progress Ring) */}
            <div className="relative w-full">
              <button
                type="button"
                disabled={cooldownRemaining > 0}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerLeave}
                onPointerCancel={handlePointerCancel}
                className={`w-full h-24 sm:h-28 rounded-3xl font-extrabold text-white flex items-center justify-between px-7 shadow-xl transition-all select-none touch-none cursor-pointer overflow-hidden ${cooldownRemaining > 0
                  ? 'bg-rose-950/40 opacity-40 pointer-events-none'
                  : isHolding
                    ? 'bg-rose-700 scale-[0.99] shadow-rose-600/30'
                    : 'bg-rose-600 hover:bg-rose-500 active:bg-rose-700'
                  }`}
                style={{ WebkitTouchCallout: 'none', userSelect: 'none' }}
              >
                <div className="flex items-center gap-4 z-10">
                  <div className="h-12 w-12 rounded-2xl bg-rose-700/60 flex items-center justify-center">
                    <Frown className="h-7 w-7 text-rose-100" />
                  </div>
                  <div className="text-left">
                    <div className="text-2xl sm:text-3xl leading-none">Lost</div>
                    <div className="text-xs text-rose-200/80 font-normal mt-1">
                      {isHolding ? 'Keep holding...' : 'Press & hold 1.2s'}
                    </div>
                  </div>
                </div>

                {/* Circular SVG Progress Ring */}
                <div className="relative h-14 w-14 flex items-center justify-center z-10">
                  <svg className="h-14 w-14 -rotate-90 transform" viewBox="0 0 80 80">
                    {/* Background track circle */}
                    <circle
                      cx="40"
                      cy="40"
                      r={circleRadius}
                      className="stroke-rose-800/80"
                      strokeWidth="6"
                      fill="transparent"
                    />
                    {/* Filling progress circle (clockwise) */}
                    <circle
                      cx="40"
                      cy="40"
                      r={circleRadius}
                      className="stroke-white transition-all duration-75 ease-linear"
                      strokeWidth="6"
                      strokeDasharray={circumference}
                      strokeDashoffset={strokeDashoffset}
                      strokeLinecap="round"
                      fill="transparent"
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    {holdProgress > 0 ? (
                      <span className="font-mono text-[11px] font-black text-white">
                        {Math.round(holdProgress)}%
                      </span>
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-rose-200 opacity-80" />
                    )}
                  </div>
                </div>
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="p-4 text-center text-slate-600 text-[11px]">
        ClassPulse • Student Response Terminal
      </footer>
    </div>
  );
}
