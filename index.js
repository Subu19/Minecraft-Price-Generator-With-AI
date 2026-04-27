#!/usr/bin/env node
// ============================================================================
// generate-prices.js  —  Minecraft Economy Price Generator
// ============================================================================
// Architecture:
//   Pass 1  — Deterministic anchor prices (recipe-graph traversal)
//   Pass 2  — AI pricing for uncraftable/generic items, WITH anchors injected
//   Pass 3  — Constraint enforcement (level monotonicity, variant ratios)
//   Pass 4  — Sanity validation + report
// ============================================================================

const mcData = require("minecraft-data")("1.21.11");
const fs = require("fs");
const yaml = require("yaml");
const { OpenAI } = require("openai");
require("dotenv").config();

// ── Optional logger (falls back to plain console) ────────────────────────────
let logger;
try {
  logger = require("./logger");
} catch {
  const noop = () => {};
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
    streaming: noop,
    streamingDone: noop,
    modelOutput: noop,
    jsonParsed: noop,
  };
}

// ============================================================================
// CONFIG
// ============================================================================

const CFG = {
  DIAMOND_PRICE: 200, // anchor for all recipe-based prices
  CHUNK_SIZE: 40, // items per AI call  (smaller = more context per item)
  MAX_RECIPE_DEPTH: 8,
  OUTPUT_FILE: "price.yml",

  // Variant multipliers (relative to base POTION price)
  VARIANT_RATIOS: {
    POTION: { base: 1.0, extended: 1.35, upgraded: 1.8 },
    SPLASH_POTION: { base: 1.35, extended: 1.75, upgraded: 2.3 },
    LINGERING_POTION: { base: 2.0, extended: 2.6, upgraded: 3.4 },
    TIPPED_ARROW: { base: 0.45, extended: 0.6, upgraded: 0.8 },
  },

  // Model settings
  MODEL: process.env.MODEL || "gpt-4o-mini",
  TEMPERATURE: 0.15,
};

// ============================================================================
// DATA LOADING
// ============================================================================

const MC = {
  items: mcData.items,
  recipes: mcData.recipes,
  effects: mcData.effects || {},
  enchantments: mcData.enchantments || {},
};

// ============================================================================
// PASS 1 — DETERMINISTIC ANCHOR PRICES (recipe-graph traversal)
// ============================================================================

class RecipePricer {
  constructor() {
    this._cache = new Map();
    this._diamondId = this._findId("diamond");
  }

  _findId(name) {
    const item = Object.values(MC.items).find((i) => i.name === name);
    return item ? item.id : null;
  }

  /**
   * Returns a price in "diamonds" (1.0 = one diamond = $DIAMOND_PRICE).
   * Returns null if no recipe path exists.
   */
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

    if (recipe.inGrid) {
      recipe.inGrid.forEach(push);
    } else if (recipe.inShape) {
      recipe.inShape.forEach((row) => row.forEach(push));
    } else if (recipe.ingredients) {
      recipe.ingredients.forEach(push);
    }
    return ids;
  }

  /** Returns dollar price or null */
  getDollarPrice(itemId) {
    const cost = this.getCost(itemId);
    return cost !== null
      ? Math.round(cost * CFG.DIAMOND_PRICE * 100) / 100
      : null;
  }
}

// ============================================================================
// ITEM CATALOGUE  —  build the full list of items to price
// ============================================================================

function buildItemCatalogue() {
  const pricer = new RecipePricer();
  const catalogue = [];

  const toSnake = (str) =>
    str.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();

  // ── Standard items ────────────────────────────────────────────────────────
  for (const item of Object.values(MC.items)) {
    const dollarPrice = pricer.getDollarPrice(item.id);
    catalogue.push({
      key: item.name.toUpperCase(), // storage key
      displayName: item.name,
      category: "ITEM",
      subtype: null,
      variant: null,
      level: null,
      anchorPrice: dollarPrice, // null = needs AI
      recipeCost: pricer.getCost(item.id),
    });
  }

  // ── Potions / splash / lingering / tipped arrows ──────────────────────────
  const potionTypes = [
    "POTION",
    "SPLASH_POTION",
    "LINGERING_POTION",
    "TIPPED_ARROW",
  ];
  const noExtended = new Set(["InstantHealth", "InstantDamage"]);
  const noUpgraded = new Set([
    "Blindness",
    "Nausea",
    "Wither",
    "InstantHealth",
    "InstantDamage",
  ]);

  for (const effect of Object.values(MC.effects)) {
    const eName = toSnake(effect.name);

    for (const pType of potionTypes) {
      const variants = ["base"];
      if (!noExtended.has(effect.name)) variants.push("extended");
      if (!noUpgraded.has(effect.name)) variants.push("upgraded");

      for (const variant of variants) {
        const suffix = variant === "base" ? "" : `:${variant.toUpperCase()}`;
        const key = `${pType}:${eName}${suffix}`;
        const subtype = effect.name;

        catalogue.push({
          key,
          displayName: key,
          category: pType,
          subtype,
          variant,
          level: null,
          anchorPrice: null, // always AI-priced
          recipeCost: null,
          // siblings injected later for context
          _effectName: effect.name,
        });
      }
    }
  }

  // ── Enchanted books ───────────────────────────────────────────────────────
  for (const enchant of Object.values(MC.enchantments)) {
    const eName = toSnake(enchant.name);
    for (let lvl = 1; lvl <= enchant.maxLevel; lvl++) {
      catalogue.push({
        key: `ENCHANTED_BOOK:${eName}:${lvl}`,
        displayName: `Enchanted Book (${enchant.name} ${lvl})`,
        category: "ENCHANTED_BOOK",
        subtype: enchant.name,
        variant: null,
        level: lvl,
        maxLevel: enchant.maxLevel,
        anchorPrice: null,
        recipeCost: null,
      });
    }
  }

  return catalogue;
}

// ============================================================================
// PASS 2 — AI PRICING
// ============================================================================

/**
 * Groups items into atomic "must-stay-together" families.
 *
 * Rules:
 *  - ENCHANTED_BOOK: all levels of the SAME enchant MUST be together
 *    (level monotonicity requires the AI to see them all at once)
 *  - POTION / SPLASH / LINGERING / TIPPED for the SAME effect MUST be together
 *    (the AI needs to see all variant tiers of one effect simultaneously)
 *  - Different effects are INDEPENDENT and can be in different batches.
 *    So each (effectName) is its own family — NOT one giant potion family.
 *  - Regular items are singletons (each is independent).
 *
 * Returns an array of families, each family being an array of items.
 * Families are sorted largest-first so the bin-packing batching below
 * fills batches efficiently.
 */
function groupIntoFamilies(catalogue) {
  const familyMap = new Map();

  for (const item of catalogue) {
    let familyKey;

    if (item.category === "ENCHANTED_BOOK") {
      // All levels of one enchant together
      familyKey = `ebook:${item.subtype}`;
    } else if (
      ["POTION", "SPLASH_POTION", "LINGERING_POTION", "TIPPED_ARROW"].includes(
        item.category,
      )
    ) {
      // All 4 types × all variants for ONE effect together (they are interdependent for ratio rules)
      // Key on effect name only — not on potion type
      familyKey = `potion_effect:${item._effectName}`;
    } else {
      // Regular items: each is a singleton (they are all independent)
      familyKey = `item:${item.key}`;
    }

    if (!familyMap.has(familyKey)) familyMap.set(familyKey, []);
    familyMap.get(familyKey).push(item);
  }

  // Return as array of arrays, sorted largest-first for better bin-packing
  return Array.from(familyMap.values()).sort((a, b) => b.length - a.length);
}

/**
 * Builds an "anchor context" string injected into every AI prompt so the
 * model calibrates correctly regardless of which chunk it's in.
 */
function buildAnchorContext(anchors) {
  const sample = Object.entries(anchors)
    .slice(0, 30)
    .map(([k, v]) => `  ${k}: $${v}`)
    .join("\n");
  return `PRICE ANCHORS (already set, use for calibration — do NOT return these):\n${sample}`;
}

function buildSystemPrompt(anchorContext) {
  return `You are a Minecraft economy designer balancing item prices for a survival server shop.
${anchorContext}

RULES (strictly enforce):
1. Prices are in server dollars ($). Diamond = $${CFG.DIAMOND_PRICE}.
2. For enchanted books: price[level N] MUST be strictly greater than price[level N-1].
   Do NOT produce a lower price for a higher level.
3. For potion variants of the same effect:
   base < extended < upgraded  (each strictly more expensive)
4. SPLASH_POTION ≈ 35-50% more than equivalent POTION
5. LINGERING_POTION ≈ 80-120% more than equivalent POTION
6. TIPPED_ARROW ≈ 40-60% cheaper than equivalent POTION
7. Common items (dirt, wood) → $1–$10. Rare loot (netherite, elytra) → $1000+.
8. Return ONLY a JSON object, no markdown, no commentary.
   Keys = the "key" field of each item. Values = number (dollars, 2 decimal places max).`;
}

async function callAI(items, systemPrompt) {
  const userContent =
    `Price these ${items.length} items:\n` +
    JSON.stringify(
      items.map((i) => ({
        key: i.key,
        category: i.category,
        subtype: i.subtype || undefined,
        variant: i.variant || undefined,
        level: i.level || undefined,
        maxLevel: i.maxLevel || undefined,
        recipeCost:
          i.recipeCost !== null
            ? `$${Math.round(i.recipeCost * CFG.DIAMOND_PRICE)}`
            : "no recipe",
      })),
      null,
      2,
    );

  const isOllamaCloud =
    process.env.OLLAMA_API_KEY && !process.env.OPENAI_API_KEY;

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
          { role: "user", content: userContent },
        ],
        temperature: CFG.TEMPERATURE,
        stream: true,
      }),
    });
    if (!response.ok)
      throw new Error(
        `Ollama Cloud ${response.status}: ${await response.text()}`,
      );

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
        } catch {
          /* skip */
        }
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
        { role: "user", content: userContent },
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

  console.log(); // newline after stream

  const clean = fullResponse
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(clean);
}

// ============================================================================
// PASS 3 — CONSTRAINT ENFORCEMENT
// ============================================================================

/**
 * Enforces strict monotonicity and variant ratios.
 * Returns { prices, violations } where violations is a list of fixed items.
 */
function enforceConstraints(prices) {
  const violations = [];
  const fixed = { ...prices };

  // ── Enchanted books: level monotonicity ───────────────────────────────────
  // Group by enchant name
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
        const corrected = +(fixed[prev.key] * 1.5).toFixed(2);
        violations.push(
          `ENCHANTED_BOOK:${name}:${curr.level} $${fixed[curr.key]} → $${corrected} ` +
            `(must exceed level ${prev.level} @ $${fixed[prev.key]})`,
        );
        fixed[curr.key] = corrected;
      }
    }
  }

  // ── Potion variants: base < extended < upgraded ───────────────────────────
  const potionTypes = [
    "POTION",
    "SPLASH_POTION",
    "LINGERING_POTION",
    "TIPPED_ARROW",
  ];
  // Collect all effect names from keys
  const effectNames = new Set();
  for (const key of Object.keys(fixed)) {
    for (const pt of potionTypes) {
      if (key.startsWith(`${pt}:`)) {
        // Extract effect part (may have :EXTENDED/:UPGRADED suffix)
        const rest = key.slice(pt.length + 1);
        const effectKey = rest
          .replace(/:EXTENDED$/, "")
          .replace(/:UPGRADED$/, "");
        effectNames.add(`${pt}:${effectKey}`);
      }
    }
  }
  for (const base of effectNames) {
    const kBase = base;
    const kExtended = `${base}:EXTENDED`;
    const kUpgraded = `${base}:UPGRADED`;

    if (fixed[kBase] != null && fixed[kExtended] != null) {
      if (fixed[kExtended] <= fixed[kBase]) {
        const corrected = +(fixed[kBase] * 1.35).toFixed(2);
        violations.push(`${kExtended} $${fixed[kExtended]} → $${corrected}`);
        fixed[kExtended] = corrected;
      }
    }
    if (fixed[kExtended] != null && fixed[kUpgraded] != null) {
      if (fixed[kUpgraded] <= fixed[kExtended]) {
        const corrected = +(fixed[kExtended] * 1.35).toFixed(2);
        violations.push(`${kUpgraded} $${fixed[kUpgraded]} → $${corrected}`);
        fixed[kUpgraded] = corrected;
      }
    }
  }

  // ── Cross-type potion ratio enforcement ───────────────────────────────────
  // For each POTION base price, ensure SPLASH/LINGERING/TIPPED are in ratio
  for (const key of Object.keys(fixed)) {
    if (!key.startsWith("POTION:")) continue;
    const effectPart = key.slice("POTION:".length); // e.g. SPEED or SPEED:EXTENDED
    const basePrice = fixed[key];

    const splashKey = `SPLASH_POTION:${effectPart}`;
    const lingeringKey = `LINGERING_POTION:${effectPart}`;
    const tippedKey = `TIPPED_ARROW:${effectPart}`;

    const checks = [
      { k: splashKey, min: 1.25, max: 1.6, label: "SPLASH" },
      { k: lingeringKey, min: 1.7, max: 2.5, label: "LINGERING" },
      { k: tippedKey, min: 0.35, max: 0.65, label: "TIPPED_ARROW" },
    ];

    for (const { k, min, max, label } of checks) {
      if (fixed[k] == null) continue;
      const ratio = fixed[k] / basePrice;
      if (ratio < min) {
        const corrected = +(basePrice * ((min + max) / 2)).toFixed(2);
        violations.push(
          `${k} ratio ${ratio.toFixed(2)}x → corrected to $${corrected}`,
        );
        fixed[k] = corrected;
      } else if (ratio > max * 1.5) {
        // Only correct extreme outliers
        const corrected = +(basePrice * ((min + max) / 2)).toFixed(2);
        violations.push(
          `${k} ratio ${ratio.toFixed(2)}x (extreme) → corrected to $${corrected}`,
        );
        fixed[k] = corrected;
      }
    }
  }

  return { prices: fixed, violations };
}

// ============================================================================
// PASS 4 — SANITY VALIDATION + REPORT
// ============================================================================

function validateAndReport(prices, catalogue) {
  const issues = [];

  for (const item of catalogue) {
    const price = prices[item.key];
    if (price == null) {
      issues.push({ severity: "MISSING", key: item.key, msg: "No price set" });
      continue;
    }
    if (price <= 0) {
      issues.push({
        severity: "INVALID",
        key: item.key,
        msg: `Non-positive price: $${price}`,
      });
    }
    if (price > 1_000_000) {
      issues.push({
        severity: "WARN",
        key: item.key,
        msg: `Very high price: $${price}`,
      });
    }
    // Recipe-anchored items shouldn't deviate more than 5x
    if (item.anchorPrice != null) {
      const ratio = price / item.anchorPrice;
      if (ratio > 5 || ratio < 0.2) {
        issues.push({
          severity: "WARN",
          key: item.key,
          msg: `Price $${price} deviates ${ratio.toFixed(1)}x from recipe anchor $${item.anchorPrice}`,
        });
      }
    }
  }

  return issues;
}

// ============================================================================
// ORCHESTRATOR
// ============================================================================

async function generatePrices(mode = "missing") {
  logger.header("Minecraft Price Generator — Multi-Pass Architecture");

  // ── Load existing ─────────────────────────────────────────────────────────
  let existingPrices = {};
  if (fs.existsSync(CFG.OUTPUT_FILE)) {
    logger.startSpinner(`Loading ${CFG.OUTPUT_FILE}...`);
    existingPrices = yaml.parse(fs.readFileSync(CFG.OUTPUT_FILE, "utf8")) || {};
    logger.stopSpinner(
      `Loaded ${Object.keys(existingPrices).length} existing prices`,
    );
  }

  // ── Build catalogue ───────────────────────────────────────────────────────
  logger.startSpinner("Building item catalogue...");
  const catalogue = buildItemCatalogue();
  logger.stopSpinner(`Catalogue: ${catalogue.length} items`);

  // ── Determine scope ───────────────────────────────────────────────────────
  let scope;
  if (mode === "all") {
    scope = catalogue;
    existingPrices = {};
  } else if (mode === "missing") {
    scope = catalogue.filter((i) => existingPrices[i.key] == null);
  } else if (Array.isArray(mode)) {
    const modeSet = new Set(mode.map((s) => s.toUpperCase()));
    scope = catalogue.filter((i) => modeSet.has(i.key));
  } else {
    scope = catalogue;
  }

  logger.info(`Scope: ${scope.length} items to price`);

  // ── Pass 1: Apply recipe anchors ──────────────────────────────────────────
  logger.header("Pass 1 — Deterministic Recipe Anchors");
  const anchors = {};
  let anchorCount = 0;
  for (const item of scope) {
    if (item.anchorPrice !== null) {
      anchors[item.key] = item.anchorPrice;
      anchorCount++;
    }
  }
  // Also include existing anchored prices for context
  for (const [k, v] of Object.entries(existingPrices)) {
    anchors[k] = v;
  }
  logger.stats("Anchored via recipe", anchorCount);
  logger.stats("Needs AI", scope.length - anchorCount);

  // ── Pass 2: AI pricing for non-anchored items ─────────────────────────────
  const needsAI = scope.filter((i) => i.anchorPrice === null);

  if (needsAI.length > 0) {
    logger.header(`Pass 2 — AI Pricing (${needsAI.length} items)`);

    // Group by family so all levels/variants go in the same AI call
    const families = groupIntoFamilies(needsAI);
    const batches = []; // array of item arrays
    let currentBatch = [];

    for (const familyItems of families.values()) {
      // If adding this family would overflow the chunk, flush first
      if (
        currentBatch.length + familyItems.length > CFG.CHUNK_SIZE &&
        currentBatch.length > 0
      ) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      currentBatch.push(...familyItems);
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    const anchorContext = buildAnchorContext(anchors);
    const systemPrompt = buildSystemPrompt(anchorContext);
    const aiPrices = {};

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      logger.chunk(b + 1, batches.length);
      logger.info(`Batch items: ${batch.map((i) => i.key).join(", ")}`);

      try {
        const result = await callAI(batch, systemPrompt);
        for (const [rawKey, price] of Object.entries(result)) {
          // Normalize key: strip minecraft: prefix, uppercase
          const normalKey = rawKey.replace(/^minecraft:/i, "").toUpperCase();
          // Try to match to a batch item
          const matched = batch.find(
            (i) => i.key === normalKey || i.key === rawKey.toUpperCase(),
          );
          const finalKey = matched ? matched.key : normalKey;
          aiPrices[finalKey] =
            typeof price === "number" ? +price.toFixed(2) : price;
        }
      } catch (err) {
        logger.error(`Batch ${b + 1} failed: ${err.message}`);
        logger.warn("Skipping batch, will be flagged as MISSING in report");
      }
    }

    Object.assign(anchors, aiPrices);
  }

  // ── Pass 3: Constraint enforcement ────────────────────────────────────────
  logger.header("Pass 3 — Constraint Enforcement");
  const { prices: constrained, violations } = enforceConstraints({
    ...existingPrices,
    ...anchors,
  });
  logger.stats("Violations corrected", violations.length);
  if (violations.length > 0) {
    logger.warn("Corrections:");
    violations.forEach((v) => logger.warn(`  ${v}`));
  }

  // ── Pass 4: Sanity validation ─────────────────────────────────────────────
  logger.header("Pass 4 — Sanity Validation");
  const issues = validateAndReport(constrained, catalogue);
  const missing = issues.filter((i) => i.severity === "MISSING");
  const invalid = issues.filter((i) => i.severity === "INVALID");
  const warns = issues.filter((i) => i.severity === "WARN");
  logger.stats("Missing prices", missing.length);
  logger.stats("Invalid prices", invalid.length);
  logger.stats("Warnings", warns.length);
  if (missing.length > 0) {
    logger.warn("Missing items (run --missing or --items to fix):");
    missing.slice(0, 10).forEach((i) => logger.warn(`  ${i.key}`));
    if (missing.length > 10)
      logger.warn(`  ... and ${missing.length - 10} more`);
  }

  // ── Write output ──────────────────────────────────────────────────────────
  logger.header("Writing Output");

  // Sort keys alphabetically for clean diffs
  const sortedPrices = Object.fromEntries(
    Object.entries(constrained).sort(([a], [b]) => a.localeCompare(b)),
  );

  fs.writeFileSync(CFG.OUTPUT_FILE, yaml.stringify(sortedPrices), "utf8");
  logger.success(
    `Saved ${Object.keys(sortedPrices).length} prices to ${CFG.OUTPUT_FILE}`,
  );

  // Optional: write a validation report
  if (issues.length > 0) {
    const report = issues
      .map((i) => `[${i.severity}] ${i.key}: ${i.msg}`)
      .join("\n");
    fs.writeFileSync("price-report.txt", report, "utf8");
    logger.info("Validation report saved to price-report.txt");
  }

  logger.success("Done!");
  return sortedPrices;
}

// ============================================================================
// CLI
// ============================================================================

function printHelp() {
  console.log(`
Usage: node generate-prices.js [options]

Modes (pick one):
  (no flags)          Price only items missing from price.yml
  -a, --all           Regenerate ALL prices from scratch
  -i, --items <keys>  Regenerate specific items by key
                      e.g. --items ENCHANTED_BOOK:SHARPNESS:3 DIAMOND_SWORD

Options:
  -c, --chunk <n>     Items per AI batch (default: ${CFG.CHUNK_SIZE})
  -m, --model <name>  Override model (default: ${CFG.MODEL})
  -o, --output <file> Output file (default: ${CFG.OUTPUT_FILE})
  -h, --help          Show this help

Examples:
  node generate-prices.js                          # fill missing
  node generate-prices.js --all                    # regenerate everything
  node generate-prices.js --items DIAMOND EMERALD  # re-price specific items
  node generate-prices.js --model gpt-4o --all     # use specific model
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let mode = "missing";
  const items = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      case "-a":
      case "--all":
        mode = "all";
        break;
      case "-i":
      case "--items":
        mode = "specific";
        // Collect all following non-flag args as item keys
        while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
          items.push(args[++i].toUpperCase());
        }
        break;
      case "-c":
      case "--chunk":
        CFG.CHUNK_SIZE = parseInt(args[++i], 10);
        break;
      case "-m":
      case "--model":
        CFG.MODEL = args[++i];
        break;
      case "-o":
      case "--output":
        CFG.OUTPUT_FILE = args[++i];
        break;
      default:
        console.warn(`Unknown argument: ${arg}`);
    }
  }

  if (mode === "specific") {
    if (items.length === 0) {
      console.error("--items requires at least one item key");
      process.exit(1);
    }
    return items; // array mode
  }
  return mode;
}

const resolvedMode = parseArgs(process.argv);
generatePrices(resolvedMode).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
