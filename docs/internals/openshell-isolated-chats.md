# OpenShell isolated chats

Working plan for the `feat/openshell-isolated-chats` branch of the kemkum53/t3code fork.

## Goal

A chat can run inside an OpenShell sandbox on whichever machine hosts the T3 server. Isolated chats
sit beside normal chats in the same project, and their guard rules are managed from the chat.

## Design

- The existing Claude driver is kept. An isolated instance replaces only how the process starts.
- `ClaudeAdapterV2.ts` already resolves `spawnProcess` from `options.spawnClaudeCodeProcess`, the SDK
  hook intended for VMs and containers. The hook runs `openshell sandbox exec --no-tty` in place of
  the local binary. On Windows it goes through `wsl.exe -d <distro>`.
- One sandbox per isolated thread, created from a template (image plus policy).
- OpenShell code lives in its own package, so upstream merges stay small.
- Every sandbox uses the MicroVM driver, on both Windows (WSL) and Raspberry Pi.

## Measured on 2026-11-05 (OpenShell 0.1.7)

| Check                                          | Result                                                 |
| ---------------------------------------------- | ------------------------------------------------------ |
| Sandbox ready, image cached                    | 4 to 12 s                                              |
| Landlock `hard_requirement`                    | Starts                                                 |
| Writes to `/etc`, `/usr/bin`, `mount`          | Denied                                                 |
| Internet, LAN, host, metadata without a rule   | Denied                                                 |
| Per-binary rule                                | `curl` denied where `claude` is allowed                |
| Two-way stream-json over `sandbox exec`        | Two messages, two results                              |
| Network rule change while running              | Applied without restart                                |
| Subscription through provider                  | Request works, sandbox holds only a placeholder        |
| Agent SDK through `wsl.exe` and `sandbox exec` | Two turns in one session, Read and Bash ran in the box |
| `canUseTool` approval                          | Round trip from the box to the host works              |

## Setup measured on 2026-11-06

Clean Ubuntu 24.04 WSL distro, non-root user, sudo password required.

| Check                              | Result                                  |
| ---------------------------------- | --------------------------------------- |
| Full setup                         | 87 s                                    |
| Second run                         | 0 s, every step skips                   |
| Wrong sudo password                | Stops with a clear message              |
| Disk used                          | About 1 GB                              |
| Image size                         | 607 MB, down from 842 MB                |
| Box ready from the built image     | 17 s                                    |
| Inside the box                     | Claude runs, `/etc` and internet denied |
| Leftovers in `/var/tmp` and mounts | None                                    |

The image is built on the user's machine from Ubuntu Base in a chroot, so setup needs no Docker and
no one redistributes Claude Code. Downloads are pinned by SHA-256.

## Access request timing measured on 2026-11-06

| Step                                | Result                                 |
| ----------------------------------- | -------------------------------------- |
| Denial reaches `openshell logs`     | 0.3 s                                  |
| Denial reaches `rule get`           | 6 to 10 s after the log line           |
| `rule approve` until usable         | 7 to 17 s                              |
| `policy update --wait` until usable | 1 to 10 s, supervisor polls every 10 s |
| Reading requests from Windows       | 174 ms                                 |

`OPENSHELL_DENIAL_FLUSH_INTERVAL_SECS` and `OPENSHELL_POLICY_POLL_INTERVAL_SECS` exist, but
`sandbox create --env` refuses keys that start with `OPENSHELL_`, so requests come from the logs.

Landlock refusals leave no log line. The guard finds them in the agent's command output, so a
denial the agent never prints stays invisible.

An idle box stops only after T3 has closed its session, because stopping it kills the agent.

## Changing a running box, tested on 2026-11-06

`policy set` accepts added filesystem paths, and they apply after stop and start. It refuses removed
paths and `run_as_user` changes, so a box can gain read access but can never become root. System
packages therefore go into the image. A rebuilt image reaches new boxes only.

| Check                                | Result                         |
| ------------------------------------ | ------------------------------ |
| Rebuild with python3, pip, node, npm | 104 s, 875 MB                  |
| Rebuild with python3 only            | 72 s, 624 MB                   |
| First box from a new image           | 54 s                           |
| Box made before the rebuild          | Keeps its old image            |
| Allow a path, including restart      | 42 s, files in `/sandbox` kept |

An open chat moves to a rebuilt image by replacing its box: `/sandbox` is copied to the Linux
filesystem, the box is recreated under the same name with the active policy, and the copy is
restored. Measured at 37 s with files, git history, rules and allowed paths kept. Rules named
`_provider_*` must be left out, because the gateway adds them itself and refuses a policy with them.

## Distribution

T3 Code has no plugin system and upstream does not take large features, so this ships as a fork with
its own installer. A user still has to install WSL with Ubuntu and paste a setup token.

## Requirements

1. New chat dialog offers normal or isolated, then template and machine.
2. The sidebar marks isolated chats. They stay in the same project.
3. The guard panel shows box state, network rules, recent denials, and stop or delete actions.
4. Blocked requests become approve or reject cards in the chat (policy advisor).
5. Filesystem rules are fixed at box start, so changing them offers a restart with new rules.
6. Settings has an OpenShell page with a setup wizard:
   - host check: WSL, KVM, kernel, disk, outbound network
   - install: package, gateway config, `kvm` group, image
   - account: show `claude setup-token`, paste the token, store it through stdin
   - verify: start a test box and send a request
7. Credentials reach the gateway through stdin only, never through argv.
8. An isolated chat can start without a project, on an empty workspace with no apply step.
9. Network rules, filesystem rules and templates are all editable from the guard panel.

## Project files

- Tracked files are copied to the WSL filesystem, then uploaded. Ignored files such as `.env` stay out.
- The box gets a baseline commit, so its changes come back as `git diff --binary`.
- The agent never touches host files. A patch reaches the project only after the user applies it.

## Known constraints

- OpenShell #3728: uploads from a WSL `/mnt/<drive>` path keep the size but lose the content.
  Copy to the Linux filesystem first and verify hashes.
- A provider credential needs L7 inspection on its endpoint (`protocol: rest`).
- `sandbox connect` attaches to the main process. Use `sandbox exec --tty -- bash` for a shell.
- The VM gateway needs `allow_driver_config = true` to accept a rootfs tar.
- The gateway user service must start after the user joins the `kvm` group.
- Claude telemetry to `datadoghq.com` is denied. The panel should not treat that as a problem.
- A setup token covers model requests only, not claude.ai connectors or Remote Control.

## Open questions

- T3 injects an MCP server per thread. Can the box reach it, and does a turn survive if not?
- Checkpoints, diffs and git run on the host. How do box changes come back: patch, or file sync?
- Which T3 paths assume host files: `claudeHistoryWorker`, resume, and worktrees?
- SDK arguments and `cwd` carry Windows paths. They need mapping to box paths.

## Template hosts, tested on 2026-11-07

| Check                                      | Result            |
| ------------------------------------------ | ----------------- |
| `/usr/bin/curl` to a listed host           | 200               |
| `/usr/bin/curl` to an unlisted host        | Denied and logged |
| `python3` to a listed host                 | 200               |
| A binary copied under `/sandbox` to a host | 200               |
| Box ready from a 917 MB template image     | 41 s              |

## Full test suite against upstream, 2026-11-09

Each package ran on this branch and on its upstream base (`337c5858c3`), and failures were compared
by test name. Failures present on both sides are Windows specific (symlink permission, path
separators, Linux only tests).

| Package    | Branch                 | Upstream               | Branch only               |
| ---------- | ---------------------- | ---------------------- | ------------------------- |
| server     | 6626 tests, 175 failed | 6568 tests, 176 failed | 1, passed 3 of 3 alone    |
| web        | 4726 tests, 1 failed   | 4718 tests, 0 failed   | 1, a real bug, fixed      |
| shared     | 1399 tests, 12 failed  | 1399 tests, 13 failed  | 0                         |
| task-cache | 41 tests, 3 failed     | 41 tests, 2 failed     | 1, timeout, passed 3 of 3 |

## Upstream

Upstream takes features only after an Ideas discussion with explicit maintainer approval of scope.
Two related PRs were open on 2026-11-09: #15350 (Docker sandbox per thread, by a maintainer) and
#32158 (OpenShell as worker environments, with maintainer fixups). This branch stays a fork; a
discussion can offer per-chat isolation as a second backend.

## Milestones

- [x] Pilot on PC and Raspberry Pi
- [x] Subscription through a provider
- [x] Dev environment for the fork (Node 26, pnpm)
- [x] Spike: Agent SDK session runs in a sandbox through `spawnClaudeCodeProcess`
- [x] Spike: same flow from a real T3 thread
- [x] File round trip
- [x] Approval cards in Supervised mode
- [x] Diff review and apply in the UI
- [x] One box per thread, deleted with the thread
- [x] Project-less isolated chat (runs on T3's scratch project, no apply step)
- [x] Settings page: machine checks, token, sandbox list
- [x] Sidebar marker and template instances
- [x] Guard dialog: network rules, denials, stop and start
- [x] Install steps in the settings page
- [x] Delete warning for unapplied changes
- [x] Stop idle boxes automatically
- [ ] Raspberry Pi support (blocked: 1.9 GB free on the Pi, setup needs 3 GB)
