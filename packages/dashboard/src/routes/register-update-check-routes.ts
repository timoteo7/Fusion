import { resolveGlobalDir } from "@fusion/core";
import { clearUpdateCheckCache, performUpdateCheck, performUpdateInstall } from "../update-check.js";
import { getCliPackageVersion } from "../cli-package-version.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerUpdateCheckRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, rethrowAsApiError } = ctx;
  const cliPackageVersion = getCliPackageVersion(import.meta.url);

  router.get("/update-check", async (_req, res) => {
    try {
      const globalSettings = await store.getGlobalSettingsStore().getSettings();
      if (globalSettings.updateCheckEnabled === false) {
        res.json({
          updateAvailable: false,
          disabled: true,
          currentVersion: cliPackageVersion,
          latestVersion: null,
          lastChecked: Date.now(),
        });
        return;
      }

      const result = await performUpdateCheck(resolveGlobalDir(), cliPackageVersion, {
        frequency: globalSettings.updateCheckFrequency,
        channel: globalSettings.updateChannel,
      });
      res.json(result);
    } catch (error) {
      rethrowAsApiError(error, "Failed to perform update check");
    }
  });

  router.post("/update-check/refresh", async (_req, res) => {
    try {
      const globalSettings = await store.getGlobalSettingsStore().getSettings();
      const fusionDir = resolveGlobalDir();
      await clearUpdateCheckCache(fusionDir);
      // Explicit `force: true` so a "manual" frequency setting doesn't short
      // out the network fetch on the user's deliberate "Check now" click.
      const result = await performUpdateCheck(fusionDir, cliPackageVersion, {
        force: true,
        channel: globalSettings.updateChannel,
      });
      res.json(result);
    } catch (error) {
      rethrowAsApiError(error, "Failed to refresh update check");
    }
  });

  router.post("/update-check/install", async (_req, res) => {
    try {
      const globalSettings = await store.getGlobalSettingsStore().getSettings();
      const fusionDir = resolveGlobalDir();
      const updateCheck = await performUpdateCheck(fusionDir, cliPackageVersion, {
        force: true,
        channel: globalSettings.updateChannel,
      });

      /*
      FNXC:UpdateInstall 2026-08-14-19:31:
      Every terminal response has an outcome: the old early return discarded a
      failed re-check and made it look like a successful no-op to both clients.
      */
      if (updateCheck.error?.trim()) {
        const message = `Could not check for updates: ${updateCheck.error}`;
        res.json({ currentVersion: updateCheck.currentVersion, latestVersion: updateCheck.latestVersion, updated: false, outcome: "check-failed", error: updateCheck.error, message });
        return;
      }
      if (!updateCheck.latestVersion) {
        const message = "Could not determine the latest published Fusion version.";
        res.json({ currentVersion: updateCheck.currentVersion, latestVersion: null, updated: false, outcome: "check-failed", error: message, message });
        return;
      }
      if (!updateCheck.updateAvailable) {
        res.json({ currentVersion: updateCheck.currentVersion, latestVersion: updateCheck.latestVersion, updated: false, outcome: "no-update-available", message: `Fusion is already up to date at v${updateCheck.currentVersion}.` });
        return;
      }

      const result = await performUpdateInstall(updateCheck.currentVersion, updateCheck.latestVersion, {
        fusionDir,
        installMethod: { sourceWorkspaceRoot: ctx.options?.systemControl?.sourceWorkspaceRoot },
      });
      res.json(result);
    } catch (error) {
      rethrowAsApiError(error, "Failed to install update");
    }
  });
};
