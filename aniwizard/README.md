# ANIwizard

An anime-style idle/incremental wizard game. Tap your wizard, learn spells, and grow your mana to one **Krillion** (10^36 in ANIwizard lore).

Open `index.html` in any browser. It's a single file with no build step and no dependencies.

## How to play

- **Tap the wizard** to cast sparks. Each tap is worth 1 mana plus 5% of your mana/sec.
- **Spellbook:** 15 spells, from Spark Sprite to the Krillion Engine. Each spell's power doubles at 10, 25, 50, 100, 150… owned.
- **Limit Break:** The gauge fills as you tap and over time. When it's full, you get ×7 mana for 20 seconds with an anime cut-in.
- **Ascension:** Once a run reaches 1 Trillion mana, you can reset for Star Shards. You get one shard per digit past a trillion, and each shard **doubles** all mana.
- Progress autosaves in your browser. You also earn 50% of your mana/sec while away, up to 8 hours.

## Balance (simulated)

A simple bot tapping 3×/sec and buying the best-payback spell reaches its first ascension in about 35 minutes and one Krillion in about 3 hours over roughly 6 ascensions. The tuning knobs are near the top of the script: `baseCost` / `baseRate` growth (11× / 12× per tier), `COST_GROWTH` (1.15), `MILESTONES`, `shardMult` and `shardGain`.

From the browser console, `ANIwizard.state()` returns the live save, which helps with testing.
