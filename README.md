# Minecraft Price Generator

A robust Node.js application that automatically generates a Minecraft economy `price.yml` using `minecraft-data` (Version 26.1.2) and an AI model (via OpenAI API or Ollama) to logically price items.

## Features
- **Recipe Engine:** Recursively parses recipe crafting matrices to deduce base item costs.
- **Relative Pricing:** Bases everything off `DIAMOND = $200` as the standard anchor.
- **AI Economy Balancer:** Calculates Rarity Modifiers, Utility Modifiers, and creates prices for uncraftable items (like dirt, nether stars) based on your formula: `Base Price = (Recipe Cost × Rarity Modifier × Utility Modifier)`.
- **Standard Compliant:** Exports to `price.yml` perfectly adhering to the `MATERIAL_NAME: PRICE` standard detailed in `price-file-standard.md`.

## Setup Instructions

1. **Install Dependencies** (Already done for you):
    ```bash
    npm install
    ```

2. **Configure AI (.env)**:
    Open the `.env` file and configure your AI settings.

    **If using OpenAI:**
    ```env
    OPENAI_API_KEY=sk-your-openai-key
    OPENAI_BASE_URL=https://api.openai.com/v1
    MODEL=gpt-4o # Or gpt-3.5-turbo
    ```

    **If using Ollama (Local AI):**
    ```env
    OPENAI_BASE_URL=http://localhost:11434/v1
    MODEL=llama3 # Or whichever model you have pulled
    ```

    **If using Ollama Cloud:**
    ```env
    OLLAMA_API_KEY=your-api-key-from-ollama.com
    MODEL=gpt-oss:120b # Or any model from https://ollama.com/search?c=cloud
    ```
    
    Get your API key from: https://ollama.com/settings/keys

3. **Run the Generator**:
    ```bash
    node index.js
    ```

This will output `price.yml` when complete, adhering to the standard you requested.

## Ollama Cloud Configuration

To use Ollama Cloud models with this generator:

1. Create an account at https://ollama.com
2. Generate an API key at https://ollama.com/settings/keys
3. Check available cloud models at https://ollama.com/search?c=cloud
4. Update `.env`:
   ```env
   OLLAMA_API_KEY=your-api-key
   MODEL=gpt-oss:120b  # or any cloud model
   ```
5. Run `node index.js`

The generator automatically detects Ollama Cloud and uses the native Ollama API with proper authentication.
