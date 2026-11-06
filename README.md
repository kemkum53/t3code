# T3 Code with OpenShell

This is a fork of [T3 Code](https://github.com/pingdotgg/t3code) that can run a Claude chat inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox. Sandboxed chats sit next to normal chats in the same sidebar, and you manage what they can reach from the chat itself.

This fork is not affiliated with T3 Tools or NVIDIA. The original T3 Code README follows [further down](#t3-code).

## Why

An agent on your machine can read your SSH keys, your `.env` files and everything else your user can read. Permission prompts help until you get tired of clicking them. A sandboxed chat runs in its own MicroVM instead:

- It sees a copy of the project's tracked files. Ignored files such as `.env` stay out.
- It has no internet except the Claude API, plus the hosts you allow.
- Your real files change only when you press Apply on a diff.
- Your Claude login stays on the host. The box only holds a placeholder.

## What you get

**Chats**

- Pick a sandbox template in the model menu to start an isolated chat. It has a green edge in the sidebar.
- One box per chat, deleted with the chat. You are warned if it holds changes you have not applied.
- Chats without a project work too. Use Save copy to get their files out.
- The terminal in a sandboxed chat opens inside the box.
- A status icon shows green when the box is running and red when it is stopped. The composer stays locked while the box starts.

**Guard**

- When the agent is refused a host or a file, a card appears in the chat with Allow and Deny.
- After Allow, the agent continues on its own. You can turn this off in Settings.
- The Guard dialog shows network rules and recent denials, and has stop, start, Save copy and update actions.
- Network rules apply to a running box. A new read path restarts the box.

**Settings**

- Install OpenShell, build the image and store your Claude token from the OpenShell page.
- Templates: name, apt packages, allowed hosts. Python, Node and C++ presets are included.
- An open chat can move to a rebuilt image from Guard. Its files and history are kept.
- Idle boxes stop on their own after 30 minutes. The time is adjustable.

## Requirements

|            |                                                     |
| ---------- | --------------------------------------------------- |
| Windows 11 | WSL2 with Ubuntu 24.04 and `/dev/kvm` available     |
| Linux      | `/dev/kvm` available, see [Status](#status)         |
| macOS      | Not supported, no KVM                               |
| Agent      | Claude, with a token from `claude setup-token`      |
| Disk       | 3 GB free to start, then 600 to 900 MB per template |

The sandbox image is built on your machine from Ubuntu Base with pinned SHA-256 hashes. Docker is not needed, and nobody redistributes Claude Code.

## Install

There is no installer yet, so this runs from source. You need Node 26.12 and [`vp`](https://viteplus.dev/guide/).

```bash
git clone https://github.com/kemkum53/t3code
cd t3code
git switch feat/openshell-isolated-chats
vp i
vp run dev:desktop
```

To keep an existing T3 Code install separate, set `T3CODE_HOME` to another folder first.

Then:

1. Open Settings, OpenShell.
2. Run the install step. It asks for your sudo password when it needs one. The password goes through stdin and is not stored.
3. In a terminal, run `claude setup-token` and paste the token into the page.
4. Start a new chat and pick OpenShell in the model menu.

A full setup took 87 seconds on a clean Ubuntu 24.04 WSL distro.

## How it works

The normal Claude driver is kept. Claude's SDK has a hook for starting the agent process somewhere else, and this fork points it at `openshell sandbox exec`, through `wsl.exe` on Windows. T3 still sees an ordinary Claude session.

```
T3 Code server
  └─ Claude driver
       └─ wsl.exe -> openshell sandbox exec -> claude (inside the MicroVM)
```

Project files go in once through a filtered copy. The box gets a baseline commit, and its changes come back as `git diff --binary` for you to review.

Network rules live in the OpenShell policy, per binary. Claude keeps its own single rule. A template's hosts apply to programs in `/usr/bin`, `/usr/lib/git-core` and `/sandbox`.

## What was measured

OpenShell 0.1.7 on Windows 11 and WSL2.

| Check                                                            | Result            |
| ---------------------------------------------------------------- | ----------------- |
| Box ready, image cached                                          | 4 to 12 s         |
| Box ready, new image                                             | 17 to 41 s        |
| Writes to `/etc`, `/usr/bin`, `mount`                            | Denied            |
| Internet, LAN, host, metadata without a rule                     | Denied            |
| Template host from `curl`, `python3`, and a binary in `/sandbox` | 200               |
| Unlisted host from the same box                                  | Denied and logged |
| Allow a host until usable                                        | 1 to 10 s         |
| Allow a read path, box restarted                                 | 45 s              |
| Image rebuild                                                    | 60 to 104 s       |
| Move an open chat to a new image                                 | 37 s              |

More numbers and the reasoning behind them are in [docs/internals/openshell-isolated-chats.md](./docs/internals/openshell-isolated-chats.md).

## Status

| Part                   | State                                               |
| ---------------------- | --------------------------------------------------- |
| Windows 11 with WSL2   | Tested                                              |
| Raspberry Pi           | OpenShell works, setup from Settings not tested yet |
| Other Linux            | Not tested                                          |
| Claude                 | Works                                               |
| Codex and other agents | Not yet                                             |

## Limits

- Only Claude runs in a box for now.
- The agent cannot write outside `/sandbox`, and you cannot grant that from the UI. A running box can gain read paths but can never lose them or become root. This comes from OpenShell.
- Packages are fixed in the image. A box has no way to install system packages by itself.
- A rebuilt image reaches open chats only when you press update in Guard.
- Landlock refusals leave no log line. The Guard finds them in the agent's command output, so a refusal the agent never prints stays invisible.
- A setup token covers model requests only. claude.ai connectors and Remote Control do not work in the box.
- The first message in a chat waits for the box to start.
- A terminal opened before the chat's first message runs on the host.

## Troubleshooting

- `/dev/kvm is missing`: enable nested virtualization for WSL, or use a machine that exposes KVM.
- The box starts but has no network on WSL: check that WSL has a working NAT. On one test machine it had to be added with `New-NetNat`, and again after WSL restarted.
- Never upload from a `/mnt/<drive>` path by hand. OpenShell issue #3728 keeps the file size and loses the content. The app copies to the Linux filesystem first.

## Plans

See [TODO.md](./TODO.md).

## License

MIT, same as T3 Code. See [LICENSE](./LICENSE).

---

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, and fx. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and fx. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - fx: install [fx](https://fx.sh) and run `fx login` on the machine running the T3 Code server ([setup guide](./docs/user/providers-fx.md))

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

#### Nix (nixpkgs)

```bash
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

The package is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
and includes the desktop app (`t3code-desktop`) and the `t3` command.
See [Nix installation](./docs/user/install.md#nix-nixpkgs) for NixOS configuration and updates.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
