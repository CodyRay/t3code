import type { EnvironmentId } from "@t3tools/contracts";

import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function KeepAwakeSetting({
  environmentId,
  checked,
}: {
  environmentId: EnvironmentId;
  checked: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  return (
    <SettingsRow
      {...searchableSetting("keep-awake-for-remote-access")}
      description="Prevent sleep when computer is plugged in. The display can still turn off."
      control={
        <Switch
          checked={checked}
          onCheckedChange={(value) => updateSettings({ keepAwakeForRemoteAccess: value })}
          aria-label="Keep awake"
        />
      }
    />
  );
}
