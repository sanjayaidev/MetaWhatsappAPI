# Testing Comments & Reply API from Browser Console

## Overview
This guide shows you how to test fetching comments and replying to them directly from your browser's developer console on the dashboard. Supports **Facebook**, **Instagram**, and **Threads**.

## API Endpoints

### 1. GET /api/comments - Fetch Recent Comments
Fetches recent comments from your connected Facebook, Instagram, and Threads accounts.

**Query Parameters:**
- `limit` (optional): Number of comments to fetch (default: 50)
- `platform` (optional): Filter by platform ('facebook', 'instagram', or 'threads')

**Request:**
```javascript
GET /api/comments?limit=50
GET /api/comments?limit=20&platform=facebook
GET /api/comments?platform=threads
```

**Response:**
```json
[
  {
    "id": 123,
    "platform": "facebook",
    "trigger_type": "comment",
    "trigger_text": "Great product!",
    "media_id": "post_123",
    "sender_id": "user_456",
    "account_id": "page_789",
    "automation_id": null,
    "automation_name": null,
    "response_type": null,
    "response_content": null,
    "reply_location": null,
    "success": false,
    "error_message": null,
    "created_at": "2025-01-15T10:30:00Z"
  }
]
```

### 2. POST /api/comments/:id/reply - Reply to a Comment
Sends a reply to a specific comment. Supports Facebook, Instagram, and Threads.

**Request:**
```javascript
POST /api/comments/123/reply
Content-Type: application/json

{
  "message": "Thank you for your feedback!"
}
```

**Response:**
```json
{
  "success": true,
  "reply_id": "comment_987"
}
```

---

## Testing from Browser Console

### Step 1: Open Browser Console
1. Go to your dashboard: `https://your-domain.com/dashboard`
2. Press `F12` or right-click → Inspect → Console tab
3. Make sure you're logged in (check if you have an auth token)

### Step 2: Check Authentication Token
Run this to verify you have a valid token:
```javascript
const token = localStorage.getItem('auth_token');
console.log('Auth token:', token ? '✅ Present' : '❌ Missing');
```

### Step 3: Fetch Recent Comments
Copy and paste this into the console:
```javascript
async function fetchComments(limit = 20, platform = null) {
    const token = localStorage.getItem('auth_token');
    if (!token) {
        console.error('❌ No auth token found. Please log in first.');
        return;
    }
    
    try {
        let url = `/api/comments?limit=${limit}`;
        if (platform) {
            url += `&platform=${platform}`;
        }
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        });
        
        if (response.status === 401) {
            console.error('❌ Unauthorized. Token may be expired.');
            localStorage.removeItem('auth_token');
            window.location.href = '/';
            return;
        }
        
        const data = await response.json();
        console.log(`✅ Fetched ${data.length} comments${platform ? ` from ${platform}` : ''}:`, data);
        console.table(data.map(c => ({
            id: c.id,
            platform: c.platform,
            text: c.trigger_text?.substring(0, 50),
            success: c.success,
            date: new Date(c.created_at).toLocaleString()
        })));
        return data;
    } catch (error) {
        console.error('❌ Error fetching comments:', error);
    }
}

// Run it
await fetchComments();
```

### Step 4: Reply to a Comment
After fetching comments, pick a comment ID and reply to it:
```javascript
async function replyToComment(commentId, message) {
    const token = localStorage.getItem('auth_token');
    if (!token) {
        console.error('❌ No auth token found. Please log in first.');
        return;
    }
    
    try {
        const response = await fetch(`/api/comments/${commentId}/reply`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ message })
        });
        
        if (response.status === 401) {
            console.error('❌ Unauthorized. Token may be expired.');
            localStorage.removeItem('auth_token');
            window.location.href = '/';
            return;
        }
        
        const data = await response.json();
        
        if (response.ok) {
            console.log('✅ Reply sent successfully!', data);
        } else {
            console.error('❌ Failed to send reply:', data);
        }
        
        return data;
    } catch (error) {
        console.error('❌ Error sending reply:', error);
    }
}

// Example usage (replace 123 with actual comment ID):
// await replyToComment(123, 'Thank you for your comment!');
```

### Step 5: Complete Test Workflow
Here's a complete workflow that fetches comments and replies to the first one:
```javascript
async function testCommentsWorkflow() {
    console.log('🧪 Starting comments API test...\n');
    
    // Step 1: Fetch comments
    console.log('📥 Fetching recent comments...');
    const comments = await fetchComments(10);
    
    if (!comments || comments.length === 0) {
        console.log('⚠️  No comments found. Make sure you have:');
        console.log('   1. Connected Facebook/Instagram accounts');
        console.log('   2. Received comments via webhooks');
        return;
    }
    
    // Find an unanswered comment
    const unansweredComment = comments.find(c => !c.success);
    
    if (!unansweredComment) {
        console.log('✅ All comments have been answered!');
        return;
    }
    
    console.log('\n📝 Found unanswered comment:');
    console.log(`   ID: ${unansweredComment.id}`);
    console.log(`   Platform: ${unansweredComment.platform}`);
    console.log(`   Text: "${unansweredComment.trigger_text}"`);
    console.log(`   Date: ${new Date(unansweredComment.created_at).toLocaleString()}`);
    
    // Step 2: Reply to the comment
    console.log('\n📤 Sending reply...');
    const replyMessage = 'Thank you for your feedback! We appreciate your support. 🙏';
    const result = await replyToComment(unansweredComment.id, replyMessage);
    
    if (result?.success) {
        console.log('\n✅ Test completed successfully!');
        console.log(`   Reply ID: ${result.reply_id}`);
    }
}

// Run the complete test
await testCommentsWorkflow();
```

---

## Troubleshooting

### Common Issues

#### 1. "No auth token found"
- **Solution**: Log in to your dashboard first, then try again.

#### 2. "Unauthorized. Token may be expired."
- **Solution**: Your session expired. Refresh the page and log in again.

#### 3. "No comments found"
- **Possible causes**:
  - You haven't connected any Facebook/Instagram accounts yet
  - No comments have been received via webhooks
  - Webhooks aren't configured properly on Meta Developer Platform
  
- **Solution**: 
  1. Go to Connections tab and connect Facebook/Instagram
  2. Ensure webhooks are set up in Meta Developer Platform
  3. Test by commenting on one of your posts

#### 4. "No connected account found for this platform"
- **Solution**: The account that received the comment is no longer connected. Re-connect it in the Connections tab.

#### 5. "Unsupported platform"
- **Note**: Currently only Facebook, Instagram, and Threads are supported for comment replies.

---

## Quick Reference Commands

```javascript
// Fetch 50 comments
await fetchComments(50);

// Fetch only Facebook comments
await fetchComments(50, 'facebook');

// Fetch only Instagram comments
await fetchComments(20, 'instagram');

// Fetch only Threads comments
await fetchComments(20, 'threads');

// Reply to comment #123
await replyToComment(123, 'Thanks for commenting!');

// Run full test workflow
await testCommentsWorkflow();

// Check token status
console.log('Token:', localStorage.getItem('auth_token') ? '✅' : '❌');
```

---

## Notes

- Comments are fetched from the `automation_logs` table
- Only comments from your connected accounts are shown
- Replies are logged as `manual_reply` trigger type
- The API supports Facebook Pages, Instagram Business accounts, and Threads
- Use the `platform` filter to view comments from specific platforms
