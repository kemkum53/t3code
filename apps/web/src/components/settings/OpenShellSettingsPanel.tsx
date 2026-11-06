import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OpenShellOverview,
  OpenShellSandboxSummary,
  OpenShellTemplate,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
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

type AtomCommandResult = Parameters<typeof isAtomCommandInterrupted>[0];

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

function ContinueAfterAllowRow() {
  const enabled = usePrimarySettings((settings) => settings.openShellContinueAfterAllow);
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      title="Continue after Allow"
      control={
        <Switch
          aria-label="Continue after Allow"
          checked={enabled}
          onCheckedChange={(checked) => {
            updateSettings({ openShellContinueAfterAllow: Boolean(checked) });
            toastManager.add({
              type: "success",
              title: checked
                ? "Claude continues after you allow access"
                : "Claude waits for your message after you allow access",
            });
          }}
        />
      }
    />
  );
}

interface SetupProps {
  readonly environmentId: EnvironmentId;
  readonly overview: OpenShellOverview;
  readonly onChanged: () => void;
}

const TEMPLATE_PRESETS = [
  { name: "Python", packages: "python3 python3-pip python3-venv" },
  { name: "Node", packages: "nodejs npm" },
  { name: "C++", packages: "build-essential cmake gdb" },
];

const NETWORK_OPTIONS = [
  { value: "developer", label: "GitHub, npm and PyPI" },
  { value: "claude", label: "Claude only" },
] as const;

function useBuildCommand(
  props: SetupProps,
  messages: { readonly success: string; readonly failure: string },
) {
  const { overview, onChanged } = props;
  const [password, setPassword] = useState("");
  const [started, setStarted] = useState(false);
  const running = started || overview.setupStep !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polling timer while the server runs setup
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(onChanged, SETUP_POLL_MS);
    return () => clearInterval(timer);
  }, [running, onChanged]);

  const run = async (command: (sudoPassword: string) => Promise<AtomCommandResult>) => {
    setStarted(true);
    const result = await command(password);
    setStarted(false);
    setPassword("");
    onChanged();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) reportFailure(messages.failure, result);
      return false;
    }
    toastManager.add({ type: "success", title: messages.success });
    return true;
  };

  const missingPassword = overview.sudoNeedsPassword && password === "";
  const stepLabel = running
    ? (SETUP_STEP_LABELS[overview.setupStep ?? "check"] ?? overview.setupStep ?? undefined)
    : undefined;
  return { running, password, setPassword, run, missingPassword, stepLabel };
}

function PasswordInput(props: {
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  if (!props.visible) return null;
  return (
    <Input
      aria-label="Linux password"
      autoComplete="off"
      disabled={props.disabled}
      placeholder="Linux password"
      type="password"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

function SetupRow(props: SetupProps) {
  const { environmentId, overview } = props;
  const setup = useAtomCommand(orchestrationEnvironment.setupOpenShell);
  const build = useBuildCommand(props, {
    success: "OpenShell installed and sandbox templates added",
    failure: "OpenShell was not set up",
  });
  return (
    <SettingsRow
      title="Set up this machine"
      description="Installs OpenShell and builds the sandbox image. Uses about 1 GB of disk."
      status={build.stepLabel}
      control={
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void build.run((sudoPassword) => setup({ environmentId, input: { sudoPassword } }));
          }}
        >
          <PasswordInput
            visible={overview.sudoNeedsPassword}
            disabled={build.running}
            value={build.password}
            onChange={build.setPassword}
          />
          <Button type="submit" size="sm" disabled={build.running || build.missingPassword}>
            {build.running ? "Installing" : "Install"}
          </Button>
        </form>
      }
    />
  );
}

function TemplateRow(props: SetupProps & { readonly template: OpenShellTemplate }) {
  const { environmentId, overview, template, onChanged } = props;
  const save = useAtomCommand(orchestrationEnvironment.saveOpenShellTemplate);
  const remove = useAtomCommand(orchestrationEnvironment.deleteOpenShellTemplate);
  const [packages, setPackages] = useState(template.packages);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const build = useBuildCommand(props, {
    success: `${template.name} rebuilt, open chats can update from Guard`,
    failure: `${template.name} was not rebuilt`,
  });
  const onDelete = async () => {
    const result = await remove({ environmentId, input: { id: template.id } });
    setConfirmingDelete(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(`${template.name} was not deleted`, result);
      }
      return;
    }
    toastManager.add({ type: "success", title: `Template ${template.name} deleted` });
    onChanged();
  };
  const network = NETWORK_OPTIONS.find(({ value }) => value === template.network)?.label;
  return (
    <SettingsRow
      title={template.name}
      description={network}
      status={build.stepLabel}
      control={
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void build.run((sudoPassword) =>
              save({
                environmentId,
                input: {
                  id: template.id,
                  name: template.name,
                  packages: packages.trim(),
                  network: template.network,
                  sudoPassword,
                },
              }),
            );
          }}
        >
          <Input
            aria-label={`Packages in ${template.name}`}
            autoComplete="off"
            className="w-72"
            disabled={build.running}
            value={packages}
            onChange={(event) => setPackages(event.target.value)}
          />
          <PasswordInput
            visible={overview.sudoNeedsPassword}
            disabled={build.running}
            value={build.password}
            onChange={build.setPassword}
          />
          <Button
            type="submit"
            size="xs"
            variant="ghost"
            disabled={build.running || build.missingPassword}
          >
            {build.running ? "Building" : "Rebuild"}
          </Button>
          {confirmingDelete ? (
            <>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep
              </Button>
              <Button type="button" size="xs" variant="destructive" onClick={() => void onDelete()}>
                Delete template
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={build.running}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </Button>
          )}
        </form>
      }
    />
  );
}

function AddTemplateRow(props: SetupProps) {
  const { environmentId, overview } = props;
  const save = useAtomCommand(orchestrationEnvironment.saveOpenShellTemplate);
  const [name, setName] = useState("");
  const [packages, setPackages] = useState("");
  const [network, setNetwork] = useState<OpenShellTemplate["network"]>("developer");
  const build = useBuildCommand(props, {
    success: `Template ${name.trim()} added, pick it in the model menu`,
    failure: "Template was not added",
  });
  const networkLabel = NETWORK_OPTIONS.find(({ value }) => value === network)?.label;
  return (
    <SettingsRow
      title="Add template"
      description="Each template has its own image of 600 to 900 MB."
      status={build.stepLabel}
      control={
        <span className="flex items-center gap-1">
          {TEMPLATE_PRESETS.map((preset) => (
            <Button
              key={preset.name}
              type="button"
              size="xs"
              variant="ghost"
              disabled={build.running}
              onClick={() => {
                setName(preset.name);
                setPackages(preset.packages);
              }}
            >
              {preset.name}
            </Button>
          ))}
        </span>
      }
    >
      <form
        className="mt-3 mb-2 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void build
            .run((sudoPassword) =>
              save({
                environmentId,
                input: {
                  id: null,
                  name: name.trim(),
                  packages: packages.trim(),
                  network,
                  sudoPassword,
                },
              }),
            )
            .then((saved) => {
              if (!saved) return;
              setName("");
              setPackages("");
            });
        }}
      >
        <Input
          aria-label="Template name"
          autoComplete="off"
          className="w-36"
          disabled={build.running}
          placeholder="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          aria-label="Template packages"
          autoComplete="off"
          className="min-w-48 flex-1"
          disabled={build.running}
          placeholder="apt packages"
          value={packages}
          onChange={(event) => setPackages(event.target.value)}
        />
        <Select
          value={network}
          onValueChange={(next) => {
            if (next === "developer" || next === "claude") setNetwork(next);
          }}
        >
          <SelectTrigger aria-label="Template network" className="w-48" size="sm">
            <SelectValue>{networkLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {NETWORK_OPTIONS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <PasswordInput
          visible={overview.sudoNeedsPassword}
          disabled={build.running}
          value={build.password}
          onChange={build.setPassword}
        />
        <Button
          type="submit"
          size="sm"
          disabled={build.running || build.missingPassword || name.trim() === ""}
        >
          {build.running ? "Building" : "Add"}
        </Button>
      </form>
    </SettingsRow>
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
      {installed ? (
        <SettingsSection title="Templates">
          {overview.templates.map((template) => (
            <TemplateRow
              key={`${template.id}:${template.packages}`}
              environmentId={environmentId}
              overview={overview}
              template={template}
              onChanged={query.refresh}
            />
          ))}
          <AddTemplateRow
            environmentId={environmentId}
            overview={overview}
            onChanged={query.refresh}
          />
        </SettingsSection>
      ) : null}
      <SettingsSection title="Sandboxes">
        <IdleStopRow minutes={overview.idleStopMinutes} onChanged={query.refresh} />
        <ContinueAfterAllowRow />
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
