import fs from 'fs';
import path from 'path';

export interface SignalRecord {
  id: string;
  value: 'got_it' | 'kinda' | 'lost';
  timestampMs: number;
}

export interface DiagnosticResponseRecord {
  id: string;
  choice: 'A' | 'B';
  answeredAtMs: number;
}

export interface SessionRecord {
  id: string;
  createdAt: string;
  currentTopic: string;
  status: 'active' | 'ended';
  endedAt: string | null;
  diagnosticQuestion: string | null;
  optionA: string | null;
  optionB: string | null;
  signals: SignalRecord[];
  diagnosticResponses: DiagnosticResponseRecord[];
}

export interface DatabaseSchema {
  sessions: Record<string, SessionRecord>;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'sessions.json');

function ensureDatabaseFile(): DatabaseSchema {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_FILE)) {
    const initial: DatabaseSchema = { sessions: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }

  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[DB] Failed to read database, creating fresh structure:', err);
    const initial: DatabaseSchema = { sessions: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
}

function writeDatabase(data: DatabaseSchema) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('[DB] Failed to write database:', err);
  }
}

export const db = {
  createSession(id?: string): SessionRecord {
    const data = ensureDatabaseFile();
    const sessionId = id || `sess_${Math.random().toString(36).slice(2, 8)}`;
    const newSession: SessionRecord = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      currentTopic: '',
      status: 'active',
      endedAt: null,
      diagnosticQuestion: null,
      optionA: null,
      optionB: null,
      signals: [],
      diagnosticResponses: [],
    };
    data.sessions[sessionId] = newSession;
    writeDatabase(data);
    return newSession;
  },

  getSession(id: string): SessionRecord | null {
    const data = ensureDatabaseFile();
    return data.sessions[id] || null;
  },

  updateSession(id: string, updates: Partial<SessionRecord>): SessionRecord | null {
    const data = ensureDatabaseFile();
    const session = data.sessions[id];
    if (!session) return null;

    const updated = {
      ...session,
      ...updates,
      id: session.id, // Immutable
    };
    data.sessions[id] = updated;
    writeDatabase(data);
    return updated;
  },

  addSignal(sessionId: string, value: 'got_it' | 'kinda' | 'lost'): SignalRecord | null {
    const data = ensureDatabaseFile();
    const session = data.sessions[sessionId];
    if (!session) return null;

    const newSignal: SignalRecord = {
      id: `sig_${Math.random().toString(36).slice(2, 8)}`,
      value,
      timestampMs: Date.now(),
    };

    session.signals.push(newSignal);
    writeDatabase(data);
    return newSignal;
  },

  addDiagnosticResponse(sessionId: string, choice: 'A' | 'B'): DiagnosticResponseRecord | null {
    const data = ensureDatabaseFile();
    const session = data.sessions[sessionId];
    if (!session) return null;

    const newResponse: DiagnosticResponseRecord = {
      id: `resp_${Math.random().toString(36).slice(2, 8)}`,
      choice,
      answeredAtMs: Date.now(),
    };

    session.diagnosticResponses.push(newResponse);
    writeDatabase(data);
    return newResponse;
  },

  getAllSignals(sessionId: string): SignalRecord[] {
    const data = ensureDatabaseFile();
    return data.sessions[sessionId]?.signals || [];
  },
};
