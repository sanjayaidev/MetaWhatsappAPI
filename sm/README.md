# Multi-Platform Social Media Automation Platform

A full-stack social media automation application with integrations for Facebook, Instagram, Threads, Google Sheets, and Google Drive. Built for deployment on Railway or any Node.js hosting platform.

## Features

- 📅 Visual calendar for scheduling posts
- 🔗 Multi-platform OAuth integrations (Facebook, Instagram, Threads, Google)
- 💾 PostgreSQL database for persistent storage
- ⚡ Automation rules for content responses
- 📊 Analytics and insights dashboard
- 🔐 Secure API key authentication for external access
- 🪝 Platform-specific webhooks for real-time events

## Environment Variables

Copy `.env.example` to `.env` and configure the following:

### Database & Security
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - JWT signing secret (generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
- `ENCRYPTION_KEY` - Encryption key for storing tokens (same generation method as JWT_SECRET)
- `SESSION_SECRET` - Session cookie secret
- `API_KEY` - API key for external platform access (generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)

### Base URL
- `APP_BASE_URL` - Your deployed URL or `http://localhost:3000` for local development

### Facebook App Configuration
**Requires separate Meta App registration:**
1. Go to [Meta Developers](https://developers.facebook.com/)
2. Create a new app with "Business" type
3. Add "Facebook Login" product
4. Configure OAuth redirect URI: `{APP_BASE_URL}/api/connections/facebook/callback`
5. Get App ID and App Secret from Dashboard > Settings > Basic

- `FB_APP_ID` - Facebook App ID
- `FB_SECRET` - Facebook App Secret
- `FB_WEBHOOK_VERIFY_TOKEN` - Custom token for webhook verification (create your own)

**Webhook Setup for Facebook:**
- Webhook URL: `{APP_BASE_URL}/webhooks/facebook`
- Subscribe to: `pages`, `comments`, `messages`
- Verify Token: Use the same value as `FB_WEBHOOK_VERIFY_TOKEN`

### Instagram App Configuration
**Can share the same Meta App as Facebook OR use separate app:**
- If sharing with Facebook: Set `IG_APP_ID` = `FB_APP_ID` and `IG_SECRET` = `FB_SECRET`
- For separate app: Follow same steps as Facebook but add "Instagram Graph API" product

1. Add "Instagram Graph API" product to your Meta app
2. Configure OAuth redirect URI: `{APP_BASE_URL}/api/connections/instagram/callback`
3. Get App ID and App Secret

- `IG_APP_ID` - Instagram App ID (can be same as FB_APP_ID)
- `IG_SECRET` - Instagram App Secret (can be same as FB_SECRET)
- `IG_WEBHOOK_VERIFY_TOKEN` - Custom token for webhook verification

**Webhook Setup for Instagram:**
- Webhook URL: `{APP_BASE_URL}/webhooks/instagram`
- Subscribe to: `instagram`, `comments`, `messages`
- Verify Token: Use the same value as `IG_WEBHOOK_VERIFY_TOKEN`

### Threads App Configuration
**Requires SEPARATE Meta App registration:**
Threads API requires a dedicated app registration separate from Facebook/Instagram.

1. Go to [Meta Developers](https://developers.facebook.com/)
2. Create a NEW app (don't reuse Facebook/Instagram app)
3. Add "Threads" product
4. Configure OAuth redirect URI: `{APP_BASE_URL}/api/connections/threads/callback`
5. Get App ID and App Secret from Dashboard > Settings > Basic

- `TH_APP_ID` - Threads App ID (must be separate from FB/IG)
- `TH_SECRET` - Threads App Secret (must be separate from FB/IG)
- `TH_WEBHOOK_VERIFY_TOKEN` - Custom token for webhook verification

**Webhook Setup for Threads:**
- Webhook URL: `{APP_BASE_URL}/webhooks/threads`
- Subscribe to: `threads`
- Verify Token: Use the same value as `TH_WEBHOOK_VERIFY_TOKEN`

### Google Configuration (Sheets & Drive)
**Single Google Cloud Project for both services:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable APIs:
   - Google Sheets API
   - Google Drive API
   - Google+ API (for userinfo)
4. Go to "Credentials" > "Create Credentials" > "OAuth 2.0 Client ID"
5. Configure OAuth consent screen
6. Add authorized redirect URI: `{APP_BASE_URL}/api/connections/google_sheets/callback` and `{APP_BASE_URL}/api/connections/google_drive/callback`
7. Get Client ID and Client Secret

- `GOOGLE_CLIENT_ID` - Google OAuth Client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth Client Secret

### API Versions
- `GRAPH_VERSION` - Meta Graph API version (default: `v21.0`)
- `THREADS_VERSION` - Threads API version (default: `v1.0`)

### Optional: AI Reply Generation
- `ANTHROPIC_API_KEY` - Anthropic API key for AI-powered auto-replies

## Deployment on Railway

### 1. Push to GitHub
```bash
git add .
git commit -m "Initial commit"
git push origin main
```

### 2. Connect to Railway
1. Go to [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repository

### 3. Add PostgreSQL Database
1. In your Railway project, click "+ New" → "Database" → "PostgreSQL"
2. Railway will automatically provision a database and set `DATABASE_URL`

### 4. Configure Environment Variables
In Railway dashboard, add all variables from `.env.example`

### 5. Deploy
Railway will automatically deploy using `npm start`

## Local Development

### Prerequisites
- Node.js 18+
- PostgreSQL (optional for local dev)

### Setup
```bash
npm install
cp .env.example .env
# Edit .env with your credentials
npm run dev
```

Open http://localhost:3000

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - User login
- `GET /api/auth/me` - Get current user

### Connections (OAuth)
- `GET /api/connections/:platform/authorize` - Initiate OAuth flow
- `GET /api/connections/:platform/callback` - OAuth callback
- `GET /api/connections` - List user connections (protected)
- `DELETE /api/connections/:id` - Remove connection (protected)

### Posts
- `GET /api/posts` - Get all posts (protected)
- `POST /api/posts` - Create new post (protected)
- `PUT /api/posts/:id` - Update post (protected)
- `DELETE /api/posts/:id` - Delete post (protected)

### Automations
- `GET /api/automations` - Get all automations (protected)
- `POST /api/automations` - Create automation (protected)
- `PATCH /api/automations/:id/toggle` - Toggle active status (protected)

### Webhooks (Public - No Auth Required)
- `GET /webhooks/facebook` - Facebook webhook verification
- `POST /webhooks/facebook` - Facebook webhook events
- `GET /webhooks/instagram` - Instagram webhook verification
- `POST /webhooks/instagram` - Instagram webhook events
- `GET /webhooks/threads` - Threads webhook verification
- `POST /webhooks/threads` - Threads webhook events

### External API Access (API Key Required)
These endpoints allow other platforms/apps to access your data with proper authentication:

- `GET /api/public/posts` - Get all posts (requires `X-API-Key` header or `api_key` query param)
- `GET /api/public/automations` - Get active automations (requires `X-API-Key` header or `api_key` query param)

**Usage Example:**
```bash
curl -H "X-API-Key: your_api_key_here" https://your-domain.com/api/public/posts
# OR
curl "https://your-domain.com/api/public/posts?api_key=your_api_key_here"
```

## Database Schema

### users
- id, email, password_hash, created_at

### posts
- id, user_id, title, caption, hook, platforms (JSONB), scheduled_date, status, ig_media_id, created_at, updated_at

### automations
- id, user_id, name, type, keywords (JSONB), ai_prompt, variations (JSONB), is_active, created_at

### connections
- id, user_id, platform, account_name, account_id, page_id, access_token (encrypted), is_connected, token_expires_at, created_at, updated_at

### processed_webhook_events
- event_id, processed_at (for deduplication)

## Platform App Requirements Summary

| Platform | Separate App Required? | Can Share App? | Notes |
|----------|----------------------|----------------|-------|
| Facebook | Yes | No | Requires Meta Business App |
| Instagram | No | Yes (with Facebook) | Can use same Meta app as Facebook |
| Threads | Yes | No | Requires dedicated Threads app |
| Google Sheets | No | Yes (with Drive) | Single Google Cloud project |
| Google Drive | No | Yes (with Sheets) | Single Google Cloud project |

## Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Backend**: Node.js, Express
- **Database**: PostgreSQL
- **APIs**: Meta Graph API, Threads API, Google APIs
- **Deployment**: Railway (or any Node.js host)

## License

ISC
