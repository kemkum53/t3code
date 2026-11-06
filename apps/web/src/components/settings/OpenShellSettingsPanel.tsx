import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OpenShellOverview, OpenShellSandboxSummary } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const SETUP_TOKEN_COMMAND = "claude setup-token";
const INSTALL_LINUX_COMMAND = "wsl --install -d Ubuntu-24.04";
const SETUP_POLL_MS = 3_000;
const SETUP_STEP_LABELS: Readonly<Record<string, string>> = {
  check: "Checking this machine",
  package: "Installing OpenShell",
  gateway: "Starting the gateway",
  image: "Building the sandbox image",
  done: "Finishing",
};

const reportFailure = (title: string, result: unknown) => {
  const error = squashAtomCommandFailure(result as never);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });
};

function CredentialRow(props: {
  readonly environmentId: EnvironmentId;
  readonly stored: boolean;
  readonly onSaved: () => void;
}) {
  const save = useAtomCommand(orchestrationEnvironment.saveOpenShellCredential);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    const result = await save({
      environmentId: props.environmentId,
      input: { token: token.trim() },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) reportFailure("Token was not saved", result);
      return;
    }
    setToken("");
    toastManager.add({ type: "success", title: "Claude token saved to the OpenShell gateway" });
    props.onSaved();
  };
  return (
    <SettingsRow
      title="Claude subscription"
      description={`Run ${SETUP_TOKEN_COMMAND} in a terminal, then paste the token here.`}
      status={props.stored ? "Stored" : "Missing"}
      control={
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            aria-label="Claude setup token"
            autoComplete="off"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={saving || token.trim() === ""}>
            Save
          </Button>
        </form>
      }
    />
  );
}

const IDLE_STOP_OPTIONS = [
  { minutes: 0, label: "Never" },
  { minutes: 30, label: "After 30 minutes" },
  { minutes: 60, label: "After 1 hour" },
  { minutes: 120, label: "After 2 hours" },
];

function IdleStopRow(props: { readonly minutes: number; readonly onChanged: () => void }) {
  const updateSettings = useUpdatePrimarySettings();
  const current = IDLE_STOP_OPTIONS.find(({ minutes }) => minutes === props.minutes);
  return (
    <SettingsRow
      title="Stop idle sandboxes"
      control={
        <Select
          value={String(props.minutes)}
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            const option = IDLE_STOP_OPTIONS.find(({ minutes }) => String(minutes) === next);
            if (option === undefined) return;
            updateSettings({ openShellIdleStopMinutes: option.minutes });
            toastManager.add({
              type: "success",
              title:
                option.minutes === 0
                  ? "Idle sandboxes keep running"
                  : `Idle sandboxes stop ${option.label.toLowerCase()}`,
            });
            props.onChanged();
          }}
        >
          <SelectTrigger aria-label="Stop idle sandboxes" size="sm">
            <SelectValue>{current?.label ?? `After ${props.minutes} minutes`}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {IDLE_STOP_OPTIONS.map(({ minutes, label }) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

interface SetupProps {
  readonly environmentId: EnvironmentId;
  readonly overview: OpenShellOverview;
  readonly onChanged: () => void;
}

function useSetupCommand(props: SetupProps, messages: { success: string; failure: string }) {
  const { environmentId, overview, onChanged } = props;
  const setup = useAtomCommand(orchestrationEnvironment.setupOpenShell);
  const [password, setPassword] = useState("");
  const [started, setStarted] = useState(false);
  const running = started || overview.setupStep !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polling timer while the server runs setup
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(onChanged, SETUP_POLL_MS);
    return () => clearInterval(timer);
  }, [running, onChanged]);

  const submit = async (imagePackages: string | null) => {
    setStarted(true);
    const result = await setup({
      environmentId,
      input: { sudoPassword: password, imagePackages },
    });
    setStarted(false);
    setPassword("");
    onChanged();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) reportFailure(messages.failure, result);
      return;
    }
    toastManager.add({ type: "success", title: messages.success });
  };

  const missingPassword = overview.sudoNeedsPassword && password === "";
  return { running, password, setPassword, submit, missingPassword };
}

function SetupRow(props: SetupProps) {
  const { overview } = props;
  const { running, password, setPassword, submit, missingPassword } = useSetupCommand(props, {
    success: "OpenShell installed and sandbox templates added",
    failure: "OpenShell was not set up",
  });
  return (
    <SettingsRow
      title="Set up this machine"
      description="Installs OpenShell and builds the sandbox image. Uses about 1 GB of disk."
      status={
        running
          ? (SETUP_STEP_LABELS[overview.setupStep ?? "check"] ?? overview.setupStep)
          : undefined
      }
      control={
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(null);
          }}
        >
          {overview.sudoNeedsPassword ? (
            <Input
              aria-label="Linux password"
              autoComplete="off"
              disabled={running}
              placeholder="Linux password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          ) : null}
          <Button type="submit" size="sm" disabled={running || missingPassword}>
            {running ? "Installing" : "Install"}
          </Button>
        </form>
      }
    />
  );
}

function ImagePackagesRow(props: SetupProps) {
  const { overview } = props;
  const [packages, setPackages] = useState(overview.imagePackages);
  const { running, password, setPassword, submit, missingPassword } = useSetupCommand(props, {
    success: "Sandbox image rebuilt, new chats get these packages",
    failure: "Sandbox image was not rebuilt",
  });
  return (
    <SettingsRow
      title="Packages in new sandboxes"
      description="Space separated apt packages. Open chats keep their own image."
      status={running ? (SETUP_STEP_LABELS[overview.setupStep ?? "check"] ?? "Working") : undefined}
      control={
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(packages.trim());
          }}
        >
          <Input
            aria-label="Image packages"
            autoComplete="off"
            disabled={running}
            value={packages}
            onChange={(event) => setPackages(event.target.value)}
          />
          {overview.sudoNeedsPassword ? (
            <Input
              aria-label="Linux password"
              autoComplete="off"
              disabled={running}
              placeholder="Linux password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          ) : null}
          <Button type="submit" size="sm" disabled={running || missingPassword}>
            {running ? "Rebuilding" : "Rebuild"}
          </Button>
        </form>
      }
    />
  );
}

function SandboxRow(props: {
  readonly environmentId: EnvironmentId;
  readonly sandbox: OpenShellSandboxSummary;
  readonly onChanged: () => void;
}) {
  const { sandbox } = props;
  const control = useAtomCommand(orchestrationEnvironment.controlSandbox);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const run = async (action: "stop" | "start" | "delete") => {
    setBusy(true);
    const result = await control({
      environmentId: props.environmentId,
      input: { sandbox: sandbox.name, action },
    });
    setBusy(false);
    setConfirmingDelete(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) reportFailure("Sandbox was not changed", result);
      return;
    }
    const verb = { stop: "stopped", start: "started", delete: "deleted" }[action];
    toastManager.add({ type: "success", title: `Sandbox ${sandbox.name} ${verb}` });
    props.onChanged();
  };
  const running = sandbox.phase === "Ready";
  return (
    <SettingsRow
      title={<span className="font-mono">{sandbox.name}</span>}
      status={sandbox.phase}
      control={
        <span className="flex items-center gap-1">
          {confirmingDelete ? (
            <>
              <Button size="xs" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Keep
              </Button>
              <Button
                size="xs"
                variant="destructive"
                disabled={busy}
                onClick={() => void run("delete")}
              >
                Delete files too
              </Button>
            </>
          ) : (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(running ? "stop" : "start")}
              >
                {running ? "Stop" : "Start"}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </Button>
            </>
          )}
        </span>
      }
    />
  );
}

function OpenShellOverviewContent(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const query = useEnvironmentQuery(
    orchestrationEnvironment.openShellOverview({ environmentId, input: {} }),
  );
  const overview = query.data;
  if (overview === null) {
    return (
      <p className="text-sm text-muted-foreground">{query.error ?? "Checking this machine"}</p>
    );
  }
  const yesNo = (ok: boolean, good: string, bad: string) => (ok ? good : bad);
  const installed =
    overview.configured &&
    overview.version !== null &&
    overview.gatewayActive &&
    overview.imageAvailable;
  return (
    <>
      <SettingsSection title="This machine">
        {overview.linuxAvailable ? (
          installed ? null : (
            <SetupRow environmentId={environmentId} overview={overview} onChanged={query.refresh} />
          )
        ) : (
          <SettingsRow
            title="Linux"
            status="Missing"
            description={`Run ${INSTALL_LINUX_COMMAND} in an administrator terminal, then open this page again.`}
          />
        )}
        <SettingsRow title="OpenShell" status={overview.version ?? "Not installed"} />
        <SettingsRow
          title="Gateway"
          status={yesNo(overview.gatewayActive, "Running", "Not running")}
        />
        <SettingsRow
          title="Virtualization"
          status={yesNo(overview.kvmAvailable, "Available", "Unavailable")}
        />
        <SettingsRow
          title="Sandbox image"
          status={yesNo(overview.imageAvailable, "Ready", "Missing")}
        />
        <SettingsRow title="Free disk" status={`${overview.freeDiskGb} GB`} />
        <CredentialRow
          environmentId={environmentId}
          stored={overview.credentialStored}
          onSaved={query.refresh}
        />
      </SettingsSection>
      <SettingsSection title="Sandboxes">
        <IdleStopRow minutes={overview.idleStopMinutes} onChanged={query.refresh} />
        {installed ? (
          <ImagePackagesRow
            environmentId={environmentId}
            overview={overview}
            onChanged={query.refresh}
          />
        ) : null}
        {overview.sandboxes.length === 0 ? (
          <SettingsRow title="No sandboxes" />
        ) : (
          overview.sandboxes.map((sandbox) => (
            <SandboxRow
              key={sandbox.name}
              environmentId={environmentId}
              sandbox={sandbox}
              onChanged={query.refresh}
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}

export function OpenShellSettingsPanel() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  return (
    <SettingsPageContainer>
      {environmentId === null ? null : <OpenShellOverviewContent environmentId={environmentId} />}
    </SettingsPageContainer>
  );
}
