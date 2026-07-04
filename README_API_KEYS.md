# API Keys Implementation Summary

## ✅ What Was Implemented

### 1. Database Schema (`/migrations/001_api_keys_table.sql`)

Created two tables in Supabase:

**`wb_api_keys`** - Stores API keys with:
- Unique hashed keys (SHA-256)
- Granular permissions (7 scopes)
- Configurable rate limits (per minute/hour/day)
- Account scoping (optional phone number restriction)
- Expiration dates
- Usage tracking

**`wb_api_key_usage`** - Tracks API usage for rate limiting:
- Minute/hour/day buckets
- Request counts
- Automatic cleanup via unique constraints

### 2. Backend Implementation

**`/src/api-keys.js`** - Core API key management:
- `generateApiKey()` - Creates secure keys with format `sk_live_<32chars>`
- `verifyApiKey()` - Validates keys and returns user/permissions
- `checkRateLimit()` - Enforces rate limits with sliding windows
- `createApiKey()` - Creates new keys with custom settings
- `listApiKeys()` - Lists all keys for a user
- `revokeApiKey()` - Deactivates keys

**`/src/middleware/api-auth.js`** - Express middleware:
- `verifyApiKey` - Authenticates requests with API keys
- `requirePermission(permission)` - Checks specific permissions
- `requireScopedAccount()` - Enforces phone number scoping

**`/server.js`** - Added routes:
- `GET /api/api-keys` - List user's API keys
- `POST /api/api-keys` - Create new API key
- `DELETE /api/api-keys/:id` - Revoke API key

### 3. Frontend UI (`/public/api-keys.html`)

Complete dashboard for managing API keys:
- View all API keys with masked values
- Create new keys with:
  - Custom name and description
  - Checkbox permissions (7 options)
  - Configurable rate limits
  - Optional phone number scoping
  - Optional expiration date
- One-time key display with copy button
- Revoke keys with confirmation
- Responsive design with modern UI

### 4. Documentation (`/API_DOCUMENTATION.md`)

Comprehensive API documentation including:
- Authentication methods
- All endpoint specifications
- Permission requirements
- Rate limiting details
- Error handling
- Integration examples for:
  - n8n workflows
  - Zapier zaps
  - cURL commands
  - Python scripts
  - Node.js applications

## 🔐 Security Features

1. **Hashed Storage** - Keys are SHA-256 hashed before storage
2. **One-Time Display** - Full key shown only once at creation
3. **Granular Permissions** - 7 different permission scopes
4. **Rate Limiting** - Prevents abuse with configurable limits
5. **Account Scoping** - Can restrict to specific phone numbers
6. **Expiration Dates** - Keys can auto-expire
7. **RLS Policies** - Database-level row security

## 📋 Available Permissions

| Permission | Description | Endpoints Affected |
|------------|-------------|-------------------|
| `canSendMessages` | Send WhatsApp messages | `/api/external/send` |
| `canReadMessages` | Read received messages | `/api/messages/received` |
| `canManageTemplates` | Create/manage templates | `/api/templates/*` |
| `canManageContacts` | Manage contact lists | `/api/contacts/*` |
| `canManageCampaigns` | Create/manage campaigns | `/api/campaigns/*` |
| `canManageAccounts` | Manage WhatsApp accounts | `/api/accounts/*` |
| `canAccessAnalytics` | View analytics data | `/api/analytics/*` |

## 🚀 How to Use

### Step 1: Run Migration

Execute the SQL migration in your Supabase SQL Editor:
```sql
-- Copy contents of /migrations/001_api_keys_table.sql
```

### Step 2: Access Dashboard

Navigate to: `https://your-instance.com/api-keys.html`

### Step 3: Create API Key

1. Click "Create New API Key"
2. Enter a name (e.g., "n8n Integration")
3. Select required permissions
4. Configure rate limits
5. (Optional) Scope to specific phone number
6. (Optional) Set expiration date
7. Click "Create Key"
8. **Copy the key immediately** (won't be shown again)

### Step 4: Use in External Apps

```bash
# Example: Send message via n8n/Zapier
curl -X POST https://your-instance.com/api/external/send \
  -H "x-api-key: sk_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number_id": "1234567890",
    "to": "+1234567890",
    "template_name": "welcome"
  }'
```

## 📊 Rate Limit Headers

Every API response includes:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 2024-01-01T12:01:00Z
```

## ⚠️ Important Notes

1. **Database Dependency**: Requires PostgreSQL with pg driver
2. **Supabase Integration**: Uses Supabase auth.users table
3. **Environment Variables**: Ensure DATABASE_URL is set
4. **Key Format**: All keys start with `sk_live_`
5. **Irreversible**: Revoked keys cannot be recovered

## 🔄 Next Steps (Optional Enhancements)

- [ ] Add API key usage analytics dashboard
- [ ] Implement key rotation workflow
- [ ] Add webhook notifications for key events
- [ ] Create audit log for key usage
- [ ] Add IP whitelisting for keys
- [ ] Implement OAuth2 flow for third-party apps

## 📁 Files Created/Modified

```
/workspace/
├── migrations/
│   └── 001_api_keys_table.sql      # NEW - Database schema
├── src/
│   ├── api-keys.js                  # NEW - Key management logic
│   ├── middleware/
│   │   └── api-auth.js              # NEW - Auth middleware
│   └── db.js                        # MODIFIED - Pool export
├── public/
│   └── api-keys.html                # NEW - Management UI
├── server.js                        # MODIFIED - Added API routes
├── API_DOCUMENTATION.md             # NEW - Complete API docs
└── README_API_KEYS.md               # NEW - This file
```

## 🆘 Troubleshooting

### "pool.query is not a function"
Ensure you're using the pg driver correctly. The pool object from `new Pool()` already has a `.query()` method.

### "Table wb_api_keys does not exist"
Run the migration SQL in Supabase SQL Editor.

### "API key not working"
1. Check key format (must start with `sk_live_`)
2. Verify key is active (not revoked)
3. Check expiration date
4. Ensure permissions match the endpoint

### "Rate limit exceeded"
Increase rate limits when creating the key or wait for the reset time.
