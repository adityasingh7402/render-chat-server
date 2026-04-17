/* =============================================================
   render-chat-server/server.js  v2.1  — Full WebSocket (Socket.io)

   Rooms:
     - conversationId room  → per-conversation messaging
     - "presence:" + key    → widget-level presence so visitors without
                              a cid still see agent online status

   CLIENT → SERVER events:
     join             { key, cid?, visitorId, role, secret? }
     visitor_message  { cid, message: { id, sender, body, type, mediaUrl, createdAt } }
     agent_message    { cid, secret, message: { id, sender, body, type, mediaUrl, createdAt } }
     typing_start     { cid, role }
     typing_stop      { cid, role }

   SERVER → CLIENT events:
     new_message      { id, sender, body, type, mediaUrl, createdAt }
     typing           { role, isTyping }
     agent_status     { online: bool, count: number }   → sent to visitors
     visitor_count    { count: number }                 → sent to agents
     error            { message: string }
   ============================================================= */

'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;
const PUSH_SECRET = process.env.PUSH_SECRET || '';

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
});

// ── In-memory trackers ──────────────────────────────────────────
// roomMembers: Map<cid, { agents: Set<socketId>, visitors: Set<socketId> }>
const roomMembers = new Map();

// widgetAgents: Map<widgetKey, Set<socketId>>  — agents online per widget
const widgetAgents = new Map();

function getRoomMembers(cid) {
    if (!roomMembers.has(cid)) {
        roomMembers.set(cid, { agents: new Set(), visitors: new Set() });
    }
    return roomMembers.get(cid);
}

// Emit agent_status to everyone in the conversation room (visitors & agents)
function broadcastAgentStatus(cid, key) {
    const members = getRoomMembers(cid);
    // Prefer the widget-level count if key is available, else fall back to room count
    const count = key
        ? (widgetAgents.get(key) || new Set()).size
        : members.agents.size;
    io.to(cid).emit('agent_status', { online: count > 0, count });
}

// Emit agent_status to the widget presence room (visitors without a cid)
function broadcastPresenceStatus(key) {
    if (!key) return;
    const count = (widgetAgents.get(key) || new Set()).size;
    io.to('presence:' + key).emit('agent_status', { online: count > 0, count });
}

function broadcastVisitorCount(cid) {
    const members = getRoomMembers(cid);
    const count = members.visitors.size;
    io.to(cid).emit('visitor_count', { count });
}

// ── Socket.io connection handler ────────────────────────────────
io.on('connection', (socket) => {

    let currentCid = null;
    let currentRole = null;
    let currentKey = null;

    // ── join ──────────────────────────────────────────────
    socket.on('join', ({ key, cid, visitorId, role, secret }) => {
        if (!role) {
            socket.emit('error', { message: 'role is required' });
            return;
        }

        // Agents must provide the PUSH_SECRET for auth
        if (role === 'agent') {
            if (!PUSH_SECRET || secret !== PUSH_SECRET) {
                socket.emit('error', { message: 'Unauthorized' });
                return;
            }
        }

        currentRole = role;
        currentKey = key || null;

        // ── Agents join the widget-level presence room ────
        if (role === 'agent' && key) {
            socket.join('presence:' + key);
            if (!widgetAgents.has(key)) widgetAgents.set(key, new Set());
            widgetAgents.get(key).add(socket.id);
            // Immediately tell all visitors watching this widget that an agent is online
            broadcastPresenceStatus(key);
        }

        // ── Join conversation room if cid is given ────────
        if (cid) {
            currentCid = cid;
            socket.join(cid);

            const members = getRoomMembers(cid);
            if (role === 'agent') {
                members.agents.add(socket.id);
            } else {
                members.visitors.add(socket.id);
            }

            // Tell the room about current agent/visitor counts
            broadcastAgentStatus(cid, key);
            broadcastVisitorCount(cid);
        } else if (role === 'visitor' && key) {
            // Visitor has no cid yet — join the presence room to get agent status
            socket.join('presence:' + key);
            // Tell this visitor immediately about agent status
            const count = (widgetAgents.get(key) || new Set()).size;
            socket.emit('agent_status', { online: count > 0, count });
        }

        console.log(`[ws] ${role} joined key=${key} cid=${cid || '(none)'} (socket ${socket.id})`);
    });

    // ── join_presence ─────────────────────────────────────────
    // Allows an agent to register as "online" for multiple widgets
    // at once, without joining any specific conversation room.
    // Used by the dashboard-level AgentPresenceProvider.
    socket.on('join_presence', ({ keys, secret }) => {
        if (!secret || !PUSH_SECRET || secret !== PUSH_SECRET) {
            socket.emit('error', { message: 'Unauthorized' });
            return;
        }

        currentRole = 'agent';

        if (!Array.isArray(keys) || keys.length === 0) return;

        for (const key of keys) {
            if (!key) continue;
            // Track this key so disconnect cleanup works
            if (!currentKey) currentKey = key; // store first key for backward compat
            socket.join('presence:' + key);
            if (!widgetAgents.has(key)) widgetAgents.set(key, new Set());
            widgetAgents.get(key).add(socket.id);
            broadcastPresenceStatus(key);
        }

        // Store all keys for cleanup on disconnect
        socket._presenceKeys = keys.filter(Boolean);

        console.log(`[ws] agent joined presence for ${keys.length} widget(s) (socket ${socket.id})`);
    });

    // ── visitor_message ───────────────────────────────────
    socket.on('visitor_message', ({ cid, message }) => {
        if (!cid || !message) return;
        // Use socket.to() to exclude the sender (visitor already has it optimistically)
        socket.to(cid).emit('new_message', {
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
        // Use socket.to() to exclude the sender (agent already has it optimistically)
        socket.to(cid).emit('new_message', {
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
        // Remove from widget-level presence tracking (single-key join)
        if (currentRole === 'agent' && currentKey) {
            const agents = widgetAgents.get(currentKey);
            if (agents) {
                agents.delete(socket.id);
                if (agents.size === 0) widgetAgents.delete(currentKey);
            }
            broadcastPresenceStatus(currentKey);
        }

        // Remove from multi-key presence tracking (join_presence)
        if (socket._presenceKeys) {
            for (const key of socket._presenceKeys) {
                if (key === currentKey) continue; // already handled above
                const agents = widgetAgents.get(key);
                if (agents) {
                    agents.delete(socket.id);
                    if (agents.size === 0) widgetAgents.delete(key);
                }
                broadcastPresenceStatus(key);
            }
        }

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
            broadcastAgentStatus(currentCid, currentKey);
            broadcastVisitorCount(currentCid);
        }

        console.log(`[ws] ${currentRole} left room ${currentCid} (socket ${socket.id})`);
    });
});

// ── HTTP REST endpoints ─────────────────────────────────────────

app.use(express.json());

/**
 * GET /health
 */
app.get('/health', (_req, res) => {
    res.status(200).send('OK');
});

/**
 * POST /push
 * Called by Next.js server to push a message into a socket room.
 * Body: { conversationId, message: { id, sender, body, type, mediaUrl, createdAt } }
 * Header: x-push-secret
 */
app.post('/push', (req, res) => {
    const secret = req.headers['x-push-secret'];
    if (!PUSH_SECRET || secret !== PUSH_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { conversationId, message, excludeSocketId } = req.body;
    if (!conversationId || !message) {
        return res.status(400).json({ error: 'conversationId and message are required' });
    }

    const payload = {
        id: message.id,
        sender: message.sender || 'agent',
        body: message.body || '',
        type: message.type || 'text',
        mediaUrl: message.mediaUrl || '',
        createdAt: message.createdAt || new Date().toISOString(),
    };

    // If excludeSocketId is provided, broadcast to each socket individually
    // so we can skip the sender (prevents duplicate delivery when client already
    // shows the message optimistically via socket emit).
    if (excludeSocketId) {
        const room = io.sockets.adapter.rooms.get(conversationId);
        if (room) {
            for (const sockId of room) {
                if (sockId === excludeSocketId) continue;
                io.to(sockId).emit('new_message', payload);
            }
        }
    } else {
        io.to(conversationId).emit('new_message', payload);
    }

    return res.json({ ok: true });
});

/**
 * GET /presence?key=xxx
 * Returns whether any agents are online for the given widget key.
 * Used by visitor widget polling as a reliable alternative to socket-based presence.
 */
app.get('/presence', (req, res) => {
    // Allow cross-origin requests from any origin (visitor widget is on a different domain)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const key = req.query.key;
    if (!key) {
        return res.status(400).json({ error: 'key is required' });
    }

    const agents = widgetAgents.get(key);
    const count = agents ? agents.size : 0;
    return res.json({ online: count > 0, count });
});

// ── Start ───────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`[chat-server v2.2] WebSocket + HTTP listening on port ${PORT}`);
    if (!PUSH_SECRET) {
        console.warn('[chat-server] WARNING: PUSH_SECRET is not set!');
    }
});
