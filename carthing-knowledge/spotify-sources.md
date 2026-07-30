# Spotify's open-source release + Amlogic reference sources

Two distinct things people conflate:
- **`spsgsb` GitHub org** = Spotify's actual GPL-compliance dump (kernel, U-Boot, BlueZ, swupdate).
- **`reference/superbird-buildroot`** (vendored here) = frederic's republish of **Amlogic's** G12A reference SDK — NOT Spotify's recipes. Full recursive grep for `superbird`/`tlsc6x`/`apple_mfi` across all 12 GB = 1 hit (its README). It's a toolchain to build *equivalent* software, not stock provenance.

## 1. The `spsgsb` org — exactly 4 repos

Bare GPL dump under a deliberately opaque name. Repos created 2020-06-16, content pushed once **2022-09-29**, never updated. No README, no branding, no announcement. Three share default branch `buildroot-openlinux-201904-g12a`.

| Repo | What | Branches | Superbird content |
|---|---|---|---|
| **spsgsb/uboot** | Amlogic vendor U-Boot fork (g12a) | default + `add-holitech-display`, `add-wily-display` | `board/amlogic/superbird_{development,production}/` + defconfigs + **the signing `.sig`** |
| **spsgsb/kernel-common** | Amlogic vendor Linux 4.9 kernel | same 3 | superbird DTS, `superbird_*_defconfig`, tlsc6x + PDM + backlight drivers |
| **spsgsb/platform-external-bluetooth-bluez** | BlueZ fork (stock BT stack) | default | stock A2DP/SPP path |
| **spsgsb/swupdate** | Fork of sbabic/swupdate | `master` + many `xdelta*` debug branches | stock OTA (heavy binary-diff work) |

The `add-holitech-display` / `add-wily-display` branches = **alternate LCD panel-supplier timings** (Car Thing shipped panels from multiple vendors).

**Not released by Spotify:** Buildroot tree, rootfs, the on-screen app, backend, MFi/iAP2 stack. Stock userspace (Weston version, launcher) is only known via community RE. `Merlin04/superbird-webapp` is a community reconstruction of the stock app, not a Spotify publish.

**Why it exists:** GPL-2.0 source obligation for shipped kernel/U-Boot/BlueZ. Surfaced publicly by journalist Josh Hendrickson; became load-bearing after Spotify bricked the device Dec 2024. That quiet drop is what enabled all alternative firmware.

## 2. kernel-common — what's rebuildable

Amlogic `buildroot-openlinux-201904-g12a` (Linux 4.9), S905D2/g12a.

Superbird DTS present in `arch/arm64/boot/dts/amlogic/`: `superbird_ep0.dts`, `superbird_evt_512.dts`, `superbird_evt_1024.dts`, `superbird_evt_512_overlays.dts`, plus `.dtsi` set (`mesong12a_superbird`, `_drm_`, `_panel_`, `_skt-panel_`, `-bifrost_`) and `partition_superbird_ab.dtsi`. Defconfigs: `superbird_defconfig`, `superbird_ep0_defconfig`, `superbird_evt_defconfig`.

**GPL driver sources — rebuildable:**
- **Touch (tlsc6x):** `drivers/amlogic/input/touchscreen/tlsc6x/` (`tlsc6x_main.c`, `tlsc6x_comp.c`, Makefile), `CONFIG_AMLOGIC_TOUCHSCREEN_TLSC6X=y` in `superbird_evt_defconfig`. **The touch module CAN be rebuilt** — this is the one driver with no mainline equivalent, so having GPL source matters for any mainline port.
- **PDM audio (mics):** `sound/soc/amlogic/auge/pdm.c` + `pdm_hw.c` + dummy codec. Buildable.
- **Backlight (aml-bl):** `drivers/amlogic/media/vout/backlight/aml_bl.c`, `CONFIG_AMLOGIC_BACKLIGHT=y`. Buildable.

**MFi — nuance (corrected):**
- The **DTS node exists**: `mfi@10 { compatible = "apple_mfi_auth"; reg = <0x10>; }` on i2c3 with Spotify's own `spotify_mfi_i2c_pins` (verified in the vendored `superbird_evt_512.dts:1037-1044,1242`). So stock hardware wired the MFi coprocessor and Spotify authored the pinmux for it.
- The **`apple_mfi_auth` kernel driver source was NOT found** in kernel-common's driver tree by the web survey. Whether stock did MFi in-kernel or in userspace over i2c is unresolved from public GPL source. Nocturne's `/dev/apple_mfi` ioctl path (see [daemon.md](daemon.md) §4) is a Nocturne-side implementation regardless — not derivable from these sources.

## 3. uboot — board config + FIP + the signing key

- Board dirs: `board/amlogic/superbird_{development,production}/` with matching defconfigs + headers, each carrying `lcd.c`, `eth_setup.c`, SCP power/PWM task firmware, DDR timing, ramdump.
- Builds **BL33 (U-Boot proper)** from source. But the FIP *packaging* uses Amlogic's **closed-source `aml_encrypt_g12a`** against proprietary BL2/BL30/BL31/BL32 blobs — those blobs + packer are NOT in the repo. Source for U-Boot, not a one-command FIP build.

**The signing key (`aml-user-key.sig`):**
- Location: `board/amlogic/superbird_production/aml-user-key.sig` (and `superbird_development/`).
- Contains the **production AES + RSA signing keys** (per `thinglabsoss/superbird-fip-tools`, which extracts them).
- Signs: **BL33 (U-Boot) and optionally BL31**; the whole FIP body is AES-encrypted + RSA-signed with these keys. **BL2 cannot be replaced** — locked by OTP-fused public-key hashes in mask ROM.
- **Implication:** fully custom U-Boot + kernel chain, packaged into a cryptographically-valid FIP, without touching fuses. Immutable vendor BL2 verifies the signed FIP with baked-in keys; because the keys leaked, custom firmware is flashable and persistent. This is the linchpin of the whole ecosystem (Nocturne, yocto-superbird, etc.).

## 4. Amlogic reference SDK (`reference/superbird-buildroot`) — build tooling worth stealing

frederic's republish of Amlogic buildroot-openlinux (single squashed commit). No superbird board — uses `mesong12a_u200_32_release` (G12A U200 reference, S905D2, armv7 userspace / arm64 kernel — same arrangement as stock). Below = the from-source recipes Nocturne replaced with blob-copying.

**Weston 6.0.1 + Mali r16p0 from source** (Nocturne uses stock Weston 3 blob instead):
- `package/weston/weston.mk` (v6.0.1) + 13 Amlogic patches (punch-video-hole, fix-UI-size, DRM connector-by-priority).
- **libgbm comes from the Mali blob, not Mesa** — the load-bearing detail: `package/amlogic/meson-mali/meson-mali.mk:69-75` copies `gbm.h`/`libgbm.so`/`.pc` from the Mali package into staging; writes `/etc/meson_egl.conf = wayland_drm`; `weston-daemon/S51Weston:13` reads that to pick the DRM backend. Blob variant `dvalin/r16p0/wayland/drm` (Bifrost).
- Kernel-side `mali.ko` (kbase) also vendored under `hardware/aml-4.9/arm/gpu/dvalin`.

**Reproducible signed `.swu`** (build Nocturne-style OTA yourself):
- Recipe `board/amlogic/common/ota/swu/ota_package_create.sh`: sha256-inject each file into `sw-description` → `openssl dgst -sha256 -sign swupdate-priv.pem sw-description > .sig` → **double `cpio -ov -H crc`** (inner `software.swu`, wrapped as `aml-software_1.0.swu`).
- Keys checked in as examples: pub `rootfs-49/etc/swupdate-public.pem`, priv `ota/swu/swupdate-priv.pem` — generate your own RSA pair, drop pub at `/etc/swupdate-public.pem`.
- sw-description templates: `ota/ota-g12a/sw-description-emmc{,-increment}`, `-nand`, `-nand-ab` (maps `rootfs.ext2.img2simg→/dev/system`, `boot.img→/dev/boot`, sets U-Boot `upgrade_step=1`).

**Image / logo / FIP tooling:**
- `aml_upgrade_pkg_gen.sh` master script. Logo: `res_packer -r logo_img_files logo.img` (`src/res_pack.cpp`) — **the tool for the Car Thing `logo.dump` format**. ext4→sparse via `img2simg`.
- Secure path: `aml_encrypt_g12a --bootsig|--imgsig|--binsig --amluserkey aml-user-key.sig` over u-boot/boot/recovery/dtb; renames `u-boot.bin.aml.efuse → SECURE_BOOT_SET`.
- FIP assembly infra: `bootloader/uboot-repo/fip/` (`mk_script.sh`, `build_bl2.sh…bl40.sh`, `fip_create/`, per-SoC `fip/g12a/` with `aml_encrypt_g12a`, DDR firmware).
- Note: **no `env.txt` generation anywhere** — the Car Thing `env.txt` scheme (Nocturne's `resources/env.txt`) is not from this tree.

**USB gadget reference:** `S89usbgadget_adb_rndis` — configfs composite RNDIS + adb FunctionFS, VID `0x18D1`/PID `0x4e26`, UDC `ff400000.dwc2_a`, `usb0 = 192.168.5.1`. (Nocturne's is RNDIS-only, 172.16.42.2 — see [firmware.md](firmware.md) §5.)

**Stock-app hook:** launcher goes in an `S90*` slot via `package/amlogic/aml_launcher/aml_launcher.mk:10-23`. Reference config selects **Cobalt** (YouTube Starboard browser) as launcher; Chromium 69 recipe exists but commented out. No `qt-superbird-app` here (Car Thing-specific, not in Amlogic ref).

## 5. What you can and can't reconstruct from public source

| Piece | Source available? |
|---|---|
| Touch (tlsc6x) driver | ✅ GPL in kernel-common — the key mainline-port carry |
| PDM mic, backlight, DRM/panel drivers | ✅ GPL in kernel-common |
| Superbird DTS (pins, panel timings, partitions) | ✅ kernel-common |
| Custom U-Boot (BL33) | ✅ spsgsb/uboot |
| Sign a valid FIP | ✅ via leaked `superbird_production/aml-user-key.sig` |
| BL2 / replace root of trust | ❌ OTP-locked |
| Weston + Mali + gbm stack from source | ✅ Amlogic ref SDK recipe (or copy stock blobs like Nocturne) |
| Signed `.swu` OTA construction | ✅ Amlogic ref SDK recipe |
| Stock userspace / app / launcher | ❌ never released (community RE: superbird-webapp) |
| MFi auth driver | ⚠️ DTS node yes; driver source not found — reimplement in userspace |
