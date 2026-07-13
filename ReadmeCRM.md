# WaBlast Pro → Omnichannel CRM: Architecture Plan

## 1. What we're building

A unified **Leads** module added on top of the existing WaBlast Pro backend (Express + Postgres/Supabase, Meta Cloud API for WhatsApp). One lead record aggregates every channel it touched, with a per-channel conversation tab, automated first-touch messaging, meeting sync, subscription gating, and an AI chatbot (website widget + in-dashboard assistant).

Channels in scope:
- **Google Sheets** (lead source, poll or Apps Script push trigger) — now with improved UI: dropdowns for selecting sheets and pages, automatic column header detection
- **Web Forms** (generic webhook receiver, any form builder can POST to it)
- **Instagram** DMs + comments (Meta Graph API — you're building the Meta app)
- **Facebook Page** DMs + comments (Meta Graph API — same app as above)
- **Gmail** — outbound automated email only (not a capture source, per your call)
- **WhatsApp** — already exists, gets wired into the unified lead record
- **smbooking** — your own booking product; meetings synced onto the lead timeline
- **Website AI chatbot widget** — becomes a lead source too (web channel)

## Google Sheets Integration Improvements

### Enhanced User Experience
The Google Sheets connection interface has been significantly improved:

1. **Sheet Filtering**: Only actual Google Spreadsheet files are now shown in the dropdown (non-sheet files like Docs, PDFs, etc. are filtered out by mimeType check)

2. **Visual Flow Indicator**: An arrow (→) is displayed between the Sheet and Page dropdowns to clearly indicate the relationship and flow

3. **Automatic Column Detection**: When a sheet and page are selected, column headers are automatically fetched from the first row of the worksheet and populated into a dropdown menu in the field mapping section

4. **Dropdown-Based Field Mapping**: Instead of manually typing column names, users can now select from a dropdown populated with actual column headers from their selected sheet

5. **User Feedback**: Toast notifications inform users when columns are successfully loaded or if there's an error

### How It Works
1. User connects Google account via OAuth
2. System fetches only spreadsheet files from Google Drive (filtered by `mimeType='application/vnd.google-apps.spreadsheet'`)
3. User selects a spreadsheet from the dropdown
4. System fetches all worksheets (pages/tabs) within that spreadsheet
5. User selects a worksheet from the second dropdown
6. System reads the first row (A1:Z1) to extract column headers
7. Column headers populate the "Column Header" dropdown in the Field Mapping section
8. Users map these columns to CRM fields (name, phone, email, tag, custom) using dropdowns

### Backend Changes
- Updated `/api/oauth/google/sheets` endpoint to use proper query syntax and filter results by mimeType
- Added client-side filtering as a safety measure to ensure only spreadsheets are displayed
- Enhanced error handling with user-friendly toast notifications

## 2. Data model (new tables, `wb_` prefix, Postgres/Supabase, RLS per user_id)

```sql
-- Unified lead entity
CREATE TABLE wb_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  email TEXT,
  ig_handle TEXT,
  fb_psid TEXT,
  primary_source TEXT NOT NULL, -- whatsapp | instagram | facebook | webform | sheet | web_chat
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','contacted','engaged','booked','won','lost','cold')),
  tags JSONB DEFAULT '[]',
  custom_fields JSONB DEFAULT '{}',
  assigned_to UUID REFERENCES auth.users(id),
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Which channel identities map to this lead (a lead can have >1 identity)
CREATE TABLE wb_lead_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES wb_leads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, -- whatsapp|instagram|facebook|webform|sheet|web_chat
  external_id TEXT NOT NULL, -- wa number / ig psid / fb psid / form submission id
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel, external_id)
);

-- Unified timeline: status changes, notes, meetings, auto-sends
CREATE TABLE wb_lead_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES wb_leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- status_change|note|meeting_booked|auto_message|manual_message
  payload JSONB,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Per-channel conversation log (WA, IG, FB unified; reuse/migrate wb_messages into this)
CREATE TABLE wb_channel_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES wb_leads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  body TEXT,
  media_url TEXT,
  meta JSONB,
  external_message_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Connected integrations per user
CREATE TABLE wb_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- google_sheet|web_form|instagram|facebook|smbooking
  config JSONB NOT NULL DEFAULT '{}', -- tokens encrypted at rest via src/crypto.js
  status TEXT DEFAULT 'disconnected',
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, type)
);

-- Public inbound webhook tokens (form/sheet POST targets)
CREATE TABLE wb_webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, -- webform|sheet
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- First-touch / follow-up automation rules
CREATE TABLE wb_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger_source TEXT NOT NULL, -- any|whatsapp|instagram|facebook|webform|sheet
  channel TEXT NOT NULL,        -- which channel to send the automated message on
  message_body TEXT,
  template_id UUID,
  delay_minutes INT DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meetings synced from smbooking
CREATE TABLE wb_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES wb_leads(id) ON DELETE SET NULL,
  external_booking_id TEXT,
  event_name TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  status TEXT DEFAULT 'scheduled',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subscriptions (multi-provider)
CREATE TABLE wb_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('razorpay','stripe','paypal')),
  provider_subscription_id TEXT,
  status TEXT DEFAULT 'active',
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI chatbot config (website widget + dashboard assistant share this shape)
CREATE TABLE wb_chatbot_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('website_widget','dashboard_assistant')),
  system_prompt TEXT,
  knowledge_urls JSONB DEFAULT '[]',
  bot_token TEXT UNIQUE,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

All new tables get RLS policies mirroring the pattern already in `migrations/001_api_keys_table.sql` (`auth.uid() = user_id`).

## 3. New backend route files

`server.js` is already 2300+ lines — new modules go in `src/routes/`, mounted from `server.js` (mirrors the existing `src/routes/ai-chat.js` pattern):

| File | Responsibility |
|---|---|
| `src/routes/leads.js` | CRUD, pipeline list/filter, status update, assign, merge duplicate leads |
| `src/routes/integrations.js` | Connect/disconnect Sheets, Web Form, IG, FB, smbooking; OAuth callbacks |
| `src/routes/webhooks-inbound.js` | Public per-user endpoints: `POST /api/hooks/form/:token`, `POST /api/hooks/sheet/:token` |
| `src/routes/social-webhooks.js` | Meta unified webhook extension — routes IG/FB events into `wb_channel_messages` + creates/matches leads |
| `src/routes/automations.js` | CRUD for auto-send rules, triggered on new lead events |
| `src/routes/meetings.js` | smbooking webhook receiver + lead-linked meeting list |
| `src/routes/billing.js` | Subscription checkout + provider webhooks (Razorpay/Stripe/PayPal) |
| `src/routes/chatbot.js` | Config CRUD, embed script generator, widget message endpoint, dashboard assistant endpoint |

**Meta webhook note:** WhatsApp, Instagram, and Facebook can share one verified webhook URL (`/webhook`) — Meta sends different `object` types (`whatsapp_business_account`, `instagram`, `page`) in the payload, so we branch inside the existing handler rather than standing up separate endpoints. Your Meta app will need `instagram_manage_messages`, `instagram_manage_comments`, `pages_messaging`, and `pages_manage_metadata` scopes.

## 4. Dashboard additions

- **New "Leads" page**: table/kanban of `wb_leads`, filterable by source/status/tag/assignee
- **Lead detail panel**: header (identity, status dropdown, assign, tags) + tabs — `Overview` (unified timeline), `WhatsApp`, `Instagram`, `Facebook`, `Meetings`, `Notes`
- **Integrations/Sources page**: connect Sheets, Web Form (shows the webhook URL to paste into the form tool), IG, FB, smbooking
- **Automations page**: define first-touch/follow-up rules per source
- **Billing page**: plan picker, provider checkout buttons, current subscription status
- **Chatbot page**: website widget config + embed snippet; dashboard assistant is a persistent floating panel available app-wide

## 5. Build order (phased, each phase is independently shippable)

1. **Leads core** — schema + `leads.js` + Leads page (manual leads only, no integrations yet)
2. **Sheets + Web Form capture** — inbound webhooks create leads, automations fire first WhatsApp message
3. **Instagram + Facebook** — once your Meta app is ready: webhook branching, DM/comment capture, per-channel reply tabs
4. **smbooking** — webhook receiver + Meetings tab
5. **Billing/subscriptions** — plan gating middleware (mirrors existing `requirePermission`), provider webhooks
6. **AI chatbot** — website widget + dashboard assistant (can reuse/extend `src/routes/ai-chat.js`)

---
Next: I'd suggest starting Phase 1 now since everything else hangs off the `wb_leads` schema. Let me know if you want to adjust the schema/routes before I start writing the migration + `leads.js` + Leads page.
