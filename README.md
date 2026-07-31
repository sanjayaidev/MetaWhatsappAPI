# Meta Graph API — App Review Test Calls

Reference doc of all API calls tested and verified during App Review permission testing.

**API Versions used:**
- Facebook / Instagram (via Facebook Graph API): `v25.0`
- Instagram (via Instagram Login / `graph.instagram.com`): `v25.0`
- Threads (`graph.threads.net`): `v1.0`

**Placeholders used throughout this doc:**
| Placeholder | What it refers to |
|---|---|
| `YOUR_BUSINESS_ID` | Meta Business Manager ID |
| `YOUR_WABA_ID` | WhatsApp Business Account ID |
| `YOUR_PHONE_NUMBER_ID` | WhatsApp registered phone number ID |
| `YOUR_PAGE_ID` | Facebook Page ID |
| `YOUR_IG_BUSINESS_ACCOUNT_ID` | Instagram Business Account ID (linked to the FB Page) |
| `YOUR_IG_USER_ID` | Instagram User ID (via Instagram Login) |
| `YOUR_THREADS_USER_ID` | Threads User ID |

Fetch each of these dynamically using the calls in the sections below (e.g. `me/accounts` for Page ID, `{page-id}?fields=instagram_business_account` for IG Business ID, etc.) rather than hardcoding them.

---

## 1. WhatsApp Messaging

Permissions: `email`, `public_profile`, `whatsapp_business_management`, `business_management`, `whatsapp_business_messaging`

**Token type:** User Access Token

```
GET me?fields=id,name,email
```
> Verifies `email`

```
GET me?fields=id,name,first_name,last_name,picture
```
> Verifies `public_profile`

```
GET {business-id}/owned_whatsapp_business_accounts
```
> Lists WABAs under a Business. Use `client_whatsapp_business_accounts` if none are owned directly.

```
GET {waba-id}/message_templates
```
> Verifies `whatsapp_business_management`

```
GET {business-id}?fields=id,name,verification_status,created_time
```
> Verifies `business_management`

```
GET {waba-id}/phone_numbers
```
> Returns the phone number ID needed to send messages.

```
POST {phone-number-id}/messages
Body:
{
  "messaging_product": "whatsapp",
  "to": "COUNTRY_CODE + PHONE_NUMBER (e.g. 91XXXXXXXXXX, no + or spaces)",
  "type": "template",
  "template": {
    "name": "hello_world",
    "language": { "code": "en_US" }
  }
}
```
> Verifies `whatsapp_business_messaging`. Recipient number must be added/verified as a test recipient in App Dashboard → WhatsApp → API Setup.

---

## 2. Facebook Page (Manage Pages)

Permissions: `read_insights`, `pages_manage_metadata`, `pages_read_user_content`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement`, `pages_show_list`, `business_management`

**Token type:** Page Access Token (unless noted)

```
GET me/accounts
```
> User token. Verifies `pages_show_list`. Also returns Page ID + Page Access Token.

```
GET {page-id}/insights?metric=page_post_engagements&period=day
```
> Verifies `read_insights`. Note: `page_impressions` is deprecated in v25 — use `page_post_engagements` or `page_fans` instead.

```
POST {page-id}/subscribed_apps?subscribed_fields=feed
```
> Verifies `pages_manage_metadata`. Empty POST body.

```
GET {page-id}/feed
```
> Verifies `pages_read_user_content`. Returns post IDs used below.

```
POST {post-id}/comments
Body: { "message": "Test comment for app review" }
```
> Verifies `pages_manage_engagement` (comment creation).

```
POST {comment-id}/comments
Body: { "message": "This is a test reply for app review." }
```
> Reply to an existing comment — also covers `pages_manage_engagement`.

**Note:** `pages_read_engagement` and `business_management` are typically satisfied automatically once tested once anywhere in the app (Meta tracks permission use app-wide, not per use-case-checklist).

---

## 3. Instagram Using Facebook API (via linked Facebook Page)

Permissions: `instagram_basic`, `instagram_manage_messages`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`, `email`, `public_profile`, `business_management`

**Token type:** Page Access Token, requests routed through the **Page ID** (not the IG Business Account ID directly — using the IG ID alone often throws `(#3) Application does not have the capability`).

```
GET {page-id}?fields=instagram_business_account
```
> Returns the linked Instagram Business Account ID.

```
GET {ig-business-account-id}?fields=id,username,name,profile_picture_url
```
> Verifies `instagram_basic`.

```
GET {page-id}/conversations?platform=instagram
```
> Lists IG DM conversations. **Must use Page ID**, not IG Business Account ID.

```
GET {conversation-id}?fields=participants
```
> Returns participant IGSID to message.

```
POST {page-id}/messages
Body:
{
  "recipient": { "id": "RECIPIENT_IGSID" },
  "message": { "text": "Hello, this is a test message for app review." }
}
```
> Verifies `instagram_manage_messages`. **Must use Page ID**, not IG Business Account ID, or the same capability error occurs.

```
GET {ig-media-id}/comments
```
> Read comments on an IG post (via Page token).

```
POST {ig-comment-id}/replies
Body: { "message": "This is a test reply for app review." }
```
> Reply to an IG comment via Facebook Page login.

---

## 4. Messenger

Permissions: `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `public_profile`, `instagram_manage_messages`, `pages_show_list`, `instagram_basic`, `email`, `business_management`

**Token type:** Page Access Token (User token for email/public_profile/pages_show_list)

```
GET {page-id}/conversations
```
> Lists Messenger conversations.

```
GET {conversation-id}?fields=participants
```
> Returns PSID of the user who messaged the Page.

```
POST me/messages
Body:
{
  "recipient": { "id": "RECIPIENT_PSID" },
  "message": { "text": "Hello, this is a test message for app review." }
}
```
> Verifies `pages_messaging`. Recipient must have messaged the Page first (24-hour window) or use a message tag.

```
POST {page-id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks
```
> Verifies `pages_manage_metadata` for Messenger context.

---

## 5. Instagram Using Instagram API (Instagram Login)

Permissions: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_insights`, `instagram_business_manage_messages`, `instagram_manage_engagement`, `instagram_manage_contents`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `instagram_manage_messages`, `instagram_basic`

**Token type:** Instagram User Access Token (Graph API Explorer → "Get Instagram User Access Token"). Requests go to `graph.instagram.com` (Explorer: select Instagram domain).

```
GET me?fields=id,username,account_type
```
> Verifies `instagram_business_basic` / `instagram_basic`.

**Publish a post (2-step):**
```
POST {ig-user-id}/media
Body:
{
  "image_url": "https://example.com/image.jpg",
  "caption": "Test post for app review"
}
```
```
POST {ig-user-id}/media_publish
Body: { "creation_id": "CONTAINER_ID_FROM_ABOVE" }
```
> Verifies `instagram_business_content_publish` / `instagram_manage_contents` / `instagram_content_publish`.

```
GET {ig-media-id}/comments
```
> Verifies read access for `instagram_business_manage_comments` / `instagram_manage_comments`.

```
POST {ig-comment-id}/replies
Body: { "message": "This is a test reply for app review." }
```
> Verifies write access for `instagram_business_manage_comments` / `instagram_manage_comments`.

```
POST {ig-comment-id}?hide=true
POST {ig-comment-id}?hide=false
```
> Verifies `instagram_manage_engagement` (hide/unhide comment). Note: direct `/likes` POST on a comment is **not** a valid endpoint (`Tried accessing nonexisting field`).

```
GET {ig-media-id}/insights?metric=reach,likes,comments
```
> Verifies `instagram_business_manage_insights` / `instagram_manage_insights`.

```
GET {ig-user-id}/conversations
```
> Lists IG DM conversations via Instagram Login.

```
GET {conversation-id}?fields=participants
```
> Returns IGSID of recipient.

```
POST {ig-user-id}/messages
Body:
{
  "recipient": { "id": "RECIPIENT_IGSID" },
  "message": { "text": "This is a test message for app review." }
}
```
> Verifies `instagram_business_manage_messages` / `instagram_manage_messages`.

**Note:** `email`, `public_profile`, `pages_show_list` do **not** need separate testing here if already verified under the Facebook/Page checklists — Meta tracks these app-wide, not per checklist.

---

## 6. Threads API

Permissions: `threads_basic`, `threads_content_publish`, `threads_manage_insights`, `threads_read_replies`, `threads_manage_replies`, `threads_delete`

**Token type:** Threads User Access Token (Graph API Explorer → "Get Threads User Access Token"). Requests go to `graph.threads.net`, **API version `v1.0`** (not v25.0).

**Prerequisite:** "Threads API" product must be added to the app in App Dashboard → Products.

```
GET me?fields=id,username,threads_profile_picture_url
```
> Verifies `threads_basic`.

**Publish a thread (2-step):**
```
POST {threads-user-id}/threads
Body:
{
  "media_type": "TEXT",
  "text": "Test post for app review"
}
```
```
POST {threads-user-id}/threads_publish
Body: { "creation_id": "CONTAINER_ID_FROM_ABOVE" }
```
> Verifies `threads_content_publish`.

```
GET {thread-id}/insights?metric=views,likes,replies
```
> Verifies `threads_manage_insights`. Note: `replies` metric returns under key `thread_replies` in response.

```
GET {thread-id}/replies
```
> Verifies `threads_read_replies`.

**Reply to a reply (2-step):**
```
POST {threads-user-id}/threads
Body:
{
  "media_type": "TEXT",
  "text": "This is a test reply for app review",
  "reply_to_id": "REPLY_ID_TO_RESPOND_TO"
}
```
```
POST {threads-user-id}/threads_publish
Body: { "creation_id": "CONTAINER_ID_FROM_ABOVE" }
```
> Verifies `threads_manage_replies`.

```
DELETE {thread-post-id}
```
> Verifies `threads_delete`. Deletes a thread/reply by its ID.

---

## General Notes

- **Facebook/Instagram (via FB API):** always use `v25.0` and `graph.facebook.com`.
- **Instagram (via Instagram Login):** use `graph.instagram.com`, version `v25.0`. In Graph API Explorer, select the **Instagram** domain toggle, or the request auto-routes correctly once an Instagram User Access Token is active.
- **Threads:** use `graph.threads.net`, version **`v1.0`** — this is different from FB/IG versioning.
- When a call to an Instagram Business Account ID directly returns `(#3) Application does not have the capability to make this API call`, retry the same call using the **linked Facebook Page ID** instead (applies to `/conversations` and `/messages` when using Page-based Instagram messaging).
- Permissions like `email`, `public_profile`, `pages_show_list`, `pages_read_engagement`, and `business_management` are validated **app-wide** — once tested successfully in any one checklist, they don't need to be repeated in every use-case section, though re-running them under each is harmless if you want fresh test-call timestamps.

---

## Quick Reference — Step-by-Step Per Call

Base URL shown once per platform (all calls in that section pass through it). Each action broken into Step 1 / Step 2 exactly as tested — Method + Body where applicable.

---

### 1. WhatsApp
**Base URL:** `https://graph.facebook.com/v25.0/`

**Send message**
- Step 1
  - Method: `POST`
  - Path: `{phone-number-id}/messages`
  - Body:
    ```json
    {
      "messaging_product": "whatsapp",
      "to": "RECIPIENT_PHONE_NUMBER",
      "type": "template",
      "template": {
        "name": "hello_world",
        "language": { "code": "en_US" }
      }
    }
    ```

**Capture message received**
- Step 1
  - Method: N/A — event-driven via **Webhook**
  - Setup: App Dashboard → WhatsApp → Configuration → Webhooks → subscribe to field `messages` → use "Test" button to simulate an inbound message to your callback URL.

---

### 2. Facebook (Page)
**Base URL:** `https://graph.facebook.com/v25.0/`

**Post**
- Step 1
  - Method: `POST`
  - Path: `{page-id}/feed`
  - Body:
    ```json
    { "message": "Test post for app review" }
    ```

**Check comment**
- Step 1
  - Method: `GET`
  - Path: `{post-id}/comments`
  - Body: —

**Reply comment**
- Step 1
  - Method: `POST`
  - Path: `{comment-id}/comments`
  - Body:
    ```json
    { "message": "Test reply for app review" }
    ```

**Check DM**
- Step 1
  - Method: `GET`
  - Path: `{page-id}/conversations`
  - Body: —
- Step 2
  - Method: `GET`
  - Path: `{conversation-id}?fields=participants`
  - Body: —

**Reply DM**
- Step 1
  - Method: `POST`
  - Path: `me/messages`
  - Body:
    ```json
    {
      "recipient": { "id": "RECIPIENT_PSID" },
      "message": { "text": "Test message for app review" }
    }
    ```

**Get post insights**
- Step 1
  - Method: `GET`
  - Path: `{post-id}/insights?metric=post_impressions,post_engaged_users`
  - Body: —

**Get Page insights**
- Step 1
  - Method: `GET`
  - Path: `{page-id}/insights?metric=page_post_engagements&period=day`
  - Body: —

---

### 3. Instagram
**Base URL:** `https://graph.instagram.com/v25.0/`

**Post**
- Step 1
  - Method: `POST`
  - Path: `{ig-user-id}/media`
  - Body:
    ```json
    {
      "image_url": "https://example.com/image.jpg",
      "caption": "Test post for app review"
    }
    ```
- Step 2
  - Method: `POST`
  - Path: `{ig-user-id}/media_publish`
  - Body:
    ```json
    { "creation_id": "CONTAINER_ID_FROM_STEP_1" }
    ```

**Check comment**
- Step 1
  - Method: `GET`
  - Path: `{ig-media-id}/comments`
  - Body: —

**Reply comment**
- Step 1
  - Method: `POST`
  - Path: `{ig-comment-id}/replies`
  - Body:
    ```json
    { "message": "Test reply for app review" }
    ```

**Check DM**
- Step 1
  - Method: `GET`
  - Path: `{ig-user-id}/conversations`
  - Body: —
- Step 2
  - Method: `GET`
  - Path: `{conversation-id}?fields=participants`
  - Body: —

**Reply DM**
- Step 1
  - Method: `POST`
  - Path: `{ig-user-id}/messages`
  - Body:
    ```json
    {
      "recipient": { "id": "RECIPIENT_IGSID" },
      "message": { "text": "Test message for app review" }
    }
    ```

**Get post insights**
- Step 1
  - Method: `GET`
  - Path: `{ig-media-id}/insights?metric=reach,likes,comments`
  - Body: —

**Get Page (account) insights**
- Step 1
  - Method: `GET`
  - Path: `{ig-user-id}/insights?metric=reach,profile_views&period=day`
  - Body: —

---

### 4. Threads
**Base URL:** `https://graph.threads.net/v1.0/`

**Post**
- Step 1
  - Method: `POST`
  - Path: `{threads-user-id}/threads`
  - Body:
    ```json
    { "media_type": "TEXT", "text": "Test post for app review" }
    ```
- Step 2
  - Method: `POST`
  - Path: `{threads-user-id}/threads_publish`
  - Body:
    ```json
    { "creation_id": "CONTAINER_ID_FROM_STEP_1" }
    ```

**Check comment (reply)**
- Step 1
  - Method: `GET`
  - Path: `{thread-id}/replies`
  - Body: —

**Reply comment**
- Step 1
  - Method: `POST`
  - Path: `{threads-user-id}/threads`
  - Body:
    ```json
    {
      "media_type": "TEXT",
      "text": "Test reply for app review",
      "reply_to_id": "REPLY_ID_TO_RESPOND_TO"
    }
    ```
- Step 2
  - Method: `POST`
  - Path: `{threads-user-id}/threads_publish`
  - Body:
    ```json
    { "creation_id": "CONTAINER_ID_FROM_STEP_1" }
    ```
