# AI Chat Integration with NVIDIA NIM

This document explains how to use the new AI Chat endpoints powered by NVIDIA's NIM API.

## Setup

1. **Get NVIDIA API Key**
   - Go to https://build.nvidia.com/
   - Create a free account
   - Get your API key from the dashboard

2. **Add to .env**
   ```bash
   NVIDIA_API_KEY=nvapi-your_key_here
   ```

3. **That's it!** The AI Chat endpoints are now available.

## API Endpoints

### 1. List Available Models
```bash
GET /api/ai/models
```

**Response:**
```json
{
  "models": ["meta/llama-3.1-70b-instruct", "moonshotai/kimi-k2.6", ...],
  "by_provider": {
    "meta": ["meta/llama-3.1-70b-instruct", ...],
    "moonshotai": ["moonshotai/kimi-k2.6"],
    ...
  }
}
```

### 2. Send Chat Message
```bash
POST /api/ai/chat
Content-Type: application/json

{
  "messages": [
    {"role": "user", "content": "What is the capital of France?"}
  ],
  "model": "meta/llama-3.1-70b-instruct",
  "temperature": 0.7,
  "max_tokens": 2048,
  "stream": false
}
```

**Response (non-streaming):**
```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris..."
      }
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20
  }
}
```

### 3. Streaming Chat (Server-Sent Events)
```bash
POST /api/ai/chat
Content-Type: application/json

{
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Explain quantum computing"}
  ],
  "model": "meta/llama-3.3-70b-instruct",
  "stream": true
}
```

Response will stream as SSE (Server-Sent Events):
```
data: {"choices":[{"delta":{"content":" Quantum"}}]}
data: {"choices":[{"delta":{"content":" computing"}}]}
...
data: [DONE]
```

## Available Models

### Meta (Llama)
- `meta/llama-3.1-70b-instruct` - Largest, most capable (default)
- `meta/llama-3.1-8b-instruct` - Fast, smaller
- `meta/llama-3.3-70b-instruct` - Latest

### Mistral
- `mistralai/mistral-large-3-675b-instruct-2512` - Most capable
- `mistralai/mistral-small-4-119b-2603` - Fast
- `mistralai/mixtral-8x7b-instruct-v0.1` - Mixture of Experts

### DeepSeek
- `deepseek-ai/deepseek-v4-pro` - More capable
- `deepseek-ai/deepseek-v4-flash` - Faster

### Moonshot (Kimi)
- `moonshotai/kimi-k2.6` - Chinese/multilingual

### Abacus
- `abacusai/dracarys-llama-3.1-70b-instruct` - Specialized

## JavaScript Example

```javascript
// List models
const models = await fetch('/api/ai/models').then(r => r.json());
console.log('Available models:', models.models);

// Send message
const response = await fetch('/api/ai/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [
      { role: 'user', content: 'Write a short poem about AI' }
    ],
    model: 'meta/llama-3.1-70b-instruct',
    temperature: 0.8,
    max_tokens: 500,
    stream: false
  })
});

const data = await response.json();
console.log('Response:', data.choices[0].message.content);

// Streaming example
const streamResponse = await fetch('/api/ai/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'Hello!' }],
    model: 'meta/llama-3.1-70b-instruct',
    stream: true
  })
});

const reader = streamResponse.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = decoder.decode(value);
  console.log('Stream chunk:', text);
}
```

## Python Example

```python
import requests
import json

API_BASE = 'http://localhost:3000'

# Get available models
response = requests.get(f'{API_BASE}/api/ai/models')
models = response.json()
print('Models:', models['models'])

# Send chat message
chat_response = requests.post(
  f'{API_BASE}/api/ai/chat',
  headers={'Content-Type': 'application/json'},
  json={
    'messages': [
      {'role': 'user', 'content': 'What is machine learning?'}
    ],
    'model': 'meta/llama-3.1-70b-instruct',
    'temperature': 0.7,
    'max_tokens': 2048,
    'stream': False
  }
)

result = chat_response.json()
print('Response:', result['choices'][0]['message']['content'])

# Streaming
stream_response = requests.post(
  f'{API_BASE}/api/ai/chat',
  headers={'Content-Type': 'application/json'},
  json={
    'messages': [{'role': 'user', 'content': 'Hello!'}],
    'model': 'meta/llama-3.1-70b-instruct',
    'stream': True
  },
  stream=True
)

for line in stream_response.iter_lines():
  if line:
    print('Stream:', line.decode('utf-8'))
```

## Integration with WhatsApp

You can integrate AI responses into your WhatsApp messaging by:

1. Process incoming messages from WhatsApp
2. Send to `/api/ai/chat` endpoint
3. Return AI response via WhatsApp API

Example:
```javascript
// When WhatsApp message received
async function handleWhatsAppMessage(phone, messageText) {
  // Get AI response
  const aiResponse = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: messageText }],
      model: 'meta/llama-3.1-70b-instruct',
      stream: false
    })
  }).then(r => r.json());

  const reply = aiResponse.choices[0].message.content;
  
  // Send reply back via WhatsApp
  await sendWhatsAppMessage(phone, reply);
}
```

## Costs & Rate Limits

- NVIDIA NIM is **free tier available** (40 requests/minute per model)
- Paid tiers available for higher limits
- Check https://build.nvidia.com/ for pricing

## Troubleshooting

**Error: NVIDIA_API_KEY not configured**
- Make sure `NVIDIA_API_KEY` is set in `.env`
- Restart the server after updating .env

**Error: Model not allowed**
- The model must be in the ALLOWED_MODELS list in `src/routes/ai-chat.js`
- Add new models to that list if needed

**Rate limit exceeded**
- Free tier has 40 requests/min per model
- Wait or upgrade your plan

## No More Aider!

You now have a **proper, production-ready AI integration** without any CLI tools or external dependencies. Just use the REST API endpoints!
