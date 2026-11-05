import { createFileRoute } from "@tanstack/react-router";

import { OpenShellSettingsPanel } from "../components/settings/OpenShellSettingsPanel";

export const Route = createFileRoute("/_chat/settings/openshell")({
  component: OpenShellSettingsPanel,
});
