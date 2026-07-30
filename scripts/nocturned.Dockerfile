# Cross-builds nocturned for the Car Thing: armv7 hard-float, glibc.
#
# Debian bookworm carries glibc 2.36. The device runs 2.42, and glibc symbols
# are backward compatible, so building against the older one is the safe
# direction. Bookworm is also new enough that pthread/dl/rt are already merged
# into libc (that happened in 2.34) — build on bullseye instead and the binary
# picks up NEEDED entries for libraries a 2.42 rootfs no longer ships.
#
# Built on the host's own architecture and cross-linked, rather than emulating
# armv7 through QEMU, which is roughly an order of magnitude slower.

FROM debian:bookworm

# file + qemu-user-static are for the pre-flight checks, not the build itself:
# qemu runs the armv7 binary here so "it links" can be upgraded to "it starts".
RUN dpkg --add-architecture armhf \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git pkg-config \
      gcc-arm-linux-gnueabihf libc6-dev-armhf-cross \
      libdbus-1-dev:armhf libopus-dev:armhf \
      file qemu-user-static \
 && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
      --default-toolchain stable --target armv7-unknown-linux-gnueabihf

# pkg-config has to be pointed at the armhf sysroot, or it hands back the
# host's .pc files and the link fails on the wrong architecture.
ENV CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_LINKER=arm-linux-gnueabihf-gcc \
    PKG_CONFIG_ALLOW_CROSS=1 \
    PKG_CONFIG_LIBDIR=/usr/lib/arm-linux-gnueabihf/pkgconfig

WORKDIR /src
CMD ["cargo", "build", "--release", "--target", "armv7-unknown-linux-gnueabihf"]
