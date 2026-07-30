# Nocturne firmware image (`nocturne/` repo)

Buildroot `BR2_EXTERNAL` tree. Only `external/`, `configs/`, `scripts/`, `resources/` are Nocturne-specific; `buildroot/` is an unpopulated submodule of upstream Buildroot (`.gitmodules:1-3`).

**Target:** Amlogic S905D2 ("superbird"), Mali-G31 GPU. Userspace is **32-bit armv7 hard-float** (`BR2_arm` + `BR2_cortex_a53` + `BR2_ARM_EABIHF`, `configs/nocturne_defconfig:27,63-71,122,157,165`) on a stock **arm64 4.9 vendor kernel** — chosen to stay ABI-compatible with stock 32-bit blobs (libMali, Weston, Chromium). Toolchain: Buildroot-internal glibc, GCC 13.4.0.

> **The single biggest constraint for new software: everything must be 32-bit armv7 EABIHF.** Prebuilt `armv7-unknown-linux-musleabihf` binaries work (proven by `external/package/static-web-server/`).

## 1. Boot chain

No kernel, no U-Boot, no genimage built in this repo. Device boots the **stock Amlogic chain**; Nocturne replaces only the rootfs, U-Boot env, and boot logo.

- **U-Boot env** = `resources/env.txt` (55 lines), the whole boot policy:
  - `bootcmd=run storeboot` → `check_button; get_boot_slot; storeargs; get_valid_slot; imgread kernel; bootm` (`env.txt:47`)
  - A/B slots: `active_slot=_a` → `mmcblk0p14`, `_b` → `mmcblk0p15` (`env.txt:3,29`). Runtime slot flip = stock `phb` binary (`phb -s 0|1`).
  - Kernel cmdline: `init=/sbin/pre-init ... rootfstype=ext4 console=ttyS0,115200n8`, root mounted `ro rootwait skip_initramfs rootflags=noload`, plus custom `nocturne.firstboot=${firstboot}` and display params `fb_width=480 fb_height=800 panel_type=lcd_8 vout=panel` (`env.txt:28,31,46`)
  - Recovery: holding `GPIOA_3` (buttons 1+4 at plug-in) → `do_usb_burning` = Amlogic USB burn mode (`env.txt:9`)
- **Kernel** lives in stock `boot` partition — whatever the stock 8.9.2 Thing Labs firmware ships. Kernel headers pinned 4.9.113 (`nocturne_defconfig:198-201`). Kernel modules are stock blobs (`fetch-stock.sh:51`), incl. `mali` and `apple_mfi_auth_i2c`.
- **Init:** `/sbin/pre-init` (`rootfs_overlay/sbin/pre-init`) mounts pseudo-fs, `mdev -s`, on firstboot runs `/bin/reset-data` + `/bin/reset-settings` then `uenv set firstboot 0`, then `exec /sbin/init` (BusyBox init) → `/etc/init.d/S??*`.
- **Rootfs image:** fixed **528428K (~516 MiB) ext4**, label `rootfs`, `-O ^64bit` (`nocturne_defconfig:3795-3806`). `post-image.sh:6-7` strips journal (`tune2fs -O ^has_journal`) because fstab mounts with `noload`.

## 2. Runtime process tree

BusyBox init scripts:
- `S49usbgadget` — USB RNDIS gadget (see §5)
- `S51display` (installed by stock-blobs pkg) — creates `/run/wayland` (0700), exports `XDG_RUNTIME_DIR=/run/wayland/`, `modprobe mali`, starts `/usr/bin/weston --tty=4 --config=/etc/weston/weston.ini`
- supervisord (Buildroot S99), config `rootfs_overlay/etc/supervisord.conf`:

| prio | program | command |
|---|---|---|
| 89 | bluetoothd | `/bin/start-bluetoothd` |
| 90 | nocturned | `/usr/bin/nocturned` — env: `RUST_LOG=…`, **`NOCTURNE_WEBAPPS_DIR=/etc/nocturne/ui`** |
| 99 | chromium | `/bin/start-chromium` |
| — | swupdate | `/usr/bin/swupdate -l 3 -k /etc/nocturne.pem` |

**Extension point:** `supervisord.conf:86-87` has `[include] files = /etc/supervisor.d/*.conf` — dir doesn't exist in overlay; a new package can `mkdir` it and drop a `.conf` to add a daemon without touching supervisord.conf.

**Weston** (`etc/weston/weston.ini`): output `LVDS-1`, `mode=480x800@60`, **`transform=90`** (panel is physical portrait 480×800, rotated to 800×480 landscape). `idle-time=0`, `hide-cursor=true`, no animations, keyboard repeat off, `[libinput] natural_scroll=true`. `seatd` for DRM/input.

**Chromium kiosk** (`rootfs_overlay/bin/start-chromium`):
- Polls `http://127.0.0.1:8080/` with wget until daemon web server answers, then launches
- `--no-sandbox --in-process-gpu --remote-debugging-port=2222 --user-data-dir=/var/lib/chrome_storage --kiosk --disable-pinch --allow-file-access-from-files --ignore-certificate-errors --enable-experimental-web-platform-features --app=http://localhost:8080`
- URL overridable: `NOCTURNE_CHROMIUM_URL` / `NOCTURNE_CHROMIUM_WAIT_URL` (`start-chromium:4-5`); binary via `NOCTURNE_CHROME_BIN`. **Easiest hook to point device at different software.**
- CDP open on **:2222** — can drive/debug kiosk externally.

Also: dropbear SSH, root password `nocturne`, `nocturne` uid-1000 user.

## 3. How UI is served

**nocturned is the web server.** Chain:
1. `external/package/nocturne-ui/nocturne-ui.mk:16-20` installs built Vite bundle to `/etc/nocturne/ui`
2. supervisord passes `NOCTURNE_WEBAPPS_DIR=/etc/nocturne/ui`
3. nocturned serves it on **:8080** + provides WebSocket bridge
4. Chromium kiosk opens `http://localhost:8080`

(`static-web-server` package exists in tree but is NOT enabled — dead code.)

## 4. Adding a new Buildroot package

Touch points:
1. `external/external.mk` auto-globs `external/package/*/*.mk` — no edit needed
2. `external/Config.in:5-11` — add `source "$BR2_EXTERNAL_Nocturne_PATH/package/<name>/Config.in"` in `menu "Nocturne packages"`
3. `configs/nocturne_defconfig` — add `BR2_PACKAGE_<NAME>=y` (existing at lines 5091-5095). Workflow: `just menuconfig` → `just copyconfig`.

Pattern examples:
- **cmake pkg + config files:** `external/package/fastfetch/fastfetch.mk` — GitHub tarball, custom `INSTALL_TARGET_CMDS` copying package-local config
- **Rust git pkg:** `external/package/nocturned/nocturned.mk` — 4 lines: `_VERSION`, `_SITE_METHOD = git`, `_SITE`, `$(eval $(cargo-package))`. Host rust: `BR2_PACKAGE_HOST_RUSTC_ARCH="armv7"` `ABI="eabihf"`
- **Prebuilt binary:** `external/package/static-web-server/static-web-server.mk` — downloads armv7 musl release tarball, `$(INSTALL) -D -m 0755`, `generic-package`
- **Local tarball / custom extract:** `stock-blobs.mk` (`SITE_METHOD = local`), `nocturne-ui.mk` (overrides `EXTRACT_CMDS` to unzip CI artifact)
- **Init script:** `INSTALL_INIT_SYSV` (see `stock-blobs.mk:17-20`)

**Rootfs overlay:** `external/board/nocturne/rootfs_overlay/` copied verbatim AFTER packages install (overlay wins conflicts). `post-build.sh` templates `${GIT_HASH}`/`${VERSION}` into `version.json`, `motd`. Per-package patches at `external/board/nocturne/patches/<pkgname>/`.

Remember: firmware build consumes **released artifacts** — `nocturne-ui.mk` downloads a nightly.link zip at tag, `nocturned.mk` clones a tag. Local sibling checkouts have zero effect until `_VERSION` bumped + `just cleandeps`.

## 5. Hardware enablement in the image

- **Display/GPU:** Mali blob only. `libMali.so` symlinked as `libgbm.so`/`libEGL`/`libGLESv2`/`libwayland-egl` (`stock-blobs/post-install.sh:16-25`), `patchelf --clear-execstack` required. No mesa, no X11. Weston is **stock Weston 3.x blob**, ABI-matched to Mali.
- **Rotary dial:** `/dev/input/event1`, forced to `ID_INPUT_MOUSE=1` via `etc/udev/rules.d/01-rotary.rules` — libinput/Weston delivers it as **scroll events** into Chromium.
- **Buttons:** plain evdev keys, arrive as keyboard events in Chromium. Touch via libinput (stock blob libs).
- **Audio:** raw ALSA (no Pulse/PipeWire). alsa-lib full plugins + alsa-utils. Opus built with armv8-32bit intrinsic patch.
- **Bluetooth:** BlueZ 5 utils. Broadcom chip on UART `ttyS1`; udev fires `/bin/attach-bt` (GPIO 493 reset, MAC from `/sys/class/efuse/mac_bt`, `btattach -P bcm -B /dev/ttyS1`). Device name `Nocturne (XXXX)` from efuse serial. `bluetoothd -n -d --plugin=gap,deviceinfo` (minimal).
- **MFi:** udev rule `97-mfi.rules` + `/bin/add-mfi-dev` mknods `/dev/apple_mfi` when `apple_mfi_auth_i2c` module appears.
- **USB gadget:** `S49usbgadget` configfs gadget, **RNDIS only**, MSFT100 os_desc for Windows. Static `usb0 = 172.16.42.2/24`, gw `172.16.42.1`.
- **Wi-Fi: none.** No wpa_supplicant, no DHCP. Network = USB-RNDIS or Bluetooth (phone app / Pi connector).
- **Wake word:** 6 ONNX models in overlay at `/etc/nocturne/models/` (openWakeWord-style: melspectrogram + embedding + 4 wake models, ~4.9 MB).

## 6. Read-only rootfs / writable storage

`rootfs_overlay/etc/fstab`:
- `/` = ext4 **ro**, `noload` (journal stripped)
- `/dev/data` → `/var` (ext4 rw) — general persistent: logs, `/var/cache`, swapfile (256 MB)
- `/dev/settings` → `/var/lib` (ext4 rw) — survives data reset: Chromium profile `/var/lib/chrome_storage`, BT pairings `/var/lib/bluetooth`, `/var/lib/nocturned`
- Bind mounts: `/var/local/root → /root`, `/var/local/home → /home`
- tmpfs: `/dev/shm`, `/tmp`, `/run`

Firstboot: `bin/reset-data` mkfs's `/dev/data` (seeded from rootfs `/var`), generates dropbear host keys, swapfile; `bin/reset-settings` mkfs's `/dev/settings`, creates `/nocturned` dir.

**New daemon needing persistent state: write to `/var` or `/var/lib`, and add its dir creation to `bin/reset-settings`.**

## 7. OTA (swupdate) + Terbium packaging

- swupdate binary is a **stock blob** (`fetch-stock.sh:57`), runs under supervisord with `-k /etc/nocturne.pem` (RSA **public** key, 9 lines, in overlay). Private key off-tree — **third parties can't ship OTAs without replacing the pem.**
- Gating metadata: `etc/sw-versions` (`nocturne 1.0.0`), `etc/hwrevision` (`nocturne-evt 1.0.0`) — static, don't track real version. No `sw-description` template in repo; `.swu` built elsewhere. Update writes inactive slot, then `phb -s 0|1`.
- **Terbium zip** (`scripts/package.sh`): downloads stock 8.9.2 Thing Labs firmware zip from thingify.tools, deletes `system_a.ext2`/`system_b.ext2`/`env.txt`/`env.dump`/`logo.dump`, substitutes `output/images/rootfs.ext2` as BOTH slots + `resources/env.txt` + `resources/logo.dump`, rezips → `output/package/nocturne.zip`. Shipped zip = stock bootloader/kernel/partition table + Nocturne rootfs.

## 8. stock-blobs — proprietary pieces

`fetch-stock.sh` loop-mounts stock `system_a.ext2` (needs root), tars to `dl/stock-blobs/stock-blobs-8.9.2.tar.gz`:

| Blob | Why |
|---|---|
| `lib/modules` (whole tree) | Vendor 4.9 kernel modules — `mali`, `apple_mfi_auth_i2c`; no kernel source |
| `lib/firmware/brcm` | Broadcom BT firmware |
| `phb`, `uenv` | Slot switch + U-Boot env tools |
| `chromium-browser/` | Whole prebuilt Chromium (Chrome 69-era) |
| `swupdate` | OTA updater |
| Weston 3.x + libweston | Matched to Mali EGL/GBM; modern weston can't build against it |
| `libMali.so` | **Critical.** EGL+GLES+GBM+wayland-egl in one blob |
| libdrm/libinput/libevdev/libxkbcommon/libwayland/pixman/cairo/NSS/OpenSSL 1.1/fontconfig/freetype etc. | ABI-matched deps for Weston 3 + Chromium |

## 9. Insertion points for new software (easiest first)

1. **New web app** — install dir under `/etc/nocturne/ui` (nocturned serves it) or repoint kiosk via `NOCTURNE_CHROMIUM_URL` env in supervisord chromium program. Browser is the intended UI layer.
2. **New daemon** — package installs binary + `/etc/supervisor.d/<name>.conf` (create dir).
3. **Boot-time hardware setup** — `INSTALL_INIT_SYSV` script `/etc/init.d/S??name` (<49 = before USB net, 51 = Weston up).
4. **Native Wayland GUI app** — hardest: Weston 3.x + Mali blob EGL, armv7 glibc only, no mesa. Most modern toolkits won't build. Avoid; use the browser.

Global constraints: armv7 EABIHF 32-bit; read-only rootfs; ~516 MiB rootfs budget; no Wi-Fi (RNDIS at 172.16.42.2 or BT only); OTA needs private key.
