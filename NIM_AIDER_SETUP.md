# NIM + Aider Setup Guide

## Prerequisites
- ✅ Aider installed (`aider-chat`)
- ✅ NVIDIA NIM API key
- NIM model access (kimi-k2.6 or other)

## Setup Steps

### 1. Add Your NIM API Key
Edit `.env` and replace `your_nim_api_key_here` with your actual API key:

```bash
NIM_API_KEY=nvapi-xxxxxxxxxxxxx
NIM_API_BASE=https://integrate.api.nvidia.com/v1
NIM_MODEL=moonshot/kimi-k2.6
```

### 2. Verify Installation
```bash
aider --version
```

### 3. Start Aider with NIM

**Option A: Using environment variables**
```bash
export NIM_API_KEY="your_api_key_here"
aider --model-api nim --model moonshot/kimi-k2.6
```

**Option B: Using the config file (recommended)**
```bash
aider --config .aider.conf.yml
```

**Option C: Direct command**
```bash
aider \
  --model-api openai \
  --model moonshot/kimi-k2.6 \
  --api-base https://integrate.api.nvidia.com/v1 \
  --api-key $NIM_API_KEY
```

### 4. Start Coding with Aider
Once aider starts, you can:
- Add files: `/add src/myfile.ts`
- Ask for changes: "Fix the login redirect issue"
- Let aider make modifications to your code

## Example: Using Aider with Your Project
```bash
# Load your .env file
export $(cat .env | xargs)

# Start aider with your repo
aider --config .aider.conf.yml
```

## Troubleshooting

### Connection Issues
```bash
# Test your API key
curl -H "Authorization: Bearer $NIM_API_KEY" \
  https://integrate.api.nvidia.com/v1/models
```

### Model Not Found
- Verify your model name is correct: `moonshot/kimi-k2.6`
- Check that your NIM account has access to the model
- Visit https://build.nvidia.com/ to manage your API keys

### Aider Not Reading Config
```bash
# Force config file
aider --no-auto-commits --config .aider.conf.yml
```

## Available NIM Models
Common NVIDIA models you can use:
- `moonshot/kimi-k2.6` (Kimi 2.6)
- `meta-llama2-70b`
- `meta-llama3-70b-instruct`
- `mistral-large`

Check https://build.nvidia.com/ for available models in your region.

## Tips & Best Practices

1. **Security**: Never commit `.env` with your API key - keep it in `.gitignore`
2. **Cost**: Monitor API usage - NIM charges per token
3. **Commits**: Aider auto-commits changes - review git history
4. **Context**: Use `/add` to add relevant files for better context
5. **Testing**: Enable `auto-test` in config to run tests after changes

## Quick Commands in Aider

- `/add <file>` - Add file to context
- `/drop <file>` - Remove file from context
- `/git diff` - Show git changes
- `/run <command>` - Run shell commands
- `/test` - Run tests
- `quit` - Exit aider

## More Info
- [Aider Docs](https://aider.chat/)
- [NVIDIA NIM Docs](https://docs.nvidia.com/nim/)
- [NIM API Reference](https://docs.api.nvidia.com/)
