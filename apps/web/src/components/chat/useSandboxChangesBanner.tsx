import { FileDiff } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { useState } from "react";
import type { EnvironmentId, OpenShellSandboxChanges, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { BoxIcon } from "lucide-react";

import { useRenderedAppearance } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { sandboxStateOfPhase, type SandboxState } from "../../lib/openShellThreads";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { DIFF_VIEW_UNSAFE_CSS } from "../diffs/StyledDiffCodeView";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { SandboxGuardButton } from "./SandboxGuardDialog";

const fileCount = (count: number) => (count === 1 ? "1 file" : `${count} files`);

const NO_CHANGES: OpenShellSandboxChanges = {
  sandboxed: true,
  sandbox: null,
  workdir: null,
  template: null,
  hasProject: false,
  blockedFileCount: 0,
  files: [],
  diff: "",
};

const sandboxIcon = (state: SandboxState | null) => {
  if (state === "starting") return <Spinner size="sm" />;
  if (state === "running") return <BoxIcon className="text-success" />;
  return <BoxIcon className={state === "stopped" ? "text-destructive" : undefined} />;
};

const blockedFiles = (count: number) =>
  count === 1 ? "1 file access blocked" : `${count} file accesses blocked`;

const parseSandboxDiff = (diff: string) => {
  try {
    return parsePatchFiles(diff).flatMap(({ files }) => files);
  } catch {
    return null;
  }
};

/** Falls back to the raw patch because a binary hunk can defeat the parser. */
function SandboxDiff(props: { readonly diff: string }) {
  const appearance = useRenderedAppearance();
  const files = parseSandboxDiff(props.diff);
  if (files === null) {
    return (
      <pre className="overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{props.diff}</pre>
    );
  }
  return (
    <DiffWorkerPoolProvider>
      <div className="space-y-3">
        {files.map((file) => (
          <div key={file.name} className="overflow-hidden rounded-md border border-border/60">
            <FileDiff
              fileDiff={file}
              options={{
                diffStyle: "unified",
                lineDiffType: "word",
                overflow: "wrap",
                theme: resolveDiffThemeName(appearance),
                themeType: appearance,
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
                unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
              }}
            />
          </div>
        ))}
      </div>
    </DiffWorkerPoolProvider>
  );
}

function SandboxChangesReview(props: {
  readonly changes: OpenShellSandboxChanges;
  readonly applying: boolean;
  readonly canApply: boolean;
  readonly hasProject: boolean;
  readonly onApply: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Review
      </Button>
      <Dialog open={open} onOpenChange={setOpen} disablePointerDismissal>
        <DialogPopup className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{fileCount(props.changes.files.length)} changed</DialogTitle>
          </DialogHeader>
          <DialogPanel>{open ? <SandboxDiff diff={props.changes.diff} /> : null}</DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            {props.hasProject ? (
              <Button
                disabled={!props.canApply || props.applying}
                onClick={() => {
                  void props.onApply().then((applied) => {
                    if (applied) setOpen(false);
                  });
                }}
              >
                {props.applying ? "Applying" : "Apply to project"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** The box folder of a sandboxed thread, which is where its files really are. */
export function useSandboxWorkdir(environmentId: EnvironmentId, threadId: ThreadId): string | null {
  const query = useEnvironmentQuery(
    orchestrationEnvironment.sandboxChanges({ environmentId, input: { threadId } }),
  );
  return query.data?.workdir ?? null;
}

/** Sandboxed threads work on a copy, so their edits wait here until the user applies them. */
export function useSandboxChangesBanner(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly phase: string;
}): ComposerBannerStackItem | null {
  const { environmentId, threadId, phase } = input;
  const query = useEnvironmentQuery(
    threadId === null
      ? null
      : orchestrationEnvironment.sandboxChanges({ environmentId, input: { threadId } }),
  );
  const { refresh } = query;
  const requestsQuery = useEnvironmentQuery(
    threadId === null
      ? null
      : orchestrationEnvironment.sandboxRequests({ environmentId, input: { threadId } }),
  );
  const refreshRequests = requestsQuery.refresh;
  const apply = useAtomCommand(orchestrationEnvironment.applySandboxChanges);
  const updateGuard = useAtomCommand(orchestrationEnvironment.updateSandboxGuard);
  const [applying, setApplying] = useState(false);
  const [resolving, setResolving] = useState(false);

  // The first message starts the box, so its state must show before the slower changes poll.
  const access = requestsQuery.data;
  const changes = query.data?.sandboxed ? query.data : access?.sandboxed ? NO_CHANGES : null;
  if (threadId === null || changes === null) return null;
  const boxState = access === null ? null : sandboxStateOfPhase(access.phase);

  const onApply = async () => {
    setApplying(true);
    const result = await apply({ environmentId, input: { threadId } });
    setApplying(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return false;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Sandbox changes were not applied",
        description: error instanceof Error ? error.message : undefined,
      });
      return false;
    }
    toastManager.add({
      type: "success",
      title: `Applied ${fileCount(result.value.appliedFiles)} to the project`,
    });
    refresh();
    return true;
  };

  const request = access?.requests[0];
  const fileRequest = request === undefined ? access?.fileRequests[0] : undefined;
  const label = changes.template ?? "Sandbox";

  const resolveFileRequest = async (approved: boolean) => {
    if (fileRequest === undefined) return;
    setResolving(true);
    const result = await updateGuard({
      environmentId,
      input: {
        threadId,
        change: { type: approved ? "allowPath" : "denyPath", path: fileRequest.path },
      },
    });
    setResolving(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "File request was not answered",
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: approved
        ? `Sandbox restarted with read access to ${fileRequest.path}`
        : `Denied read access to ${fileRequest.path}`,
    });
    refreshRequests();
  };

  const resolveRequest = async (approved: boolean) => {
    if (request === undefined) return;
    setResolving(true);
    const result = await updateGuard({
      environmentId,
      input: {
        threadId,
        change: approved
          ? { type: "allow", host: request.host, port: request.port, binary: request.binary }
          : {
              type: "deny",
              host: request.host,
              port: request.port,
              binary: request.binary,
              chunkId: request.chunkId,
            },
      },
    });
    setResolving(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Access request was not answered",
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: approved
        ? `Allowed ${request.host}:${request.port}, active now`
        : `Denied ${request.host}:${request.port}`,
    });
    refreshRequests();
  };

  const summary = [
    changes.files.length === 0 ? null : `${fileCount(changes.files.length)} changed`,
    changes.blockedFileCount === 0 ? null : blockedFiles(changes.blockedFileCount),
  ].filter((part) => part !== null);
  const stateLabel =
    boxState === "starting" ? "starting" : boxState === "stopped" ? "stopped" : null;
  const changedTitle = [[label, stateLabel].filter(Boolean).join(" "), summary.join(", ")]
    .filter(Boolean)
    .join(": ");
  const programName = request?.binary.split("/").at(-1);

  return {
    id: "sandbox-changes",
    variant: request === undefined && fileRequest === undefined ? "info" : "warning",
    icon: sandboxIcon(boxState),
    title:
      request !== undefined
        ? `${programName} wants ${request.host}:${request.port}`
        : fileRequest !== undefined
          ? `${fileRequest.program} wants to read ${fileRequest.path}`
          : changedTitle,
    actions: (
      <>
        {request === undefined ? null : (
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={resolving}
              onClick={() => void resolveRequest(false)}
            >
              Deny
            </Button>
            <Button size="xs" disabled={resolving} onClick={() => void resolveRequest(true)}>
              {resolving ? "Allowing" : "Allow"}
            </Button>
          </>
        )}
        {fileRequest === undefined ? null : (
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={resolving}
              onClick={() => void resolveFileRequest(false)}
            >
              Deny
            </Button>
            <Button
              size="xs"
              disabled={resolving || phase === "running"}
              onClick={() => void resolveFileRequest(true)}
            >
              {resolving ? "Restarting" : "Allow"}
            </Button>
          </>
        )}
        <SandboxGuardButton environmentId={environmentId} threadId={threadId} />
        {changes.files.length === 0 ? null : (
          <SandboxChangesReview
            changes={changes}
            applying={applying}
            canApply={phase !== "running"}
            hasProject={changes.hasProject}
            onApply={onApply}
          />
        )}
      </>
    ),
  };
}
