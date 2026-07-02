#!/usr/bin/env node

/**
 * CLI Tool for NVIDIA NIM AI Chat
 * Usage: node ai-cli.js "Your question here"
 * Or: node ai-cli.js --model meta/llama-3.1-8b-instruct "Your question"
 * Or: node ai-cli.js --interactive (for multi-turn chat)
 */

const readline = require('readline');
const API_BASE = process.env.API_BASE || 'http://localhost:3000';

// Default model
let currentModel = 'meta/llama-3.1-70b-instruct';

const args = process.argv.slice(2);

// Parse arguments
let isInteractive = false;
let userMessage = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--model' && args[i + 1]) {
    currentModel = args[i + 1];
    i++;
  } else if (args[i] === '--interactive') {
    isInteractive = true;
  } else if (!args[i].startsWith('--')) {
    userMessage = args[i];
  }
}

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

async function sendMessage(message, stream = true) {
  try {
    const response = await fetch(`${API_BASE}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: message }],
        model: currentModel,
        temperature: 0.7,
        max_tokens: 2048,
        stream: stream,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error(
        `${colors.red}Error: ${error.error}${colors.reset}`
      );
      return;
    }

    if (stream && response.body) {
      // Handle streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      process.stdout.write(`${colors.cyan}Assistant: ${colors.reset}`);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim();
            if (jsonStr === '[DONE]') continue;

            try {
              const data = JSON.parse(jsonStr);
              const content = data.choices?.[0]?.delta?.content;
              if (content) process.stdout.write(content);
            } catch (_) {
              // Ignore parse errors
            }
          }
        }

        buffer = lines[lines.length - 1];
      }

      console.log(`\n`);
    } else {
      // Handle non-streaming response
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        console.log(`${colors.cyan}Assistant: ${colors.reset}${content}\n`);
      }
    }
  } catch (err) {
    console.error(
      `${colors.red}Connection error: ${err.message}${colors.reset}`
    );
    console.error(
      `${colors.yellow}Make sure the server is running at ${API_BASE}${colors.reset}`
    );
  }
}

async function listModels() {
  try {
    const response = await fetch(`${API_BASE}/api/ai/models`);
    const data = await response.json();
    
    console.log(`${colors.bright}${colors.blue}Available Models:${colors.reset}\n`);
    Object.entries(data.by_provider).forEach(([provider, models]) => {
      console.log(`${colors.green}${provider}:${colors.reset}`);
      models.forEach(m => console.log(`  - ${m}`));
    });
    console.log();
  } catch (err) {
    console.error(`${colors.red}Failed to fetch models: ${err.message}${colors.reset}`);
  }
}

async function interactiveMode() {
  console.log(`${colors.bright}${colors.cyan}AI Chat (NVIDIA NIM)${colors.reset}`);
  console.log(`${colors.dim}Model: ${currentModel}${colors.reset}`);
  console.log(`${colors.dim}Type 'exit' to quit, 'models' to list models, 'model <name>' to switch${colors.reset}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question(`${colors.green}You: ${colors.reset}`, async (input) => {
      input = input.trim();

      if (input.toLowerCase() === 'exit') {
        console.log('Goodbye!');
        rl.close();
        return;
      }

      if (input.toLowerCase() === 'models') {
        await listModels();
        prompt();
        return;
      }

      if (input.toLowerCase().startsWith('model ')) {
        const newModel = input.slice(6).trim();
        currentModel = newModel;
        console.log(`${colors.yellow}Switched to: ${currentModel}${colors.reset}\n`);
        prompt();
        return;
      }

      if (!input) {
        prompt();
        return;
      }

      await sendMessage(input, true);
      prompt();
    });
  };

  prompt();
}

async function main() {
  if (isInteractive) {
    await interactiveMode();
  } else if (userMessage) {
    console.log(`${colors.green}You: ${colors.reset}${userMessage}`);
    console.log(`${colors.dim}Model: ${currentModel}${colors.reset}\n`);
    await sendMessage(userMessage, true);
  } else {
    console.log(`${colors.bright}${colors.cyan}AI Chat CLI${colors.reset}\n`);
    console.log('Usage:');
    console.log(`  ${colors.green}npx node ai-cli.js${colors.reset} "Your question here"`);
    console.log(`  ${colors.green}npx node ai-cli.js${colors.reset} --model meta/llama-3.1-8b-instruct "Your question"`);
    console.log(`  ${colors.green}npx node ai-cli.js${colors.reset} --interactive`);
    console.log();

    await listModels();

    console.log(`${colors.bright}${colors.yellow}Quick Start:${colors.reset}`);
    console.log(`  ${colors.dim}# Ask a quick question${colors.reset}`);
    console.log(`  node ai-cli.js "What is machine learning?"\n`);
    console.log(`  ${colors.dim}# Switch model${colors.reset}`);
    console.log(`  node ai-cli.js --model meta/llama-3.1-8b-instruct "Quick question"\n`);
    console.log(`  ${colors.dim}# Interactive multi-turn chat${colors.reset}`);
    console.log(`  node ai-cli.js --interactive\n`);
  }
}

main();
