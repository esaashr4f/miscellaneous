# Glance

A Tesla overlay plus a background sysmodule for Atmosphère. While a game is running, you open the overlay, Glance captures the screen, sends it to Claude, and shows the reply on top of the game. The main use is language learning: translate the text on screen and explain the grammar.

> **Status: v0.0.3, hardware spike (milestones M0 to M3).**
> This build is a test panel. Its job is to prove the risky parts on a real console before the real app is built on top of them. Section 5 has the test steps. Run them, then send back `/config/glance/glance.log` and the `capture_*.jpg` files.

---

## 1. How it works

```
 ┌─────────── glance.ovl (Tesla overlay) ──────────┐       ┌────────── glance-sys (sysmodule) ──────────┐
 │ buttons, "thinking…" state, wrapped reply text   │  IPC  │ capture (caps:sc) → HTTPS (curl + ssl svc) │
 │ tiny heap, never touches network or images       │ ────► │ → Claude API → reply text                  │
 └──────────────────────────────────────────────────┘ "glance" └──────────────────────────────────────────┘
```

**Why there are two parts.** A Tesla overlay gets a small heap, and it is frozen whenever it is hidden. If the overlay did a 10-second HTTPS request itself, its UI would freeze. Closing the overlay would also kill the request. The sysmodule runs all the time on core 3, the system core that games don't use, so it does the slow work. The overlay just asks for a job and polls for the result.

**IPC design.** Every command returns immediately (`common/glance_ipc.h`):

| Cmd | Name | What it does |
|---|---|---|
| 0 | `GetVersion` | Returns the IPC version, so mismatched builds are detected |
| 1 | `StartJob(job, arg)` | Queues work on the worker thread. Returns `Busy` if a job is already running |
| 2 | `GetStatus` | Returns state, stage (`Capturing` / `Network`), elapsed time and result length |
| 3 | `GetResult` | Copies the UTF-8 result text into a buffer the overlay provides |

M4 adds an `Ask(presetId)` job on top of the same mechanism.

**Decisions that differ from the original brief, and why:**

- **No mbedTLS and no CA bundle.** devkitPro's `switch-curl` uses curl's *libnx* TLS backend. That backend hands TLS to the console's own `ssl` system service, which uses Nintendo's built-in trust store. This saves a lot of sysmodule heap, and there is no `cacert.pem` to keep up to date. If a root certificate is ever missing, you can still point `[debug] ca_file=` at a PEM file.
- **The overlay blanks itself during capture.** libtesla adds its layer to *every* vi layer stack, including Screenshot and ApplicationForDebug. Picking a different layer stack therefore can't keep the panel out of the image. Instead, the overlay draws a fully transparent frame for a few frames, and stays blank while the sysmodule reports `stage == Capturing`.
- **Networking starts only when needed.** Sockets are opened for each job and closed afterwards. Sockets reserve about 0.5 MB of transfer memory, so this keeps idle cost close to zero.
- **libtesla is vendored and patched.** Upstream libtesla loads the Korean font only when the console language is Korean, so Hangul would show as blanks on an English console. The patch is described in `overlay/lib/libtesla/VENDORED.md`.
- **Hand-written IPC server** (`sysmodule/source/ipc_server.c`, about 150 lines over libnx's HIPC helpers) instead of Atmosphère's libstratosphere. Four tiny commands don't justify a large C++ framework. sys-clk uses the same approach.

## 2. Repository layout

```
common/glance_ipc.h          IPC contract shared by both sides
sysmodule/                   glance-sys  → exefs.nsp
  glance-sys.json            NPDM: program ID, service access, core 3, priorities
  toolbox.json               lets ovl-sysmodules toggle it
  source/main.c              heap, service init, command dispatch
  source/ipc_server.c        minimal CMIF server
  source/jobs.c              worker thread, job state machine
  source/net.c               nifm check, sockets, curl wrapper
  source/capture.c           caps:sc JPEG capture + caps:a album fallback
  source/selftest.c          the M1–M3 test jobs
  source/config.c, log.c     INI parser, SD log
overlay/                     glance.ovl
  source/main.cpp            test panel UI
  source/wrapped_text.hpp    word-wrapping, scrollable text element (CJK-aware)
  source/glance_client.c     IPC client
  lib/libtesla/              vendored libtesla (patched)
sd-template/                 files copied as-is to the SD card
Makefile                     make / make dist / make clean
```

## 3. Building on Windows

1. Install devkitPro with the [graphical installer](https://github.com/devkitPro/installer/releases). Tick **Switch Development**.
2. From the Start menu, open **devkitPro → MSYS2**, then install the libraries:
   ```bash
   pacman -Syu
   ```
   ```bash
   pacman -S switch-dev switch-curl switch-zlib
   ```
3. Build the project:
   ```bash
   cd /c/path/to/miscellaneous
   ```
   ```bash
   make dist
   ```
   `make dist` builds both parts and creates `dist/`, a folder laid out exactly like the root of the SD card. If `zip` is installed, it also creates `glance-<version>.zip`.

The build was verified with libnx 4.12.0 and switch-curl 7.69.1 (the `devkitpro/devkita64` Docker image). If you have Docker, this command builds the same thing on any OS:

```bash
docker run --rm -v "$PWD":/src -w /src devkitpro/devkita64 make dist
```

## 4. Installing

**Prerequisites on the SD card:**
- **nx-ovlloader** and a Tesla-compatible menu: **Tesla-Menu**, or **Ultrahand Overlay** (actively maintained, loads the same `.ovl` files). If Tesla-Menu won't open on the latest firmware, try Ultrahand. Part of M0 is confirming which one works for you.
- Optional: **ovl-sysmodules**, to turn glance-sys on and off without rebooting.

**Copy the files.** Use Hekate → Tools → USB Tools → SD Card (UMS), or ftpd. Drag the *contents* of `dist/` onto the root of the SD card:

```
SD:/atmosphere/contents/4200000000474C43/exefs.nsp
SD:/atmosphere/contents/4200000000474C43/flags/boot2.flag
SD:/atmosphere/contents/4200000000474C43/toolbox.json
SD:/switch/.overlays/glance.ovl
SD:/config/glance/config.ini.example
```

Then rename `config.ini.example` to `config.ini` and fill in your key. Do this **on the SD card**, so a later drag-and-drop can't overwrite your key. Reboot into Atmosphère (emuMMC).

**Uninstall:** delete `SD:/atmosphere/contents/4200000000474C43/` and `SD:/switch/.overlays/glance.ovl`. Optionally delete `SD:/config/glance/` too.

### API key safety
- The key is stored **in plain text** on the SD card. Anyone with the card can read it.
- Create a dedicated key for Glance, and set a **monthly spend limit** in the Anthropic Console (Settings → Limits). One request costs a fraction of a cent to a few cents, depending on the model.
- glance-sys never writes the key to the log. The log only says whether a key is set.

### Network
Glance only ever contacts the host in `test_url`, and later `api.anthropic.com`. It never contacts Nintendo. Your DNS-MITM hosts file must **not** block `api.anthropic.com`.

## 5. Hardware test plan (do these in order)

Open the overlay with the Tesla combo (default **L + D-pad Down + right stick press**) and choose **Glance**.

| Milestone | Action | Expected | If it fails |
|---|---|---|---|
| **M0** | Open the overlay | Panel opens. The *Font check* section shows Japanese, Korean, Spanish and French with no blanks or boxes | Overlay doesn't open: problem with the menu or loader version, try Ultrahand. Blank Korean: tell me (font patch) |
| **M1** | Check the top line, then press **Ping sysmodule** | "Connected (IPC v1)", then `pong …` with uptime, heap use and clock | "Not running": check that the folder name is exactly `4200000000474C43`, reboot, and read `glance.log` (missing file = the sysmodule never started) |
| **M2** | **Test HTTPS**, first without a key, then with one | `HTTPS OK: HTTP 401` without a key, `HTTP 200` with a valid key | DNS error: the host is blocked. TLS error: check that the console clock is correct. "No connection": Wi-Fi is off |
| **M3** | Start a game, open the overlay, press **Test screen capture** | The panel disappears for about a second, then lists `default / screenshot / appdebug` with sizes in KB | Note which stacks failed and their codes. Then press the Capture button once and run the test again: the *album* line tests the fallback |

Run M3 in **handheld and docked** mode. Afterwards, copy these files to the PC and send them back:

- `SD:/config/glance/glance.log`: every step, with result codes, timings and heap use.
- `SD:/config/glance/capture_default.jpg`, `capture_screenshot.jpg`, `capture_appdebug.jpg`, `capture_album.jpg`. Check that each shows the game **without** the overlay panel, and that the image isn't black.

These results decide the M4 capture path, the sysmodule heap size, and whether the image needs downscaling before upload.

## 6. Troubleshooting

- **Console hangs at boot after installing:** boot Hekate, mount the SD card over UMS, and delete `atmosphere/contents/4200000000474C43/flags/boot2.flag`. Then send me the log.
- **`glance.log` is empty or missing:** the sysmodule didn't start. Check the folder name and that the file is called `exefs.nsp`.
- **Overlay says "IPC vX != vY":** the overlay and sysmodule come from different builds. Copy both files from the same `dist/`.
- **HTTPS error 60 / SSL errors:** check the system clock (Ping shows it). As a last resort, set `[debug] ca_file=sdmc:/config/glance/cacert.pem` with a PEM bundle.
- **Logs:** `glance.log` rotates to `glance.log.old` at 256 KB.

## 7. Roadmap

- **M4** (next, after the results above): `Ask(preset)` job → build the Messages API request (base64 JPEG + preset prompt, model and `max_tokens` from config) → parse `content[].text` → show it in the overlay. Clear messages for 401, 429/529, timeouts and bad JSON.
- **M5:** preset buttons from config, polished error states, a proper README section on usage.
- **M6 (v0.2):** structured translate mode (original → translation → note), a single "ask more" follow-up, and a history log at `/config/glance/history.md`.
