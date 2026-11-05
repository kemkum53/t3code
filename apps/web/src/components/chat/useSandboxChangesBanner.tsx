import { useState } from "react";
import type { EnvironmentId, OpenShellSandboxChanges, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { BoxIcon } from "lucide-react";

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
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const fileCount = (count: number) => (count === 1 ? "1 file" : `${count} files`);

const lineStats = (file: OpenShellSandboxChanges["files"][number]) =>
  file.additions === null ? "binary" : `+${file.additions} -${file.deletions}`;

function SandboxChangesReview(props: {
  readonly changes: OpenShellSandboxChanges;
  readonly applying: boolean;
  readonly canApply: boolean;
  readonly onApply: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Review
      </Button>
      <Dialog open={open} onOpenChange={setOpen} disablePointerDismissal>
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Changes in {props.changes.sandbox}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <ul className="mb-3 space-y-1 text-sm">
              {props.changes.files.map((file) => (
                <li key={file.path} className="flex justify-between gap-4">
                  <span className="min-w-0 truncate font-mono">{file.path}</span>
                  <span className="shrink-0 text-muted-foreground">{lineStats(file)}</span>
                </li>
              ))}
            </ul>
            <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
              {props.changes.diff}
            </pre>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
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
  const apply = useAtomCommand(orchestrationEnvironment.applySandboxChanges);
  const [applying, setApplying] = useState(false);

  const changes = query.data;
  if (threadId === null || changes === null || changes.files.length === 0) return null;

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

  return {
    id: "sandbox-changes",
    variant: "info",
    icon: <BoxIcon />,
    title: `${fileCount(changes.files.length)} changed in the sandbox`,
    actions: (
      <SandboxChangesReview
        changes={changes}
        applying={applying}
        canApply={phase !== "running"}
        onApply={onApply}
      />
    ),
  };
}
