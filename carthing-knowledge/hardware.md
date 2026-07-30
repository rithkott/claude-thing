# Spotify Car Thing ("superbird") hardware & low-level reference

**Key discovery: Spotify published real vendor sources.** `spsgsb/kernel-common` has the actual board device trees (`arch/arm64/boot/dts/amlogic/superbird_ep0.dts`, `superbird_evt_512.dts`, `superbird_evt_1024.dts`, `mesong12a_panel_superbird.dtsi`); `spsgsb/uboot` has U-Boot. Pins, keycodes, panel timings, I²C addresses below are read from those, not inferred. Full enumeration of what Spotify released (4 repos) + the leaked FIP signing key in [spotify-sources.md](spotify-sources.md).

## 1. Core hardware

| Item | Value |
|---|---|
| SoC | **Amlogic S905D2** (G12A family; BootROM banner `G12A:BL:`) |
| CPU | 4× Cortex-A53, OPP up to 1.8–1.908 GHz (`superbird_evt_512.dts:764-858`) |
| GPU | Mali-G31 — blob `libMali.so` only, no mesa/panfrost in any shipping image |
| RAM | **512 MB** DDR3L (retail). `evt_1024` (1 GB) / `ep0` (2 GB) DTs are pre-production boards |
| eMMC | **4 GB** Toshiba/Kioxia, HS200 8-bit |
| Display | **Sitronix ST7701S**, MIPI-DSI 2-lane, native **480×800 portrait**, 27.918 MHz pclk → 60.02 Hz. U-Boot `panel_type=lcd_8`. Compositor rotates 90° → apps see 800×480 |
| Backlight | PWM_F 30 kHz; `/sys/class/backlight/aml-bl/brightness`, **inverted: 1=brightest, 255=darkest** |
| Touch | **TLSC6x** on I²C0 @ 0x2e, 480×800. Vendor driver only — **no mainline driver exists** |
| Audio | **Capture only** — 4 PDM mics (card `AML-AUGESOUND`). **No speaker, no jack.** Used as `arecord -D hw:0,0 -f S16_LE -c 1 -r 16000` |
| Bluetooth | Cypress **CYW20706** on UART `/dev/ttyS1` @ 3 Mbaud (`brcm,bcm4345c0` compat). Reset GPIOX_17 (sysfs gpio 493). `btattach -P bcm`. MAC/serial from `/sys/class/efuse/{mac_bt,usid}` |
| **Wi-Fi** | **None usable — device is Bluetooth-only.** No SDIO node in any superbird DT; radio is BT-only. IP = USB RNDIS, BT-PAN, or external hardware |
| Sensors | ALS/prox **TMD2772** I²C2 @ 0x39 (prox disabled; ALS drives auto-brightness). Accelerometer in DT but NOT populated on retail. **MAX20332** USB-C mux @ 0x35 |
| USB | Single USB-C: power + Amlogic burn mode + gadget (RNDIS/ADB/mass-storage). Host mode works on mainline |

## 2. Input hardware — exact evdev contract

`superbird_evt_512.dts:159-223`:

```
gpio-keys-polled, poll-interval = 40ms
  preset1  GPIOA_0   KEY_1
  preset2  GPIOA_1   KEY_2
  preset3  GPIOA_2   KEY_3
  preset4  GPIOA_3   KEY_4
  mute     GPIOAO_3  KEY_M      (top-right "settings" button)
  back     GPIOA_5   KEY_ESC
  select   GPIOZ_7   KEY_ENTER  (dial press)

rotary@0  "rotary-encoder", GPIOZ_8/GPIOZ_9, gray encoding, steps-per-period 2
  linux,axis = 6 → REL_HWHEEL
```

In browser: `Digit1-4`, `KeyM`, `Escape`, `Enter`, dial → **`wheel` events with `deltaX`**. Rotary is `/dev/input/event1`, MUST be udev-tagged `ID_INPUT_MOUSE=1` or libinput drops it — most common "dial does nothing" bug. Long-press is entirely userspace. Keys polled at 40ms → fast double-taps can be missed, press timing quantized.

## 3. Boot / unlock

Boot modes (`superbird-tool`):
1. **USB Mode** — hold presets 1+4 while plugging in → `1b8e:c003 Amlogic GX-CHIP`, BootROM accepts signed BL2
2. **USB Burn Mode** — U-Boot 2015.01 Amlogic burn protocol; `bulkcmd` runs arbitrary U-Boot commands
3. Normal boot
4. `--boot_adb_kernel` — RAM-boot kernel with USB gadget (non-persistent)

**Unlock is not an exploit** — BootROM accepts Spotify's signed BL2/BL33 which drops to U-Boot shell over USB. Tools: `superbird-tool` (pyamlboot), Thing Labs **Terbium** (WebUSB in browser).

superbird-tool: `--burn_mode`, `--bulkcmd`, `--boot_adb_kernel A|B`, `--enable_uart_shell`, `--disable_avb2`, `--enable/disable_burn_mode`, `--disable_charger_check`, `--dump_device`/`--restore_device`, env get/set. Dump ~545 KB/s (~110 min full eMMC), write ~4.9 MB/s.

**UART:** pads exist, connector unpopulated — 10-pin 0.5mm FPC footprint (TE 1-2328702-0) next to USB-C + solderable pads. 115200 8N1, `console=ttyS0`, `earlycon=aml-uart,0xff803000`.

**HARD RULE: never run `fastboot flashing unlock` — bricks every device, no recovery.**

Modern recovery: `thinglabsoss/superbird-fip-tools` + Spotify's published `aml-user-key.sig` → sign custom FIP; `pyamlboot boot-g12a.py` boots mainline U-Boot from USB incl. **eMMC-as-USB-mass-storage mode** — eMMC contents no longer load-bearing for recovery.

## 4. Partition table (stock, Android A/B, mmcblk0p1..p18)

| p | name | size |
|---|---|---|
| 01 | bootloader | 4 MB |
| 02 | reserved | 64 MB |
| 04 | env | 8 MB |
| 05/06 | fip_a/b | 4 MB |
| 07 | logo | 8 MB |
| 08/09 | dtbo_a/b | 4 MB |
| 10/11 | vbmeta_a/b | 1 MB |
| 12/13 | boot_a/b | 16 MB (kernel+dtb) |
| 14/15 | **system_a/b** | ~516 MB (rootfs) |
| 16 | misc | 8 MB (A/B metadata) |
| 17 | settings | 256 MB |
| 18 | data | ~2.1 GB |

**Nocturne changes little:** only rootfs (both slots), U-Boot env, boot logo. Bootloader/fip/dtbo/boot (stock 4.9 kernel)/vbmeta stay stock.

Env diff stock → Nocturne: `avb2=1→0` (verified boot off), `bootcmd=run check_charger → run storeboot` (MAX20332 charger check bypassed — stock refuses boot on weak USB-C sources), adds preset-4-hold → burn mode, UART console always on, explicit A/B root selection, `nocturne.firstboot` flag.

## 5. Kernel situation

- Stock: Amlogic `aml-4.9` (4.9.113), **arm64 kernel + armv7 32-bit userspace**. Nocturne builds no kernel.
- Vendor sources: `spsgsb/kernel-common`, `spsgsb/uboot`. `frederic/superbird-buildroot` = Amlogic openlinux Buildroot (vendored in `reference/`).
- **Mainline now genuinely viable:** `alexcaoys/notes-superbird` maintains Linux 6.18 DT + patches — display/UART/keys/rotary/touch(vendor driver)/ALS/PDM audio/USB device+host/BT/backlight all working.
- Two mainline blockers: (a) **tlsc6x touch has no upstream** — carry vendor module forever; (b) GPIO-keys IRQ double-edge quirk → keys stay `gpio-keys-polled` 40ms. ST7701S panel IS mainline; 60 Hz needed a Meson DSI timing fix.
- Furthest along: `JoeyEamigh/yocto-superbird` — Yocto BSP, mainline kernel + mainline U-Boot 2026.07 with signed FIP, flashed via `flashthing-cli`. Also `thinglabsoss/superbird-uboot`.

## 6. Custom-software ecosystem — two architectures

**A. Stock firmware + swapped webapp + host companion** (thin client; PC supplies logic/internet over USB ADB/RNDIS + WS):
- **DeskThing** (ItsRiprod) — Electron server + app store
- **GlanceThing** (BluDood) — macro pad
- **pajowu/superbird-custom-webapp** — original: ADB-push webapp, bind-mount over `/usr/share/qt-superbird-app/webapp/` on stock firmware. Non-persistent, near-zero risk — **fastest path to running own UI**
- **err4o4 "Wall Thing"** — Debian 13 in `data` partition on stock kernel → Home Assistant kiosk
- Trade-off: trivial install, but useless without host plugged in.

**B. Full custom rootfs:**
- **Nocturne** — Buildroot + stock kernel; only one designed host-PC-free (phone BT supplies internet)
- **bishopdynamics/superbird-debian-kiosk** — Debian 11 + X11; needs permanent Pi Zero 2 W; Mali unusable under X11
- **JoeyEamigh/nixos-superbird** → superseded by **yocto-superbird** (mainline, "way more performance")
- **Thing Labs** = shared infra: superbird-tool fork, Terbium (WebUSB flasher), Thingify (image CDN — hosts the 8.9.2 stock image Nocturne pulls blobs from), fip-tools, uboot, reconstructed stock webapp, wiki.

**Recommendation:** prototype as (A) — panel/touch/dial/backlight free. Move to (B) when you need own daemon, BT, or mics. Going (B) long-term: target mainline path (yocto-superbird), not 4.9 vendor kernel.

## 7. MFi auth chip

Real hardware, Spotify-authored: `mfi@10 { compatible = "apple_mfi_auth"; reg = <0x10>; }` on I²C3 with dedicated `spotify_mfi_i2c_pins` pinmux (verified in vendored `superbird_evt_512.dts:1037-1044,1242`). Module `apple_mfi_auth_i2c`; udev mknods `/dev/apple_mfi`. Four ioctls: `0x80107704` cert len, `0x80107705` cert, `0x40107706` set 32B challenge, `0x80107707` get 64B response.

Note: the DTS node is public, but the **`apple_mfi_auth` kernel driver source was NOT found in Spotify's published kernel-common** — see [spotify-sources.md](spotify-sources.md) §2. Reimplementable in userspace over i2c regardless (Nocturne does this).

Gates **iAP2 auth only** — iPhone won't open EA session without it. Irrelevant for Android SPP, Pi/macOS connector, local UI. Genuine hardware advantage vs a Pi.

## 8. Quirks

- **Thermals:** 3 ADC thermal sensors, passive trips 60/75°C, **critical poweroff 85°C**. Hot car + heavy SPA = throttling. Budget accordingly.
- **Charger check** (stock): MAX20332 reg 0x3, unknown charger ID = "bad charger" logo + infinite spin. Nocturne removes; `--disable_charger_check` on stock.
- **eMMC wear:** 512 MB RAM + Chromium exercises the `/var/swapfile` constantly — main wear vector. Bound logs (Nocturne caps supervisord logs 1 MB × 3), avoid chatty `/var` writes.
- **Display timings fixed** — don't expect resolution/refresh changes.
- Burn-mode USB timeouts common: no hubs, retry, rear-IO ports.
- Spotify service shut down; stock app dead; disabling AVB2 kills Spotify OTA permanently — irrelevant, device EOL.
