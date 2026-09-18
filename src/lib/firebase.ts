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

// Environment variable detection
const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
const hasFirebaseConfig = Boolean(apiKey && projectId && apiKey.trim() !== '');

let realDb: Firestore | null = null;
let firebaseApp: FirebaseApp | null = null;

if (hasFirebaseConfig) {
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
    console.info('[ClassPulse] Firebase initialized in cloud mode for project:', projectId);
  } catch (err) {
    console.warn('[ClassPulse] Failed to initialize Firebase SDK, falling back to local sync:', err);
    realDb = null;
  }
} else {
  console.info('[ClassPulse] Running in resilient local demo mode with multi-tab sync.');
}

// ---------------------------------------------------------------------------
// In-Memory & Multi-Tab BroadcastChannel Local Sync Store
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

type Listener = () => void;

class LocalStore {
  private documents = new Map<string, Record<string, unknown>>();
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  private readonly storageKey = 'classpulse_local_store_v1';

  constructor() {
    this.loadFromStorage();

    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel('classpulse_sync_channel');
        this.channel.onmessage = (event) => {
          if (event.data && event.data.type === 'SYNC') {
            this.handleRemoteSync(event.data.path, event.data.doc);
          }
        };
      } catch (e) {
        console.warn('[ClassPulse] BroadcastChannel unavailable:', e);
      }
    }
  }

  private loadFromStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const [key, val] of Object.entries(parsed)) {
          this.documents.set(key, this.reviveTimestamps(val as Record<string, unknown>));
        }
      }
    } catch {
      // Ignore storage read errors
    }
  }

  private saveToStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const plainObj: Record<string, unknown> = {};
      this.documents.forEach((val, key) => {
        plainObj[key] = val;
      });
      localStorage.setItem(this.storageKey, JSON.stringify(plainObj));
    } catch {
      // Ignore storage write errors
    }
  }

  private reviveTimestamps(obj: Record<string, unknown>): Record<string, unknown> {
    if (!obj || typeof obj !== 'object') return obj;
    const res: Record<string, unknown> = { ...obj };
    for (const [k, v] of Object.entries(res)) {
      if (v && typeof v === 'object' && (v as { _isTimestamp?: boolean })._isTimestamp) {
        const sec = (v as { seconds: number }).seconds || 0;
        const d = new Date(sec * 1000);
        res[k] = createMockTimestamp(d);
      }
    }
    return res;
  }

  private normalizeData(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && (v as { _isServerTimestamp?: boolean })._isServerTimestamp) {
        result[k] = createMockTimestamp(new Date());
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  private handleRemoteSync(path: string, docData: Record<string, unknown> | null) {
    if (docData === null) {
      this.documents.delete(path);
    } else {
      this.documents.set(path, this.reviveTimestamps(docData));
    }
    this.notify();
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public notify() {
    for (const l of this.listeners) {
      try {
        l();
      } catch (e) {
        console.error('[ClassPulse] Listener error:', e);
      }
    }
  }

  public set(path: string, data: Record<string, unknown>, broadcast = true) {
    const normalized = this.normalizeData(data);
    const existing = this.documents.get(path) || {};
    const updated = { ...existing, ...normalized };
    this.documents.set(path, updated);
    this.saveToStorage();
    if (broadcast && this.channel) {
      this.channel.postMessage({ type: 'SYNC', path, doc: updated });
    }
    this.notify();
    return updated;
  }

  public get(path: string): Record<string, unknown> | undefined {
    return this.documents.get(path);
  }

  public listByPrefix(prefix: string): MockDoc[] {
    const results: MockDoc[] = [];
    const prefixSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
    this.documents.forEach((val, key) => {
      if (key.startsWith(prefixSlash)) {
        const sub = key.slice(prefixSlash.length);
        if (!sub.includes('/')) {
          results.push({ id: sub, data: val });
        }
      }
    });
    return results;
  }
}

const localStore = new LocalStore();

// Reference representations
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
// Universal Operations
// ---------------------------------------------------------------------------

export const db = (realDb || { _isLocalDb: true }) as unknown as Firestore;

export function collection(
  _db: unknown,
  firstSegment: string,
  ...restSegments: string[]
): CollectionReference | AppCollectionRef {
  const fullPath = [firstSegment, ...restSegments].filter(Boolean).join('/');
  if (realDb) {
    try {
      return fsCollection(realDb, firstSegment, ...restSegments);
    } catch {
      // Fall through to mock
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
  if (realDb) {
    try {
      return fsDoc(realDb, firstSegment, ...restSegments);
    } catch {
      // Fall through to mock
    }
  }
  return { _type: 'doc', path: fullPath, id: docId };
}

export function query(
  colRef: CollectionReference | AppCollectionRef,
  ..._clauses: unknown[]
): Query | AppQuery {
  if (realDb && !(colRef as AppCollectionRef)._type) {
    try {
      return fsQuery(colRef as CollectionReference);
    } catch {
      // Fall through to mock
    }
  }
  return { _type: 'query', collectionRef: colRef as AppCollectionRef };
}

export async function addDoc(
  targetRef: CollectionReference | AppCollectionRef,
  data: Record<string, unknown>
): Promise<{ id: string }> {
  if (realDb && !(targetRef as AppCollectionRef)._type) {
    try {
      const docRef = await fsAddDoc(targetRef as CollectionReference, data);
      return { id: docRef.id };
    } catch (err) {
      console.warn('[ClassPulse] fsAddDoc failed, switching to local store:', err);
    }
  }

  const colPath = (targetRef as AppCollectionRef).path;
  const newId = `sess_${Math.random().toString(36).slice(2, 8)}`;
  const docPath = `${colPath}/${newId}`;
  localStore.set(docPath, data, true);
  return { id: newId };
}

export async function updateDoc(
  targetRef: DocumentReference | AppDocumentRef,
  data: Record<string, unknown>
): Promise<void> {
  if (realDb && !(targetRef as AppDocumentRef)._type) {
    try {
      await fsUpdateDoc(targetRef as DocumentReference, data);
      return;
    } catch (err) {
      console.warn('[ClassPulse] fsUpdateDoc failed, switching to local store:', err);
    }
  }

  const docPath = (targetRef as AppDocumentRef).path;
  localStore.set(docPath, data, true);
}

export async function getDocs(
  targetRef: CollectionReference | Query | AppCollectionRef | AppQuery
): Promise<MockQuerySnapshot> {
  if (realDb && !(targetRef as AppCollectionRef)._type && !(targetRef as AppQuery)._type) {
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
      console.warn('[ClassPulse] fsGetDocs failed, falling back to local store:', err);
    }
  }

  const colPath =
    (targetRef as AppQuery)._type === 'query'
      ? (targetRef as AppQuery).collectionRef.path
      : (targetRef as AppCollectionRef).path;

  const items = localStore.listByPrefix(colPath);
  const docs: MockDocumentSnapshot[] = items.map((item) => ({
    id: item.id,
    exists: () => true,
    data: () => item.data,
  }));

  return {
    empty: docs.length === 0,
    docs,
    forEach: (cb) => docs.forEach(cb),
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

  if (realDb && !isMockRef) {
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
      console.warn('[ClassPulse] fsOnSnapshot setup failed, falling back to local store:', err);
    }
  }

  // Local Store Mock implementation
  if ((targetRef as AppDocumentRef)._type === 'doc') {
    const docPath = (targetRef as AppDocumentRef).path;
    const docId = (targetRef as AppDocumentRef).id;

    const emit = () => {
      const data = localStore.get(docPath);
      onNext({
        id: docId,
        exists: () => data !== undefined,
        data: () => data,
      });
    };

    // Emit immediately
    emit();
    return localStore.subscribe(emit);
  }

  // Collection or Query
  const colPath =
    (targetRef as AppQuery)._type === 'query'
      ? (targetRef as AppQuery).collectionRef.path
      : (targetRef as AppCollectionRef).path;

  const emit = () => {
    const items = localStore.listByPrefix(colPath);
    const docs: MockDocumentSnapshot[] = items.map((item) => ({
      id: item.id,
      exists: () => true,
      data: () => item.data,
    }));

    onNext({
      empty: docs.length === 0,
      docs,
      forEach: (cb: (docSnap: MockDocumentSnapshot) => void) => docs.forEach(cb),
    });
  };

  // Emit immediately
  emit();
  return localStore.subscribe(emit);
}

export function serverTimestamp() {
  if (realDb) {
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
