#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const commands = {
  "missing": {
    description: "Generate prices for items missing from price.yml (default)",
    run: () => require("./generate-smart.js")
  },
  "regenerate": {
    description: "Regenerate all prices from scratch",
    run: () => {
      process.argv.push("--all");
      require("./generate-smart.js");
    }
  },
  "add": {
    description: "Add specific items by name. Usage: pricing-cli add POTION:SPEED SPLASH_POTION:STRENGTH",
    run: (items) => {
      if (!items || items.length === 0) {
        console.error("❌ Please specify items to add: pricing-cli add ITEM1 ITEM2 ...");
        process.exit(1);
      }
      process.argv = [process.argv[0], process.argv[1], "--items", ...items];
      require("./generate-smart.js");
    }
  },
  "status": {
    description: "Show current pricing status",
    run: () => {
      if (!fs.existsSync("price.yml")) {
        console.log("❌ price.yml not found. Run 'pricing-cli missing' to generate.");
        process.exit(0);
      }

      const yaml = require("yaml");
      const prices = yaml.parse(fs.readFileSync("price.yml", "utf8")) || {};
      
      console.log("\n📊 Pricing Status:");
      console.log(`Total items priced: ${Object.keys(prices).length}`);
      
      // Count by type
      const typeCount = {};
      Object.keys(prices).forEach(key => {
        const type = key.split(":")[0];
        typeCount[type] = (typeCount[type] || 0) + 1;
      });
      
      console.log("\nBreakdown by type:");
      Object.entries(typeCount).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
        console.log(`  ${type}: ${count}`);
      });
      
      console.log("\nSample prices:");
      Object.entries(prices).slice(0, 5).forEach(([item, price]) => {
        console.log(`  ${item}: ${price}`);
      });
    }
  },
  "check-missing": {
    description: "Show what items are missing from price.yml",
    run: () => {
      const mcData = require("minecraft-data")("1.21.11");
      const yaml = require("yaml");

      if (!fs.existsSync("price.yml")) {
        console.log("❌ price.yml not found. Run 'pricing-cli missing' to generate.");
        process.exit(0);
      }

      const prices = yaml.parse(fs.readFileSync("price.yml", "utf8")) || {};
      
      // Gather all possible items
      const items = mcData.items || {};
      const effects = mcData.effects || {};
      const enchantments = mcData.enchantments || {};

      const allItems = new Set();
      
      // Standard items
      Object.values(items).forEach(item => {
        allItems.add(item.name.toUpperCase());
      });

      // Generic items
      Object.values(effects).forEach(effect => {
        const name = effect.name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
        allItems.add(`POTION:${name}`);
        allItems.add(`SPLASH_POTION:${name}`);
        allItems.add(`LINGERING_POTION:${name}`);
        allItems.add(`TIPPED_ARROW:${name}`);
      });

      Object.values(enchantments).forEach(ench => {
        const name = ench.name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
        for (let i = 1; i <= ench.maxLevel; i++) {
          allItems.add(`ENCHANTED_BOOK:${name}:${i}`);
        }
      });

      const missing = [];
      allItems.forEach(item => {
        if (!prices[item]) {
          missing.push(item);
        }
      });

      if (missing.length === 0) {
        console.log("✅ All items are priced!");
        return;
      }

      console.log(`\n⚠️  ${missing.length} items missing from price.yml\n`);
      console.log("First 20 missing:");
      missing.slice(0, 20).forEach(item => console.log(`  ${item}`));
      
      if (missing.length > 20) {
        console.log(`  ... and ${missing.length - 20} more`);
      }

      console.log(`\nRun: pricing-cli missing`);
    }
  },
  "help": {
    description: "Show this help message",
    run: () => {
      console.log("\n🎮 Minecraft Price Generator CLI\n");
      console.log("Usage: pricing-cli <command> [options]\n");
      console.log("Commands:");
      Object.entries(commands).forEach(([cmd, info]) => {
        console.log(`  ${cmd.padEnd(15)} - ${info.description}`);
      });
      console.log("");
    }
  }
};

const command = process.argv[2] || "help";
const args = process.argv.slice(3);

if (commands[command]) {
  commands[command].run(args);
} else {
  console.error(`❌ Unknown command: ${command}`);
  console.log("Run 'pricing-cli help' for available commands");
  process.exit(1);
}
