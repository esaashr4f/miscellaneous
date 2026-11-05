# Project brief: "Smashline Compat", one Smashline that runs both pre-2.0 and 2.0 movesets

You're working with **Esa**, who has a modded Nintendo Switch and wants Super Smash Bros. Ultimate moveset mods to work. Everything below was worked out in a long earlier debugging session (crash logs, binary analysis, GameBanana/GitHub research). **Read the whole brief before doing anything.** Several obvious-looking paths have already been ruled out, and it records what's been verified and what's still an assumption.

---

## 0. How to work with Esa

- He prefers **step-by-step instructions** with exact file paths, and links where useful. Explain *why* briefly, but don't lecture.
- He's capable but not a programmer. **You** do the coding, building and reasoning. **He** copies files to the SD card, launches the game, and sends back crash logs and screenshots.
- **Don't make him check requirements or guess.** Check things yourself (repos, source, binaries) before asking him.
- **Keep his testing effort low.** Every failed launch costs him a slow automatic "corrupted data check" (unskippable, harmless, takes ages). So batch tests sensibly, and say exactly what to launch and what result to expect.
- Be honest about uncertainty, and own mistakes plainly. The earlier session made a few (see §9) and he noticed. He values straight answers.
- He has **no piracy interest**. Everything here is for his own legitimately owned copy.
- His only computer is a **Surface Laptop 3 (Windows)**. The SD card appears as **`D:`** when the Switch is in Hekate's USB mass-storage mode (Hekate → Tools → USB Tools → SD Card). That's much faster and safer than MTP/haze.

---

## 1. His setup (verified)

| Thing | Version / detail |
|---|---|
| Console | Original unpatched Switch (Erista V1), Hekate 6.5.4 + Atmosphère **1.12.1**, firmware **23.0.1**, CFW on **emuMMC** |
| Game | Super Smash Bros. Ultimate **13.0.5** (title ID `01006A800016E000`). The version string `13.0.5` appears in the TLS of every crash log. |
| SD card | 512 GB, FAT32 (chkdsk clean) |
| Skyline | Official latest release (build/module ID `EAA2C23A4AA1FABBEB98F389C47E0450570CAB0C`), **but with a custom patch applied by us**. See §2. **Never overwrite `exefs\subsdk9`.** |
| ARCropolis | **4.1.1** (4.1.x no longer bundles Skyline) |
| Plugins folder | `D:\atmosphere\contents\01006A800016E000\romfs\skyline\plugins\` |
| Plugins installed (all verified as official current builds by file size/hash) | `libarcropolis.nro` (4.1.1), `libnro_hook.nro` (0.4.0, 52 KB), `libparam_config.nro` (latest 6.5, 248 KB), `libone_slot_eff.nro` (13.0.5 build, 336 KB), `libstage_config.nro` (v1.1.1, 392 KB), `libthe_csk_collection.nro` (CSK 6.0.0, 3 Nov 2026, 1,480 KB), `libsmashline_plugin.nro` (**currently 2.0.0, 364,544 bytes**; about to be swapped to 1.6.8, 311,296 bytes) |
| Mods | `D:\ultimate\mods\` = active mods only. `D:\ultimate\mods_all\` = his library (some folders prefixed with `.`). **Never leave dotted/disabled mods inside `mods`.** Param Config scanned them and crashed (`2002-4802` on `nn::fs::OpenFile`), so the library lives outside `mods`. |
| Crash logs | `D:\atmosphere\crash_reports\*.log`. File name contains a Unix timestamp; Esa is in Europe/London (UTC+0 in Nov). |

**Important:** don't put backup `.nro` files inside the `plugins` folder, even renamed (e.g. `.off`). Keep backups elsewhere (e.g. `D:\plugin_backups\`).

---

## 2. Already fixed (don't undo, don't redo)

### 2a. Skyline patch-verify bug (we fixed it)
- **Symptom:** crash on boot, Data Abort at address `0x69`, PC = `Skyline + 0x4C58`, every time Smashline was in `plugins`.
- **Cause (verified by disassembling Skyline's `subsdk9`):** when Skyline writes a code patch, it maps a 0x1000-byte RW mirror of the target page and then verifies the mirror using an **8-byte** compare (`ldr x1,[x0]` at +0x4C38 / `ldr x0,[x0]` at +0x4C44). A 4-byte patch at `main + 0x3D3FFC`, the **last 4 bytes of a page** on 13.0.5, makes the 8-byte read run into the next page of the mirror region (`0x8065000`, a different mapping). The compare fails and Skyline deliberately aborts (`str w1,[0x69]` at +0x4C58).
- **Fix:** both loads changed to 4-byte (`ldr w1,[x0]` = `010040b9`, `ldr w0,[x0]` = `000040b9`). The NSO was rebuilt **uncompressed**, with segment SHA-256 hashes recomputed and hash-check flags kept. All three segment hashes validate, and the module ID/name are unchanged.
- **Result:** Smash boots with Smashline. Esa is using this patched `subsdk9`.
- He may file a GitHub issue on `skyline-dev/skyline` about it (a draft was written).

### 2b. Other things already sorted
- Old/broken Bandana Dee copy deleted. CSK's extra config folders moved out (optional, not needed).
- Param Config crash solved by keeping dotted mods out of `mods`.
- Old Blaze (fire_|nolan, 2024) identified as a crasher. Esa is downloading the newer Blaze (TheS0nicGuy, GameBanana 714915, Sept 2026).

---

## 3. The current problem

**Smashline v2.0.0** (released 28 Oct 2026, "Cloning experiments", PR #87) **changed the API** for weapon cloning. The release notes say: *"Movesets built using previous versions of smashline may not be compatible with this update!"* The wiki page **"[READ!] Major Update Information"** says plugins using the **old `clone_weapon` / `update_weapon_count` definitions will CRASH** on the new Smashline.

- Repo: https://github.com/HDR-Development/smashline
- Releases: https://github.com/HDR-Development/smashline/releases (v2.0.0 = 364,544 bytes; v1.6.8 = 311,296 bytes; v1.6.7 = first 13.0.5 build; **1.6.7+ only run on 13.0.5**)
- Wiki: https://github.com/HDR-Development/smashline/wiki/%5BREAD!%5D-Major-Update-Information

### API changes (from the wiki, verbatim semantics)

**clone_weapon**
```rust
// OLD (<= 1.6.8)
let generate_id_add = clone_weapon(
    "mario",                      // Original Article Owner
    *WEAPON_KIND_MARIO_FIREBALL,  // Original Article ID
    "sonic",                      // Cloned Article Owner
    "fireball",                   // Cloned Article Name
    true                          // Use Original ACMD/Status Scripts
);  // returned generate_id_add, which the plugin handled itself

// NEW (2.0.0)
let fireball = clone_weapon(
    "sonic",                      // Cloned Article Owner
    "fireball",                   // Cloned Article Name
    *WEAPON_KIND_MARIO_FIREBALL,  // Original Article ID
    true                          // Use Original ACMD/Status Scripts
);  // returns a CloneWeapon struct containing weapon_id and generate_id
```

**update_weapon_count**
```rust
// OLD
update_weapon_count(*WEAPON_KIND_MARIO_FIREBALL /*Article ID*/, 10 /*max count*/);
// NEW
update_weapon_count(*FIGHTER_KIND_MARIO /*Fighter ID*/, *FIGHTER_MARIO_GENERATE_ARTICLE_FIREBALL /*Generate Article ID*/, 10);
```

**whitelist_kirby_copy_article:** same signature, but the second argument's *meaning* changed from **Weapon ID** (old) to **Generate Article ID** (new). Using it the old way is "undefined/unintended behavior".

**Behavior changes in 2.0:**
- `use_original_code = false` now **disables param remapping**.
- `use_original_code = true` warns in some duplicate-clone situations.
- New APIs: `replace_fighter_vtable`, `replace_fighter_vtable_costume`, `replace_weapon_vtable`, `get_original_fighter_vtable`, `get_original_weapon_vtable`, `enable_weapon_module`, `clone_article_descriptor`.

### Crash signature of an old moveset on 2.0 (verified, several logs)
- Data Abort at a small address (`0x30`, `0x5a`, `0xb9`), PC = `smashline + 0x55d8`, LR = `smashline + 0x1bfcc` (`smashline_clone_weapon + 0x340`) in the 2.0.0 binary.
- `smashline + 0x55a4` is the core `str::from_utf8` validation loop. At `+0x1bfc8`, `clone_weapon` validates a string from (ptr=`x20`, len=`x23`). In the crash, **X1 = 0x30** (bogus pointer) and X2 = a huge value (bogus length). That's what you'd expect when an old-ABI caller puts an `i32` weapon kind where 2.0 expects a string.

---

## 4. Analysis of Esa's movesets (method + results)

### Important finding about linking
Movesets **do not import Smashline functions through the dynamic symbol table.** The `smashline_*` names appear as **string literals in `.rodata`**, not in `.dynstr`/`.dynsym`. So moveset plugins (or the Smashline API crate they're built with) **resolve Smashline functions at runtime by name** (probably `nn::ro::LookupSymbol` or Skyline's symbol lookup).

**Verify this** in the smashline API crate source (whatever crate movesets depend on, likely `smashline` in the repo or a separate `smashline` crate). This matters a lot for the design, because:
- Symbol names alone can't be versioned. Old and new movesets both look up the **same name** `smashline_clone_weapon`.
- But if lookup is by name, a compat build **could export extra names**, if it ever helps.

Method used: `strings` on each moveset's `plugin.nro`, `grep -oE "smashline_[a-zA-Z0-9_]+"`, compared against names present in the official 1.6.8 and 2.0.0 binaries.

### Names present in official binaries
- **1.6.8:** `smashline_clone_weapon`, `smashline_update_weapon_count`, `smashline_get_original_acmd`, `smashline_get_original_status` (plus the rest of the base API)
- **2.0.0 adds:** `smashline_clone_article_descriptor`, `smashline_enable_weapon_module`, `smashline_get_original_fighter_vtable`, `smashline_get_original_weapon_vtable`, `smashline_replace_fighter_vtable`, `smashline_replace_fighter_vtable_costume`, `smashline_replace_weapon_vtable`

### Esa's mods, classified
| Group | Mods | Notes |
|---|---|---|
| **No clone_weapon/update_weapon_count at all** (should work on either) | Alucard, Blood Falcon, Ichiban Kasuga, Krystal, Phosphora, Shadow, Thwomp, Ultron, Spider-Man, Vegeta, Mega Man X | Alucard + Blaziken booted fine on 2.0 |
| **Uses 2.0-only names** (built for 2.0) | **Blaziken** (`replace_fighter_vtable_costume`), **Goomba** (`replace_fighter_vtable`, `get_original_fighter_vtable`, also clone_weapon + update_weapon_count), **Monster Hunter** (`enable_weapon_module`, `get_original_weapon_vtable`, `replace_weapon_vtable`, `replace_fighter_vtable_costume`, clone_weapon), **Phoenix Wright** (same family as MH, clone_weapon) | Blaziken works on 2.0. Note Goomba's *folder* is dated Oct 2025 but references 2.0 names, so names may be looked up optionally. Verify how the API crate handles missing symbols. |
| **Uses clone_weapon, no 2.0-only names** (probably old ABI; a set of Thwomp, Herobrine, Waluigi, Tails and Iron Man crashed 1.6.8 with the new-caller signature. **Herobrine (updated 5 Nov) is the prime suspect for being NEW-ABI**; confirm by testing.) | Iron Man, Herobrine, Waluigi, Tails, Hilda, Meiling, Sailor Moon, Shadow Mewtwo, Lati(os/as), Chaos, Conker, Knuckles, Magolor, Sans, Silver, Funky Kong, Kamek, Decidueye, Diluc, Electivire, Machamp, Mona, Naruto, Zeraora; old Blaze also crashed in clone_weapon | **Herobrine and Lati were updated 5 Nov 2026**, so they could be new-ABI without using other 2.0 names. Determine per binary (see §6). |
| **Needs functions in neither release** | **Tetrimino**: `smashline_install_lvd_edit_costume`, `smashline_update_weapon_count_costume` | Check smashline `master`/branches/PRs for these. If they exist unreleased, building from master may support Tetrimino. Every crashing batch so far contained Tetrimino. |

Esa can provide all moveset `plugin.nro` files (he zipped them once; the PowerShell command is in §8). You can analyse them locally on his laptop.

---

## 5. Goal

Build a **single `libsmashline_plugin.nro`** that:
1. Is based on the **latest Smashline source** (2.0.0 or newer `master`, ideally including the Tetrimino functions if they exist).
2. Runs on **SSBU 13.0.5** with his patched Skyline + ARCropolis 4.1.1 + the plugins above.
3. Supports **new-ABI movesets natively** (Blaziken, Goomba, Monster Hunter, Phoenix Wright).
4. Supports **old-ABI movesets** (≤1.6.8 `clone_weapon`, `update_weapon_count`, `whitelist_kirby_copy_article`) by detecting the old calling convention and translating to the new implementation, **returning what old callers expect** (old `clone_weapon` returned `generate_id_add`).
5. Doesn't regress anything else.

Stretch: also support Tetrimino's functions (if they're in master).
Stretch 1b: **legacy functions from older Smashline 2 releases.** Esa's 2024-era movesets (Decidueye, Diluc, Electivire, Machamp, Mona, Naruto, Zeraora) reference `smashline_install_symbol_hook` and `smashline_test`; Spider-Man and Meiling reference `smashline_test`. **Neither name exists in 1.6.8 or 2.0.0.** Use `git log -S "install_symbol_hook"` / `git log -S "smashline_test"` in the smashline repo to find when they existed, what they did, and why they were removed, then re-add them (or safe stubs) in the compat build. Caveat to tell Esa: these mods may *also* contain their own hard-coded game offsets for pre-13.0.5 Smash. A Smashline-side fix can't solve those, so some may still crash after the functions are restored. Test them one at a time.
Stretch 2: if it works well, consider offering it upstream as a PR (compat layer), since many users are hitting this.

---

## 6. Design notes and ideas (to verify against real source)

### Step 1: get the facts from source first
- Clone `HDR-Development/smashline`. Check out tags `v1.6.8` and `v2.0.0`, plus `master`.
- Find the **exported** `extern "C"` definitions of `smashline_clone_weapon`, `smashline_update_weapon_count` and `smashline_whitelist_kirby_copy_article` in both versions. Note the **exact FFI types**: how strings are passed (a `StringFFI`-style `{ptr,len}` struct? `*const u8 + usize`? C string?), and the return type of the new `clone_weapon` (struct size → returned in registers or via the `x8` indirect-result pointer per AArch64 AAPCS64).
- Find the **API crate** movesets use (the code that turns `clone_weapon("sonic", ...)` into the FFI call and looks up the symbol). Confirm runtime-by-name lookup (§4).
- Check `master` for `install_lvd_edit_costume` / `update_weapon_count_costume`.
- Check the repo **licence** before redistributing anything.

### Step 2: telling old from new callers
Options, in rough order of robustness:

1. **Argument-shape detection inside `clone_weapon`** (likely workable). Under AAPCS64, if strings are passed as two-register `{ptr,len}`:
   - OLD: `x0,x1` = original owner str; `w2` = original weapon kind (**small int**, < ~0x1000); `x3,x4` = new owner str; `x5,x6` = new name str; `w7` = bool.
   - NEW: `x0,x1` = owner str; `x2,x3` = name str (**`x2` is a pointer**, a large address like `0x1x_xxxx_xxxx`); `w4` = weapon kind; `w5` = bool; return via `x8` if the struct is > 16 bytes.
   - So `x2 < 0x10000` ⇒ old ABI. Confirm the real FFI layout first, because this assumes string-by-value.
   - **VERIFIED for 1.6.8 (disassembly of official v1.6.8, `smashline_clone_weapon` at file offset 0x20e84):** prologue saves `x0,x1` (str 1 ptr,len), `w2` (kind), `x3,x4` (str 2 ptr,len), `x5,x6` (str 3), `w7` (bool), then runs `from_utf8` on (x0,x1), then on (x3,x4). A **new-ABI caller on 1.6.8** crashed with Data Abort at address **0x5** (PC `smashline+0x540c` in the utf8 loop, LR `smashline_clone_weapon+0xa0`). That's the new caller's name-string *length* sitting in `x3` and being used as a pointer. So strings really are passed as two-register `{ptr,len}` pairs, and the register-shape discriminator is sound in both directions.
   - Implementation: the exported symbol receives raw registers. Probably cleanest as a small **naked/asm trampoline** that captures `x0–x8` (including `x8`, the indirect-result register, which isn't a normal argument in Rust) and dispatches to `clone_weapon_old(...)` or `clone_weapon_new(...)`.
2. **Per-caller-module ABI detection.** Use `LR` (return address) → find which loaded module called (Skyline/nn::ro module list). Classify the module once (from its first `clone_weapon` call shape, or by scanning its rodata for 2.0-only API names) and remember it. Use that classification for `update_weapon_count` and `whitelist_kirby_copy_article`, where argument shape is **ambiguous**:
   - `update_weapon_count` old `(weapon_kind, count)` vs new `(fighter_kind, generate_article_id, count)`: all small ints, so shape alone is unreliable. The `w2` register is garbage for old callers.
   - `whitelist_kirby_copy_article`: same signature, different meaning. **Only** caller classification can fix it.
3. **Config-file override** as a safety net: `sd:/ultimate/smashline_compat.toml` listing module/plugin names forced to old or new ABI. Lets Esa fix a misdetected moveset without a rebuild.

### Step 3: implementing old behaviour on top of 2.0
- Old `clone_weapon` returned `generate_id_add`. Work out from 1.6.8 source what that number meant, and compute it from the 2.0 `CloneWeapon` struct (which contains `weapon_id` and `generate_id`).
- Old `update_weapon_count(weapon_kind, count)`: map weapon kind → owning fighter kind + generate-article ID using 2.0's internal tables, then call the new path.
- Old `whitelist_kirby_copy_article(fighter, weapon_id)`: convert weapon ID → generate article ID.
- Param remapping semantics changed (`use_original_code`). Decide whether old callers should get 1.6.8-like behaviour. Document what you chose.

### Step 4: logging
Add clear logging (Skyline logger / `println!` via Skyline's TCP logger, and/or a log file on SD such as `sd:/ultimate/smashline_compat.log`). Record each caller module and the ABI it was detected as. This makes his test rounds much more informative.

---

## 7. Build environment (Windows laptop)

- Install Rust via **rustup**, then **cargo-skyline** (`cargo install cargo-skyline`). Use whatever nightly/toolchain the smashline repo pins (check `rust-toolchain`/`rust-toolchain.toml`). `cargo skyline` downloads the Skyline std toolchain from GitHub.
- Build: `cargo skyline build --release`. Output is usually `target/aarch64-skyline-switch/release/libsmashline_plugin.nro`.
- **Sanity check first:** build unmodified `v2.0.0` and compare its size to the official release (364,544 bytes) and, if possible, its behaviour, before changing anything. That proves the toolchain.
- Git, a text editor, and (optional) a disassembler such as Ghidra or `capstone` in Python are helpful.

---

## 8. Test plan with Esa

**Before any test:** Hekate → USB Tools → SD Card (drive `D:`), copy files, safely eject, then boot **CFW (emuMMC)** from Hekate.

1. **Toolchain proof:** unmodified build of 2.0.0 (or master) replaces `libsmashline_plugin.nro`. Launch with **Alucard + Blaziken + Thwomp** (known-good on 2.0). Should boot and play.
2. **Old-ABI test:** compat build. Launch with **Waluigi + Iron Man** (old-ABI clone users, updated Oct/May 2026). Play a match with each. Then add **Herobrine, Tails**.
3. **New-ABI test:** compat build with **Blaziken + Goomba (re-downloaded) + Monster Hunter + Phoenix Wright**.
4. **Mixed:** old + new together.
5. **Tetrimino** (only if master has its functions).
6. **Blaze (new TheS0nicGuy version)**, alone.

For each crash, ask for the **newest `.log` in `D:\atmosphere\crash_reports\`**. Smashline panics also show a message on screen ("smashline has panicked: …"). Ask for a photo.

Command to collect all moveset `plugin.nro` files for analysis (PowerShell, not Command Prompt):
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\Desktop\nros"
Get-ChildItem D:\ultimate -Recurse -Filter *.nro | ForEach-Object { Copy-Item $_.FullName ("$env:USERPROFILE\Desktop\nros\" + $_.FullName.Split('\')[3] + "_" + $_.Name) }
```

Keep official `1.6.8` and `2.0.0` builds as backups **outside** the plugins folder, so he can always fall back.

---

## 9. Lessons from the earlier session (avoid repeating)

- **Verify versions by hash/size, not by "latest" links.** The earlier session hashed his Smashline against the GitHub "latest" asset, assumed that was 1.6.8, and told him it matched 1.6.8. It was actually 2.0.0. This cost a lot of time.
- **Crash logs are gold.** Atmosphère logs include module lists, PC/LR with module offsets, and stack dumps. Read them before guessing.
- Don't blame things Esa has already ruled out. Remember what he tells you.
- Disabling mods with a leading dot stops ARCropolis loading them, **but other plugins (Param Config) still scan them**. Keep the library outside `mods`.
- Tell him time-saving tricks up front (e.g. the dot trick, Hekate USB mode for fast file moves).
- `2002-4802` (fs DataCorrupted range) came from Param Config / ARCropolis opening odd files, not real SD corruption (chkdsk was clean).

---

## 10. Other known mod notes (for context)
- **Iron Man** (GameBanana 660142): over Mario c48–c55. Known bugs: crashes if a 5th player is present when he wins, conflicts with mods on Mario c00, Down B crash reports.
- **Conker:** Down B reflect crash, clashes with Iron Man (arrow).
- **Sans:** crash/freeze reports on 13.0.5.
- **Mega Man X:** crash when projectiles hit (reported with updated CSK).
- **Chaos, Knuckles, Magolor, Machamp, Naruto:** crash reports on 13.0.5, unfixed.
- **Piranha Plant (vanilla):** one mid-match crash inside `lua2cpp_pickel.nrs` via `smashline_interpreter` on 2.0.0. Possibly a Smashline 2.0 issue. Worth testing on the compat build.
- **CSS 91-255** (GameBanana 573626): UI layout only. Add on its own when the roster outgrows the select screen.

Good luck. Keep Esa informed in plain language, and keep each test round worth the launch.
