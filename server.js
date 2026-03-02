/* =============================================================
   render-chat-server/server.js  v2.0  — Full WebSocket (Socket.io)

   Rooms: each conversationId is a socket.io room.
   
   CLIENT → SERVER events:
     join            { key, cid, visitorId, role, secret? }
     visitor_message { cid, message: { id, sender, body, type, mediaUrl, createdAt } }
     agent_message   { cid, secret, message: { id, sender, body, type, mediaUrl, createdAt } }
     typing_start    { cid, role }
     typing_stop     { cid, role }

   SERVER → CLIENT events:
     new_message     { id, sender, body, type, mediaUrl, createdAt }
     typing          { role, isTyping }
     agent_status    { online: bool, count: number }   → sent to visitors in room
     visitor_count   { count: number }                 → sent to agents in room
     error           { message: string }
   ============================================================= */

'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;
const PUSH_SECRET = process.env.PUSH_SECRET || '';

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    // Ping timeout/interval to keep Render free-tier alive
    pingTimeout: 60000,
    pingInterval: 25000,
});

// ── In-memory room membership tracker ──────────────────────────
// roomMembers: Map<cid, { agents: Set<socketId>, visitors: Set<socketId> }>
const roomMembers = new Map();

function getRoomMembers(cid) {
    if (!roomMembers.has(cid)) {
        roomMembers.set(cid, { agents: new Set(), visitors: new Set() });
    }
    return roomMembers.get(cid);
}

function broadcastAgentStatus(cid) {
    const members = getRoomMembers(cid);
    const count = members.agents.size;
    // Tell all visitors in this room the agent count
    io.to(cid).emit('agent_status', { online: count > 0, count });
}

function broadcastVisitorCount(cid) {
    const members = getRoomMembers(cid);
    const count = members.visitors.size;
    // Tell all agents in this room the visitor count
    io.to(cid).emit('visitor_count', { count });
}

// ── Socket.io connection handler ────────────────────────────────
io.on('connection', (socket) => {

    let currentCid = null;
    let currentRole = null;

    // ── join ──────────────────────────────────────────────
    socket.on('join', ({ key, cid, visitorId, role, secret }) => {
        if (!cid || !role) {
            socket.emit('error', { message: 'cid and role are required' });
            return;
        }

        // Agents must provide the PUSH_SECRET for auth
        if (role === 'agent') {
            if (!PUSH_SECRET || secret !== PUSH_SECRET) {
                socket.emit('error', { message: 'Unauthorized' });
                return;
            }
        }

        currentCid = cid;
        currentRole = role;

        socket.join(cid);

        const members = getRoomMembers(cid);
        if (role === 'agent') {
            members.agents.add(socket.id);
        } else {
            members.visitors.add(socket.id);
        }

        // Immediately push status to the newly joined client
        broadcastAgentStatus(cid);
        broadcastVisitorCount(cid);

        console.log(`[ws] ${role} joined room ${cid} (socket ${socket.id})`);
    });

    // ── visitor_message ───────────────────────────────────
    socket.on('visitor_message', ({ cid, message }) => {
        if (!cid || !message) return;
        // Broadcast to everyone in the room (including the sender for confirmation)
        io.to(cid).emit('new_message', {
            id: message.id,
            sender: 'visitor',
            body: message.body || '',
            type: message.type || 'text',
            mediaUrl: message.mediaUrl || '',
            createdAt: message.createdAt || new Date().toISOString(),
        });
    });

    // ── agent_message ─────────────────────────────────────
    socket.on('agent_message', ({ cid, secret, message }) => {
        if (!cid || !message) return;
        if (!PUSH_SECRET || secret !== PUSH_SECRET) {
            socket.emit('error', { message: 'Unauthorized' });
            return;
        }
        io.to(cid).emit('new_message', {
            id: message.id,
            sender: 'agent',
            body: message.body || '',
            type: message.type || 'text',
            mediaUrl: message.mediaUrl || '',
            createdAt: message.createdAt || new Date().toISOString(),
        });
    });

    // ── typing_start ──────────────────────────────────────
    socket.on('typing_start', ({ cid, role }) => {
        if (!cid) return;
        socket.to(cid).emit('typing', { role, isTyping: true });
    });

    // ── typing_stop ───────────────────────────────────────
    socket.on('typing_stop', ({ cid, role }) => {
        if (!cid) return;
        socket.to(cid).emit('typing', { role, isTyping: false });
    });

    // ── disconnect ────────────────────────────────────────
    socket.on('disconnect', () => {
        if (!currentCid) return;

        const members = getRoomMembers(currentCid);
        if (currentRole === 'agent') {
            members.agents.delete(socket.id);
        } else {
            members.visitors.delete(socket.id);
        }

        // Clean up empty rooms
        if (members.agents.size === 0 && members.visitors.size === 0) {
            roomMembers.delete(currentCid);
        } else {
            broadcastAgentStatus(currentCid);
            broadcastVisitorCount(currentCid);
        }

        console.log(`[ws] ${currentRole} left room ${currentCid} (socket ${socket.id})`);
    });
});

// ── HTTP REST endpoints ─────────────────────────────────────────

app.use(express.json());

/**
 * GET /health
 * UptimeRobot pings this to keep the free-tier instance awake.
 */
app.get('/health', (_req, res) => {
    res.status(200).send('OK');
});

/**
 * POST /push
 * Called by the Next.js server (agent reply API) to push a message
 * to a visitor's socket room without the agent being in the socket room itself.
 * Body: { conversationId, message: { id, sender, body, type, mediaUrl, createdAt } }
 * Header: x-push-secret
 */
app.post('/push', (req, res) => {
    const secret = req.headers['x-push-secret'];
    if (!PUSH_SECRET || secret !== PUSH_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { conversationId, message } = req.body;
    if (!conversationId || !message) {
        return res.status(400).json({ error: 'conversationId and message are required' });
    }

    io.to(conversationId).emit('new_message', {
        id: message.id,
        sender: message.sender || 'agent',
        body: message.body || '',
        type: message.type || 'text',
        mediaUrl: message.mediaUrl || '',
        createdAt: message.createdAt || new Date().toISOString(),
    });

    return res.json({ ok: true });
});

// ── Start ───────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`[chat-server v2] WebSocket + HTTP listening on port ${PORT}`);
    if (!PUSH_SECRET) {
        console.warn('[chat-server] WARNING: PUSH_SECRET is not set!');
    }
});
