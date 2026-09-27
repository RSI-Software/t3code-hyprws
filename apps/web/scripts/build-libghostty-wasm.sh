#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${WEB_DIR}/../.." && pwd)"
CANONICAL_VENDOR_DIR="${REPO_DIR}/native/libghostty-vt"
VENDOR_DIR="${WEB_DIR}/src/terminal/ghostty/vendor"

GHOSTTY_REVISION="$(tr -d '[:space:]' < "${CANONICAL_VENDOR_DIR}/VERSION")"
GHOSTTY_SOURCE_DIR="${GHOSTTY_SOURCE_DIR:-${HOME}/.cache/t3code/ghostty-${GHOSTTY_REVISION:0:8}}"
GHOSTTY_ZIG_VERSION="${GHOSTTY_ZIG_VERSION:-0.15.2}"
GHOSTTY_ZIG="${GHOSTTY_ZIG:-}"

log() {
  printf '[libghostty-vt-wasm] %s\n' "$*"
}

die() {
  printf '[libghostty-vt-wasm] error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

ensure_zig() {
  if [[ -n "${GHOSTTY_ZIG}" ]]; then
    [[ -x "${GHOSTTY_ZIG}" ]] || die "GHOSTTY_ZIG is not executable: ${GHOSTTY_ZIG}"
    return
  fi
  if command -v zig >/dev/null 2>&1 && [[ "$(zig version)" == "${GHOSTTY_ZIG_VERSION}" ]]; then
    GHOSTTY_ZIG="$(command -v zig)"
    return
  fi

  local host_os host_arch cache_dir
  host_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  host_arch="$(uname -m)"
  case "${host_os}" in
    darwin) host_os="macos" ;;
    linux) ;;
    *) die "unsupported host OS for Zig download: ${host_os}" ;;
  esac
  case "${host_arch}" in
    arm64) host_arch="aarch64" ;;
    aarch64 | x86_64) ;;
    *) die "unsupported host architecture: ${host_arch}" ;;
  esac

  cache_dir="${HOME}/.cache/t3code/zig-${GHOSTTY_ZIG_VERSION}"
  GHOSTTY_ZIG="${cache_dir}/zig"
  if [[ -x "${GHOSTTY_ZIG}" ]]; then
    return
  fi

  require_cmd curl
  require_cmd tar
  mkdir -p "${cache_dir}"
  log "downloading Zig ${GHOSTTY_ZIG_VERSION}"
  curl -fsSL \
    "https://ziglang.org/download/${GHOSTTY_ZIG_VERSION}/zig-${host_arch}-${host_os}-${GHOSTTY_ZIG_VERSION}.tar.xz" \
    | tar -xJ --strip-components=1 -C "${cache_dir}"
}

ensure_ghostty_source() {
  require_cmd git
  if [[ ! -d "${GHOSTTY_SOURCE_DIR}/.git" ]]; then
    mkdir -p "$(dirname "${GHOSTTY_SOURCE_DIR}")"
    log "cloning Ghostty ${GHOSTTY_REVISION}"
    git clone --filter=blob:none --no-checkout https://github.com/ghostty-org/ghostty.git \
      "${GHOSTTY_SOURCE_DIR}"
  fi

  # A cached checkout may still be on a previously pinned revision; converge on
  # the pinned one instead of failing the rebuild.
  local actual_revision
  actual_revision="$(git -C "${GHOSTTY_SOURCE_DIR}" rev-parse HEAD 2>/dev/null || echo none)"
  if [[ "${actual_revision}" != "${GHOSTTY_REVISION}" ]]; then
    log "checking out Ghostty ${GHOSTTY_REVISION}"
    git -C "${GHOSTTY_SOURCE_DIR}" fetch --depth=1 origin "${GHOSTTY_REVISION}"
    git -C "${GHOSTTY_SOURCE_DIR}" checkout --detach "${GHOSTTY_REVISION}"
  fi

  actual_revision="$(git -C "${GHOSTTY_SOURCE_DIR}" rev-parse HEAD)"
  [[ "${actual_revision}" == "${GHOSTTY_REVISION}" ]] || \
    die "expected Ghostty ${GHOSTTY_REVISION}, found ${actual_revision}"
}

ensure_zig
ensure_ghostty_source

build_root="$(mktemp -d)"
trap 'rm -rf "${build_root}"' EXIT

log "building ${GHOSTTY_REVISION} for wasm32-freestanding"
(
  cd "${GHOSTTY_SOURCE_DIR}"
  # The pinned revision rides along as semver build metadata so the artifact
  # identifies its own provenance through ghostty_build_info(); mobile's
  # VERSION file stays the single source of truth for the pin.
  "${GHOSTTY_ZIG}" build \
    -Demit-lib-vt \
    -Dtarget=wasm32-freestanding \
    -Doptimize=ReleaseSmall \
    -Dstrip=true \
    -Dlib-version-string="0.1.0-dev+${GHOSTTY_REVISION}" \
    -p "${build_root}"
)

mkdir -p "${VENDOR_DIR}"
cp "${build_root}/bin/ghostty-vt.wasm" "${VENDOR_DIR}/ghostty-vt.wasm"
"${GHOSTTY_ZIG}" build-exe \
  "${SCRIPT_DIR}/ghostty-write-pty.zig" \
  -target wasm32-freestanding \
  -O ReleaseSmall \
  -fno-entry \
  -rdynamic \
  -femit-bin="${VENDOR_DIR}/ghostty-write-pty.wasm"
chmod 0644 "${VENDOR_DIR}/ghostty-write-pty.wasm"
log "wrote ${VENDOR_DIR}/ghostty-vt.wasm"

# Box drawing, block, Powerline, and other cell-filling glyphs come from
# Ghostty's own sprite rasterizer (src/font/sprite), built as a sidecar module.
# The real src/font/main.zig drags the web_canvas font backend into any wasm
# build, so a copy of the pinned src/ gets a stub font root instead.
zon_dependency_field() {
  sed -n "/\.$1 = \.{/,/}/p" "${GHOSTTY_SOURCE_DIR}/build.zig.zon" \
    | sed -n "s/.*\.$2 = \"\(.*\)\".*/\1/p"
}

z2d_url="$(zon_dependency_field z2d url)"
z2d_hash="$(zon_dependency_field z2d hash)"
[[ -n "${z2d_url}" && -n "${z2d_hash}" ]] || die "z2d dependency missing from build.zig.zon"
log "fetching z2d ${z2d_hash}"
fetched_hash="$("${GHOSTTY_ZIG}" fetch "${z2d_url}")"
[[ "${fetched_hash}" == "${z2d_hash}" ]] || \
  die "z2d hash mismatch: build.zig.zon has ${z2d_hash}, fetched ${fetched_hash}"
zig_cache_dir="$("${GHOSTTY_ZIG}" env | sed -n 's/.*\.global_cache_dir = "\(.*\)".*/\1/p')"
z2d_dir="${zig_cache_dir}/p/${z2d_hash}"
[[ -f "${z2d_dir}/src/z2d.zig" ]] || die "z2d source not found at ${z2d_dir}"

sprite_root="${build_root}/sprite"
cp -R "${GHOSTTY_SOURCE_DIR}/src" "${sprite_root}"
cp "${SCRIPT_DIR}/ghostty-sprite-font.zig" "${sprite_root}/font/main.zig"
cp "${SCRIPT_DIR}/ghostty-sprite.zig" "${sprite_root}/t3_sprite.zig"
# Vector length 4 halves the module against z2d's default of 16; sprite output
# is pixel-identical because the golden check below still passes.
printf 'pub const vector_length: u32 = 4;\n' > "${build_root}/z2d_options.zig"
# The pinned revision is embedded so the artifact names its own provenance.
printf 'pub const ghostty_revision = "%s";\n' "${GHOSTTY_REVISION}" \
  > "${build_root}/t3_sprite_options.zig"

log "building ghostty-sprite.wasm"
(
  cd "${sprite_root}"
  "${GHOSTTY_ZIG}" build-exe \
    -target wasm32-freestanding \
    -O ReleaseSmall \
    -fno-entry \
    -rdynamic \
    -fstrip \
    --dep z2d \
    --dep t3_sprite_options \
    -Mroot=t3_sprite.zig \
    --dep z2d_options \
    -Mz2d="${z2d_dir}/src/z2d.zig" \
    -Mz2d_options="${build_root}/z2d_options.zig" \
    -Mt3_sprite_options="${build_root}/t3_sprite_options.zig" \
    -femit-bin="${VENDOR_DIR}/ghostty-sprite.wasm"
)
chmod 0644 "${VENDOR_DIR}/ghostty-sprite.wasm"

require_cmd node
node "${SCRIPT_DIR}/check-ghostty-sprite-goldens.ts" \
  "${VENDOR_DIR}/ghostty-sprite.wasm" \
  "${GHOSTTY_SOURCE_DIR}/src/font/sprite/testdata"
log "wrote ${VENDOR_DIR}/ghostty-sprite.wasm"
