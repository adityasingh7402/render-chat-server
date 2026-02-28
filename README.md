# render-chat-server

> Real-time SSE push server for the Email Router live chat feature.  
> Deploy **only this folder** to [Render.com](https://render.com) free tier.

---

## How It Works

| Route | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | None | Health check — ping this with UptimeRobot |
| `/live?key=&cid=` | GET | None | SSE stream for visitor browser (55s max) |
| `/push` | POST | `x-push-secret` header | Vercel calls this to deliver agent replies to visitors |

The visitor's chat embed page connects to `/live` and keeps it open. When a dashboard agent sends a reply, Vercel calls `/push` → this server forwards the message via SSE to all active connections for that conversation.

---

## Deploy to Render.com (Free Tier)

### Step 1 — Push the folder to GitHub

You can either:
- Push the **whole project** and set the root directory to `render-chat-server/` in Render, OR
- Create a **separate GitHub repo** containing only this folder's contents (recommended for clarity)

### Step 2 — Create a new Web Service on Render

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Set the **Root Directory** to `render-chat-server` (if using the full monorepo)
4. Configure:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`

### Step 3 — Set Environment Variables

In Render → your service → **Environment** tab, add:

| Key | Value |
|---|---|
| `PORT` | `3001` (Render overrides this automatically) |
| `PUSH_SECRET` | A long random string — must match `RENDER_PUSH_SECRET` in your Vercel env |

### Step 4 — Add Render URL to Vercel

In your Vercel project settings (or `.env.local` for local dev), add:

```
RENDER_CHAT_SERVER_URL=https://your-app-name.onrender.com
RENDER_PUSH_SECRET=the_same_secret_you_set_on_render
NEXT_PUBLIC_RENDER_CHAT_SERVER_URL=https://your-app-name.onrender.com
NEXT_PUBLIC_BASE_URL=https://your-vercel-app.vercel.app
```

> **Note:** `NEXT_PUBLIC_RENDER_CHAT_SERVER_URL` must be a `NEXT_PUBLIC_` var so the visitor's browser can connect to it directly for SSE.

---

## Keep It Awake (Free Tier Pinger) — UptimeRobot

Render free tier spins down after **15 minutes of inactivity**. Use UptimeRobot to ping it every 10 minutes:

1. Go to [uptimerobot.com](https://uptimerobot.com) → Create Free Account
2. Click **Add New Monitor**
3. Set:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: `Email Router Chat Server`
   - **URL (or IP)**: `https://your-app-name.onrender.com/health`
   - **Monitoring Interval**: `10 minutes`
4. Click **Create Monitor** — that's it!

UptimeRobot pings `/health` every 10 minutes which returns `200 OK` and keeps the instance awake 24/7 for free.

---

## Local Development

```bash
# Install dependencies
npm install

# Copy env
cp .env.example .env

# Edit PUSH_SECRET in .env, then:
node server.js
# → Listening on port 3001

# Test health
curl http://localhost:3001/health
# → OK

# Test SSE (open in browser or curl)
curl -N "http://localhost:3001/live?key=cw_test&cid=conv123"

# Test push (from another terminal)
curl -X POST http://localhost:3001/push \
  -H "Content-Type: application/json" \
  -H "x-push-secret: changeme_use_a_long_random_string_here" \
  -d '{"conversationId":"conv123","message":{"id":"m1","sender":"agent","body":"Hello!","createdAt":"2025-01-01T00:00:00Z"}}'
```

---

## Architecture Notes

- **Stateless per restart**: SSE connections are stored in-memory (`Map`). If the server restarts, visitors reconnect automatically (EventSource retries by default).
- **55s max connection**: Render terminates idle connections; keeping under 60s + heartbeats ensures reliability.
- **Horizontal scaling**: The free tier runs a single instance, which is fine. If you upgrade, use Redis pub/sub instead of in-memory Maps.
