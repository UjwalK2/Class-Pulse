import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getFirestore,
  type Firestore,
  collection as fsCollection,
  doc as fsDoc,
  addDoc as fsAddDoc,
  updateDoc as fsUpdateDoc,
  getDocs as fsGetDocs,
  onSnapshot as fsOnSnapshot,
  serverTimestamp as fsServerTimestamp,
  query as fsQuery,
  type CollectionReference,
  type DocumentReference,
  type Query,
} from 'firebase/firestore';

// ---------------------------------------------------------------------------
// Configuration & Environment Detection
// ---------------------------------------------------------------------------
const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
const hasFirebaseConfig = Boolean(apiKey && projectId && apiKey.trim() !== '');

// Storage mode: 'json' (default local server database) or 'firebase' (optional cloud)
const storageMode: 'json' | 'firebase' =
  import.meta.env.VITE_STORAGE_MODE === 'firebase' && hasFirebaseConfig
    ? 'firebase'
    : 'json';

let realDb: Firestore | null = null;
let firebaseApp: FirebaseApp | null = null;

if (storageMode === 'firebase') {
  try {
    const firebaseConfig = {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
      appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
    };

    firebaseApp = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
    realDb = getFirestore(firebaseApp);
    console.info('[ClassPulse] Firebase mode active. Firestore connected for:', projectId);
  } catch (err) {
    console.warn('[ClassPulse] Firebase initialization failed, falling back to server JSON database:', err);
    realDb = null;
  }
} else {
  console.info('[ClassPulse] Server-side JSON database mode active (/api/sessions + SSE).');
}

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

export interface MockTimestamp {
  _isTimestamp: true;
  seconds: number;
  nanoseconds: number;
  toMillis: () => number;
  toDate: () => Date;
}

export function createMockTimestamp(date: Date = new Date()): MockTimestamp {
  const ms = date.getTime();
  return {
    _isTimestamp: true,
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1e6,
    toMillis: () => ms,
    toDate: () => new Date(ms),
  };
}

export interface MockDoc {
  id: string;
  data: Record<string, any>;
}

export interface MockDocumentSnapshot {
  id: string;
  exists: () => boolean;
  data: () => Record<string, any>;
}

export interface MockQuerySnapshot {
  empty: boolean;
  docs: MockDocumentSnapshot[];
  forEach: (callback: (doc: MockDocumentSnapshot) => void) => void;
}

export interface AppCollectionRef {
  _type: 'collection';
  path: string;
}

export interface AppDocumentRef {
  _type: 'doc';
  path: string;
  id: string;
}

export interface AppQuery {
  _type: 'query';
  collectionRef: AppCollectionRef;
}

// ---------------------------------------------------------------------------
// SSE Connection Hub for Real-Time Cross-Device Communication
// ---------------------------------------------------------------------------

class SessionSSEManager {
  private activeStreams = new Map<string, {
    source: EventSource;
    sessionListeners: Set<(session: Record<string, any>) => void>;
    signalsListeners: Set<(signals: Array<Record<string, any>>) => void>;
    diagnosticListeners: Set<(responses: Array<Record<string, any>>) => void>;
    sessionData: Record<string, any> | null;
    signals: Array<Record<string, any>>;
    diagnosticResponses: Array<Record<string, any>>;
  }>();

  public getOrCreateStream(sessionId: string) {
    let stream = this.activeStreams.get(sessionId);
    if (!stream) {
      const source = new EventSource(`/api/sessions/${sessionId}/events`);
      stream = {
        source,
        sessionListeners: new Set(),
        signalsListeners: new Set(),
        diagnosticListeners: new Set(),
        sessionData: null,
        signals: [],
        diagnosticResponses: [],
      };

      source.addEventListener('init', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          stream!.sessionData = data;
          stream!.signals = data.signals || [];
          stream!.diagnosticResponses = data.diagnosticResponses || [];

          stream!.sessionListeners.forEach((fn) => fn(data));
          stream!.signalsListeners.forEach((fn) => fn(stream!.signals));
          stream!.diagnosticListeners.forEach((fn) => fn(stream!.diagnosticResponses));
        } catch (err) {
          console.error('[SSE init error]:', err);
        }
      });

      source.addEventListener('session_updated', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          stream!.sessionData = data;
          stream!.sessionListeners.forEach((fn) => fn(data));
        } catch (err) {
          console.error('[SSE update error]:', err);
        }
      });

      source.addEventListener('signal_added', (e: MessageEvent) => {
        try {
          const signal = JSON.parse(e.data);
          stream!.signals = [...stream!.signals, signal];
          stream!.signalsListeners.forEach((fn) => fn(stream!.signals));
        } catch (err) {
          console.error('[SSE signal error]:', err);
        }
      });

      source.addEventListener('response_added', (e: MessageEvent) => {
        try {
          const resp = JSON.parse(e.data);
          stream!.diagnosticResponses = [...stream!.diagnosticResponses, resp];
          stream!.diagnosticListeners.forEach((fn) => fn(stream!.diagnosticResponses));
        } catch (err) {
          console.error('[SSE response error]:', err);
        }
      });

      source.onerror = () => {
        // Fallback polling if SSE disconnects temporarily
        fetch(`/api/sessions/${sessionId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data && stream) {
              stream.sessionData = data;
              stream.signals = data.signals || [];
              stream.diagnosticResponses = data.diagnosticResponses || [];
              stream.sessionListeners.forEach((fn) => fn(data));
              stream.signalsListeners.forEach((fn) => fn(stream.signals));
              stream.diagnosticListeners.forEach((fn) => fn(stream.diagnosticResponses));
            }
          })
          .catch(() => {});
      };

      this.activeStreams.set(sessionId, stream);
    }
    return stream;
  }

  public subscribeSession(sessionId: string, cb: (data: Record<string, any>) => void) {
    const stream = this.getOrCreateStream(sessionId);
    stream.sessionListeners.add(cb);
    if (stream.sessionData) {
      cb(stream.sessionData);
    } else {
      // Immediate fetch
      fetch(`/api/sessions/${sessionId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) {
            stream.sessionData = data;
            cb(data);
          }
        })
        .catch(() => {});
    }
    return () => {
      stream.sessionListeners.delete(cb);
      this.cleanupIfEmpty(sessionId);
    };
  }

  public subscribeSignals(sessionId: string, cb: (signals: Array<Record<string, any>>) => void) {
    const stream = this.getOrCreateStream(sessionId);
    stream.signalsListeners.add(cb);
    if (stream.signals.length > 0) {
      cb(stream.signals);
    } else {
      fetch(`/api/sessions/${sessionId}/signals`)
        .then((r) => (r.ok ? r.json() : []))
        .then((signals) => {
          if (Array.isArray(signals)) {
            stream.signals = signals;
            cb(signals);
          }
        })
        .catch(() => {});
    }
    return () => {
      stream.signalsListeners.delete(cb);
      this.cleanupIfEmpty(sessionId);
    };
  }

  public subscribeDiagnostics(sessionId: string, cb: (responses: Array<Record<string, any>>) => void) {
    const stream = this.getOrCreateStream(sessionId);
    stream.diagnosticListeners.add(cb);
    if (stream.diagnosticResponses.length > 0) {
      cb(stream.diagnosticResponses);
    }
    return () => {
      stream.diagnosticListeners.delete(cb);
      this.cleanupIfEmpty(sessionId);
    };
  }

  private cleanupIfEmpty(sessionId: string) {
    const stream = this.activeStreams.get(sessionId);
    if (
      stream &&
      stream.sessionListeners.size === 0 &&
      stream.signalsListeners.size === 0 &&
      stream.diagnosticListeners.size === 0
    ) {
      stream.source.close();
      this.activeStreams.delete(sessionId);
    }
  }
}

const sseManager = new SessionSSEManager();

// ---------------------------------------------------------------------------
// Universal Operations
// ---------------------------------------------------------------------------

export const db = (realDb || { _isLocalDb: true }) as unknown as Firestore;

export function collection(
  _db: unknown,
  firstSegment: string,
  ...restSegments: string[]
): CollectionReference | AppCollectionRef {
  const fullPath = [firstSegment, ...restSegments].filter(Boolean).join('/');
  if (realDb && storageMode === 'firebase') {
    try {
      return fsCollection(realDb, firstSegment, ...restSegments);
    } catch {
      // Fall through to JSON server
    }
  }
  return { _type: 'collection', path: fullPath };
}

export function doc(
  _db: unknown,
  firstSegment: string,
  ...restSegments: string[]
): DocumentReference | AppDocumentRef {
  const fullPath = [firstSegment, ...restSegments].filter(Boolean).join('/');
  const segments = fullPath.split('/');
  const docId = segments[segments.length - 1];
  if (realDb && storageMode === 'firebase') {
    try {
      return fsDoc(realDb, firstSegment, ...restSegments);
    } catch {
      // Fall through to JSON server
    }
  }
  return { _type: 'doc', path: fullPath, id: docId };
}

export function query(
  colRef: CollectionReference | AppCollectionRef,
  ..._clauses: unknown[]
): Query | AppQuery {
  if (realDb && storageMode === 'firebase' && !(colRef as AppCollectionRef)._type) {
    try {
      return fsQuery(colRef as CollectionReference);
    } catch {
      // Fall through to JSON server
    }
  }
  return { _type: 'query', collectionRef: colRef as AppCollectionRef };
}

export async function addDoc(
  targetRef: CollectionReference | AppCollectionRef,
  data: Record<string, any>
): Promise<{ id: string }> {
  if (realDb && storageMode === 'firebase' && !(targetRef as AppCollectionRef)._type) {
    try {
      const docRef = await fsAddDoc(targetRef as CollectionReference, data);
      return { id: docRef.id };
    } catch (err) {
      console.warn('[ClassPulse] fsAddDoc failed, switching to server JSON database:', err);
    }
  }

  const colPath = (targetRef as AppCollectionRef).path;

  // Case 1: sessions collection
  if (colPath === 'sessions') {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Failed to create session on server (${res.status})`);
    const created = await res.json();
    return { id: created.id };
  }

  // Case 2: sessions/:roomId/signals
  if (colPath.includes('/signals')) {
    const parts = colPath.split('/');
    const roomId = parts[1];
    const res = await fetch(`/api/sessions/${roomId}/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: data.value }),
    });
    if (!res.ok) throw new Error(`Failed to post signal to server (${res.status})`);
    const saved = await res.json();
    return { id: saved.id };
  }

  // Case 3: sessions/:roomId/diagnosticResponses
  if (colPath.includes('/diagnosticResponses')) {
    const parts = colPath.split('/');
    const roomId = parts[1];
    const res = await fetch(`/api/sessions/${roomId}/diagnostic-responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice: data.choice }),
    });
    if (!res.ok) throw new Error(`Failed to post response to server (${res.status})`);
    const saved = await res.json();
    return { id: saved.id };
  }

  return { id: `doc_${Math.random().toString(36).slice(2, 8)}` };
}

export async function updateDoc(
  targetRef: DocumentReference | AppDocumentRef,
  data: Record<string, any>
): Promise<void> {
  if (realDb && storageMode === 'firebase' && !(targetRef as AppDocumentRef)._type) {
    try {
      await fsUpdateDoc(targetRef as DocumentReference, data);
      return;
    } catch (err) {
      console.warn('[ClassPulse] fsUpdateDoc failed, switching to server JSON database:', err);
    }
  }

  const docPath = (targetRef as AppDocumentRef).path;
  const parts = docPath.split('/');
  if (parts[0] === 'sessions' && parts[1]) {
    const roomId = parts[1];
    const res = await fetch(`/api/sessions/${roomId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      console.warn(`[ClassPulse] PATCH /api/sessions/${roomId} failed with status:`, res.status);
    }
  }
}

export async function getDocs(
  targetRef: CollectionReference | Query | AppCollectionRef | AppQuery
): Promise<MockQuerySnapshot> {
  if (realDb && storageMode === 'firebase' && !(targetRef as AppCollectionRef)._type && !(targetRef as AppQuery)._type) {
    try {
      const snap = await fsGetDocs(targetRef as CollectionReference);
      const docs: MockDocumentSnapshot[] = [];
      snap.forEach((d) => {
        docs.push({
          id: d.id,
          exists: () => d.exists(),
          data: () => d.data(),
        });
      });
      return {
        empty: snap.empty,
        docs,
        forEach: (cb) => docs.forEach(cb),
      };
    } catch (err) {
      console.warn('[ClassPulse] fsGetDocs failed, falling back to server JSON database:', err);
    }
  }

  const colPath =
    (targetRef as AppQuery)._type === 'query'
      ? (targetRef as AppQuery).collectionRef.path
      : (targetRef as AppCollectionRef).path;

  // Retrieve signals from server
  if (colPath.includes('/signals')) {
    const parts = colPath.split('/');
    const roomId = parts[1];
    try {
      const res = await fetch(`/api/sessions/${roomId}/signals`);
      if (res.ok) {
        const signals = await res.json();
        const docs: MockDocumentSnapshot[] = (signals || []).map((s: any) => ({
          id: s.id,
          exists: () => true,
          data: () => ({
            value: s.value,
            timestamp: createMockTimestamp(new Date(s.timestampMs || Date.now())),
          }),
        }));
        return {
          empty: docs.length === 0,
          docs,
          forEach: (cb) => docs.forEach(cb),
        };
      }
    } catch (err) {
      console.warn('[ClassPulse] Failed to fetch signals from server:', err);
    }
  }

  return {
    empty: true,
    docs: [],
    forEach: () => {},
  };
}

export function onSnapshot(
  targetRef: DocumentReference | AppDocumentRef,
  onNext: (snapshot: MockDocumentSnapshot) => void,
  onError?: (error: Error) => void
): () => void;
export function onSnapshot(
  targetRef: CollectionReference | Query | AppCollectionRef | AppQuery,
  onNext: (snapshot: MockQuerySnapshot) => void,
  onError?: (error: Error) => void
): () => void;
export function onSnapshot(
  targetRef: any,
  onNext: (snapshot: any) => void,
  onError?: (error: Error) => void
): () => void {
  const isMockRef =
    (targetRef as AppDocumentRef)._type === 'doc' ||
    (targetRef as AppCollectionRef)._type === 'collection' ||
    (targetRef as AppQuery)._type === 'query';

  if (realDb && storageMode === 'firebase' && !isMockRef) {
    try {
      return fsOnSnapshot(
        targetRef as any,
        onNext,
        (err) => {
          console.warn('[ClassPulse] fsOnSnapshot error:', err);
          if (onError) onError(err);
        }
      );
    } catch (err) {
      console.warn('[ClassPulse] fsOnSnapshot setup failed, falling back to server SSE:', err);
    }
  }

  // SSE & Server JSON database implementation
  if ((targetRef as AppDocumentRef)._type === 'doc') {
    const docPath = (targetRef as AppDocumentRef).path;
    const parts = docPath.split('/');
    const roomId = parts[1];

    return sseManager.subscribeSession(roomId, (sessionData) => {
      onNext({
        id: roomId,
        exists: () => Boolean(sessionData),
        data: () => sessionData || {},
      });
    });
  }

  // Collections or queries
  const colPath =
    (targetRef as AppQuery)._type === 'query'
      ? (targetRef as AppQuery).collectionRef.path
      : (targetRef as AppCollectionRef).path;

  const parts = colPath.split('/');
  const roomId = parts[1];

  if (colPath.includes('/signals')) {
    return sseManager.subscribeSignals(roomId, (signals) => {
      const docs: MockDocumentSnapshot[] = (signals || []).map((s) => ({
        id: s.id,
        exists: () => true,
        data: () => ({
          value: s.value,
          timestamp: createMockTimestamp(new Date(s.timestampMs || Date.now())),
        }),
      }));
      onNext({
        empty: docs.length === 0,
        docs,
        forEach: (cb: (docSnap: MockDocumentSnapshot) => void) => docs.forEach(cb),
      });
    });
  }

  if (colPath.includes('/diagnosticResponses')) {
    return sseManager.subscribeDiagnostics(roomId, (responses) => {
      const docs: MockDocumentSnapshot[] = (responses || []).map((r) => ({
        id: r.id,
        exists: () => true,
        data: () => ({
          choice: r.choice,
          answeredAt: createMockTimestamp(new Date(r.answeredAtMs || Date.now())),
        }),
      }));
      onNext({
        empty: docs.length === 0,
        docs,
        forEach: (cb: (docSnap: MockDocumentSnapshot) => void) => docs.forEach(cb),
      });
    });
  }

  // Fallback empty
  onNext({
    empty: true,
    docs: [],
    forEach: () => {},
  });
  return () => {};
}

export function serverTimestamp() {
  if (realDb && storageMode === 'firebase') {
    try {
      return fsServerTimestamp();
    } catch {
      // Fall through to mock
    }
  }
  return {
    _isServerTimestamp: true,
    _isTimestamp: true,
    seconds: Math.floor(Date.now() / 1000),
    nanoseconds: 0,
    toMillis: () => Date.now(),
    toDate: () => new Date(),
  };
}

export const isFirebaseConfigured = hasFirebaseConfig;
export const currentStorageMode = storageMode;
