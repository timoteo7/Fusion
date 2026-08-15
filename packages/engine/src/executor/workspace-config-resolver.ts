import { loadWorkspaceConfig, type WorkspaceConfig } from "@fusion/core";

/**
 * FNXC:Workspace 2026-08-14-21:06:
 * Workspace detection has one host-owned writer: a per-lane copy silently routes a multi-repo
 * project through its non-git root. Memoization is per host so concurrent projects and tests
 * cannot share configuration, and a config with no usable repositories is single-repo mode.
 */
const inFlightWorkspaceConfigLoads = new WeakMap<object, Promise<WorkspaceConfig | null>>();

export type WorkspaceConfigResolverDeps = {
  rootDir: string;
  workspaceConfigOwner: object;
  getWorkspaceConfig: () => WorkspaceConfig | null | undefined;
  setWorkspaceConfig: (config: WorkspaceConfig | null) => void;
};

export async function resolveWorkspaceConfigOnce(
  deps: WorkspaceConfigResolverDeps,
): Promise<WorkspaceConfig | null> {
  const current = deps.getWorkspaceConfig();
  if (current !== undefined) return current;

  const existing = inFlightWorkspaceConfigLoads.get(deps.workspaceConfigOwner);
  if (existing) return existing;

  const promise = loadWorkspaceConfig(deps.rootDir).then((config) => {
    const normalized = config && config.repos.length > 0 ? config : null;
    deps.setWorkspaceConfig(normalized);
    return normalized;
  });
  inFlightWorkspaceConfigLoads.set(deps.workspaceConfigOwner, promise);
  try {
    return await promise;
  } finally {
    if (inFlightWorkspaceConfigLoads.get(deps.workspaceConfigOwner) === promise) {
      inFlightWorkspaceConfigLoads.delete(deps.workspaceConfigOwner);
    }
  }
}
