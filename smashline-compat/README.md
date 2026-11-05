# Smashline Compat

One `libsmashline_plugin.nro` that runs both **pre-2.0 (≤ 1.6.8)** and **2.0** movesets on
SSBU 13.0.5. It is official Smashline **v2.0.0** (= current `master`, commit `642dd17`) plus
`smashline-compat.patch` from this folder.

Status: **code written and logic unit-tested, not built or run on hardware yet.**

## What it does

Movesets look up Smashline functions **by name at runtime** (`nn::ro::LookupSymbol`, lazily on
first call). Old and new movesets therefore call the same symbols. Only three of them changed in 2.0
(commit `d9bee02`, 21 Sep 2026):

| function | ≤ 1.6.8 | 2.0 |
|---|---|---|
| `smashline_clone_weapon` | `(orig_owner, orig_kind, new_owner, new_name, use_original_code) -> index` | `(owner, name, orig_kind, use_original_code) -> {generate_id, weapon_id}` |
| `smashline_update_weapon_count` | `(weapon_kind, count)` | `(fighter_kind, generate_article_id, count)` |
| `smashline_whitelist_kirby_copy_article` | `(fighter_kind, weapon_kind)` | `(fighter_kind, generate_article_id)` |

All other imports have identical signatures in both versions (checked by diffing the API crate).

The compat build replaces those three exported symbols with small assembly stubs that record
**who called** (return address → calling module), then decide per call:

* **clone_weapon:** decided by register shape. Strings are `{ptr,len}` register pairs, so `x3` is a
  pointer for old callers and a short length for new ones. This is the same fact behind both crash
  signatures (old moveset on 2.0: X1=0x30; new moveset on 1.6.8: fault at 0x5).
* **update_weapon_count / kirby whitelist:** decided by the calling module's ABI, in this order:
  1. an override in `sd:/ultimate/smashline_compat.txt`
  2. the signature that module used for `clone_weapon`
  3. the **smashline git revision embedded in the moveset**. Rust panic paths contain
     `.../git/checkouts/smashline-<hash>/<rev>/...`; all 209 known revisions are classified.
  4. 2.0-only API names in the module
  5. otherwise argument plausibility, defaulting to the old meaning

Old callers then get **1.6.8 behaviour on top of the 2.0 engine**:

* `clone_weapon` returns the old 0-based index, so `FIGHTER_X_GENERATE_ARTICLE_Y += clone_weapon(...)`
  (the pattern Waluigi, Meiling, Hilda and Sailor Moon all use) gives the right ID.
* Clone params are always remapped `param_<original>` → `param_<clone>`, as on 1.6.8. (2.0 only
  does this with `use_original_code = true`.)
* Weapon counts and the Kirby whitelist are keyed by weapon kind, and apply to vanilla articles of
  that kind and to old-style clones made from it (1.6.8 semantics).
* **Weapon kind emulation.** On 1.6.8 a clone kept the original weapon kind; 2.0 gives it a new one.
  Old code like Waluigi's `get_kind(weapon) == WEAPON_KIND_MARIO_FIREBALL` would silently stop
  matching. For old modules only, their own import slots for `app::utility::get_kind` and
  `app::sv_battle_object::kind` are redirected so their clones report the original kind again.
  Nothing in the game is hooked for this, and other plugins are unaffected.
* 2.0's "check your clone_weapon calls" popups are written to the log instead of shown for old
  callers. The patterns they warn about were normal on 1.6.8.

New callers go straight to the unmodified 2.0 code.

### Log and config

* Log: **`sd:/ultimate/smashline_compat.log`** is rewritten on every boot. It lists each calling
  module, the ABI it was classified as and why, and every translated call. Send this after each test.
* Optional config: `sd:/ultimate/smashline_compat.txt`
  ```
  # force a module (name as shown in the log) to an ABI
  old waluigi
  new herobrine
  # turn the weapon-kind emulation off if it causes trouble
  kind_remap off
  ```

## Not covered / known limits

* **Tetrimino:** `smashline_install_lvd_edit_costume` / `smashline_update_weapon_count_costume`
  don't exist anywhere in Smashline's history, branches or PRs. It was built against an
  unpublished fork. It will still panic with "Could not find …" when it calls them.
* **`smashline_test`** (2024 movesets, Spider-Man, Meiling) is **not a function**. It is the crate/module
  name of the Smashline example template (`#[skyline::main(name = "smashline_test")]`).
* **`smashline_install_symbol_hook`** is declared in the API crate but **no Smashline plugin has ever
  implemented it** (every commit checked). A moveset that called it would have failed on every
  version, so those mods don't call it at startup. The log notes modules that reference it.
* Old code that reads the kind straight from memory (`(*weapon).battle_object.kind`) still sees the
  2.0 kind. Only the two kind functions are redirected.
* Param Config edits keyed by a weapon kind (e.g. Meiling's `-WEAPON_KIND_FOX_BLASTER_BULLET`) are
  matched by Param Config itself, not by Smashline, so they may not reach 2.0-style clones.
* Movesets with their own hard-coded pre-13.0.5 offsets will still crash in their own code.

## Building (Windows)

1. Install **Rust** from https://rustup.rs (accept the Visual Studio Build Tools prompt) and
   **Git** from https://git-scm.com.
2. In PowerShell:
   ```powershell
   cargo install cargo-skyline
   git clone https://github.com/HDR-Development/smashline.git
   cd smashline
   git checkout v2.0.0
   cargo skyline build --release
   ```
   That is an **unmodified** build. `target\aarch64-skyline-switch\release\libsmashline_plugin.nro`
   should be close to the official 364,544 bytes. Keep it: it proves the toolchain.
3. Apply the patch and rebuild:
   ```powershell
   git apply path\to\smashline-compat\smashline-compat.patch
   cargo skyline build --release
   ```

## Test plan

Copy files in Hekate USB mode (Tools → USB Tools → SD Card), keep the official 1.6.8 / 2.0.0 nros
in `D:\plugin_backups\` (never in `plugins`), and never touch `exefs\subsdk9`.
After each launch, send `D:\ultimate\smashline_compat.log`, plus the newest
`D:\atmosphere\crash_reports\*.log` if it crashed.

1. **Compat build, known-good set:** Alucard + Blaziken + Thwomp. Expect boot and play.
2. **Old ABI:** Waluigi + Iron Man, one match each. Then add Herobrine + Tails. The log shows which
   ABI each was detected as. Herobrine is expected to come out as **New**.
3. **New ABI:** Blaziken + Goomba + Monster Hunter + Phoenix Wright.
4. **Mixed:** old + new together.
5. **Blaze** (new TheS0nicGuy version) alone.
6. 2024 movesets one at a time (they may have their own pre-13.0.5 offsets).
