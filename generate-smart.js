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

const BASE_DIAMOND_PRICE = 200;
const recipeCosts = new Map();

// ============================================================================
// SMART PRICING SYSTEM - INCREMENTAL & FLEXIBLE
// ============================================================================

async function smartGeneratePrices(mode = "missing") {
  logger.header("Smart Minecraft Price Generator");
  
  // Load existing prices
  let existingPrices = {};
  if (fs.existsSync("price.yml")) {
    logger.startSpinner("Loading existing price.yml...");
    const yamlContent = fs.readFileSync("price.yml", "utf8");
    existingPrices = yaml.parse(yamlContent) || {};
    logger.stopSpinner(`Loaded ${Object.keys(existingPrices).length} existing prices`, true);
  }

  // Gather all items
  logger.startSpinner("Gathering items...");
  const allItems = gatherAllItems();
  logger.stopSpinner(`Gathered ${allItems.length} total items`, true);

  // Determine which items to process
  let itemsToProcess = [];
  
  if (mode === "missing") {
    logger.startSpinner("Identifying missing items...");
    itemsToProcess = allItems.filter(item => !existingPrices[item.format]);
    logger.stopSpinner(`Found ${itemsToProcess.length} missing items`, true);
  } else if (mode === "all") {
    logger.startSpinner("Preparing to regenerate all items...");
    itemsToProcess = allItems;
    existingPrices = {}; // Start fresh
    logger.stopSpinner(`Will regenerate all ${itemsToProcess.length} items`, true);
  } else if (Array.isArray(mode)) {
    // mode is an array of specific item formats to regenerate
    logger.startSpinner(`Preparing to regenerate ${mode.length} specific items...`);
    itemsToProcess = allItems.filter(item => mode.includes(item.format));
    logger.stopSpinner(`Found ${itemsToProcess.length} items to regenerate`, true);
  }

  if (itemsToProcess.length === 0) {
    logger.success("✅ All items already priced! Nothing to do.");
    return existingPrices;
  }

  // Process items in chunks
  logger.header(`Processing ${itemsToProcess.length} items with AI`);
  const CHUNK_SIZE = 50;
  const totalChunks = Math.ceil(itemsToProcess.length / CHUNK_SIZE);

  const newPrices = {};

  for (let i = 0; i < itemsToProcess.length; i += CHUNK_SIZE) {
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    const chunk = itemsToProcess.slice(i, i + CHUNK_SIZE);
    
    const aiResult = await runAIValidation(chunk, chunkNum, totalChunks);

    // Map responses to format
    for (const [key, value] of Object.entries(aiResult)) {
      let matchedItem = null;

      matchedItem = chunk.find(item => 
        item.name === key || 
        key === `minecraft:${item.name}` ||
        key.replace("minecraft:", "").toLowerCase() === item.name.toLowerCase()
      );

      if (!matchedItem) {
        for (const item of chunk) {
          if (item.type) {
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

      let finalKey;
      if (matchedItem && matchedItem.format) {
        finalKey = matchedItem.format;
      } else {
        finalKey = key.replace("minecraft:", "").toUpperCase();
      }

      newPrices[finalKey] = value;
    }
  }

  // Merge with existing prices
  logger.header("Merging Results");
  logger.startSpinner(`Merging ${Object.keys(newPrices).length} new prices with ${Object.keys(existingPrices).length} existing...`);
  
  const finalPrices = { ...existingPrices, ...newPrices };
  
  logger.stopSpinner(`Final total: ${Object.keys(finalPrices).length} priced items`, true);

  // Write to file
  logger.startSpinner("Saving to price.yml...");
  const yamlStr = yaml.stringify(finalPrices);
  fs.writeFileSync("price.yml", yamlStr, "utf8");
  logger.stopSpinner("Saved to price.yml!", true);

  logger.stats("New prices added", Object.keys(newPrices).length);
  logger.stats("Total prices", Object.keys(finalPrices).length);
  logger.success("Done!");

  return finalPrices;
}

function gatherAllItems() {
  const allItems = [];

  // Standard items
  for (const item of Object.values(items)) {
    const cost = getRecipeCost(item.id);
    allItems.push({
      name: item.name,
      format: item.name.toUpperCase(),
      type: null,
      baseCost: cost,
    });
  }

  // Generic items (potions, enchanted books, tipped arrows)
  allItems.push(...generateGenericItems());

  return allItems;
}

function getRecipeCost(itemId, depth = 0) {
  if (depth > 5 || !itemId) return null;
  if (recipeCosts.has(itemId)) return recipeCosts.get(itemId);

  const diamondId = getDiamondId();
  if (itemId === diamondId) return BASE_DIAMOND_PRICE / BASE_DIAMOND_PRICE;

  const recipeList = recipes[itemId] || [];
  let minCost = Infinity;

  for (const recipe of recipeList) {
    let cost = 0;
    let valid = true;

    if (recipe.inGrid) {
      for (const ingredient of recipe.inGrid) {
        if (!ingredient || ingredient.length === 0) continue;
        const id = Array.isArray(ingredient) ? ingredient[0] : ingredient;
        const ingCost = getRecipeCost(id, depth + 1);
        if (ingCost === null) {
          valid = false;
          break;
        }
        cost += ingCost;
      }
    } else if (recipe.inShape) {
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

function getDiamondId() {
  const diamond = Object.values(items).find((i) => i.name === "diamond");
  return diamond ? diamond.id : null;
}

function generateGenericItems() {
  const genericItems = [];

  const toSnakeCase = (str) => {
    return str.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
  };

  // Generate all potion variants
  Object.values(effects).forEach((effect) => {
    const effectName = toSnakeCase(effect.name);
    
    // POTION variants
    genericItems.push({
      name: `potion:${effect.name}`,
      format: `POTION:${effectName}`,
      type: "POTION",
      baseCost: null,
    });

    if (!["InstantHealth", "InstantDamage"].includes(effect.name)) {
      genericItems.push({
        name: `potion:${effect.name}:extended`,
        format: `POTION:${effectName}:EXTENDED`,
        type: "POTION",
        baseCost: null,
      });

      if (!["Blindness", "Nausea", "Wither"].includes(effect.name)) {
        genericItems.push({
          name: `potion:${effect.name}:upgraded`,
          format: `POTION:${effectName}:UPGRADED`,
          type: "POTION",
          baseCost: null,
        });
      }
    }

    // SPLASH_POTION variants
    genericItems.push({
      name: `splash_potion:${effect.name}`,
      format: `SPLASH_POTION:${effectName}`,
      type: "SPLASH_POTION",
      baseCost: null,
    });

    if (!["InstantHealth", "InstantDamage"].includes(effect.name)) {
      genericItems.push({
        name: `splash_potion:${effect.name}:extended`,
        format: `SPLASH_POTION:${effectName}:EXTENDED`,
        type: "SPLASH_POTION",
        baseCost: null,
      });

      if (!["Blindness", "Nausea", "Wither"].includes(effect.name)) {
        genericItems.push({
          name: `splash_potion:${effect.name}:upgraded`,
          format: `SPLASH_POTION:${effectName}:UPGRADED`,
          type: "SPLASH_POTION",
          baseCost: null,
        });
      }
    }

    // LINGERING_POTION variants
    genericItems.push({
      name: `lingering_potion:${effect.name}`,
      format: `LINGERING_POTION:${effectName}`,
      type: "LINGERING_POTION",
      baseCost: null,
    });

    if (!["InstantHealth", "InstantDamage"].includes(effect.name)) {
      genericItems.push({
        name: `lingering_potion:${effect.name}:extended`,
        format: `LINGERING_POTION:${effectName}:EXTENDED`,
        type: "LINGERING_POTION",
        baseCost: null,
      });

      if (!["Blindness", "Nausea", "Wither"].includes(effect.name)) {
        genericItems.push({
          name: `lingering_potion:${effect.name}:upgraded`,
          format: `LINGERING_POTION:${effectName}:UPGRADED`,
          type: "LINGERING_POTION",
          baseCost: null,
        });
      }
    }

    // TIPPED_ARROW variants
    genericItems.push({
      name: `tipped_arrow:${effect.name}`,
      format: `TIPPED_ARROW:${effectName}`,
      type: "TIPPED_ARROW",
      baseCost: null,
    });

    if (!["InstantHealth", "InstantDamage"].includes(effect.name)) {
      genericItems.push({
        name: `tipped_arrow:${effect.name}:extended`,
        format: `TIPPED_ARROW:${effectName}:EXTENDED`,
        type: "TIPPED_ARROW",
        baseCost: null,
      });

      if (!["Blindness", "Nausea", "Wither"].includes(effect.name)) {
        genericItems.push({
          name: `tipped_arrow:${effect.name}:upgraded`,
          format: `TIPPED_ARROW:${effectName}:UPGRADED`,
          type: "TIPPED_ARROW",
          baseCost: null,
        });
      }
    }
  });

  // Generate enchanted books
  Object.values(enchantments).forEach((enchant) => {
    const enchantName = toSnakeCase(enchant.name);

    for (let level = 1; level <= enchant.maxLevel; level++) {
      genericItems.push({
        name: `enchanted_book:${enchant.name}:${level}`,
        format: `ENCHANTED_BOOK:${enchantName}:${level}`,
        type: "ENCHANTED_BOOK",
        baseCost: null,
      });
    }
  });

  return genericItems;
}

async function runAIValidation(itemDataChunk, chunkNum, totalChunks) {
  const isOllamaCloud = process.env.OLLAMA_API_KEY && !process.env.OPENAI_API_KEY;

  const prompt = `You are an expert Minecraft economy balancer.
I have a list of Minecraft items with their base recipe costs (relative to a Diamond = $200).
Some items cannot be crafted and have "null" as their base price.
Some items are generic variants like potions, enchanted books, and tipped arrows.

Your task:
1. Estimate a fair "Price" for each item based on its Base Recipe Cost, Rarity Modifier, and Utility Modifier.
2. If Base Cost is null, you MUST estimate a fair market price from scratch based on its rarity and utility.
3. For generic items (marked with a "type" field), price them appropriately:
   - Basic potions should cost less than rare effects (Invisibility, Regeneration)
   - IMPORTANT: Extended and Upgraded variants exist for POTION, SPLASH_POTION, LINGERING_POTION, and TIPPED_ARROW types
   - Extended variants should cost more than normal variants (e.g., POTION:SPEED < POTION:SPEED:EXTENDED)
   - Upgraded/Amplified variants should cost the most for each type (e.g., POTION:SPEED:UPGRADED is highest)
   - SPLASH_POTION variants should be ~25-50% more expensive than equivalent POTION variants
   - LINGERING_POTION variants should be ~80-120% more expensive than equivalent POTION variants
   - TIPPED_ARROW variants should be ~40-60% cheaper than equivalent POTION variants
   - Enchanted books: Higher levels and rarer enchantments should be more expensive
4. Base Price = (Recipe Cost * Rarity Modifier). If no recipe cost, estimate directly.
5. Output ONLY valid JSON with item names as keys and prices as values. For regular items use "minecraft:" prefix, for generic items use item name directly:
{
  "minecraft:item_name": 150.50,
  "potion:speed": 60.00,
  "splash_potion:speed:extended": 100.00,
  "enchanted_book:sharpness:5": 1500.00
}
Ensure keys match the item names exactly. Do not include markdown formatting.

Items to process (${itemDataChunk.length} items):
${JSON.stringify(itemDataChunk, null, 2)}`;

  try {
    logger.chunk(chunkNum, totalChunks);
    logger.startSpinner(`Streaming response from ${process.env.MODEL || "gpt-3.5-turbo"}...`);

    let fullResponse = "";
    let tokenCount = 0;

    if (isOllamaCloud) {
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

// ============================================================================
// CLI INTERFACE
// ============================================================================

const args = process.argv.slice(2);
let mode = "missing"; // default mode

if (args.length > 0) {
  if (args[0] === "--all" || args[0] === "-a") {
    mode = "all";
  } else if (args[0] === "--items" || args[0] === "-i") {
    // node generate-smart.js --items POTION:SPEED SPLASH_POTION:STRENGTH
    mode = args.slice(1);
  }
}

smartGeneratePrices(mode).catch(console.error);
