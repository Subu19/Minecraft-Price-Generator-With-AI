#!/usr/bin/env node
const fs = require("fs");
const yaml = require("yaml");
const { OpenAI } = require("openai");
const mcDataLib = require("minecraft-data");
const latestValid = mcDataLib.versions.pc.find(v => !v.minecraftVersion.includes('snapshot') && mcDataLib(v.minecraftVersion) !== null);
const mcData = mcDataLib(latestValid.minecraftVersion);
require("dotenv").config();

let logger;
try {
  logger = require("./logger");
} catch {
  const noop = () => { };
  logger = {
    header: (m) => console.log(`\n=== ${m} ===`),
    success: (m) => console.log(`✅ ${m}`),
    warn: (m) => console.warn(`⚠️  ${m}`),
    error: (m) => console.error(`❌ ${m}`),
    info: (m) => console.log(`ℹ️  ${m}`),
    stats: (k, v) => console.log(`   ${k}: ${v}`),
    startSpinner: (m) => process.stdout.write(`   ${m}`),
    stopSpinner: (m) => console.log(` → ${m}`),
    chunk: (n, t) => console.log(`\n[Chunk ${n}/${t}]`),
  };
}

const CFG = {
  DIAMOND_PRICE: 200,
  CHUNK_SIZE: 40,
  MAX_RECIPE_DEPTH: 8,
  OUTPUT_FILE: "price.yml",
  MODEL: process.env.MODEL || "gpt-4o-mini",
  TEMPERATURE: 0.15,
};

const ANCHORS = {
  "ENCHANTED_GOLDEN_APPLE": 25000,
  "SILENCE_ARMOR_TRIM_SMITHING_TEMPLATE": 15000,
  "ELYTRA": 10000,
  "BEACON": 6000,
  "NETHER_STAR": 5000,
  "DRAGON_EGG": 1000000,
};

const MC = {
  items: mcData.items,
  recipes: mcData.recipes,
  effects: mcData.effects || {},
  enchantments: mcData.enchantments || {},
};

class RecipePricer {
  constructor() {
    this._cache = new Map();
    this._diamondId = this._findId("diamond");
  }

  _findId(name) {
    const item = Object.values(MC.items).find((i) => i.name === name);
    return item ? item.id : null;
  }

  getCost(itemId, depth = 0) {
    if (depth > CFG.MAX_RECIPE_DEPTH || itemId == null) return null;
    if (this._cache.has(itemId)) return this._cache.get(itemId);
    if (itemId === this._diamondId) return 1.0;

    const recipeList = MC.recipes[itemId] || [];
    let minCost = Infinity;

    for (const recipe of recipeList) {
      const ingredients = this._extractIngredients(recipe);
      let recipeCost = 0;
      let valid = true;

      for (const ingId of ingredients) {
        const ingCost = this.getCost(ingId, depth + 1);
        if (ingCost === null) {
          valid = false;
          break;
        }
        recipeCost += ingCost;
      }

      if (valid) {
        const perItem = recipeCost / Math.max(recipe.result?.count || 1, 1);
        if (perItem < minCost) minCost = perItem;
      }
    }

    const result = minCost === Infinity ? null : minCost;
    this._cache.set(itemId, result);
    return result;
  }

  _extractIngredients(recipe) {
    const ids = [];
    const push = (slot) => {
      if (!slot || slot.length === 0) return;
      const id = Array.isArray(slot) ? slot[0] : slot;
      if (id != null) ids.push(id);
    };

    if (recipe.inGrid) recipe.inGrid.forEach(push);
    else if (recipe.inShape) recipe.inShape.forEach((row) => row.forEach(push));
    else if (recipe.ingredients) recipe.ingredients.forEach(push);
    return ids;
  }

  getDollarPrice(itemId) {
    const cost = this.getCost(itemId);
    return cost !== null ? Math.round(cost * CFG.DIAMOND_PRICE * 100) / 100 : null;
  }
}

function buildItemCatalogue() {
  const pricer = new RecipePricer();
  const catalogue = [];
  const toSnake = (str) => str.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();

  for (const item of Object.values(MC.items)) {
    const key = item.name.toUpperCase();
    const recipePrice = pricer.getDollarPrice(item.id);
    catalogue.push({
      key,
      category: "ITEM",
      anchorPrice: ANCHORS[key] || recipePrice,
      recipeCost: pricer.getCost(item.id),
    });
  }

  const potionTypes = ["POTION", "SPLASH_POTION", "LINGERING_POTION", "TIPPED_ARROW"];
  const noExtended = new Set(["InstantHealth", "InstantDamage"]);
  const noUpgraded = new Set(["Blindness", "Nausea", "Wither", "InstantHealth", "InstantDamage"]);

  for (const effect of Object.values(MC.effects)) {
    const eName = toSnake(effect.name);
    for (const pType of potionTypes) {
      const variants = ["base"];
      if (!noExtended.has(effect.name)) variants.push("extended");
      if (!noUpgraded.has(effect.name)) variants.push("upgraded");

      for (const variant of variants) {
        const suffix = variant === "base" ? "" : `:${variant.toUpperCase()}`;
        const key = `${pType}:${eName}${suffix}`;
        catalogue.push({
          key,
          category: pType,
          subtype: effect.name,
          variant,
          anchorPrice: ANCHORS[key] || null,
          _effectName: effect.name,
        });
      }
    }
  }

  for (const enchant of Object.values(MC.enchantments)) {
    const eName = toSnake(enchant.name);
    // Usually level 1-5
    for (let lvl = 1; lvl <= (enchant.maxLevel || 5); lvl++) {
      const key = `ENCHANTED_BOOK:${eName}:${lvl}`;
      catalogue.push({
        key,
        category: "ENCHANTED_BOOK",
        subtype: enchant.name,
        level: lvl,
        anchorPrice: ANCHORS[key] || null,
      });
    }
  }

  return catalogue;
}

function groupIntoFamilies(catalogue) {
  const familyMap = new Map();
  for (const item of catalogue) {
    let familyKey;
    if (item.category === "ENCHANTED_BOOK") {
      familyKey = `ebook:${item.subtype}`;
    } else if (["POTION", "SPLASH_POTION", "LINGERING_POTION", "TIPPED_ARROW"].includes(item.category)) {
      familyKey = `potion_effect:${item._effectName}`;
    } else {
      familyKey = `item:${item.key}`;
    }
    if (!familyMap.has(familyKey)) familyMap.set(familyKey, []);
    familyMap.get(familyKey).push(item);
  }
  return Array.from(familyMap.values()).sort((a, b) => b.length - a.length);
}

function buildSystemPrompt(anchorContext) {
  return `You are a Minecraft economy designer balancing item prices for a survival server shop.
${anchorContext}

RULES (strictly enforce):
1. Prices are in server dollars ($). Diamond = $${CFG.DIAMOND_PRICE}.
2. RARITY EXTREMELY MATTERS. Items that are uncraftable and incredibly rare to find (e.g. silence armor trim, enchanted golden apple, elytra, beacon) MUST be priced very high (e.g. $10,000 to $100,000+). Rarity heavily drives the price up!
3. Common items (dirt, cobblestone) should be cheap ($1-$5).
4. For enchanted books: price[level N] MUST be strictly greater than price[level N-1].
5. For potion variants of the same effect: base < extended < upgraded
6. SPLASH_POTION ≈ 35-50% more than POTION. LINGERING_POTION ≈ 80-120% more than POTION.
7. Return ONLY a JSON object, no markdown, no commentary. Keys = the "key" field. Values = number (dollars).`;
}

async function callAI(items, systemPrompt) {
  const userContent = JSON.stringify(
    items.map((i) => ({
      key: i.key,
      category: i.category,
      variant: i.variant,
      level: i.level,
      recipeCost: i.recipeCost !== null ? `$${Math.round(i.recipeCost * CFG.DIAMOND_PRICE)}` : "no recipe",
    })),
    null,
    2,
  );

  const isOllamaCloud = process.env.OLLAMA_API_KEY && !process.env.OPENAI_API_KEY;
  let fullResponse = "";

  if (isOllamaCloud) {
    const response = await fetch("https://ollama.com/api/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CFG.MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Price these items:\n${userContent}` },
        ],
        temperature: CFG.TEMPERATURE,
        stream: true,
      }),
    });
    if (!response.ok) throw new Error(`Ollama Cloud ${response.status}: ${await response.text()}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message?.content) {
            fullResponse += json.message.content;
            process.stdout.write(json.message.content);
          }
        } catch { }
      }
    }
  } else {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || "ollama",
      baseURL: process.env.OPENAI_BASE_URL,
    });
    const stream = await openai.chat.completions.create({
      model: CFG.MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Price these items:\n${userContent}` },
      ],
      temperature: CFG.TEMPERATURE,
      disable_thinking: true,
      stream: true,
    });
    for await (const event of stream) {
      const content = event.choices[0]?.delta?.content;
      if (content) {
        fullResponse += content;
        process.stdout.write(content);
      }
    }
  }

  console.log();
  const clean = fullResponse.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  return JSON.parse(clean);
}

function enforceConstraints(prices) {
  const violations = [];
  const fixed = { ...prices };

  // Enchanted books
  const ebookFamilies = new Map();
  for (const key of Object.keys(fixed)) {
    const m = key.match(/^ENCHANTED_BOOK:(.+):(\d+)$/);
    if (!m) continue;
    const [, name, lvlStr] = m;
    if (!ebookFamilies.has(name)) ebookFamilies.set(name, []);
    ebookFamilies.get(name).push({ key, level: parseInt(lvlStr, 10) });
  }
  for (const [name, entries] of ebookFamilies) {
    entries.sort((a, b) => a.level - b.level);
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const curr = entries[i];
      if (fixed[curr.key] <= fixed[prev.key]) {
        fixed[curr.key] = +(fixed[prev.key] * 1.5).toFixed(2);
      }
    }
  }

  return { prices: fixed, violations };
}

async function generatePrices(mode = "missing") {
  logger.header("Minecraft Price Generator — AI Driven (Java Edition)");

  let existingPrices = {};
  if (fs.existsSync(CFG.OUTPUT_FILE)) {
    existingPrices = yaml.parse(fs.readFileSync(CFG.OUTPUT_FILE, "utf8")) || {};
  }

  const catalogue = buildItemCatalogue();
  let scope = mode === "all" ? catalogue : catalogue.filter((i) => existingPrices[i.key] == null);

  if (Array.isArray(mode)) {
    const modeSet = new Set(mode.map((s) => s.toUpperCase()));
    scope = catalogue.filter((i) => modeSet.has(i.key));
  }

  const anchors = {};
  for (const item of scope) {
    if (item.anchorPrice !== null) {
      anchors[item.key] = item.anchorPrice;
    }
  }

  const anchorContextStr = Object.entries(ANCHORS).map(([k, v]) => `${k}: $${v}`).join("\n");
  const systemPrompt = buildSystemPrompt(`MANUAL PRICE ANCHORS:\n${anchorContextStr}`);

  const aiPrices = { ...existingPrices, ...anchors };
  const needsAI = scope.filter((i) => aiPrices[i.key] == null);

  if (needsAI.length > 0) {
    const families = groupIntoFamilies(needsAI);
    const batches = [];
    let currentBatch = [];

    for (const familyItems of families) {
      if (currentBatch.length + familyItems.length > CFG.CHUNK_SIZE && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      currentBatch.push(...familyItems);
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    for (let b = 0; b < batches.length; b++) {
      logger.chunk(b + 1, batches.length);
      try {
        const result = await callAI(batches[b], systemPrompt);
        for (const [key, price] of Object.entries(result)) {
          const formattedKey = key.toUpperCase();
          aiPrices[formattedKey] = typeof price === "number" ? +price.toFixed(2) : price;
        }
      } catch (err) {
        logger.error(`Batch ${b + 1} failed: ${err.message}`);
      }
    }
  }

  const { prices: constrained } = enforceConstraints(aiPrices);
  const sortedPrices = Object.fromEntries(Object.entries(constrained).sort(([a], [b]) => a.localeCompare(b)));

  fs.writeFileSync(CFG.OUTPUT_FILE, yaml.stringify(sortedPrices), "utf8");
  logger.success(`Saved ${Object.keys(sortedPrices).length} prices to ${CFG.OUTPUT_FILE}`);
  return sortedPrices;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let mode = "missing";
  const items = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-a" || args[i] === "--all") mode = "all";
    if (args[i] === "-i" || args[i] === "--items") {
      mode = "specific";
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) items.push(args[++i].toUpperCase());
    }
  }
  return mode === "specific" ? items : mode;
}

generatePrices(parseArgs(process.argv)).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
