const mcData = require("minecraft-data")("1.21.11");
const fs = require("fs");
const yaml = require("yaml");
const { OpenAI } = require("openai");
require("dotenv").config();
const logger = require("./logger");

const items = mcData.items;
const recipes = mcData.recipes;
const effects = mcData.effects || {};
const enchantments = mcData.enchantments || {};

// Diamond relative price
const BASE_DIAMOND_PRICE = 200;

function getDiamondId() {
  const diamond = Object.values(items).find((i) => i.name === "diamond");
  return diamond ? diamond.id : null;
}

const diamondId = getDiamondId();

// Map to store calculated base recipe costs
const recipeCosts = new Map();

// Helper to calculate recipe cost recursively
function getRecipeCost(itemId, depth = 0) {
  if (depth > 10) return null; // prevent infinite loops
  if (itemId === diamondId) return BASE_DIAMOND_PRICE;
  if (recipeCosts.has(itemId)) return recipeCosts.get(itemId);

  const itemRecipes = recipes[itemId];
  if (!itemRecipes || itemRecipes.length === 0) {
    return null; // No recipe, base item
  }

  // Find the cheapest recipe
  let minCost = Infinity;
  for (const recipe of itemRecipes) {
    let cost = 0;
    let valid = true;

    if (recipe.ingredients) {
      // shaped or shapeless
      for (const ingredient of recipe.ingredients) {
        if (!ingredient || ingredient.length === 0) continue;
        // ingredients can be arrays (any of the items)
        const id = Array.isArray(ingredient) ? ingredient[0] : ingredient;
        const ingCost = getRecipeCost(id, depth + 1);
        if (ingCost === null) {
          valid = false;
          break;
        }
        cost += ingCost;
      }
    } else if (recipe.inShape) {
      // shaped recipe matrix
      for (const row of recipe.inShape) {
        for (const ingredient of row) {
          if (!ingredient || ingredient.length === 0) continue;
          const id = Array.isArray(ingredient) ? ingredient[0] : ingredient;
          const ingCost = getRecipeCost(id, depth + 1);
          if (ingCost === null) {
            valid = false;
            break;
          }
          cost += ingCost;
        }
      }
    }

    if (valid && cost < minCost) {
      minCost = cost / (recipe.result.count || 1);
    }
  }

  const finalCost = minCost === Infinity ? null : minCost;
  recipeCosts.set(itemId, finalCost);
  return finalCost;
}

async function runAIValidation(itemDataChunk, chunkNum, totalChunks) {
  // Support OpenAI, Ollama (local), and Ollama Cloud
  const isOllamaCloud = process.env.OLLAMA_API_KEY && !process.env.OPENAI_API_KEY;

  const prompt = `You are an expert Minecraft economy balancer.
I have a list of Minecraft items with their base recipe costs (relative to a Diamond = $200).
Some items cannot be crafted and have "null" as their base price.
Some items are generic variants like potions, enchanted books, and tipped arrows.

Your task:
1. Estimate a fair "Price" for each item based on its Base Recipe Cost, Rarity Modifier, and Utility Modifier.
2. If Base Cost is null, you MUST estimate a fair market price from scratch based on its rarity and utility. (e.g., Nether Star, Elytra, Dirt).
3. For generic items (marked with a "type" field), price them appropriately:
   - Basic potions (Speed, Haste, etc.) should generally cost less than rare effects (Invisibility, Regeneration)
   - IMPORTANT: Extended and Upgraded variants exist for POTION, SPLASH_POTION, LINGERING_POTION, and TIPPED_ARROW types
   - Extended variants should cost more than normal variants (e.g., POTION:SPEED < POTION:SPEED:EXTENDED)
   - Upgraded/Amplified variants should cost the most for each type (e.g., POTION:SPEED:UPGRADED is highest)
   - SPLASH_POTION variants should be ~25-50% more expensive than equivalent POTION variants
   - LINGERING_POTION variants should be ~80-120% more expensive than equivalent POTION variants
   - TIPPED_ARROW variants should be ~40-60% cheaper than equivalent POTION variants (but still follow the extended/upgraded tiers)
   - Example pricing tiers for SPEED effect:
     * POTION:SPEED: 60 → POTION:SPEED:EXTENDED: 80 → POTION:SPEED:UPGRADED: 110
     * SPLASH_POTION:SPEED: 75 → SPLASH_POTION:SPEED:EXTENDED: 100 → SPLASH_POTION:SPEED:UPGRADED: 140
     * LINGERING_POTION:SPEED: 180 → LINGERING_POTION:SPEED:EXTENDED: 240 → LINGERING_POTION:SPEED:UPGRADED: 330
     * TIPPED_ARROW:SPEED: 30 → TIPPED_ARROW:SPEED:EXTENDED: 40 → TIPPED_ARROW:SPEED:UPGRADED: 55
   - Enchanted books: Higher levels and rarer enchantments should be more expensive
   - Treasure-only enchantments should be significantly more expensive
4. Base Price = (Recipe Cost * Rarity Modifier * Utility Modifier). If no recipe cost, just estimate a fair price directly.
5. Output ONLY valid JSON in this exact format. For regular items use "minecraft:" prefix, for generic items use the item name directly:
{
  "minecraft:item_name": 150.50,
  "potion:speed": 60.00,
  "potion:speed:extended": 80.00,
  "potion:speed:upgraded": 110.00,
  "splash_potion:speed": 75.00,
  "splash_potion:speed:extended": 100.00,
  "splash_potion:speed:upgraded": 140.00,
  "lingering_potion:strength": 180.00,
  "lingering_potion:strength:extended": 240.00,
  "lingering_potion:strength:upgraded": 330.00,
  "tipped_arrow:speed": 30.00,
  "tipped_arrow:speed:extended": 40.00,
  "tipped_arrow:speed:upgraded": 55.00,
  "enchanted_book:sharpness:5": 1500.00
}
Ensure the keys match the item names exactly as provided. Do not include markdown formatting like \`\`\`json.

Items to process (${itemDataChunk.length} items):
${JSON.stringify(itemDataChunk, null, 2)}`;

  try {
    logger.chunk(chunkNum, totalChunks);
    logger.startSpinner(`Streaming response from ${process.env.MODEL || "gpt-3.5-turbo"}...`);

    let fullResponse = "";
    let tokenCount = 0;

    if (isOllamaCloud) {
      // Use native Ollama API for Ollama Cloud
      logger.stopSpinner(`Streaming started for chunk ${chunkNum}/${totalChunks}`);
      logger.modelOutput("Model Output", "");

      const response = await fetch("https://ollama.com/api/chat", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OLLAMA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama Cloud API error: ${response.status} ${errorText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.trim()) {
            try {
              const json = JSON.parse(line);
              if (json.message?.content) {
                fullResponse += json.message.content;
                logger.streaming(json.message.content);
                tokenCount++;
              }
            } catch (e) {
              // Skip non-JSON lines
            }
          }
        }
      }
    } else {
      // Use OpenAI-compatible API for OpenAI and local Ollama
      const apiKey = process.env.OPENAI_API_KEY || "ollama";
      const baseURL = process.env.OPENAI_BASE_URL;

      const openai = new OpenAI({
        apiKey: apiKey,
        baseURL: baseURL,
      });

      const stream = await openai.chat.completions.create({
        model: process.env.MODEL || "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        disable_thinking: true,
        stream: true,
      });

      logger.stopSpinner(`Streaming started for chunk ${chunkNum}/${totalChunks}`);
      logger.modelOutput("Model Output", "");

      for await (const event of stream) {
        const delta = event.choices[0]?.delta;
        if (delta?.content) {
          fullResponse += delta.content;
          logger.streaming(delta.content);
          tokenCount++;
        }
      }
    }

    logger.streamingDone();

    // Clean and parse response
    const jsonStr = fullResponse
      .trim()
      .replace(/^```json/i, "")
      .replace(/```$/i, "")
      .trim();

    const parsed = JSON.parse(jsonStr);
    logger.jsonParsed(parsed, Object.keys(parsed).length);
    logger.stats(`Tokens generated`, tokenCount);

    return parsed;
  } catch (err) {
    logger.error(`AI Error in chunk ${chunkNum}: ${err.message}`);
    logger.warn("Returning empty object for this chunk");
    return {};
  }
}

function generateGenericItems() {
  const genericItems = [];

  // Helper to convert camelCase to UPPER_SNAKE_CASE
  const toSnakeCase = (str) => {
    return str.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
  };

  // Generate potion variants
  Object.values(effects).forEach((effect) => {
    const effectName = toSnakeCase(effect.name);
    
    // Normal potion
    genericItems.push({
      name: `potion:${effect.name}`,
      baseCost: null, // Will be estimated by AI
      displayName: `Potion of ${effect.displayName}`,
      type: "POTION",
      format: `POTION:${effectName}`,
    });

    // Extended (if applicable - most potions can be extended)
    if (!["InstantHealth", "InstantDamage"].includes(effect.name)) {
      genericItems.push({
        name: `potion:${effect.name}:extended`,
        baseCost: null,
        displayName: `Potion of ${effect.displayName} (Extended)`,
        type: "POTION",
        format: `POTION:${effectName}:EXTENDED`,
      });

      // Upgraded/Amplified (for applicable potions)
      if (!["Blindness", "Nausea", "Wither"].includes(effect.name)) {
        genericItems.push({
          name: `potion:${effect.name}:upgraded`,
          baseCost: null,
          displayName: `Potion of ${effect.displayName} II`,
          type: "POTION",
          format: `POTION:${effectName}:UPGRADED`,
        });
      }
    }

    // Splash potion (normal, extended, upgraded)
    genericItems.push({
      name: `splash_potion:${effect.name}`,
      baseCost: null,
      displayName: `Splash Potion of ${effect.displayName}`,
      type: "SPLASH_POTION",
      format: `SPLASH_POTION:${effectName}`,
    });

    // Splash extended (if applicable)
    if (!["InstantHealth", "InstantDamage"].includes(effect.name)) {
      genericItems.push({
        name: `splash_potion:${effect.name}:extended`,
        baseCost: null,
        displayName: `Splash Potion of ${effect.displayName} (Extended)`,
        type: "SPLASH_POTION",
        format: `SPLASH_POTION:${effectName}:EXTENDED`,
      });

      // Splash upgraded (for applicable potions)
      if (!["Blindness", "Nausea", "Wither"].includes(effect.name)) {
        genericItems.push({
          name: `splash_potion:${effect.name}:upgraded`,
          baseCost: null,
          displayName: `Splash Potion of ${effect.displayName} II`,
          type: "SPLASH_POTION",
          format: `SPLASH_POTION:${effectName}:UPGRADED`,
        });
      }
    }

    // Lingering potion (normal, extended, upgraded)
    genericItems.push({
      name: `lingering_potion:${effect.name}`,
      baseCost: null,
      displayName: `Lingering Potion of ${effect.displayName}`,
      type: "LINGERING_POTION",
      format: `LINGERING_POTION:${effectName}`,
    });

    // Lingering extended (if applicable)
    if (!["InstantHealth", "InstantDamage"].includes(effect.name)) {
      genericItems.push({
        name: `lingering_potion:${effect.name}:extended`,
        baseCost: null,
        displayName: `Lingering Potion of ${effect.displayName} (Extended)`,
        type: "LINGERING_POTION",
        format: `LINGERING_POTION:${effectName}:EXTENDED`,
      });

      // Lingering upgraded (for applicable potions)
      if (!["Blindness", "Nausea", "Wither"].includes(effect.name)) {
        genericItems.push({
          name: `lingering_potion:${effect.name}:upgraded`,
          baseCost: null,
          displayName: `Lingering Potion of ${effect.displayName} II`,
          type: "LINGERING_POTION",
          format: `LINGERING_POTION:${effectName}:UPGRADED`,
        });
      }
    }

    // Tipped arrow (normal, extended, upgraded)
    genericItems.push({
      name: `tipped_arrow:${effect.name}`,
      baseCost: null,
      displayName: `Arrow of ${effect.displayName}`,
      type: "TIPPED_ARROW",
      format: `TIPPED_ARROW:${effectName}`,
    });

    // Tipped arrow extended (if applicable)
    if (!["InstantHealth", "InstantDamage"].includes(effect.name)) {
      genericItems.push({
        name: `tipped_arrow:${effect.name}:extended`,
        baseCost: null,
        displayName: `Arrow of ${effect.displayName} (Extended)`,
        type: "TIPPED_ARROW",
        format: `TIPPED_ARROW:${effectName}:EXTENDED`,
      });

      // Tipped arrow upgraded (for applicable potions)
      if (!["Blindness", "Nausea", "Wither"].includes(effect.name)) {
        genericItems.push({
          name: `tipped_arrow:${effect.name}:upgraded`,
          baseCost: null,
          displayName: `Arrow of ${effect.displayName} II`,
          type: "TIPPED_ARROW",
          format: `TIPPED_ARROW:${effectName}:UPGRADED`,
        });
      }
    }
  });

  // Generate enchanted book variants
  Object.values(enchantments).forEach((enchant) => {
    const enchantName = toSnakeCase(enchant.name);

    for (let level = 1; level <= enchant.maxLevel; level++) {
      genericItems.push({
        name: `enchanted_book:${enchant.name}:${level}`,
        baseCost: null,
        displayName: `Enchanted Book of ${enchant.displayName} ${level}`,
        type: "ENCHANTED_BOOK",
        format: `ENCHANTED_BOOK:${enchantName}:${level}`,
      });
    }
  });

  return genericItems;
}

async function main() {
  logger.setLogFile("price-generation.log");
  logger.header("Minecraft Price Generator");
  
  logger.startSpinner("Gathering items and calculating base costs...");
  const itemData = [];

  for (const item of Object.values(items)) {
    const cost = getRecipeCost(item.id);
    itemData.push({
      name: item.name,
      baseCost: cost,
      displayName: item.displayName,
    });
  }

  // Add generic items (potions, enchanted books, tipped arrows)
  logger.stopSpinner(`Gathered ${itemData.length} items`, true);
  logger.startSpinner("Generating generic item variants...");
  
  const genericItems = generateGenericItems();
  itemData.push(...genericItems);
  
  logger.stopSpinner(`Added ${genericItems.length} generic items (potions, enchanted books, tipped arrows)`, true);
  logger.stats("Total Items (including variants)", itemData.length);
  logger.stats("Base Items", itemData.filter(i => !i.type).length);
  logger.stats("Generic Variants", itemData.filter(i => i.type).length);

  // We'll chunk the data so the AI doesn't get overwhelmed
  const finalPrices = {};
  const CHUNK_SIZE = 50;
  const totalChunks = Math.ceil(itemData.length / CHUNK_SIZE);

  logger.header(`Processing ${totalChunks} chunks with AI`);

  for (let i = 0; i < itemData.length; i += CHUNK_SIZE) {
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    const chunk = itemData.slice(i, i + CHUNK_SIZE);
    
    const aiResult = await runAIValidation(chunk, chunkNum, totalChunks);

    // Merge results
    for (const [key, value] of Object.entries(aiResult)) {
      // For generic items, use the format field directly
      // For regular items, convert minecraft:name to BUKKIT_NAME
      let finalKey;
      
      // Try to find a matching item in the chunk
      let matchedItem = null;
      
      // Direct match on name
      matchedItem = chunk.find(item => 
        item.name === key || 
        key === `minecraft:${item.name}` ||
        key.replace("minecraft:", "").toLowerCase() === item.name.toLowerCase()
      );
      
      // If not found, try partial match for generic items
      if (!matchedItem) {
        for (const item of chunk) {
          if (item.type) {
            // Generic item - try matching various key formats
            const keyLower = key.toLowerCase().replace("minecraft:", "");
            const nameLower = item.name.toLowerCase();
            const formatKey = item.format.toLowerCase().replace(/:/g, "_");
            
            if (keyLower === nameLower || 
                keyLower === item.format.toLowerCase() ||
                keyLower.replace(/:/g, "_") === formatKey) {
              matchedItem = item;
              break;
            }
          }
        }
      }

      if (matchedItem && matchedItem.format) {
        // This is a generic item - use the standardized format
        finalKey = matchedItem.format;
      } else {
        // This is a regular item - convert to uppercase
        finalKey = key.replace("minecraft:", "").toUpperCase();
      }
      
      finalPrices[finalKey] = value;
    }
  }

  logger.header("Finalizing");
  logger.startSpinner("Generating price.yml...");

  // Create YAML
  const yamlStr = yaml.stringify(finalPrices);
  fs.writeFileSync("price.yml", yamlStr, "utf8");

  logger.stopSpinner("Saved to price.yml!", true);
  logger.stats("Total Prices Generated", Object.keys(finalPrices).length);
  logger.success("Price generation complete!");
}

main().catch(console.error);
