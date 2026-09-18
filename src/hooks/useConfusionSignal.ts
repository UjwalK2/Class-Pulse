import { useState, useEffect, useRef } from 'react';
import { db, collection, onSnapshot, query } from '../lib/firebase';

export interface RawSignal {
  id: string;
  value: 'got_it' | 'kinda' | 'lost';
  timestampMs: number;
}

export interface WindowStats {
  gotItPercent: number;
  kindaPercent: number;
  lostPercent: number;
  confusionScore: number;
  totalInWindow: number;
}

export interface ConfusionPoint {
  index: number;
  score: number;
  time: string;
}

export function useConfusionSignal(roomId: string | null) {
  const [hasReceivedSignal, setHasReceivedSignal] = useState(false);
  const [latestStats, setLatestStats] = useState<WindowStats>({
    gotItPercent: 0,
    kindaPercent: 0,
    lostPercent: 0,
    confusionScore: 0,
    totalInWindow: 0,
  });
  const [history, setHistory] = useState<ConfusionPoint[]>([]);

  // Ref to hold all received signals across ticks without stale closures
  const signalsRef = useRef<RawSignal[]>([]);
  const pointCounterRef = useRef<number>(0);

  // Subscribe to real-time signals for this session
  useEffect(() => {
    if (!roomId) {
      signalsRef.current = [];
      pointCounterRef.current = 0;
      queueMicrotask(() => {
        setHasReceivedSignal(false);
        setHistory([]);
      });
      return;
    }

    signalsRef.current = [];
    pointCounterRef.current = 0;
    queueMicrotask(() => {
      setHasReceivedSignal(false);
      setHistory([]);
    });

    const signalsCollectionRef = collection(db, 'sessions', roomId, 'signals');
    const signalsQuery = query(signalsCollectionRef);

    const unsubscribe = onSnapshot(
      signalsQuery,
      (snapshot) => {
        if (!snapshot.empty) {
          setHasReceivedSignal(true);
        }

        const parsedSignals: RawSignal[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          let ts = Date.now();
          if (data.timestamp) {
            if (typeof data.timestamp.toMillis === 'function') {
              ts = data.timestamp.toMillis();
            } else if (typeof data.timestamp.toDate === 'function') {
              ts = data.timestamp.toDate().getTime();
            } else if (typeof data.timestamp.seconds === 'number') {
              ts = data.timestamp.seconds * 1000;
            } else if (data.timestamp instanceof Date) {
              ts = data.timestamp.getTime();
            } else if (typeof data.timestamp === 'number') {
              ts = data.timestamp;
            }
          }

          if (data.value === 'got_it' || data.value === 'kinda' || data.value === 'lost') {
            parsedSignals.push({
              id: docSnap.id,
              value: data.value,
              timestampMs: ts,
            });
          }
        });

        signalsRef.current = parsedSignals;
      },
      (error) => {
        console.warn('Firestore signals listener error:', error);
      }
    );

    return () => unsubscribe();
  }, [roomId]);

  // Sliding 60-second window calculation every 2 seconds
  useEffect(() => {
    if (!roomId) return;

    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const windowStart = now - 60 * 1000; // 60 seconds ago

      // Filter signals within the sliding 60s window
      const activeSignals = signalsRef.current.filter(
        (s) => s.timestampMs >= windowStart && s.timestampMs <= now + 5000
      );

      const totalInWindow = activeSignals.length;
      let gotItPercent = 0;
      let kindaPercent = 0;
      let lostPercent = 0;
      let confusionScore = 0;

      if (totalInWindow > 0) {
        const gotItCount = activeSignals.filter((s) => s.value === 'got_it').length;
        const kindaCount = activeSignals.filter((s) => s.value === 'kinda').length;
        const lostCount = activeSignals.filter((s) => s.value === 'lost').length;

        gotItPercent = Number(((gotItCount / totalInWindow) * 100).toFixed(1));
        kindaPercent = Number(((kindaCount / totalInWindow) * 100).toFixed(1));
        lostPercent = Number(((lostCount / totalInWindow) * 100).toFixed(1));

        // confusionScore = lostPercent + (0.5 * kindaPercent)
        confusionScore = Number(
          Math.min(100, Math.max(0, lostPercent + 0.5 * kindaPercent)).toFixed(1)
        );
      }

      const currentStats: WindowStats = {
        gotItPercent,
        kindaPercent,
        lostPercent,
        confusionScore,
        totalInWindow,
      };

      setLatestStats(currentStats);

      // Add to rolling history if we have received at least one signal
      if (signalsRef.current.length > 0) {
        pointCounterRef.current += 1;
        const nowTimeStr = new Date(now).toLocaleTimeString([], {
          minute: '2-digit',
          second: '2-digit',
        });

        const newPoint: ConfusionPoint = {
          index: pointCounterRef.current,
          score: confusionScore,
          time: nowTimeStr,
        };

        setHistory((prevHistory) => {
          const updated = [...prevHistory, newPoint];
          // Keep only the last 30 readings
          return updated.slice(-30);
        });
      }
    }, 2000);

    return () => clearInterval(intervalId);
  }, [roomId]);

  return {
    hasReceivedSignal,
    latestStats,
    history,
    isConfusionSpike: latestStats.confusionScore >= 50,
  };
}
