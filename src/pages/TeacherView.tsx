import { useEffect, useState, useRef } from 'react';
import {
  collection,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
  onSnapshot,
  getDocs,
} from 'firebase/firestore';
import { QRCodeSVG } from 'qrcode.react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';
import {
  Loader2,
  AlertCircle,
  Copy,
  Check,
  Radio,
  BookOpen,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  Activity,
  Sparkles,
  Send,
  X,
  Quote,
  RefreshCw,
  Power,
  BarChart3,
  RotateCcw,
  Clock,
  HelpCircle,
} from 'lucide-react';
import { db } from '../lib/firebase';
import { useConfusionSignal } from '../hooks/useConfusionSignal';
import { generateIntervention, type InterventionResult } from '../lib/gemini';

interface DiagnosticHistoryItem {
  id: string;
  question: string;
  optionA: string;
  optionB: string;
  correctOption?: 'A' | 'B';
  misconceptionIfWrong?: string;
  tallyA: number;
  tallyB: number;
}

interface HeatmapBucket {
  bucket: string;
  confusionScore: number;
  count: number;
}

export default function TeacherView() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [sessionStartTime, setSessionStartTime] = useState<number>(Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sessionCreatedRef = useRef(false);

  // Current Topic with debounce
  const [currentTopic, setCurrentTopic] = useState('');
  const currentTopicRef = useRef('');
  const topicDebounceRef = useRef<number | null>(null);

  // End Session Summary State
  const [isSessionEnded, setIsSessionEnded] = useState(false);
  const [summaryBuckets, setSummaryBuckets] = useState<HeatmapBucket[]>([]);
  const [summaryDiagnostics, setSummaryDiagnostics] = useState<DiagnosticHistoryItem[]>([]);
  const [loadingSummary, setLoadingSummary] = useState(false);

  // Hook for real-time confusion metrics
  const { hasReceivedSignal, latestStats, history, isConfusionSpike } =
    useConfusionSignal(isSessionEnded ? null : roomId);

  // AI Intervention State
  const [intervention, setIntervention] = useState<InterventionResult | null>(null);
  const [loadingIntervention, setLoadingIntervention] = useState(false);
  const [isDiagnosticPushed, setIsDiagnosticPushed] = useState(false);
  const previousSpikeRef = useRef(false);

  // Live Diagnostic Responses Tally State
  const [tallyA, setTallyA] = useState(0);
  const [tallyB, setTallyB] = useState(0);
  const diagnosticsHistoryRef = useRef<DiagnosticHistoryItem[]>([]);

  // Function to initialize a new session
  const initializeSession = async () => {
    try {
      setLoading(true);
      setError(null);
      setIsSessionEnded(false);
      setSummaryBuckets([]);
      setSummaryDiagnostics([]);
      diagnosticsHistoryRef.current = [];
      setTallyA(0);
      setTallyB(0);
      setIntervention(null);
      setIsDiagnosticPushed(false);
      previousSpikeRef.current = false;
      const startTime = Date.now();
      setSessionStartTime(startTime);

      const docRef = await addDoc(collection(db, 'sessions'), {
        createdAt: serverTimestamp(),
        currentTopic: '',
        status: 'active',
        diagnosticQuestion: null,
        optionA: null,
        optionB: null,
      });
      setRoomId(docRef.id);
    } catch (err: unknown) {
      console.error('Failed to create session in Firestore:', err);
      const errorMessage =
        err instanceof Error
          ? err.message
          : 'Failed to create session. Please verify your Firebase configuration.';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionCreatedRef.current) return;
    sessionCreatedRef.current = true;
    initializeSession();
  }, []);

  // Listen to the session doc to track if diagnosticQuestion is currently active
  useEffect(() => {
    if (!roomId || isSessionEnded) return;
    const unsub = onSnapshot(doc(db, 'sessions', roomId), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setIsDiagnosticPushed(Boolean(data.diagnosticQuestion));
      }
    });
    return () => unsub();
  }, [roomId, isSessionEnded]);

  // Listen to diagnostic responses in real-time
  useEffect(() => {
    if (!roomId || isSessionEnded) return;
    const responsesRef = collection(db, 'sessions', roomId, 'diagnosticResponses');
    const unsub = onSnapshot(responsesRef, (snapshot) => {
      let countA = 0;
      let countB = 0;
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (data.choice === 'A') countA++;
        if (data.choice === 'B') countB++;
      });
      setTallyA(countA);
      setTallyB(countB);

      // Keep active diagnostic record up to date in history
      if (diagnosticsHistoryRef.current.length > 0) {
        const lastIdx = diagnosticsHistoryRef.current.length - 1;
        diagnosticsHistoryRef.current[lastIdx] = {
          ...diagnosticsHistoryRef.current[lastIdx],
          tallyA: countA,
          tallyB: countB,
        };
      }
    });
    return () => unsub();
  }, [roomId, isSessionEnded]);

  // Fetch AI intervention when confusionScore first crosses 50
  useEffect(() => {
    if (isSessionEnded) return;

    if (isConfusionSpike && !previousSpikeRef.current) {
      previousSpikeRef.current = true;

      const triggerIntervention = async () => {
        setLoadingIntervention(true);
        try {
          const result = await generateIntervention(currentTopicRef.current);
          setIntervention(result);
        } catch (err) {
          console.error('Failed to generate intervention:', err);
        } finally {
          setLoadingIntervention(false);
        }
      };

      triggerIntervention();
    } else if (!isConfusionSpike && previousSpikeRef.current) {
      previousSpikeRef.current = false;
    }
  }, [isConfusionSpike, isSessionEnded]);

  // Manual regenerate handler for teacher convenience
  const handleRegenerate = async () => {
    setLoadingIntervention(true);
    try {
      const result = await generateIntervention(currentTopicRef.current);
      setIntervention(result);
    } catch (err) {
      console.error('Failed to regenerate intervention:', err);
    } finally {
      setLoadingIntervention(false);
    }
  };

  // Push diagnostic question to all student devices
  const handlePushDiagnostic = async () => {
    if (!roomId || !intervention) return;
    try {
      await updateDoc(doc(db, 'sessions', roomId), {
        diagnosticQuestion: intervention.diagnosticQuestion,
        optionA: intervention.optionA,
        optionB: intervention.optionB,
      });

      // Save to history tracking
      const newItem: DiagnosticHistoryItem = {
        id: `diag_${Date.now()}`,
        question: intervention.diagnosticQuestion,
        optionA: intervention.optionA,
        optionB: intervention.optionB,
        correctOption: intervention.correctOption,
        misconceptionIfWrong: intervention.misconceptionIfWrong,
        tallyA: 0,
        tallyB: 0,
      };
      diagnosticsHistoryRef.current.push(newItem);
    } catch (err) {
      console.error('Failed to push diagnostic question:', err);
    }
  };

  // Dismiss diagnostic question to resume standard lecture pulse
  const handleDismissDiagnostic = async () => {
    if (!roomId) return;
    try {
      await updateDoc(doc(db, 'sessions', roomId), {
        diagnosticQuestion: null,
        optionA: null,
        optionB: null,
      });
    } catch (err) {
      console.error('Failed to dismiss diagnostic question:', err);
    }
  };

  // Debounced update for current topic
  const handleTopicChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTopic = e.target.value;
    setCurrentTopic(newTopic);
    currentTopicRef.current = newTopic;

    if (!roomId || isSessionEnded) return;

    if (topicDebounceRef.current) {
      window.clearTimeout(topicDebounceRef.current);
    }

    topicDebounceRef.current = window.setTimeout(async () => {
      try {
        await updateDoc(doc(db, 'sessions', roomId), {
          currentTopic: newTopic,
        });
      } catch (err) {
        console.error('Failed to update topic in Firestore:', err);
      }
    }, 500);
  };

  // End Session: Stop live listeners and generate summary heatmap
  const handleEndSession = async () => {
    if (!roomId) return;
    setLoadingSummary(true);
    setIsSessionEnded(true);

    try {
      // Mark session as ended in Firestore
      await updateDoc(doc(db, 'sessions', roomId), {
        status: 'ended',
        endedAt: serverTimestamp(),
      });

      // Fetch all signals once
      const signalsSnap = await getDocs(collection(db, 'sessions', roomId, 'signals'));
      const rawSignals: Array<{ value: string; timestampMs: number }> = [];

      signalsSnap.forEach((docSnap) => {
        const d = docSnap.data();
        let ts = Date.now();
        if (d.timestamp) {
          if (typeof d.timestamp.toMillis === 'function') {
            ts = d.timestamp.toMillis();
          } else if (typeof d.timestamp.toDate === 'function') {
            ts = d.timestamp.toDate().getTime();
          } else if (typeof d.timestamp.seconds === 'number') {
            ts = d.timestamp.seconds * 1000;
          } else if (typeof d.timestamp === 'number') {
            ts = d.timestamp;
          }
        }
        if (d.value === 'got_it' || d.value === 'kinda' || d.value === 'lost') {
          rawSignals.push({ value: d.value, timestampMs: ts });
        }
      });

      // 2-minute bucket aggregation
      const startMs = sessionStartTime;
      const endMs = Math.max(Date.now(), startMs + 120_000);
      const bucketDurationMs = 2 * 60 * 1000; // 2 minutes
      const totalBuckets = Math.max(1, Math.ceil((endMs - startMs) / bucketDurationMs));

      const computedBuckets: HeatmapBucket[] = [];

      for (let i = 0; i < totalBuckets; i++) {
        const bStart = startMs + i * bucketDurationMs;
        const bEnd = bStart + bucketDurationMs;
        const bLabel = `${i * 2}-${(i + 1) * 2}m`;

        const signalsInBucket = rawSignals.filter(
          (s) => s.timestampMs >= bStart && s.timestampMs < bEnd
        );

        const count = signalsInBucket.length;
        let score = 0;

        if (count > 0) {
          const kinda = signalsInBucket.filter((s) => s.value === 'kinda').length;
          const lost = signalsInBucket.filter((s) => s.value === 'lost').length;
          const lostPct = (lost / count) * 100;
          const kindaPct = (kinda / count) * 100;
          score = Number(Math.min(100, Math.max(0, lostPct + 0.5 * kindaPct)).toFixed(1));
        }

        computedBuckets.push({
          bucket: bLabel,
          confusionScore: score,
          count,
        });
      }

      setSummaryBuckets(computedBuckets);
      setSummaryDiagnostics([...diagnosticsHistoryRef.current]);
    } catch (err) {
      console.error('Failed to generate session summary:', err);
    } finally {
      setLoadingSummary(false);
    }
  };

  const joinUrl = roomId ? `${window.location.origin}/join/${roomId}` : '';

  const handleCopy = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const chartStrokeColor = isConfusionSpike ? '#ef4444' : '#10b981';

  const totalTally = tallyA + tallyB;
  const percentA = totalTally > 0 ? Math.round((tallyA / totalTally) * 100) : 50;
  const percentB = totalTally > 0 ? Math.round((tallyB / totalTally) * 100) : 50;

  return (
    <div className="min-h-screen w-full flex flex-col bg-slate-950 text-white p-4 sm:p-8">
      {/* Header Bar */}
      <header className="w-full max-w-5xl mx-auto flex items-center justify-between pb-6 border-b border-slate-900">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-500/30">
            <Radio className="h-5 w-5 animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">ClassPulse</h1>
            <p className="text-xs text-slate-400">Teacher Dashboard</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {roomId && !isSessionEnded && (
            <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3.5 py-1.5 rounded-full text-xs font-medium text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              Session Live
            </div>
          )}

          {roomId && !isSessionEnded && (
            <button
              type="button"
              onClick={handleEndSession}
              className="flex items-center gap-2 bg-rose-600/20 hover:bg-rose-600 border border-rose-500/40 text-rose-300 hover:text-white text-xs font-semibold px-4 py-2 rounded-xl transition-all cursor-pointer shadow-md"
            >
              <Power className="h-3.5 w-3.5" />
              <span>End Session</span>
            </button>
          )}

          {isSessionEnded && (
            <button
              type="button"
              onClick={initializeSession}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-all cursor-pointer shadow-md"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>New Session</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Container */}
      <main className="w-full max-w-5xl mx-auto flex-1 flex flex-col items-center justify-start py-8 gap-8">
        {loading && (
          <div className="flex flex-col items-center gap-4 my-auto">
            <Loader2 className="h-12 w-12 text-indigo-500 animate-spin" />
            <p className="text-slate-300 font-medium text-lg">Initializing classroom session...</p>
          </div>
        )}

        {error && (
          <div className="w-full max-w-lg bg-red-950/50 border border-red-800/80 rounded-2xl p-6 flex flex-col items-center gap-4 text-center my-auto">
            <div className="h-12 w-12 rounded-full bg-red-900/50 flex items-center justify-center text-red-400">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-red-200">Unable to create session</h2>
              <p className="text-sm text-red-300/80 mt-1">{error}</p>
              <p className="text-xs text-slate-400 mt-3">
                Ensure valid Firebase credentials are set in <code className="bg-slate-900 px-2 py-0.5 rounded text-slate-300">.env</code>
              </p>
            </div>
          </div>
        )}

        {/* ---------------- SECTION: POST-SESSION SUMMARY VIEW ---------------- */}
        {isSessionEnded && !loading && (
          <div className="w-full max-w-4xl flex flex-col gap-8 animate-in fade-in zoom-in-95 duration-300">
            {/* Summary Banner */}
            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-xl">
              <div className="flex items-center gap-4">
                <div className="h-14 w-14 rounded-2xl bg-indigo-500/20 border border-indigo-500/40 text-indigo-400 flex items-center justify-center shrink-0">
                  <BarChart3 className="h-7 w-7" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-indigo-400">
                      Post-Lecture Report
                    </span>
                    <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full">
                      Room {roomId}
                    </span>
                  </div>
                  <h2 className="text-2xl sm:text-3xl font-black text-white mt-1">
                    Curriculum Bottleneck Heatmap
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Aggregated confusion distribution grouped into 2-minute lecture segments
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Clock className="h-4 w-4 text-slate-500" />
                <span>Session Ended</span>
              </div>
            </div>

            {loadingSummary ? (
              <div className="py-16 flex flex-col items-center justify-center gap-3">
                <Loader2 className="h-10 w-10 text-indigo-500 animate-spin" />
                <p className="text-sm text-slate-400 font-medium">Aggregating bottleneck heatmap...</p>
              </div>
            ) : (
              <>
                {/* 1. Miniature Bottleneck Heatmap (BarChart) */}
                <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl flex flex-col gap-5">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <div>
                      <h3 className="text-base font-bold text-white">
                        Average Confusion Score per 2-Minute Window
                      </h3>
                      <p className="text-xs text-slate-400">
                        High red bars indicate key lecture bottlenecks where students struggled most
                      </p>
                    </div>
                  </div>

                  {summaryBuckets.length > 0 ? (
                    <div className="w-full h-72 sm:h-80 pt-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={summaryBuckets}
                          margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                        >
                          <XAxis
                            dataKey="bucket"
                            tick={{ fill: '#94a3b8', fontSize: 11 }}
                            tickLine={{ stroke: '#334155' }}
                            axisLine={{ stroke: '#334155' }}
                          />
                          <YAxis
                            domain={[0, 100]}
                            tick={{ fill: '#94a3b8', fontSize: 11 }}
                            tickLine={{ stroke: '#334155' }}
                            axisLine={{ stroke: '#334155' }}
                            ticks={[0, 25, 50, 75, 100]}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: '#0f172a',
                              borderColor: '#334155',
                              borderRadius: '0.75rem',
                              fontSize: '12px',
                              color: '#fff',
                            }}
                            formatter={(value, name) => [
                              `${value}%`,
                              name === 'confusionScore' ? 'Avg Confusion' : name,
                            ]}
                            labelFormatter={(label) => `Lecture Interval: ${label}`}
                          />
                          <Bar dataKey="confusionScore" radius={[6, 6, 0, 0]}>
                            {summaryBuckets.map((entry, index) => {
                              const fill =
                                entry.confusionScore >= 50
                                  ? '#ef4444' // Red spike
                                  : entry.confusionScore >= 25
                                  ? '#f59e0b' // Amber moderate
                                  : '#10b981'; // Green clear
                              return <Cell key={`cell-${index}`} fill={fill} />;
                            })}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="py-12 text-center text-slate-500 text-sm">
                      No response signals recorded during this session.
                    </div>
                  )}
                </div>

                {/* 2. Diagnostic Question Events Recap */}
                <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl flex flex-col gap-6">
                  <div className="border-b border-slate-800 pb-3">
                    <h3 className="text-base font-bold text-white">
                      Diagnostic Checks & Confirmed Misconceptions
                    </h3>
                    <p className="text-xs text-slate-400">
                      Summary of AI-assisted concept checks pushed to students during this session
                    </p>
                  </div>

                  {summaryDiagnostics.length > 0 ? (
                    <div className="flex flex-col gap-5">
                      {summaryDiagnostics.map((diag, index) => {
                        const total = diag.tallyA + diag.tallyB;
                        const pA = total > 0 ? Math.round((diag.tallyA / total) * 100) : 0;
                        const pB = total > 0 ? Math.round((diag.tallyB / total) * 100) : 0;

                        return (
                          <div
                            key={diag.id || index}
                            className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5 flex flex-col gap-4"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <span className="text-[10px] uppercase font-bold tracking-wider text-indigo-400">
                                  Diagnostic Prompt #{index + 1}
                                </span>
                                <h4 className="text-base font-semibold text-white mt-0.5">
                                  {diag.question}
                                </h4>
                              </div>
                              <span className="text-xs font-mono text-slate-400 shrink-0 bg-slate-900 px-2.5 py-1 rounded-lg border border-slate-800">
                                {total} responses
                              </span>
                            </div>

                            {/* Options with breakdown */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 flex items-start gap-3">
                                <span className={`h-6 w-6 rounded-lg font-bold text-xs flex items-center justify-center shrink-0 ${
                                  diag.correctOption === 'A'
                                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                                    : 'bg-indigo-950 text-indigo-300 border border-indigo-500/30'
                                }`}>
                                  A
                                </span>
                                <div className="text-xs text-slate-300 flex-1">
                                  <div className="flex items-center justify-between mb-1">
                                    <span className={`font-semibold ${
                                      diag.correctOption === 'A' ? 'text-emerald-300' : 'text-slate-200'
                                    }`}>
                                      {diag.correctOption === 'A' ? 'Target Concept' : 'Misconception'}
                                    </span>
                                    <span className="font-mono font-bold text-indigo-300">
                                      {diag.tallyA} votes ({pA}%)
                                    </span>
                                  </div>
                                  <p>{diag.optionA}</p>
                                </div>
                              </div>

                              <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 flex items-start gap-3">
                                <span className={`h-6 w-6 rounded-lg font-bold text-xs flex items-center justify-center shrink-0 ${
                                  diag.correctOption === 'B' || !diag.correctOption
                                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                                    : 'bg-indigo-950 text-indigo-300 border border-indigo-500/30'
                                }`}>
                                  B
                                </span>
                                <div className="text-xs text-slate-300 flex-1">
                                  <div className="flex items-center justify-between mb-1">
                                    <span className={`font-semibold ${
                                      diag.correctOption === 'B' || !diag.correctOption ? 'text-emerald-300' : 'text-slate-200'
                                    }`}>
                                      {diag.correctOption === 'B' || !diag.correctOption ? 'Target Concept' : 'Misconception'}
                                    </span>
                                    <span className="font-mono font-bold text-emerald-300">
                                      {diag.tallyB} votes ({pB}%)
                                    </span>
                                  </div>
                                  <p>{diag.optionB}</p>
                                </div>
                              </div>
                            </div>

                            {/* Split bar visualization */}
                            <div className="w-full h-4 bg-slate-900 rounded-lg overflow-hidden flex border border-slate-800">
                              <div
                                style={{ width: `${pA}%` }}
                                className="bg-indigo-600 h-full transition-all duration-500"
                              />
                              <div
                                style={{ width: `${pB}%` }}
                                className="bg-emerald-600 h-full transition-all duration-500"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="py-8 text-center text-slate-500 text-sm flex flex-col items-center gap-2">
                      <HelpCircle className="h-6 w-6 text-slate-600" />
                      <span>No diagnostic questions were pushed during this session.</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ---------------- SECTION: LIVE SESSION DASHBOARD ---------------- */}
        {!isSessionEnded && !loading && !error && roomId && (
          <div className="w-full flex flex-col items-center gap-10">
            {/* Top QR Code & Room Invitation Section */}
            <section className="w-full flex flex-col items-center text-center">
              <div className="mb-6">
                <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-white">
                  Join the Session
                </h2>
                <p className="text-slate-400 mt-2 text-sm sm:text-base">
                  Scan the QR code with your camera or enter the room code manually
                </p>
              </div>

              {/* QR Code */}
              <div className="p-6 bg-white rounded-3xl shadow-2xl shadow-indigo-500/10 ring-8 ring-indigo-500/10">
                <QRCodeSVG
                  value={joinUrl}
                  size={260}
                  level="H"
                  includeMargin={true}
                />
              </div>

              {/* Room Code Display */}
              <div className="mt-8 flex flex-col items-center gap-2">
                <span className="text-xs uppercase tracking-widest text-slate-400 font-semibold">
                  Room ID Code
                </span>
                <div className="flex items-center gap-3 bg-slate-900/90 border border-slate-800 px-6 py-3 rounded-2xl shadow-inner">
                  <span className="font-mono text-3xl sm:text-4xl font-bold tracking-wider text-indigo-400 select-all">
                    {roomId}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopy}
                    title="Copy Join Link"
                    className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
                  >
                    {copied ? (
                      <Check className="h-5 w-5 text-emerald-400" />
                    ) : (
                      <Copy className="h-5 w-5" />
                    )}
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-1 select-all break-all max-w-sm">
                  {joinUrl}
                </p>
              </div>
            </section>

            {/* Current Topic Input Box (above dashboard) */}
            <section className="w-full max-w-3xl bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="h-10 w-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center shrink-0">
                <BookOpen className="h-5 w-5" />
              </div>
              <div className="flex-1 w-full">
                <label
                  htmlFor="currentTopicInput"
                  className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1"
                >
                  Current Topic (Broadcasted to Session & AI)
                </label>
                <input
                  id="currentTopicInput"
                  type="text"
                  value={currentTopic}
                  onChange={handleTopicChange}
                  placeholder="e.g., Binary Search Trees, Dynamic Programming, Thermodynamics..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                />
              </div>
            </section>

            {/* Live Comprehension Dashboard (appears once at least 1 signal is received) */}
            {hasReceivedSignal ? (
              <section className="w-full max-w-3xl flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                {/* 1. Status Alert Card */}
                {isConfusionSpike ? (
                  <div className="w-full bg-rose-950/40 border-2 border-rose-500/80 rounded-3xl p-6 shadow-2xl shadow-rose-950/50 animate-pulse flex flex-col gap-5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-xl bg-rose-600 text-white flex items-center justify-center">
                          <AlertTriangle className="h-6 w-6" />
                        </div>
                        <div>
                          <h3 className="text-lg sm:text-xl font-black text-rose-300">
                            ⚠ Confusion Spike Detected
                          </h3>
                          <p className="text-xs text-rose-300/80">
                            Confusion score is at {latestStats.confusionScore}% (&gt;= 50% threshold)
                          </p>
                        </div>
                      </div>
                      <div className="text-right hidden sm:block">
                        <span className="text-xs uppercase tracking-wider text-rose-400/80 font-bold block">
                          60s Window
                        </span>
                        <span className="text-sm font-mono text-rose-200">
                          {latestStats.totalInWindow} responses
                        </span>
                      </div>
                    </div>

                    {/* Stat Badges */}
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-slate-950/80 border border-emerald-900/60 rounded-2xl p-3.5 text-center">
                        <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold block">
                          Got It
                        </span>
                        <span className="text-2xl font-black text-emerald-400 font-mono">
                          {latestStats.gotItPercent}%
                        </span>
                      </div>

                      <div className="bg-slate-950/80 border border-amber-900/60 rounded-2xl p-3.5 text-center">
                        <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold block">
                          Kinda
                        </span>
                        <span className="text-2xl font-black text-amber-400 font-mono">
                          {latestStats.kindaPercent}%
                        </span>
                      </div>

                      <div className="bg-slate-950/80 border border-rose-900/60 rounded-2xl p-3.5 text-center">
                        <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold block">
                          Lost
                        </span>
                        <span className="text-2xl font-black text-rose-400 font-mono">
                          {latestStats.lostPercent}%
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="w-full bg-slate-900/90 border border-emerald-500/40 rounded-3xl p-6 shadow-xl flex flex-col gap-5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-xl bg-emerald-600/20 border border-emerald-500/30 text-emerald-400 flex items-center justify-center">
                          <CheckCircle2 className="h-6 w-6" />
                        </div>
                        <div>
                          <h3 className="text-lg sm:text-xl font-bold text-emerald-300">
                            All Good • Lecture On Track
                          </h3>
                          <p className="text-xs text-slate-400">
                            Confusion score is low at {latestStats.confusionScore}%
                          </p>
                        </div>
                      </div>
                      <div className="text-right hidden sm:block">
                        <span className="text-xs uppercase tracking-wider text-slate-500 font-bold block">
                          60s Window
                        </span>
                        <span className="text-sm font-mono text-slate-300">
                          {latestStats.totalInWindow} responses
                        </span>
                      </div>
                    </div>

                    {/* Stat Badges */}
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-3.5 text-center">
                        <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold block">
                          Got It
                        </span>
                        <span className="text-2xl font-black text-emerald-400 font-mono">
                          {latestStats.gotItPercent}%
                        </span>
                      </div>

                      <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-3.5 text-center">
                        <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold block">
                          Kinda
                        </span>
                        <span className="text-2xl font-black text-amber-400 font-mono">
                          {latestStats.kindaPercent}%
                        </span>
                      </div>

                      <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-3.5 text-center">
                        <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold block">
                          Lost
                        </span>
                        <span className="text-2xl font-black text-rose-400 font-mono">
                          {latestStats.lostPercent}%
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* 2. AI Intervention Panel (Visible only when confusionScore >= 50) */}
                {isConfusionSpike && (
                  <div className="w-full bg-slate-900 border-2 border-indigo-500/60 rounded-3xl p-6 shadow-2xl shadow-indigo-950/60 flex flex-col gap-6 animate-in zoom-in-95 duration-300">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-2xl bg-indigo-500/20 border border-indigo-500/40 text-indigo-400 flex items-center justify-center">
                          <Sparkles className="h-6 w-6 animate-spin" style={{ animationDuration: '4s' }} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-lg font-bold text-white">
                              AI Lecture Intervention
                            </h3>
                            <span className="text-[10px] bg-indigo-500/20 text-indigo-300 font-bold px-2 py-0.5 rounded-full border border-indigo-500/30">
                              Gemini 2.5 Flash
                            </span>
                          </div>
                          <p className="text-xs text-slate-400">
                            Auto-generated pedagogical analogy and concept diagnostic for &ldquo;{currentTopic || 'Current Topic'}&rdquo;
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={handleRegenerate}
                        disabled={loadingIntervention}
                        title="Regenerate Intervention"
                        className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <RefreshCw className={`h-4 w-4 ${loadingIntervention ? 'animate-spin' : ''}`} />
                      </button>
                    </div>

                    {loadingIntervention ? (
                      <div className="py-12 flex flex-col items-center justify-center gap-3">
                        <Loader2 className="h-10 w-10 text-indigo-500 animate-spin" />
                        <p className="text-sm font-medium text-slate-300">
                          Generating intuitive teaching analogy & diagnostic check...
                        </p>
                      </div>
                    ) : intervention ? (
                      <div className="flex flex-col gap-6">
                        {/* Analogy Quote Card */}
                        <div className="relative bg-gradient-to-br from-indigo-950/60 to-slate-900 border border-indigo-500/30 rounded-2xl p-6">
                          <Quote className="absolute top-4 right-4 h-12 w-12 text-indigo-500/10 pointer-events-none" />
                          <span className="text-[11px] font-bold uppercase tracking-widest text-indigo-400 block mb-2">
                            Suggested Teaching Analogy
                          </span>
                          <p className="text-lg sm:text-xl font-medium text-indigo-100 leading-relaxed italic">
                            &ldquo;{intervention.analogy}&rdquo;
                          </p>
                        </div>

                        {/* Diagnostic Question Preview Card */}
                        <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5 flex flex-col gap-4">
                          <div>
                            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400 block mb-1">
                              Diagnostic Concept Check
                            </span>
                            <h4 className="text-base font-semibold text-white">
                              {intervention.diagnosticQuestion}
                            </h4>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 flex items-start gap-3">
                              <span className={`h-6 w-6 rounded-lg font-bold text-xs flex items-center justify-center shrink-0 ${
                                intervention.correctOption === 'A'
                                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                                  : 'bg-indigo-950 text-indigo-300 border border-indigo-500/30'
                              }`}>
                                A
                              </span>
                              <div className="text-xs text-slate-300">
                                <span className={`font-semibold block mb-0.5 ${
                                  intervention.correctOption === 'A' ? 'text-emerald-300' : 'text-slate-200'
                                }`}>
                                  {intervention.correctOption === 'A' ? 'Target Concept:' : 'Misconception:'}
                                </span>
                                {intervention.optionA}
                              </div>
                            </div>

                            <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 flex items-start gap-3">
                              <span className={`h-6 w-6 rounded-lg font-bold text-xs flex items-center justify-center shrink-0 ${
                                intervention.correctOption === 'B' || !intervention.correctOption
                                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                                  : 'bg-indigo-950 text-indigo-300 border border-indigo-500/30'
                              }`}>
                                B
                              </span>
                              <div className="text-xs text-slate-300">
                                <span className={`font-semibold block mb-0.5 ${
                                  intervention.correctOption === 'B' || !intervention.correctOption ? 'text-emerald-300' : 'text-slate-200'
                                }`}>
                                  {intervention.correctOption === 'B' || !intervention.correctOption ? 'Target Concept:' : 'Misconception:'}
                                </span>
                                {intervention.optionB}
                              </div>
                            </div>
                          </div>

                          {intervention.misconceptionIfWrong && (
                            <div className="text-[11px] text-slate-400 bg-slate-900/50 rounded-lg px-3 py-1.5 border border-slate-800/60">
                              <span className="font-semibold text-slate-300">Misconception targeted: </span>
                              {intervention.misconceptionIfWrong}
                            </div>
                          )}

                          {/* Action Button: Push Diagnostic / Dismiss / Live Tally */}
                          {isDiagnosticPushed ? (
                            <div className="pt-2 flex flex-col gap-4 border-t border-slate-800/80">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
                                  Diagnostic Active on Student Phones ({totalTally} answers)
                                </div>
                                <button
                                  type="button"
                                  onClick={handleDismissDiagnostic}
                                  className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-red-400 transition-colors cursor-pointer px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800"
                                >
                                  <X className="h-3.5 w-3.5" />
                                  <span>Dismiss & Continue Lecture</span>
                                </button>
                              </div>

                              {/* Live A vs B Horizontal Split Bar Comparison */}
                              <div className="w-full flex flex-col gap-2">
                                <div className="h-7 w-full bg-slate-950 rounded-xl overflow-hidden flex border border-slate-800">
                                  <div
                                    style={{ width: `${percentA}%` }}
                                    className="bg-indigo-600 h-full flex items-center justify-center text-[11px] font-black text-white transition-all duration-500"
                                  >
                                    {totalTally > 0 && `${percentA}% (A)`}
                                  </div>
                                  <div
                                    style={{ width: `${percentB}%` }}
                                    className="bg-emerald-600 h-full flex items-center justify-center text-[11px] font-black text-white transition-all duration-500"
                                  >
                                    {totalTally > 0 && `${percentB}% (B)`}
                                  </div>
                                </div>

                                <div className="flex justify-between text-xs font-mono text-slate-400">
                                  <span>Option A: {tallyA} students</span>
                                  <span>Option B: {tallyB} students</span>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={handlePushDiagnostic}
                              className="mt-2 w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] text-white font-bold rounded-xl flex items-center justify-center gap-2.5 shadow-lg shadow-indigo-600/30 transition-all cursor-pointer"
                            >
                              <Send className="h-4 w-4" />
                              <span>Push Diagnostic to Class</span>
                            </button>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}

                {/* 3. Live Comprehension Retention Curve (Recharts) */}
                <div className="w-full bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl flex flex-col gap-4">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                    <div className="flex items-center gap-2.5">
                      <TrendingUp className="h-5 w-5 text-indigo-400" />
                      <div>
                        <h4 className="text-base font-bold text-white">
                          Live Comprehension Retention Curve
                        </h4>
                        <p className="text-xs text-slate-400">
                          Confusion Score history (last 30 ticks, updated every 2s)
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-400 font-medium">
                      <Activity className="h-4 w-4 text-indigo-400 animate-pulse" />
                      <span>Live Stream</span>
                    </div>
                  </div>

                  {/* Chart Container */}
                  <div className="w-full h-64 sm:h-72 pt-4">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={history.length > 0 ? history : [{ index: 0, score: 0, time: '' }]}
                        margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                      >
                        <YAxis
                          domain={[0, 100]}
                          tick={{ fill: '#94a3b8', fontSize: 11 }}
                          tickLine={{ stroke: '#334155' }}
                          axisLine={{ stroke: '#334155' }}
                          ticks={[0, 25, 50, 75, 100]}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#0f172a',
                            borderColor: '#334155',
                            borderRadius: '0.75rem',
                            fontSize: '12px',
                            color: '#fff',
                          }}
                          formatter={(value) => [`${value}%`, 'Confusion Score']}
                          labelFormatter={(label) => `Tick ${label}`}
                        />
                        <Line
                          type="monotone"
                          dataKey="score"
                          stroke={chartStrokeColor}
                          strokeWidth={3}
                          dot={false}
                          activeDot={{ r: 6, fill: chartStrokeColor }}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </section>
            ) : (
              /* Waiting for signals placeholder */
              <div className="w-full max-w-md p-6 rounded-3xl bg-slate-900/60 border border-slate-800/80 text-center flex flex-col items-center gap-3">
                <Activity className="h-6 w-6 text-slate-500 animate-pulse" />
                <div>
                  <p className="text-sm font-semibold text-slate-300">
                    Waiting for student responses...
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    The live comprehension dashboard and AI intervention will automatically appear as soon as students submit their first feedback signal.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
