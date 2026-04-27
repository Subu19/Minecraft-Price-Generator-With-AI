Here is our new price.yml standard. You can use these keys to set specific prices for any item variation in the game:

1. Standard Items
Use the default Bukkit Material name.

Format: MATERIAL_NAME: PRICE
Example: DIAMOND: 500
2. Potions & Tipped Arrows
Includes the effect type and an optional modifier for Level II or Duration.

Format: MATERIAL:EFFECT[:MODIFIER]
Modifiers: UPGRADED (Level II), EXTENDED (Long Duration)
Examples:
POTION:STRENGTH: 150 (Normal)
POTION:STRENGTH:UPGRADED: 350 (Strength II)
SPLASH_POTION:POISON:EXTENDED: 200 (Extended Poison)
TIPPED_ARROW:SWIFTNESS: 45 (Normal Speed Arrow)
3. Enchanted Books
Specific pricing based on the enchantment and its level.

Format: ENCHANTED_BOOK:ENCHANT_NAME:LEVEL
Examples:
ENCHANTED_BOOK:SHARPNESS:5: 1500
ENCHANTED_BOOK:MENDING:1: 2000
ENCHANTED_BOOK:PROTECTION:4: 800
