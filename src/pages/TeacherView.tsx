import { useEffect, useState, useRef } from 'react';
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
  Database,
  Wifi,
  Laptop,
  ExternalLink,
  Globe,
  ChevronDown,
} from 'lucide-react';
import {
  db,
  collection,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
  onSnapshot,
  getDocs,
  currentStorageMode,
} from '../lib/firebase';
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

interface NetworkInterfaceItem {
  name: string;
  address: string;
  isDefault: boolean;
}

interface NetworkConfig {
  localIp: string;
  port: number;
  allIps: NetworkInterfaceItem[];
}

export default function TeacherView() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [sessionStartTime, setSessionStartTime] = useState<number>(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sessionCreatedRef = useRef(false);

  // Network connection & local IP discovery state
  const [networkConfig, setNetworkConfig] = useState<NetworkConfig | null>(null);
  const [selectedHostMode, setSelectedHostMode] = useState<'network' | 'localhost'>('network');
  const [activeLanIp, setActiveLanIp] = useState<string>('');
  const [hostDropdownOpen, setHostDropdownOpen] = useState(false);
  const hostDropdownRef = useRef<HTMLDivElement>(null);

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

  // Fetch server network configuration (local IP & adapters)
  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        if (data && data.localIp) {
          setNetworkConfig({
            localIp: data.localIp,
            port: data.port || 3000,
            allIps: data.allIps || [],
          });
          setActiveLanIp(data.localIp);
        }
      })
      .catch((err) => {
        console.warn('[TeacherView] Could not fetch server network config:', err);
      });
  }, []);

  // Close host dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (hostDropdownRef.current && !hostDropdownRef.current.contains(e.target as Node)) {
        setHostDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
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

  // Determine effective origin for student devices (local IP on Wi-Fi vs localhost vs custom)
  const effectiveBaseUrl = (() => {
    // 1. Explicit Localhost mode
    if (selectedHostMode === 'localhost') {
      const port = window.location.port
        ? `:${window.location.port}`
        : networkConfig?.port
          ? `:${networkConfig.port}`
          : ':3000';
      return `${window.location.protocol}//localhost${port}`;
    }

    // 2. Network mode (default)
    const hostname = window.location.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';

    if (!isLocalhost) {
      // Teacher is already browsing via LAN IP or public domain
      return window.location.origin;
    }

    // Teacher opened on localhost: automatically route other devices to LAN IP
    const targetIp = activeLanIp || networkConfig?.localIp;
    if (targetIp && targetIp !== 'localhost') {
      const port = window.location.port || (networkConfig?.port ? `${networkConfig.port}` : '3000');
      return `${window.location.protocol}//${targetIp}${port ? `:${port}` : ''}`;
    }

    return window.location.origin;
  })();

  const joinUrl = roomId ? `${effectiveBaseUrl}/join/${roomId}` : '';

  const handleCopy = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const chartStrokeColor = isConfusionSpike ? '#cdc4ba' : 'rgba(205,196,186,0.5)';

  const totalTally = tallyA + tallyB;
  const percentA = totalTally > 0 ? Math.round((tallyA / totalTally) * 100) : 50;
  const percentB = totalTally > 0 ? Math.round((tallyB / totalTally) * 100) : 50;

  return (
    <div className="min-h-screen w-full flex flex-col bg-[#0a0a0a] text-[#cdc4ba]">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="w-full px-6 sm:px-10 py-4 flex items-center justify-between border-b border-[#cdc4ba]/15 bg-[#0a0a0a] sticky top-0 z-30">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-[#cdc4ba]">CLASSPULSE</h1>
            <span className="eyebrow">TEACHER DOSSIER</span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {/* Host Mode Dropdown */}
          <div className="relative" ref={hostDropdownRef}>
            <button
              type="button"
              onClick={() => setHostDropdownOpen((prev) => !prev)}
              className="flex items-center gap-1.5 border border-[#cdc4ba]/20 hover:border-[#cdc4ba]/50 hover:bg-[#cdc4ba]/5 px-3 py-1.5 font-mono text-xs text-[#cdc4ba]/70 transition-all cursor-pointer"
              title="Configure QR Code Network Host"
            >
              <Globe className="h-3 w-3 text-[#cdc4ba]/40" />
              <span className="hidden md:inline text-[#cdc4ba]/40">HOST:</span>
              <span className="text-[#cdc4ba]">
                {selectedHostMode === 'network' ? (activeLanIp || 'WIFI') : 'localhost'}
              </span>
              <ChevronDown
                className={`h-3 w-3 text-[#cdc4ba]/40 transition-transform duration-200 ${
                  hostDropdownOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {hostDropdownOpen && (
              <div className="absolute right-0 top-full mt-1 w-72 sm:w-80 bg-[#0d0d0d] border border-[#cdc4ba]/20 p-4 z-50 text-left animate-in fade-in duration-150">
                <div className="flex items-center justify-between pb-2.5 mb-3 border-b border-[#cdc4ba]/15">
                  <span className="eyebrow">QR LINK TARGET HOST</span>
                  <span className="font-mono text-[10px] text-[#cdc4ba]/40">
                    :{networkConfig?.port || window.location.port || 3000}
                  </span>
                </div>

                <p className="font-mono text-[11px] text-[#cdc4ba]/40 mb-3 leading-relaxed">
                  Select which address student phones use when scanning:
                </p>

                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => { setSelectedHostMode('network'); setHostDropdownOpen(false); }}
                    className={`w-full flex items-center justify-between p-2.5 text-xs border transition-all cursor-pointer ${
                      selectedHostMode === 'network'
                        ? 'border-[#cdc4ba]/60 bg-[#cdc4ba]/8 text-[#cdc4ba]'
                        : 'border-[#cdc4ba]/15 text-[#cdc4ba]/60 hover:bg-[#cdc4ba]/5 hover:border-[#cdc4ba]/30'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Wifi className="h-3.5 w-3.5 text-[#cdc4ba]/50" />
                      <div className="text-left">
                        <div className="font-medium text-[#cdc4ba]">Local Wi-Fi IP</div>
                        <div className="font-mono text-[10px] text-[#cdc4ba]/40">
                          {activeLanIp || networkConfig?.localIp || 'Detecting...'}
                        </div>
                      </div>
                    </div>
                    {selectedHostMode === 'network' && (
                      <Check className="h-3.5 w-3.5 text-[#cdc4ba]" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => { setSelectedHostMode('localhost'); setHostDropdownOpen(false); }}
                    className={`w-full flex items-center justify-between p-2.5 text-xs border transition-all cursor-pointer ${
                      selectedHostMode === 'localhost'
                        ? 'border-[#cdc4ba]/60 bg-[#cdc4ba]/8 text-[#cdc4ba]'
                        : 'border-[#cdc4ba]/15 text-[#cdc4ba]/60 hover:bg-[#cdc4ba]/5 hover:border-[#cdc4ba]/30'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Laptop className="h-3.5 w-3.5 text-[#cdc4ba]/50" />
                      <div className="text-left">
                        <div className="font-medium text-[#cdc4ba]">Localhost</div>
                        <div className="font-mono text-[10px] text-[#cdc4ba]/40">
                          localhost:{networkConfig?.port || window.location.port || 3000}
                        </div>
                      </div>
                    </div>
                    {selectedHostMode === 'localhost' && (
                      <Check className="h-3.5 w-3.5 text-[#cdc4ba]" />
                    )}
                  </button>
                </div>

                {/* Multi-adapter selection */}
                {selectedHostMode === 'network' && networkConfig && networkConfig.allIps && networkConfig.allIps.length > 1 && (
                  <div className="mt-3 pt-3 border-t border-[#cdc4ba]/15 flex flex-col gap-1.5">
                    <label className="eyebrow">NETWORK ADAPTER</label>
                    <select
                      value={activeLanIp}
                      onChange={(e) => setActiveLanIp(e.target.value)}
                      className="w-full bg-[#0a0a0a] border border-[#cdc4ba]/20 text-[#cdc4ba] text-xs p-2 focus:outline-none font-mono"
                    >
                      {networkConfig.allIps.map((item) => (
                        <option key={item.address} value={item.address}>
                          {item.name}: {item.address} {item.isDefault ? '(default)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="mt-3 pt-2.5 border-t border-[#cdc4ba]/15 font-mono text-[10px] text-[#cdc4ba]/30 leading-normal">
                  Devices on same Wi-Fi router connect via this address.
                </div>
              </div>
            )}
          </div>

          {/* Storage Mode Badge */}
          <div className="hidden sm:flex items-center gap-1.5 border border-[#cdc4ba]/15 px-3 py-1.5 font-mono text-xs text-[#cdc4ba]/40">
            <Database className="h-3 w-3" />
            <span>{currentStorageMode === 'firebase' ? 'Firebase' : 'JSON DB'}</span>
          </div>

          {/* Live indicator */}
          {roomId && !isSessionEnded && (
            <div className="flex items-center gap-1.5 border border-[#cdc4ba]/20 px-3 py-1.5 font-mono text-xs text-[#cdc4ba]/70">
              <span className="w-1.5 h-1.5 rounded-full bg-[#cdc4ba] animate-pulse" />
              LIVE
            </div>
          )}

          {/* End Session */}
          {roomId && !isSessionEnded && (
            <button
              type="button"
              onClick={handleEndSession}
              className="flex items-center gap-1.5 border border-[#cdc4ba]/20 hover:border-[#cdc4ba]/60 hover:bg-[#cdc4ba]/5 text-[#cdc4ba]/60 hover:text-[#cdc4ba] font-mono text-xs px-3 py-1.5 transition-all cursor-pointer"
            >
              <Power className="h-3 w-3" />
              END SESSION
            </button>
          )}

          {/* New Session */}
          {isSessionEnded && (
            <button
              type="button"
              onClick={initializeSession}
              className="flex items-center gap-1.5 border border-[#cdc4ba]/40 hover:border-[#cdc4ba] hover:bg-[#cdc4ba]/5 text-[#cdc4ba] font-mono text-xs px-3 py-1.5 transition-all cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
              NEW SESSION
            </button>
          )}
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────────── */}
      <main className="w-full max-w-4xl mx-auto flex-1 flex flex-col px-6 sm:px-10 py-10 gap-16">

        {/* Loading State */}
        {loading && (
          <div className="flex flex-col items-center gap-4 my-auto py-20">
            <Loader2 className="h-8 w-8 text-[#cdc4ba]/40 animate-spin" />
            <p className="eyebrow">INITIALIZING SESSION</p>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="border border-[#cdc4ba]/30 bg-[#cdc4ba]/5 p-6 flex flex-col gap-3 my-auto">
            <span className="eyebrow">SESSION ERROR</span>
            <p className="text-sm text-[#cdc4ba]/70">{error}</p>
            <p className="font-mono text-[11px] text-[#cdc4ba]/40">
              Verify Firebase credentials in{' '}
              <code className="border border-[#cdc4ba]/20 px-1.5 py-0.5 font-mono text-[#cdc4ba]/60">.env</code>
            </p>
          </div>
        )}

        {/* ────────────── POST-SESSION SUMMARY VIEW ────────────── */}
        {isSessionEnded && !loading && (
          <div className="flex flex-col gap-12 animate-in fade-in duration-300">

            {/* 05 // Summary Banner */}
            <div className="flex flex-col gap-1 border-b border-[#cdc4ba]/15 pb-6">
              <span className="eyebrow">05 // POST-SESSION REPORT</span>
              <h2 className="text-2xl sm:text-3xl font-normal tracking-tight text-[#cdc4ba]">
                Bottleneck Heatmap
              </h2>
              <p className="font-mono text-xs text-[#cdc4ba]/40 mt-1">
                CONFUSION DISTRIBUTION IN 2-MINUTE LECTURE SEGMENTS &nbsp;·&nbsp; ROOM {roomId}
              </p>
            </div>

            {loadingSummary ? (
              <div className="py-12 flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 text-[#cdc4ba]/40 animate-spin" />
                <p className="eyebrow">AGGREGATING DATA</p>
              </div>
            ) : (
              <>
                {/* Confusion BarChart */}
                <div className="flex flex-col gap-5 border border-[#cdc4ba]/15 p-6">
                  <div className="flex items-center justify-between border-b border-[#cdc4ba]/15 pb-3">
                    <div>
                      <span className="eyebrow block mb-1">CONFUSION SCORE / 2-MIN WINDOW</span>
                      <p className="font-mono text-[11px] text-[#cdc4ba]/40">
                        High bars indicate lecture bottlenecks where students struggled most
                      </p>
                    </div>
                  </div>

                  {summaryBuckets.length > 0 ? (
                    <div className="w-full h-64 sm:h-72 pt-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={summaryBuckets} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
                          <XAxis
                            dataKey="bucket"
                            tick={{ fill: 'rgba(205,196,186,0.4)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
                            tickLine={{ stroke: 'rgba(205,196,186,0.1)' }}
                            axisLine={{ stroke: 'rgba(205,196,186,0.1)' }}
                          />
                          <YAxis
                            domain={[0, 100]}
                            tick={{ fill: 'rgba(205,196,186,0.4)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
                            tickLine={{ stroke: 'rgba(205,196,186,0.1)' }}
                            axisLine={{ stroke: 'rgba(205,196,186,0.1)' }}
                            ticks={[0, 25, 50, 75, 100]}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: '#0d0d0d',
                              borderColor: 'rgba(205,196,186,0.2)',
                              borderRadius: '2px',
                              fontSize: '11px',
                              color: '#cdc4ba',
                              fontFamily: 'JetBrains Mono, monospace',
                            }}
                            formatter={(value, name) => [`${value}%`, name === 'confusionScore' ? 'Confusion' : name]}
                            labelFormatter={(label) => `Interval: ${label}`}
                          />
                          <Bar dataKey="confusionScore" radius={[0, 0, 0, 0]}>
                            {summaryBuckets.map((entry, index) => {
                              const opacity = entry.confusionScore >= 50 ? 1 : entry.confusionScore >= 25 ? 0.6 : 0.3;
                              return <Cell key={`cell-${index}`} fill={`rgba(205,196,186,${opacity})`} />;
                            })}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="py-10 text-center font-mono text-xs text-[#cdc4ba]/30">
                      No response signals recorded during this session.
                    </div>
                  )}
                </div>

                {/* Diagnostic Recap */}
                <div className="flex flex-col gap-6 border border-[#cdc4ba]/15 p-6">
                  <div className="border-b border-[#cdc4ba]/15 pb-3">
                    <span className="eyebrow block mb-1">DIAGNOSTIC CHECKS & CONFIRMED MISCONCEPTIONS</span>
                    <p className="font-mono text-[11px] text-[#cdc4ba]/40">
                      AI-assisted concept checks pushed to students during this session
                    </p>
                  </div>

                  {summaryDiagnostics.length > 0 ? (
                    <div className="flex flex-col gap-5">
                      {summaryDiagnostics.map((diag, index) => {
                        const total = diag.tallyA + diag.tallyB;
                        const pA = total > 0 ? Math.round((diag.tallyA / total) * 100) : 0;
                        const pB = total > 0 ? Math.round((diag.tallyB / total) * 100) : 0;

                        return (
                          <div key={diag.id || index} className="border border-[#cdc4ba]/15 p-5 flex flex-col gap-4">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <span className="eyebrow block mb-1">
                                  CHECK #{String(index + 1).padStart(2, '0')}
                                </span>
                                <h4 className="text-sm font-medium text-[#cdc4ba] leading-snug">
                                  {diag.question}
                                </h4>
                              </div>
                              <span className="font-mono text-[10px] text-[#cdc4ba]/40 border border-[#cdc4ba]/15 px-2 py-1 shrink-0">
                                {total} responses
                              </span>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <div className="border border-[#cdc4ba]/15 p-3 flex items-start gap-3">
                                <span className={`font-mono text-xs px-1.5 py-0.5 border shrink-0 ${
                                  diag.correctOption === 'A'
                                    ? 'border-[#cdc4ba]/60 text-[#cdc4ba]'
                                    : 'border-[#cdc4ba]/20 text-[#cdc4ba]/40'
                                }`}>A</span>
                                <div className="text-xs text-[#cdc4ba]/70 flex-1">
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="font-mono text-[10px] text-[#cdc4ba]/40">
                                      {diag.correctOption === 'A' ? 'TARGET' : 'MISCONCEPTION'}
                                    </span>
                                    <span className="font-mono text-[#cdc4ba]/60">{diag.tallyA} ({pA}%)</span>
                                  </div>
                                  <p>{diag.optionA}</p>
                                </div>
                              </div>

                              <div className="border border-[#cdc4ba]/15 p-3 flex items-start gap-3">
                                <span className={`font-mono text-xs px-1.5 py-0.5 border shrink-0 ${
                                  diag.correctOption === 'B' || !diag.correctOption
                                    ? 'border-[#cdc4ba]/60 text-[#cdc4ba]'
                                    : 'border-[#cdc4ba]/20 text-[#cdc4ba]/40'
                                }`}>B</span>
                                <div className="text-xs text-[#cdc4ba]/70 flex-1">
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="font-mono text-[10px] text-[#cdc4ba]/40">
                                      {diag.correctOption === 'B' || !diag.correctOption ? 'TARGET' : 'MISCONCEPTION'}
                                    </span>
                                    <span className="font-mono text-[#cdc4ba]/60">{diag.tallyB} ({pB}%)</span>
                                  </div>
                                  <p>{diag.optionB}</p>
                                </div>
                              </div>
                            </div>

                            {/* Split bar */}
                            <div className="w-full h-2 bg-[#cdc4ba]/10 overflow-hidden flex">
                              <div style={{ width: `${pA}%` }} className="bg-[#cdc4ba]/50 h-full transition-all duration-500" />
                              <div style={{ width: `${pB}%` }} className="bg-[#cdc4ba] h-full transition-all duration-500" />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="py-8 text-center font-mono text-xs text-[#cdc4ba]/30">
                      No diagnostic questions were pushed during this session.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ────────────── LIVE SESSION DASHBOARD ────────────── */}
        {!isSessionEnded && !loading && !error && roomId && (
          <div className="w-full flex flex-col gap-16">

            {/* 01 // ACCESS POINT */}
            <section className="flex flex-col gap-6">
              <div className="border-b border-[#cdc4ba]/15 pb-4">
                <span className="eyebrow block mb-1">01 // ACCESS POINT &amp; INVITATION</span>
                <h2 className="text-xl font-normal tracking-tight text-[#cdc4ba]">
                  {selectedHostMode === 'localhost'
                    ? 'Localhost Mode — This PC Only'
                    : `Network Access — ${activeLanIp || networkConfig?.localIp || 'Detecting...'}`}
                </h2>
              </div>

              <div className="flex flex-col sm:flex-row gap-8 items-start">
                {/* QR Code */}
                <div className="p-4 bg-white self-start">
                  <QRCodeSVG value={joinUrl} size={200} level="H" includeMargin={true} />
                </div>

                {/* Room ID + URL */}
                <div className="flex flex-col gap-5 flex-1">
                  <div>
                    <span className="eyebrow block mb-2">ROOM ID</span>
                    <div className="flex items-center gap-3 border border-[#cdc4ba]/20 px-4 py-3">
                      <span className="font-mono text-3xl sm:text-4xl font-bold tracking-widest text-[#cdc4ba] select-all">
                        {roomId}
                      </span>
                      <div className="flex items-center gap-1.5 border-l border-[#cdc4ba]/15 pl-3 ml-auto">
                        <button
                          type="button"
                          onClick={handleCopy}
                          title="Copy Join Link"
                          className="p-1.5 border border-[#cdc4ba]/20 hover:border-[#cdc4ba]/60 hover:bg-[#cdc4ba]/5 text-[#cdc4ba]/60 hover:text-[#cdc4ba] transition-all cursor-pointer"
                        >
                          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        </button>
                        <a
                          href={joinUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open Student View in New Tab"
                          className="p-1.5 border border-[#cdc4ba]/20 hover:border-[#cdc4ba]/60 hover:bg-[#cdc4ba]/5 text-[#cdc4ba]/60 hover:text-[#cdc4ba] transition-all"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                    </div>
                  </div>

                  <div>
                    <span className="eyebrow block mb-2">JOIN URL</span>
                    <p className="font-mono text-xs text-[#cdc4ba]/50 select-all break-all border border-[#cdc4ba]/15 px-3 py-2">
                      {joinUrl}
                    </p>
                  </div>

                  <p className="font-mono text-[11px] text-[#cdc4ba]/30">
                    Devices on same Wi-Fi network can scan QR or navigate to the URL above.
                  </p>
                </div>
              </div>
            </section>

            {/* 02 // LECTURE TOPIC */}
            <section className="flex flex-col gap-4">
              <div className="border-b border-[#cdc4ba]/15 pb-4">
                <span className="eyebrow block mb-1">02 // LECTURE TOPIC</span>
                <h2 className="text-xl font-normal tracking-tight text-[#cdc4ba]">
                  Current Context (Broadcast to AI)
                </h2>
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="currentTopicInput" className="eyebrow">
                  TOPIC STRING — BROADCASTED TO SESSION &amp; GEMINI
                </label>
                <input
                  id="currentTopicInput"
                  type="text"
                  value={currentTopic}
                  onChange={handleTopicChange}
                  placeholder="e.g. Binary Search Trees, Dynamic Programming, Thermodynamics..."
                  className="w-full bg-transparent border border-[#cdc4ba]/20 hover:border-[#cdc4ba]/40 focus:border-[#cdc4ba]/70 focus:outline-none px-4 py-3 font-mono text-sm text-[#cdc4ba] placeholder-[#cdc4ba]/20 transition-all"
                />
              </div>
            </section>

            {/* 03 // TELEMETRY (appears once signals received) */}
            {hasReceivedSignal ? (
              <section className="flex flex-col gap-8 animate-in fade-in duration-300">
                <div className="border-b border-[#cdc4ba]/15 pb-4">
                  <span className="eyebrow block mb-1">03 // TELEMETRY &amp; LIVE PULSE</span>
                  <h2 className="text-xl font-normal tracking-tight text-[#cdc4ba]">
                    Real-Time Comprehension Signal
                  </h2>
                </div>

                {/* Status Card */}
                <div className={`border p-6 flex flex-col gap-5 ${
                  isConfusionSpike
                    ? 'border-[#cdc4ba] bg-[#cdc4ba]/5'
                    : 'border-[#cdc4ba]/20'
                }`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="eyebrow block mb-1">
                        {isConfusionSpike ? '⚠ CONFUSION SPIKE DETECTED' : 'COMPREHENSION NOMINAL'}
                      </span>
                      <p className="font-mono text-sm text-[#cdc4ba]">
                        Confusion score: {latestStats.confusionScore}% {isConfusionSpike ? '(≥ 50% threshold)' : '(below threshold)'}
                      </p>
                    </div>
                    <div className="text-right hidden sm:block">
                      <span className="eyebrow block mb-0.5">60s WINDOW</span>
                      <span className="font-mono text-sm text-[#cdc4ba]">
                        {latestStats.totalInWindow} responses
                      </span>
                    </div>
                  </div>

                  {/* Stat cells */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="border border-[#cdc4ba]/15 p-4 text-center">
                      <span className="eyebrow block mb-1">01 // GOT IT</span>
                      <span className="font-mono text-2xl font-bold text-[#cdc4ba]">
                        {latestStats.gotItPercent}%
                      </span>
                    </div>
                    <div className="border border-[#cdc4ba]/15 p-4 text-center">
                      <span className="eyebrow block mb-1">02 // KINDA</span>
                      <span className="font-mono text-2xl font-bold text-[#cdc4ba]/70">
                        {latestStats.kindaPercent}%
                      </span>
                    </div>
                    <div className="border border-[#cdc4ba]/15 p-4 text-center">
                      <span className="eyebrow block mb-1">03 // LOST</span>
                      <span className={`font-mono text-2xl font-bold ${
                        isConfusionSpike ? 'text-[#cdc4ba]' : 'text-[#cdc4ba]/40'
                      }`}>
                        {latestStats.lostPercent}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* 04 // AI Intervention Panel */}
                {isConfusionSpike && (
                  <div className="border border-[#cdc4ba]/30 p-6 flex flex-col gap-6 animate-in fade-in duration-200">
                    <div className="flex items-center justify-between border-b border-[#cdc4ba]/15 pb-4">
                      <div>
                        <span className="eyebrow block mb-1">
                          04 // AI INTERVENTION PROTOCOL
                        </span>
                        <div className="flex items-center gap-2 mt-1">
                          <h3 className="text-base font-medium text-[#cdc4ba]">
                            Pedagogical Intervention
                          </h3>
                          <span className="font-mono text-[10px] border border-[#cdc4ba]/20 text-[#cdc4ba]/40 px-1.5 py-0.5">
                            GEMINI 2.5 FLASH
                          </span>
                        </div>
                        <p className="font-mono text-[11px] text-[#cdc4ba]/40 mt-1">
                          Auto-generated analogy &amp; concept diagnostic for &ldquo;{currentTopic || 'Current Topic'}&rdquo;
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={handleRegenerate}
                        disabled={loadingIntervention}
                        title="Regenerate Intervention"
                        className="p-2 border border-[#cdc4ba]/20 hover:border-[#cdc4ba]/60 hover:bg-[#cdc4ba]/5 text-[#cdc4ba]/50 hover:text-[#cdc4ba] transition-all cursor-pointer disabled:opacity-30"
                      >
                        <RefreshCw className={`h-4 w-4 ${loadingIntervention ? 'animate-spin' : ''}`} />
                      </button>
                    </div>

                    {loadingIntervention ? (
                      <div className="py-10 flex flex-col items-center gap-3">
                        <Loader2 className="h-8 w-8 text-[#cdc4ba]/40 animate-spin" />
                        <p className="eyebrow">GENERATING ANALOGY &amp; DIAGNOSTIC</p>
                      </div>
                    ) : intervention ? (
                      <div className="flex flex-col gap-6">
                        {/* Analogy */}
                        <div className="border border-[#cdc4ba]/20 p-5">
                          <span className="eyebrow block mb-3">SUGGESTED TEACHING ANALOGY</span>
                          <p className="text-base font-normal text-[#cdc4ba]/90 leading-relaxed italic">
                            &ldquo;{intervention.analogy}&rdquo;
                          </p>
                        </div>

                        {/* Diagnostic Preview */}
                        <div className="border border-[#cdc4ba]/15 p-5 flex flex-col gap-4">
                          <div>
                            <span className="eyebrow block mb-2">DIAGNOSTIC CONCEPT CHECK</span>
                            <h4 className="text-sm font-medium text-[#cdc4ba] leading-snug">
                              {intervention.diagnosticQuestion}
                            </h4>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div className="border border-[#cdc4ba]/15 p-3 flex items-start gap-3">
                              <span className={`font-mono text-xs px-1.5 py-0.5 border shrink-0 ${
                                intervention.correctOption === 'A'
                                  ? 'border-[#cdc4ba]/60 text-[#cdc4ba]'
                                  : 'border-[#cdc4ba]/20 text-[#cdc4ba]/40'
                              }`}>A</span>
                              <div className="text-xs text-[#cdc4ba]/70">
                                <span className="font-mono text-[10px] text-[#cdc4ba]/40 block mb-0.5">
                                  {intervention.correctOption === 'A' ? 'TARGET:' : 'MISCONCEPTION:'}
                                </span>
                                {intervention.optionA}
                              </div>
                            </div>

                            <div className="border border-[#cdc4ba]/15 p-3 flex items-start gap-3">
                              <span className={`font-mono text-xs px-1.5 py-0.5 border shrink-0 ${
                                intervention.correctOption === 'B' || !intervention.correctOption
                                  ? 'border-[#cdc4ba]/60 text-[#cdc4ba]'
                                  : 'border-[#cdc4ba]/20 text-[#cdc4ba]/40'
                              }`}>B</span>
                              <div className="text-xs text-[#cdc4ba]/70">
                                <span className="font-mono text-[10px] text-[#cdc4ba]/40 block mb-0.5">
                                  {intervention.correctOption === 'B' || !intervention.correctOption ? 'TARGET:' : 'MISCONCEPTION:'}
                                </span>
                                {intervention.optionB}
                              </div>
                            </div>
                          </div>

                          {intervention.misconceptionIfWrong && (
                            <div className="font-mono text-[11px] text-[#cdc4ba]/40 border border-[#cdc4ba]/10 px-3 py-2">
                              <span className="text-[#cdc4ba]/60">Misconception targeted: </span>
                              {intervention.misconceptionIfWrong}
                            </div>
                          )}

                          {/* Push Diagnostic / Active Tally */}
                          {isDiagnosticPushed ? (
                            <div className="flex flex-col gap-4 border-t border-[#cdc4ba]/15 pt-4">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 font-mono text-xs text-[#cdc4ba]">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#cdc4ba] animate-ping" />
                                  DIAGNOSTIC ACTIVE — {totalTally} ANSWERS
                                </div>
                                <button
                                  type="button"
                                  onClick={handleDismissDiagnostic}
                                  className="flex items-center gap-1.5 font-mono text-xs text-[#cdc4ba]/40 hover:text-[#cdc4ba] border border-[#cdc4ba]/15 hover:border-[#cdc4ba]/40 px-2.5 py-1 transition-all cursor-pointer"
                                >
                                  <X className="h-3 w-3" />
                                  DISMISS
                                </button>
                              </div>

                              {/* Split bar */}
                              <div className="w-full flex flex-col gap-2">
                                <div className="h-6 w-full bg-[#cdc4ba]/10 overflow-hidden flex border border-[#cdc4ba]/15">
                                  <div
                                    style={{ width: `${percentA}%` }}
                                    className="bg-[#cdc4ba]/50 h-full flex items-center justify-center font-mono text-[10px] font-bold text-[#0a0a0a] transition-all duration-500"
                                  >
                                    {totalTally > 0 && `${percentA}%`}
                                  </div>
                                  <div
                                    style={{ width: `${percentB}%` }}
                                    className="bg-[#cdc4ba] h-full flex items-center justify-center font-mono text-[10px] font-bold text-[#0a0a0a] transition-all duration-500"
                                  >
                                    {totalTally > 0 && `${percentB}%`}
                                  </div>
                                </div>
                                <div className="flex justify-between font-mono text-[10px] text-[#cdc4ba]/40">
                                  <span>A: {tallyA} students</span>
                                  <span>B: {tallyB} students</span>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={handlePushDiagnostic}
                              className="w-full py-3 border border-[#cdc4ba]/30 hover:border-[#cdc4ba] hover:bg-[#cdc4ba]/5 text-[#cdc4ba] font-mono text-xs flex items-center justify-center gap-2 transition-all cursor-pointer"
                            >
                              <Send className="h-3.5 w-3.5" />
                              PUSH DIAGNOSTIC TO CLASS
                            </button>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}

                {/* Live Comprehension Curve */}
                <div className="border border-[#cdc4ba]/15 p-6 flex flex-col gap-4">
                  <div className="flex items-center justify-between border-b border-[#cdc4ba]/15 pb-3">
                    <div>
                      <span className="eyebrow block mb-1">LIVE COMPREHENSION CURVE</span>
                      <p className="font-mono text-[11px] text-[#cdc4ba]/40">
                        Confusion score history (last 30 ticks, updated every 2s)
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-xs text-[#cdc4ba]/40">
                      <Activity className="h-3.5 w-3.5 animate-pulse" />
                      LIVE
                    </div>
                  </div>

                  <div className="w-full h-56 sm:h-64 pt-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={history.length > 0 ? history : [{ index: 0, score: 0, time: '' }]}
                        margin={{ top: 8, right: 8, left: -24, bottom: 0 }}
                      >
                        <YAxis
                          domain={[0, 100]}
                          tick={{ fill: 'rgba(205,196,186,0.4)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
                          tickLine={{ stroke: 'rgba(205,196,186,0.1)' }}
                          axisLine={{ stroke: 'rgba(205,196,186,0.1)' }}
                          ticks={[0, 25, 50, 75, 100]}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#0d0d0d',
                            borderColor: 'rgba(205,196,186,0.2)',
                            borderRadius: '2px',
                            fontSize: '11px',
                            color: '#cdc4ba',
                            fontFamily: 'JetBrains Mono, monospace',
                          }}
                          formatter={(value) => [`${value}%`, 'Confusion']}
                          labelFormatter={(label) => `Tick ${label}`}
                        />
                        <Line
                          type="monotone"
                          dataKey="score"
                          stroke={chartStrokeColor}
                          strokeWidth={1.5}
                          dot={false}
                          activeDot={{ r: 3, fill: '#cdc4ba', strokeWidth: 0 }}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </section>
            ) : (
              /* Waiting for signals placeholder */
              <section className="flex flex-col gap-6">
                <div className="border-b border-[#cdc4ba]/15 pb-4">
                  <span className="eyebrow block mb-1">03 // TELEMETRY &amp; LIVE PULSE</span>
                  <h2 className="text-xl font-normal tracking-tight text-[#cdc4ba]">
                    Awaiting Signals
                  </h2>
                </div>
                <div className="border border-[#cdc4ba]/15 p-8 flex flex-col items-center gap-3 text-center">
                  <Activity className="h-5 w-5 text-[#cdc4ba]/20 animate-pulse" />
                  <p className="font-mono text-xs text-[#cdc4ba]/40">
                    The live comprehension dashboard and AI intervention will appear<br />
                    as soon as students submit their first feedback signal.
                  </p>
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="border-t border-[#cdc4ba]/10 px-6 sm:px-10 py-4 flex items-center justify-between">
        <span className="font-mono text-[10px] text-[#cdc4ba]/30 tracking-wider">
          CLASSPULSE // TEACHER DOSSIER
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
