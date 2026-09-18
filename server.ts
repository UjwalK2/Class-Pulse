import express, { type Request, type Response } from 'express';
import cors from 'cors';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { db } from './server/db.js';
import { generateInterventionServer } from './server/gemini.js';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // -------------------------------------------------------------------------
  // Real-Time Server-Sent Events (SSE) Client Registry
  // -------------------------------------------------------------------------
  const sseClients = new Map<string, Set<Response>>();

  function broadcast(sessionId: string, eventType: string, payload: unknown) {
    const clients = sseClients.get(sessionId);
    if (!clients || clients.size === 0) return;
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.write(msg);
      } catch (err) {
        console.warn('[SSE] Failed to write to client:', err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // API Routes
  // -------------------------------------------------------------------------

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      storage: 'json-local',
      timestamp: Date.now(),
    });
  });

  // App configuration state
  app.get('/api/config', (_req: Request, res: Response) => {
    const hasFirebase = Boolean(
      process.env.VITE_FIREBASE_API_KEY && process.env.VITE_FIREBASE_PROJECT_ID
    );
    res.json({
      primaryStorage: 'json',
      firebaseConfigured: hasFirebase,
    });
  });

  // Create new session
  app.post('/api/sessions', (req: Request, res: Response) => {
    const { id } = req.body || {};
    const session = db.createSession(id);
    res.status(201).json(session);
  });

  // Get session details
  app.get('/api/sessions/:id', (req: Request, res: Response) => {
    const session = db.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  });

  // Update session (topic, status, diagnostic question)
  app.patch('/api/sessions/:id', (req: Request, res: Response) => {
    const session = db.updateSession(req.params.id, req.body);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    broadcast(req.params.id, 'session_updated', session);
    res.json(session);
  });

  // Real-time SSE stream for a session
  app.get('/api/sessions/:id/events', (req: Request, res: Response) => {
    const sessionId = req.params.id;
    const session = db.getSession(sessionId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    res.write(': keep-alive ping\n\n');

    // Register SSE subscriber
    if (!sseClients.has(sessionId)) {
      sseClients.set(sessionId, new Set());
    }
    const clients = sseClients.get(sessionId)!;
    clients.add(res);

    // Initial state push
    if (session) {
      res.write(`event: init\ndata: ${JSON.stringify(session)}\n\n`);
    }

    const interval = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(interval);
      clients.delete(res);
      if (clients.size === 0) {
        sseClients.delete(sessionId);
      }
    });
  });

  // Submit student confusion signal
  app.post('/api/sessions/:id/signals', (req: Request, res: Response) => {
    const { value } = req.body;
    if (value !== 'got_it' && value !== 'kinda' && value !== 'lost') {
      res.status(400).json({ error: "Invalid signal value. Must be 'got_it', 'kinda', or 'lost'" });
      return;
    }

    const newSignal = db.addSignal(req.params.id, value);
    if (!newSignal) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    broadcast(req.params.id, 'signal_added', newSignal);
    res.status(201).json(newSignal);
  });

  // Retrieve signals for summary/charts
  app.get('/api/sessions/:id/signals', (req: Request, res: Response) => {
    const signals = db.getAllSignals(req.params.id);
    res.json(signals);
  });

  // Submit student diagnostic response
  app.post('/api/sessions/:id/diagnostic-responses', (req: Request, res: Response) => {
    const { choice } = req.body;
    if (choice !== 'A' && choice !== 'B') {
      res.status(400).json({ error: "Invalid choice. Must be 'A' or 'B'" });
      return;
    }

    const newResponse = db.addDiagnosticResponse(req.params.id, choice);
    if (!newResponse) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    broadcast(req.params.id, 'response_added', newResponse);
    res.status(201).json(newResponse);
  });

  // Generate AI Intervention
  app.post('/api/intervention', async (req: Request, res: Response) => {
    try {
      const topic = req.body?.topic || '';
      const result = await generateInterventionServer(topic);
      res.json(result);
    } catch (err) {
      console.error('[API /api/intervention] Error:', err);
      res.status(500).json({ error: 'Failed to generate intervention' });
    }
  });

  // -------------------------------------------------------------------------
  // Vite Frontend Middleware
  // -------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ClassPulse] Full-Stack Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
