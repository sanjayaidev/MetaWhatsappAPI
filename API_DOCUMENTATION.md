# WaBlast API Documentation

Complete API documentation for integrating with external applications like n8n, Zapier, and custom apps.

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [API Keys Management](#api-keys-management)
4. [Core Endpoints](#core-endpoints)
5. [Rate Limiting](#rate-limiting)
6. [Error Handling](#error-handling)
7. [Examples](#examples)

---

## Overview

WaBlast provides a RESTful API for managing WhatsApp campaigns, templates, contacts, and messages. All API endpoints return JSON responses and require authentication.

**Base URL:** `https://your-wablast-instance.com`

---

## Authentication

### Methods

The API supports two authentication methods:

1. **Bearer Token (JWT)** - For user sessions
2. **API Key** - For external integrations (recommended for n8n/Zapier)

### Using API Keys

Include your API key in the request header:

```bash
# Method 1: x-api-key header
curl -H "x-api-key: sk_live_abc123..." https://your-instance.com/api/templates

# Method 2: Authorization header
curl -H "Authorization: Bearer sk_live_abc123..." https://your-instance.com/api/templates
```

### Generating API Keys

1. Log in to your WaBlast dashboard
2. Navigate to `/api-keys.html`
3. Click "Create New API Key"
4. Configure permissions and rate limits
5. **Copy and store the key securely** (it won't be shown again)

---

## API Keys Management

Manage your API keys programmatically or via the dashboard.

### List All API Keys

```http
GET /api/api-keys
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "success": true,
  "keys": [
    {
      "id": "uuid",
      "name": "n8n Integration",
      "keyPrefix": "abc12345",
      "permissions": {
        "canSendMessages": true,
        "canReadMessages": false,
        "canManageTemplates": true
      },
      "rateLimits": {
        "perMinute": 60,
        "perHour": 1000,
        "perDay": 10000
      },
      "scopedPhoneNumberId": null,
      "isActive": true,
      "createdAt": "2024-01-01T00:00:00Z",
      "lastUsedAt": "2024-01-02T00:00:00Z"
    }
  ]
}
```

### Create API Key

```http
POST /api/api-keys
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "name": "Production App",
  "description": "API key for production environment",
  "permissions": {
    "canSendMessages": true,
    "canReadMessages": true,
    "canManageTemplates": false,
    "canManageContacts": false,
    "canManageCampaigns": false,
    "canManageAccounts": false,
    "canAccessAnalytics": false
  },
  "rateLimits": {
    "perMinute": 30,
    "perHour": 500,
    "perDay": 5000
  },
  "scopedPhoneNumberId": "1234567890",
  "expiresAt": "2025-12-31"
}
```

**Response:**
```json
{
  "success": true,
  "key": {
    "id": "uuid",
    "name": "Production App",
    "keyPrefix": "xyz98765",
    "apiKey": "sk_live_xyz98765...",
    "createdAt": "2024-01-01T00:00:00Z"
  },
  "warning": "Store this API key securely. It will not be shown again."
}
```

### Revoke API Key

```http
DELETE /api/api-keys/:id
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "success": true,
  "message": "API key revoked"
}
```

---

## Core Endpoints

### Send Message (External API)

Send a WhatsApp template message to any phone number.

```http
POST /api/external/send
Authorization: Bearer <api_key_or_jwt>
Content-Type: application/json
```

**Request Body:**
```json
{
  "phone_number_id": "1234567890",
  "to": "+1234567890",
  "template_name": "welcome_template",
  "language_code": "en_US"
}
```

**Permissions Required:** `canSendMessages`

**Response:**
```json
{
  "success": true,
  "message_id": "wamid.HBgNMTIzNDU2Nzg5MA=="
}
```

### Get Templates

```http
GET /api/templates
Authorization: Bearer <api_key_or_jwt>
```

**Permissions Required:** `canManageTemplates`

**Response:**
```json
{
  "success": true,
  "templates": [
    {
      "id": "uuid",
      "name": "welcome_template",
      "body": "Hello {{1}}, welcome to our service!",
      "category": "MARKETING",
      "language": "en_US",
      "status": "APPROVED",
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

### Create Template

```http
POST /api/templates
Authorization: Bearer <api_key_or_jwt>
Content-Type: application/json
```

**Request Body:**
```json
{
  "name": "order_confirmation",
  "body": "Your order {{1}} has been confirmed. Total: {{2}}",
  "category": "UTILITY",
  "language": "en_US",
  "footer": "Thank you for your business",
  "buttons": [
    {
      "type": "URL",
      "text": "Track Order",
      "url": "https://example.com/track/{{1}}"
    }
  ]
}
```

**Permissions Required:** `canManageTemplates`

### Get Contacts

```http
GET /api/contacts
Authorization: Bearer <api_key_or_jwt>
```

**Permissions Required:** `canManageContacts`

### Create Campaign

```http
POST /api/campaigns
Authorization: Bearer <api_key_or_jwt>
Content-Type: application/json
```

**Request Body:**
```json
{
  "name": "Black Friday Campaign",
  "template_id": "uuid",
  "contact_list_id": "uuid",
  "scheduled_at": "2024-11-24T00:00:00Z"
}
```

**Permissions Required:** `canManageCampaigns`

### Get Messages Received

```http
GET /api/messages/received
Authorization: Bearer <api_key_or_jwt>
```

**Permissions Required:** `canReadMessages`

**Response:**
```json
{
  "success": true,
  "messages": [
    {
      "id": "uuid",
      "from": "+1234567890",
      "message": "Hi, I need help with my order",
      "received_at": "2024-01-01T12:00:00Z"
    }
  ]
}
```

### AI Chat

```http
POST /api/ai/chat
Authorization: Bearer <api_key_or_jwt>
Content-Type: application/json
```

**Request Body:**
```json
{
  "message": "Hello",
  "session_id": "user123"
}
```

---

## Rate Limiting

API keys have configurable rate limits to prevent abuse:

| Limit Type | Default | Description |
|------------|---------|-------------|
| Per Minute | 60 | Max requests per minute |
| Per Hour | 1000 | Max requests per hour |
| Per Day | 10000 | Max requests per day |

### Rate Limit Headers

Every response includes rate limit information:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 2024-01-01T12:01:00Z
```

### Rate Limit Exceeded Response

```json
HTTP 429 Too Many Requests
{
  "error": "Rate limit exceeded",
  "reason": "Too many requests per minute",
  "resetAt": "2024-01-01T12:01:00Z"
}
```

---

## Error Handling

### Standard Error Response

```json
{
  "error": "Error message description"
}
```

### Common HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Missing or invalid auth |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |

### Permission Error

```json
HTTP 403 Forbidden
{
  "error": "Insufficient permissions",
  "message": "This API key does not have 'canSendMessages' permission",
  "requiredPermission": "canSendMessages"
}
```

---

## Examples

### n8n Integration

#### 1. HTTP Request Node Configuration

**Method:** POST  
**URL:** `https://your-instance.com/api/external/send`  
**Headers:**
```
x-api-key: sk_live_your_api_key_here
Content-Type: application/json
```

**Body (JSON):**
```json
{
  "phone_number_id": "{{$json.phone_number_id}}",
  "to": "{{$json.phone}}",
  "template_name": "{{$json.template_name}}",
  "language_code": "en_US"
}
```

#### 2. Handle Response

Add an IF node to check `{{$json.success}} === true`

### Zapier Integration

#### 1. Create a Zap

**Trigger:** Your choice (Form submission, Schedule, etc.)  
**Action:** Webhooks by Zapier → POST

**Setup:**
- URL: `https://your-instance.com/api/external/send`
- Headers:
  - `x-api-key`: `sk_live_your_api_key_here`
  - `Content-Type`: `application/json`
- Data (JSON):
```json
{
  "phone_number_id": "1234567890",
  "to": "{{trigger.phone}}",
  "template_name": "notification"
}
```

### cURL Examples

```bash
# Send a message
curl -X POST https://your-instance.com/api/external/send \
  -H "x-api-key: sk_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number_id": "1234567890",
    "to": "+1234567890",
    "template_name": "welcome"
  }'

# List templates
curl -X GET https://your-instance.com/api/templates \
  -H "x-api-key: sk_live_abc123..."

# Create a campaign
curl -X POST https://your-instance.com/api/campaigns \
  -H "x-api-key: sk_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Summer Sale",
    "template_id": "uuid",
    "contact_list_id": "uuid"
  }'
```

### Python Example

```python
import requests

API_KEY = "sk_live_your_api_key"
BASE_URL = "https://your-instance.com"

headers = {
    "x-api-key": API_KEY,
    "Content-Type": "application/json"
}

# Send a message
response = requests.post(
    f"{BASE_URL}/api/external/send",
    headers=headers,
    json={
        "phone_number_id": "1234567890",
        "to": "+1234567890",
        "template_name": "welcome"
    }
)

if response.status_code == 200:
    data = response.json()
    print(f"Message sent: {data['message_id']}")
else:
    print(f"Error: {response.json()}")
```

### Node.js Example

```javascript
const axios = require('axios');

const API_KEY = 'sk_live_your_api_key';
const BASE_URL = 'https://your-instance.com';

async function sendMessage(phone, templateName) {
  try {
    const response = await axios.post(
      `${BASE_URL}/api/external/send`,
      {
        phone_number_id: '1234567890',
        to: phone,
        template_name: templateName
      },
      {
        headers: {
          'x-api-key': API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Message sent:', response.data.message_id);
    return response.data;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    throw error;
  }
}
```

---

## Security Best Practices

1. **Never expose API keys in client-side code**
2. **Use environment variables** to store API keys
3. **Rotate keys regularly** and revoke unused ones
4. **Set appropriate rate limits** based on your needs
5. **Use scoped keys** to limit access to specific phone numbers
6. **Set expiration dates** for temporary integrations
7. **Monitor usage** via the dashboard

---

## Support

For API support, contact: support@wablast.com
