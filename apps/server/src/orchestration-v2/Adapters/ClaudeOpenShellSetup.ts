import { ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";

import { runInLinux } from "./ClaudeOpenShellWorkspace.ts";

const OPENSHELL_VERSION = "0.1.7";
const UBUNTU_BASE_VERSION = "24.04.5";
const SETUP_ROOT = "$HOME/t3-openshell";
const SETUP_CACHE = "$HOME/.cache/t3-openshell";
const CREDENTIAL_PROVIDER = "claude-sub";
const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/;

export const DEFAULT_IMAGE_PATH = `${SETUP_ROOT}/rootfs.tar`;
export const SETUP_STEP_FILE = `${SETUP_CACHE}/setup-step`;

const STRICT_POLICY_PATH = `${SETUP_ROOT}/policy.yaml`;
const DEV_POLICY_PATH = `${SETUP_ROOT}/policy-dev.yaml`;

const STRICT_POLICY = `version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/bin, /usr, /lib, /lib64, /proc, /dev/urandom, /etc, /var/log]
  read_write: [/sandbox, /tmp, /dev/null]
landlock:
  compatibility: hard_requirement
process:
  run_as_user: sandbox
  run_as_group: sandbox
network_policies:
  claude_api:
    endpoints:
      - host: api.anthropic.com
        port: 443
        protocol: rest
        access: read-write
        enforcement: enforce
    binaries:
      - path: /usr/local/bin/claude
`;

const DEV_POLICY = `${STRICT_POLICY}  t3_user_curl:
    endpoints:
      - { host: github.com, port: 443 }
      - { host: registry.npmjs.org, port: 443 }
      - { host: pypi.org, port: 443 }
      - { host: files.pythonhosted.org, port: 443 }
    binaries:
      - path: /usr/bin/curl
  t3_user_git:
    endpoints:
      - { host: github.com, port: 443 }
    binaries:
      - path: /usr/bin/git
      - path: /usr/lib/git-core/git-remote-https
`;

const GATEWAY_CONFIG = `[openshell]
version = 2

[openshell.gateway]
compute_driver = "vm"

[openshell.drivers.vm]
allow_driver_config = true
driver_dir = "/usr/libexec/openshell"
default_image = "nvcr.io/nvidia/base/ubuntu:24.04"
vcpus = 2
mem_mib = 2048
`;

const CREDENTIAL_PROFILE = `id: claude-subscription
display_name: Claude Subscription
description: Claude Code with a setup-token subscription credential
category: agent
inference_capable: true
credentials:
  - name: oauth_token
    description: Long-lived token from claude setup-token
    env_vars: [CLAUDE_CODE_OAUTH_TOKEN]
    required: true
    auth_style: bearer
    header_name: authorization
discovery:
  credentials: [oauth_token]
endpoints:
  - host: api.anthropic.com
    port: 443
    protocol: rest
    access: read-write
    enforcement: enforce
binaries:
  - /usr/local/bin/claude
`;

/** Runs inside the chroot. The image is built here because Claude cannot be redistributed. */
const provisionScript = (packages: string) => `set -eu
export DEBIAN_FRONTEND=noninteractive HOME=/root
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends ca-certificates curl git openssh-client tar coreutils bash ripgrep iproute2 ${packages} >/dev/null
rm -rf /var/lib/apt/lists/*
groupadd -g 10001 sandbox
useradd -m -d /sandbox -u 10001 -g 10001 -s /bin/bash sandbox
curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh
CLAUDE_INSTALL_ALLOW_SUDO=1 bash /tmp/claude-install.sh stable
cp -L /root/.local/bin/claude /usr/local/bin/claude
chmod 755 /usr/local/bin/claude
rm -rf /root/.local /root/.claude /tmp/* /tmp/.[!.]*
`;

const buildImageScript = (packages: string) => `set -eu
BASE=$1
IMAGE=$2
OWNER=$3
ROOTFS=$(mktemp -d /var/tmp/t3-openshell-image.XXXXXX)
cleanup() {
  umount "$ROOTFS/proc" 2>/dev/null || true
  mountpoint -q "$ROOTFS/proc" || rm -rf "$ROOTFS"
}
trap cleanup EXIT
tar -xzf "$BASE" -C "$ROOTFS"
rm -f "$ROOTFS/etc/resolv.conf"
cp -L /etc/resolv.conf "$ROOTFS/etc/resolv.conf"
rm -f "$ROOTFS/dev/null" "$ROOTFS/dev/urandom"
mknod -m 666 "$ROOTFS/dev/null" c 1 3
mknod -m 666 "$ROOTFS/dev/urandom" c 1 9
mount -t proc proc "$ROOTFS/proc"
cat >"$ROOTFS/tmp/provision.sh" <<'PROVISION'
${provisionScript(packages)}PROVISION
chroot "$ROOTFS" sh /tmp/provision.sh
umount "$ROOTFS/proc"
rm -f "$ROOTFS/dev/null" "$ROOTFS/dev/urandom"
: >"$ROOTFS/etc/resolv.conf"
tar --numeric-owner -C "$ROOTFS" -cf "$IMAGE.tmp" .
chown "$OWNER" "$IMAGE.tmp"
mv "$IMAGE.tmp" "$IMAGE"
`;

/**
 * Safe to run again after a failure: every step skips what is already done.
 * The first line of stdin is the sudo password, so it never reaches a process list.
 */
export const setupScript = (input: {
  readonly image: string;
  readonly packages: string;
  readonly rebuildImage: boolean;
}) => `set -eu
export XDG_RUNTIME_DIR=/run/user/$(id -u)
ROOT=${SETUP_ROOT}
CACHE=${SETUP_CACHE}
CONFIG=$HOME/.config/openshell
TLS=$HOME/.local/state/openshell/tls
ENDPOINT=https://127.0.0.1:17670
IMAGE=${input.image}
mkdir -p "$ROOT" "$CACHE" "$CONFIG"
IFS= read -r SUDO_PASSWORD || SUDO_PASSWORD=
step() { printf '%s\\n' "$1" >"${SETUP_STEP_FILE}"; }
die() { printf '%s\\n' "$1" >&2; exit 1; }
as_root() { printf '%s\\n' "$SUDO_PASSWORD" | sudo -S -p '' "$@"; }

step check
command -v apt-get >/dev/null || die "This setup needs an Ubuntu or Debian system."
as_root true || die "The sudo password was refused."
[ -r /dev/kvm ] || [ -e /dev/kvm ] || die "/dev/kvm is missing, so this machine cannot run MicroVMs."
curl -fsS -m 20 -o /dev/null https://github.com || die "Linux has no internet access. Fix its network and try again."
FREE_GB=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc 0-9)
[ "$FREE_GB" -ge 5 ] || die "Setup needs 5 GB of free disk, this machine has $FREE_GB GB."
case $(dpkg --print-architecture) in
  amd64)
    ARCH=amd64
    PACKAGE_SHA=c0bbac200db9a4cf691b0bc6dd23e1cf03c0e8156dd71f368ae6bf8e48405fe6
    BASE_SHA=e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86
    ;;
  arm64)
    ARCH=arm64
    PACKAGE_SHA=354f74db54b21ed34f7bacdc5c97ee35749e4d3690f2c3b83b3a6e32ac5bed05
    BASE_SHA=a91d5a93010193712d346d761372b7c9db6dfcf093893161c64ca107f05914f2
    ;;
  *) die "Only amd64 and arm64 are supported." ;;
esac

step package
if [ "$(openshell --version 2>/dev/null)" != "openshell ${OPENSHELL_VERSION}" ]; then
  PACKAGE=$CACHE/openshell_${OPENSHELL_VERSION}-1_$ARCH.deb
  curl -fsSL -o "$PACKAGE" "https://github.com/NVIDIA/OpenShell/releases/download/v${OPENSHELL_VERSION}/openshell_${OPENSHELL_VERSION}-1_$ARCH.deb"
  printf '%s  %s\\n' "$PACKAGE_SHA" "$PACKAGE" | sha256sum -c --quiet
  as_root apt-get update -qq
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$PACKAGE" e2fsprogs
  rm -f "$PACKAGE"
fi

step gateway
if [ ! -f "$CONFIG/gateway.toml" ]; then
  cat >"$CONFIG/gateway.toml" <<'GATEWAY'
${GATEWAY_CONFIG}GATEWAY
fi
grep -q 'compute_driver = "vm"' "$CONFIG/gateway.toml" || die "$CONFIG/gateway.toml does not use the vm driver."
as_root loginctl enable-linger "$(id -un)"
if ! id -nG | grep -qw kvm; then
  as_root usermod -aG kvm "$(id -un)"
  as_root systemctl restart "user@$(id -u)"
  sleep 2
fi
systemctl --user enable --now openshell-gateway
WAITED=0
until [ -s "$TLS/client/tls.crt" ]; do
  [ "$WAITED" -lt 30 ] || die "The OpenShell gateway did not start."
  WAITED=$((WAITED + 1))
  sleep 1
done
if [ ! -f "$CONFIG/gateways/local/metadata.json" ]; then
  mkdir -p "$CONFIG/gateways/local/mtls"
  cp "$TLS/ca.crt" "$TLS/client/tls.crt" "$TLS/client/tls.key" "$CONFIG/gateways/local/mtls/"
  chmod 700 "$CONFIG/gateways/local/mtls"
  openshell gateway add "$ENDPOINT" --local --name local </dev/null
fi
WAITED=0
until openshell provider list </dev/null >/dev/null 2>&1; do
  [ "$WAITED" -lt 30 ] || die "The OpenShell gateway does not answer."
  WAITED=$((WAITED + 1))
  sleep 1
done
if ! openshell provider profile export claude-subscription </dev/null >/dev/null 2>&1; then
  cat >"$CACHE/claude-subscription.yaml" <<'PROFILE'
${CREDENTIAL_PROFILE}PROFILE
  openshell provider profile import -f "$CACHE/claude-subscription.yaml" </dev/null
  rm -f "$CACHE/claude-subscription.yaml"
fi
cat >${STRICT_POLICY_PATH} <<'POLICY'
${STRICT_POLICY}POLICY
cat >${DEV_POLICY_PATH} <<'POLICY'
${DEV_POLICY}POLICY

step image
if [ ! -s "$IMAGE" ] || [ "${input.rebuildImage ? 1 : 0}" = 1 ]; then
  BASE=$CACHE/ubuntu-base-$ARCH.tar.gz
  curl -fsSL -o "$BASE" "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-${UBUNTU_BASE_VERSION}-base-$ARCH.tar.gz"
  printf '%s  %s\\n' "$BASE_SHA" "$BASE" | sha256sum -c --quiet
  cat >"$CACHE/build-image.sh" <<'BUILD'
${buildImageScript(input.packages)}BUILD
  as_root sh "$CACHE/build-image.sh" "$BASE" "$IMAGE" "$(id -un)"
  rm -f "$BASE" "$CACHE/build-image.sh"
fi

step done
`;

const templateInstance = (
  displayName: string,
  policyPath: string,
  distro: string | undefined,
  binaryPath: string | undefined,
): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName,
  enabled: true,
  environment: [
    { name: "T3_OPENSHELL_IMAGE", value: DEFAULT_IMAGE_PATH, sensitive: false },
    { name: "T3_OPENSHELL_POLICY", value: policyPath, sensitive: false },
    { name: "T3_OPENSHELL_PROVIDER", value: CREDENTIAL_PROVIDER, sensitive: false },
    ...(distro === undefined
      ? []
      : [{ name: "T3_OPENSHELL_WSL_DISTRO", value: distro, sensitive: false }]),
  ],
  ...(binaryPath === undefined ? {} : { config: { binaryPath } }),
});

export const setupTemplates = (distro: string | undefined, binaryPath: string | undefined) =>
  [
    ["openshell", templateInstance("OpenShell", STRICT_POLICY_PATH, distro, binaryPath)],
    ["openshell_dev", templateInstance("OpenShell Dev", DEV_POLICY_PATH, distro, binaryPath)],
  ] as const;

let activeSetup: Promise<Buffer> | undefined;

export const isSetupRunning = (): boolean => activeSetup !== undefined;

/** Package names land in a root shell, so nothing but plain apt names gets through. */
export const assertPackages = (packages: string): string => {
  const names = packages.split(/\s+/).filter(Boolean);
  const invalid = names.find((name) => !PACKAGE_PATTERN.test(name));
  if (invalid !== undefined) throw new Error(`Invalid package name: ${invalid}`);
  return names.join(" ");
};

/** The script reports its own failure on stderr, which is the part worth showing. */
export const setupFailureMessage = (cause: unknown): string => {
  const detail = cause instanceof Error ? cause.message.replace(/^[\s\S]*?exited \d+: /, "") : "";
  return detail.trim().split("\n").at(-1)?.trim() || "OpenShell setup failed";
};

export const firstClaudeBinaryPath = (
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
): string | undefined =>
  Object.values(instances).flatMap(({ driver, config }) => {
    const binaryPath = (config as { readonly binaryPath?: unknown } | undefined)?.binaryPath;
    return driver === "claudeAgent" && typeof binaryPath === "string" ? [binaryPath] : [];
  })[0];

export const runSetup = async (
  wslDistro: string | undefined,
  sudoPassword: string,
  image: { readonly path: string; readonly packages: string; readonly rebuild: boolean },
  platform: NodeJS.Platform,
): Promise<void> => {
  if (activeSetup !== undefined) throw new Error("Setup is already running.");
  const script = setupScript({
    image: image.path,
    packages: assertPackages(image.packages),
    rebuildImage: image.rebuild,
  });
  activeSetup = runInLinux({ wslDistro }, script, platform, Buffer.from(`${sudoPassword}\n`));
  try {
    await activeSetup;
  } finally {
    activeSetup = undefined;
  }
};
