const fs = require("fs");
const yaml = require("yaml");

// Fixes pricing inversions where EXTENDED/UPGRADED should cost more than base
function fixPricingHierarchy() {
  const prices = yaml.parse(fs.readFileSync("price.yml", "utf8")) || {};

  const effects = [
    "SPEED",
    "SLOWNESS",
    "HASTE",
    "MINING_FATIGUE",
    "STRENGTH",
    "JUMP_BOOST",
    "NAUSEA",
    "REGENERATION",
    "RESISTANCE",
    "FIRE_RESISTANCE",
    "WATER_BREATHING",
    "INVISIBILITY",
    "BLINDNESS",
    "NIGHT_VISION",
    "HUNGER",
    "WEAKNESS",
    "POISON",
    "WITHER",
    "HEALTH_BOOST",
    "ABSORPTION",
    "SATURATION",
    "GLOWING",
    "LEVITATION",
    "LUCK",
    "BAD_LUCK",
    "SLOW_FALLING",
    "CONDUIT_POWER",
    "DOLPHINS_GRACE",
    "BAD_OMEN",
    "HERO_OF_THE_VILLAGE",
    "DARKNESS",
    "TRIAL_OMEN",
    "RAID_OMEN",
    "WIND_CHARGED",
    "WEAVING",
    "OOZING",
    "INFESTED",
    "BREATH_OF_THE_NAUTILUS",
  ];

  const types = ["POTION", "SPLASH_POTION", "LINGERING_POTION", "TIPPED_ARROW"];

  let fixedCount = 0;

  effects.forEach((effect) => {
    types.forEach((type) => {
      const baseKey = `${type}:${effect}`;
      const extendedKey = `${type}:${effect}:EXTENDED`;
      const upgradedKey = `${type}:${effect}:UPGRADED`;

      const basePrice = prices[baseKey];
      const extendedPrice = prices[extendedKey];
      const upgradedPrice = prices[upgradedKey];

      // Fix EXTENDED < BASE
      if (basePrice && extendedPrice && extendedPrice < basePrice) {
        // Extended should be 125-135% of base
        const newExtendedPrice = Math.round(basePrice * 1.3);
        console.log(
          `Fixing ${extendedKey}: ${extendedPrice} → ${newExtendedPrice} (base: ${basePrice})`
        );
        prices[extendedKey] = newExtendedPrice;
        fixedCount++;
      }

      // Fix UPGRADED < EXTENDED
      if (extendedPrice && upgradedPrice && upgradedPrice < extendedPrice) {
        // Upgraded should be 140-170% of extended
        const newUpgradedPrice = Math.round(extendedPrice * 1.5);
        console.log(
          `Fixing ${upgradedKey}: ${upgradedPrice} → ${newUpgradedPrice} (extended: ${extendedPrice})`
        );
        prices[upgradedKey] = newUpgradedPrice;
        fixedCount++;
      }

      // Fix UPGRADED < BASE (missing extended)
      if (basePrice && upgradedPrice && !extendedPrice && upgradedPrice < basePrice) {
        // If extended is missing, upgraded should still be > base
        const newUpgradedPrice = Math.round(basePrice * 1.8);
        console.log(
          `Fixing ${upgradedKey}: ${upgradedPrice} → ${newUpgradedPrice} (base: ${basePrice}, no extended)`
        );
        prices[upgradedKey] = newUpgradedPrice;
        fixedCount++;
      }
    });
  });

  // Write fixed prices
  const yamlStr = yaml.stringify(prices);
  fs.writeFileSync("price.yml", yamlStr, "utf8");

  console.log(`\n✅ Fixed ${fixedCount} pricing inversions`);
  console.log(`📊 Total items: ${Object.keys(prices).length}`);
}

fixPricingHierarchy();
