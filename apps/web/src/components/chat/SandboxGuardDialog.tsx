import { useState } from "react";
import type {
  EnvironmentId,
  OpenShellDenial,
  OpenShellGuardRule,
  OpenShellSandboxGuardChange,
  ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

const DEFAULT_PORT = 443;
const DEFAULT_BINARY = "/usr/bin/curl";

const changeNotice = (change: OpenShellSandboxGuardChange) => {
  switch (change.type) {
    case "allow":
      return `Allowed ${change.host}:${change.port} for ${change.binary}, active now`;
    case "remove":
      return `Removed ${change.host}:${change.port} from the rules`;
    case "deny":
      return `Denied ${change.host}:${change.port}`;
    case "allowPath":
      return `Sandbox restarted with read access to ${change.path}`;
    case "denyPath":
      return `Denied read access to ${change.path}`;
    case "saveCopy":
      return "Sandbox files copied to your Downloads folder";
    case "updateImage":
      return "Sandbox moved to the new image, files and rules kept";
    case "stop":
      return "Sandbox stopped, its files stay on disk";
    case "start":
      return "Sandbox started";
  }
};

function RuleRow(props: {
  readonly rule: OpenShellGuardRule;
  readonly busy: boolean;
  readonly onRemove: () => void;
}) {
  const { rule } = props;
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="min-w-0 truncate font-mono">
        {rule.host}:{rule.port}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
        {rule.binaries.map((binary) => binary.split("/").at(-1)).join(", ")}
        {rule.managed ? (
          <span className="text-xs">required</span>
        ) : (
          <Button size="xs" variant="ghost" disabled={props.busy} onClick={props.onRemove}>
            Remove
          </Button>
        )}
      </span>
    </li>
  );
}

function DenialRow(props: {
  readonly denial: OpenShellDenial;
  readonly busy: boolean;
  readonly onAllow: () => void;
}) {
  const { denial } = props;
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="min-w-0 truncate font-mono">
        {denial.host}:{denial.port}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
        {denial.binary.split("/").at(-1)} × {denial.count}
        <Button size="xs" variant="ghost" disabled={props.busy} onClick={props.onAllow}>
          Allow
        </Button>
      </span>
    </li>
  );
}

function GuardContent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agentRunning: boolean;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId } = props;
  const query = useEnvironmentQuery(
    orchestrationEnvironment.sandboxGuard({ environmentId, input: { threadId } }),
  );
  const update = useAtomCommand(orchestrationEnvironment.updateSandboxGuard);
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState("");
  const [binary, setBinary] = useState(DEFAULT_BINARY);

  const apply = async (change: OpenShellSandboxGuardChange) => {
    setBusy(true);
    const result = await update({ environmentId, input: { threadId, change } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return false;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Sandbox was not changed",
        description: error instanceof Error ? error.message : undefined,
      });
      return false;
    }
    toastManager.add({ type: "success", title: changeNotice(change) });
    query.refresh();
    return true;
  };

  const guard = query.data;
  const running = guard?.phase === "Ready";
  const pending = new Set(guard?.requests.map(({ host, port }) => `${host}:${port}`));
  const blocked = (guard?.denials ?? []).filter(
    ({ host, port }) => !pending.has(`${host}:${port}`),
  );
  return (
    <>
      <DialogHeader>
        <DialogTitle>{guard?.sandbox ?? "Sandbox"}</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        {guard === null || guard === undefined ? (
          <p className="text-sm text-muted-foreground">{query.error ?? "Loading sandbox rules"}</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm">Status: {guard.phase}</p>
            {guard.requests.length > 0 ? (
              <section>
                <h3 className="mb-1 text-sm font-medium">Access requests</h3>
                <ul className="space-y-1">
                  {guard.requests.map((request) => (
                    <li
                      key={`${request.binary}:${request.host}:${request.port}`}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="min-w-0 truncate font-mono">
                        {request.host}:{request.port}
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                        {request.binary.split("/").at(-1)}
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void apply({
                              type: "deny",
                              host: request.host,
                              port: request.port,
                              binary: request.binary,
                              chunkId: request.chunkId,
                            })
                          }
                        >
                          Deny
                        </Button>
                        <Button
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            void apply({
                              type: "allow",
                              host: request.host,
                              port: request.port,
                              binary: request.binary,
                            })
                          }
                        >
                          Allow
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {blocked.length > 0 ? (
              <section>
                <h3 className="mb-1 text-sm font-medium">Blocked in the last 30 minutes</h3>
                <ul className="space-y-1">
                  {blocked.map((denial) => (
                    <DenialRow
                      key={`${denial.binary}:${denial.host}:${denial.port}`}
                      denial={denial}
                      busy={busy}
                      onAllow={() =>
                        void apply({
                          type: "allow",
                          host: denial.host,
                          port: denial.port,
                          binary: denial.binary,
                        })
                      }
                    />
                  ))}
                </ul>
              </section>
            ) : null}
            {guard.fileRequests.length > 0 ? (
              <section>
                <h3 className="mb-1 text-sm font-medium">File requests</h3>
                <ul className="space-y-1">
                  {guard.fileRequests.map(({ path, program }) => (
                    <li key={path} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate font-mono">{path}</span>
                      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                        {program}
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void apply({ type: "denyPath", path })}
                        >
                          Deny
                        </Button>
                        <Button
                          size="xs"
                          disabled={busy}
                          onClick={() => void apply({ type: "allowPath", path })}
                        >
                          Allow read
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {guard.fileDenials.length > 0 ? (
              <section>
                <h3 className="mb-1 text-sm font-medium">Blocked file access</h3>
                <ul className="space-y-1">
                  {guard.fileDenials.map((denial) => (
                    <li key={`${denial.command}:${denial.message}`} className="text-sm">
                      <span className="block truncate font-mono">{denial.command}</span>
                      <span className="block truncate text-muted-foreground">{denial.message}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section>
              <h3 className="mb-1 text-sm font-medium">Allowed files</h3>
              <p className="font-mono text-xs">Write: {guard.writablePaths.join("  ")}</p>
              <p className="font-mono text-xs text-muted-foreground">
                Read: {guard.readOnlyPaths.join("  ")}
              </p>
            </section>
            <section>
              <h3 className="mb-1 text-sm font-medium">Allowed network</h3>
              <ul className="space-y-1">
                {guard.rules.map((rule) => (
                  <RuleRow
                    key={`${rule.name}:${rule.host}:${rule.port}`}
                    rule={rule}
                    busy={busy}
                    onRemove={() =>
                      void apply({ type: "remove", host: rule.host, port: rule.port })
                    }
                  />
                ))}
              </ul>
            </section>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void apply({
                  type: "allow",
                  host: host.trim(),
                  port: DEFAULT_PORT,
                  binary: binary.trim(),
                }).then((allowed) => {
                  if (allowed) setHost("");
                });
              }}
            >
              <Input
                aria-label="Host"
                placeholder="registry.npmjs.org"
                value={host}
                onChange={(event) => setHost(event.target.value)}
              />
              <Input
                aria-label="Program"
                value={binary}
                onChange={(event) => setBinary(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={busy || host.trim() === ""}>
                Allow
              </Button>
            </form>
          </div>
        )}
      </DialogPanel>
      <DialogFooter>
        {guard ? (
          <Button
            variant="ghost"
            disabled={busy || !running}
            onClick={() => void apply({ type: "saveCopy" })}
          >
            Save copy
          </Button>
        ) : null}
        {guard?.updateAvailable ? (
          <Button
            disabled={busy || props.agentRunning}
            onClick={() => void apply({ type: "updateImage" })}
          >
            {busy ? "Updating" : "Update to new image"}
          </Button>
        ) : null}
        {guard ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void apply({ type: running ? "stop" : "start" })}
          >
            {running ? "Stop sandbox" : "Start sandbox"}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

/** Network rules change live, so this stays available while the agent works. */
export function SandboxGuardButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agentRunning: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Guard
      </Button>
      <Dialog open={open} onOpenChange={setOpen} disablePointerDismissal>
        <DialogPopup className="max-w-2xl">
          {open ? (
            <GuardContent
              environmentId={props.environmentId}
              threadId={props.threadId}
              agentRunning={props.agentRunning}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}
