/* =============================================================
   render-chat-server/server.js
   
   Lightweight Express SSE push server.
   Deploy only THIS FOLDER to Render.com free tier.
   
   Routes:
     GET  /health          → 200 "OK"  (UptimeRobot pings this)
     GET  /live?key=&cid=  → SSE stream, max 55s, heartbeat every 20s
     POST /push            → Push agent reply to visitor SSE stream
   ============================================================= */

'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const PUSH_SECRET = process.env.PUSH_SECRET || '';

// ── Middleware ──────────────────────────────────────────────────
app.use(cors({
    origin: '*',            // visitors come from any domain
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-push-secret'],
}));
app.use(express.json());

// ── In-memory SSE client registry ──────────────────────────────
// Map<conversationId, Set<{ key:string, res:Response }>>
const clients = new Map();

function addClient(conversationId, key, res) {
    if (!clients.has(conversationId)) {
        clients.set(conversationId, new Set());
    }
    const entry = { key, res };
    clients.get(conversationId).add(entry);
    return entry;
}

function removeClient(conversationId, entry) {
    const set = clients.get(conversationId);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) clients.delete(conversationId);
}

// ── Routes ──────────────────────────────────────────────────────

/**
 * GET /health
 * Used by UptimeRobot (or any pinger) to keep the free-tier instance awake.
 */
app.get('/health', (_req, res) => {
    res.status(200).send('OK');
});

/**
 * GET /live?key=&cid=
 * Opens an SSE stream for the given conversation.
 * - Sends a heartbeat comment every 20s to prevent Render/browser timeouts.
 * - Closes automatically after 55s (respects Render 60s idle limit).
 * - The embed page will reconnect automatically via EventSource retry.
 */
app.get('/live', (req, res) => {
    const { key, cid } = req.query;

    if (!key || !cid) {
        return res.status(400).json({ error: 'key and cid are required' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering on Render
    res.flushHeaders();

    // Send initial connection event
    res.write('event: connected\ndata: {"ok":true}\n\n');

    // Heartbeat every 20s (keeps the TCP connection alive)
    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 20000);

    // Max lifetime: 55s — browser EventSource auto‑reconnects
    const timeout = setTimeout(() => {
        res.write('event: reconnect\ndata: {"reason":"timeout"}\n\n');
        res.end();
    }, 55000);

    // Register client
    const entry = addClient(cid, key, res);

    // Cleanup on disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        removeClient(cid, entry);
        res.end();
    });
});

/**
 * POST /push
 * Called by Vercel (the Next.js app) when an agent replies.
 * Body: { conversationId: string, message: { id, sender, body, createdAt } }
 * Header: x-push-secret must match PUSH_SECRET env var.
 */
app.post('/push', (req, res) => {
    // Validate push secret
    const secret = req.headers['x-push-secret'];
    if (!PUSH_SECRET || secret !== PUSH_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { conversationId, message } = req.body;

    if (!conversationId || !message) {
        return res.status(400).json({ error: 'conversationId and message are required' });
    }

    const set = clients.get(conversationId);
    if (!set || set.size === 0) {
        // No active SSE clients for this conversation — that's OK
        return res.json({ delivered: 0, note: 'No active SSE clients for this conversation' });
    }

    const payload = `data: ${JSON.stringify(message)}\n\n`;
    let delivered = 0;

    for (const entry of set) {
        try {
            entry.res.write(payload);
            delivered++;
        } catch {
            // Client disconnected
            set.delete(entry);
        }
    }

    if (set.size === 0) clients.delete(conversationId);

    return res.json({ delivered });
});

// ── Start server ────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[chat-server] Listening on port ${PORT}`);
    if (!PUSH_SECRET) {
        console.warn('[chat-server] WARNING: PUSH_SECRET is not set. /push endpoint is insecure!');
    }
});
