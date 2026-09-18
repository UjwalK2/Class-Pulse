import { useState, useEffect, useRef } from 'react';
import {
  Users,
  Play,
  Square,
  TrendingDown,
  TrendingUp,
  Sliders,
} from 'lucide-react';
import { db, collection, addDoc, serverTimestamp } from '../lib/firebase';

interface ClassSimulatorProps {
  roomId: string | null;
  isDiagnosticPushed: boolean;
  isSessionEnded: boolean;
}

type SimulationMode = 'confusion' | 'balanced' | 'clear';

export default function ClassSimulator({
  roomId,
  isDiagnosticPushed,
  isSessionEnded,
}: ClassSimulatorProps) {
  const [isRunning, setIsRunning] = useState(false);
  const [mode, setMode] = useState<SimulationMode>('confusion');
  const [studentCount, setStudentCount] = useState(25);
  const [signalsSent, setSignalsSent] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);

  const answeredQuestionsRef = useRef<Set<string>>(new Set());

  // Automatic Signal Emission Loop
  useEffect(() => {
    if (!isRunning || !roomId || isSessionEnded) return;

    let timeoutId: number;

    const emitSignal = async () => {
      let chosenValue: 'got_it' | 'kinda' | 'lost';

      const rand = Math.random();
      if (mode === 'confusion') {
        // High confusion to trigger AI intervention
        if (rand < 0.65) chosenValue = 'lost';
        else if (rand < 0.9) chosenValue = 'kinda';
        else chosenValue = 'got_it';
      } else if (mode === 'balanced') {
        if (rand < 0.5) chosenValue = 'got_it';
        else if (rand < 0.8) chosenValue = 'kinda';
        else chosenValue = 'lost';
      } else {
        // Clear
        if (rand < 0.85) chosenValue = 'got_it';
        else chosenValue = 'kinda';
      }

      try {
        await addDoc(collection(db, 'sessions', roomId, 'signals'), {
          value: chosenValue,
          timestamp: serverTimestamp(),
        });
        setSignalsSent((prev) => prev + 1);
      } catch (err) {
        console.warn('[Simulator] Failed to emit simulated signal:', err);
      }

      // Random delay between 700ms and 1400ms for realistic continuous traffic
      const delay = Math.floor(Math.random() * 700) + 700;
      timeoutId = window.setTimeout(emitSignal, delay);
    };

    timeoutId = window.setTimeout(emitSignal, 500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isRunning, roomId, isSessionEnded, mode]);

  // Simulated Diagnostic Voting
  useEffect(() => {
    if (!isRunning || !roomId || !isDiagnosticPushed || isSessionEnded) return;

    // Trigger auto-responses when a question is pushed
    const simKey = `${roomId}_diag_${Date.now()}`;
    if (answeredQuestionsRef.current.has(simKey)) return;
    answeredQuestionsRef.current.add(simKey);

    const voterCount = Math.min(studentCount, 22);
    const timers: number[] = [];

    for (let i = 0; i < voterCount; i++) {
      const staggerMs = Math.floor(Math.random() * 3200) + 400; // answers trickle in over 3.6s
      const choice: 'A' | 'B' = Math.random() < 0.58 ? 'B' : 'A';

      const timer = window.setTimeout(async () => {
        try {
          await addDoc(collection(db, 'sessions', roomId, 'diagnosticResponses'), {
            choice,
            answeredAt: serverTimestamp(),
          });
        } catch (err) {
          console.warn('[Simulator] Failed to emit simulated diagnostic answer:', err);
        }
      }, staggerMs);

      timers.push(timer);
    }

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [isRunning, roomId, isDiagnosticPushed, isSessionEnded, studentCount]);

  // Burst Helpers
  const triggerBurst = async (value: 'got_it' | 'lost', count = 8) => {
    if (!roomId || isSessionEnded) return;
    for (let i = 0; i < count; i++) {
      setTimeout(async () => {
        try {
          await addDoc(collection(db, 'sessions', roomId, 'signals'), {
            value,
            timestamp: serverTimestamp(),
          });
          setSignalsSent((prev) => prev + 1);
        } catch {
          // ignore
        }
      }, i * 120);
    }
  };

  if (!roomId || isSessionEnded) return null;

  return (
    <div className="w-full bg-slate-900/90 border border-indigo-500/30 rounded-2xl p-4 shadow-lg transition-all backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Left: Indicator & Status */}
        <div className="flex items-center gap-3">
          <div
            className={`h-10 w-10 rounded-xl flex items-center justify-center transition-all ${
              isRunning
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/30 animate-pulse'
                : 'bg-slate-800 text-slate-400'
            }`}
          >
            <Users className="h-5 w-5" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white tracking-wide">
                Live Class Simulator
              </span>
              <span className="bg-indigo-950 border border-indigo-700/60 text-indigo-300 text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full">
                Demo Tool
              </span>
              {isRunning && (
                <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  Active ({signalsSent} signals)
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Simulates {studentCount} connected student devices sending live feedback
            </p>
          </div>
        </div>

        {/* Right: Controls */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsRunning(!isRunning)}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-all ${
              isRunning
                ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-md shadow-amber-600/30'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/30'
            }`}
          >
            {isRunning ? (
              <>
                <Square className="h-3.5 w-3.5 fill-current" />
                <span>Pause Sim</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Simulate Class</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer border border-slate-700/70"
          >
            <Sliders className="h-3.5 w-3.5" />
            <span>{isExpanded ? 'Hide' : 'Options'}</span>
          </button>
        </div>
      </div>

      {/* Expanded Scenario Configuration & Quick Actions */}
      {isExpanded && (
        <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-col gap-3 animate-in fade-in duration-200">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
            {/* Scenario Selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-slate-400 font-medium mr-1">Scenario:</span>
              <button
                type="button"
                onClick={() => setMode('confusion')}
                className={`px-2.5 py-1 rounded-lg font-medium transition-all ${
                  mode === 'confusion'
                    ? 'bg-rose-600/20 text-rose-300 border border-rose-500/50'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                Trigger AI (High Confusion)
              </button>
              <button
                type="button"
                onClick={() => setMode('balanced')}
                className={`px-2.5 py-1 rounded-lg font-medium transition-all ${
                  mode === 'balanced'
                    ? 'bg-amber-600/20 text-amber-300 border border-amber-500/50'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                Normal Lecture
              </button>
              <button
                type="button"
                onClick={() => setMode('clear')}
                className={`px-2.5 py-1 rounded-lg font-medium transition-all ${
                  mode === 'clear'
                    ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/50'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                High Mastery
              </button>
            </div>

            {/* Class Size */}
            <div className="flex items-center gap-1.5">
              <span className="text-slate-400 font-medium">Class Size:</span>
              {[15, 25, 40].map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => setStudentCount(count)}
                  className={`px-2 py-0.5 rounded font-mono text-[11px] transition-all ${
                    studentCount === count
                      ? 'bg-indigo-600 text-white font-bold'
                      : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {count}
                </button>
              ))}
            </div>

            {/* Quick Trigger Bursts */}
            <div className="flex items-center gap-2">
              <span className="text-slate-400 font-medium">Quick Bursts:</span>
              <button
                type="button"
                onClick={() => triggerBurst('lost', 10)}
                className="flex items-center gap-1 bg-rose-950/70 hover:bg-rose-900/80 text-rose-300 border border-rose-800/60 px-2.5 py-1 rounded-lg font-medium text-[11px] transition-all cursor-pointer"
                title="Immediately sends 10 Lost signals to push score > 50"
              >
                <TrendingUp className="h-3 w-3 text-rose-400" />
                <span>+10 Confusion</span>
              </button>
              <button
                type="button"
                onClick={() => triggerBurst('got_it', 10)}
                className="flex items-center gap-1 bg-emerald-950/70 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-800/60 px-2.5 py-1 rounded-lg font-medium text-[11px] transition-all cursor-pointer"
                title="Immediately sends 10 Got It signals"
              >
                <TrendingDown className="h-3 w-3 text-emerald-400" />
                <span>+10 Got It</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
