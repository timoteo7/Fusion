/*
FNXC:Settings-FallbackModels 2026-09-04-00:00:
GDPR-001 acceptance test for the three new `type: "text"` lane settings
(`planningFallbackModels`, `executionFallbackModels`, `validatorFallbackModels`).
Validates that the declarations are present on `BUILTIN_WORKFLOW_SETTINGS`,
that a `text` payload (string) is accepted, and that the array-of-objects
shape — which `validateValue`'s never-exhaustiveness default would reject — is
rejected with `type-mismatch` to lock the encoding decision.
*/
import { describe, it, expect } from "vitest";

import {
  BUILTIN_WORKFLOW_SETTINGS,
} from "../workflows/builtin-workflow-settings.js";
import { validateSettingValuePatch } from "../workflows/workflow-settings.js";

describe("BUILTIN_WORKFLOW_SETTINGS — GDPR-001 fallback model lists", () => {
  const newIds = [
    "executionFallbackModels",
    "planningFallbackModels",
    "validatorFallbackModels",
  ] as const;

  it("declares all three new text-typed fallback-model list settings", () => {
    const byId = new Map(BUILTIN_WORKFLOW_SETTINGS.map((d) => [d.id, d]));
    for (const id of newIds) {
      const def = byId.get(id);
      expect(def, `expected declaration for ${id}`).toBeDefined();
      expect(def?.type, `${id} must be type "text"`).toBe("text");
    }
  });

  it("accepts a serialized `provider:modelId[:thinkingLevel]` payload (text shape)", () => {
    const result = validateSettingValuePatch(BUILTIN_WORKFLOW_SETTINGS, {
      executionFallbackModels: "openrouter:anthropic/claude-3.5-sonnet\nclinefree:z-ai/glm-5.3-flash:high",
      planningFallbackModels: "openrouter:minimax/minimax-m3:free",
      validatorFallbackModels: "",
    });
    expect(result.accepted).toEqual({
      executionFallbackModels: "openrouter:anthropic/claude-3.5-sonnet\nclinefree:z-ai/glm-5.3-flash:high",
      planningFallbackModels: "openrouter:minimax/minimax-m3:free",
      validatorFallbackModels: "",
    });
    expect(result.rejections).toEqual([]);
  });

  it("accepts an empty string as the legacy-disable sentinel", () => {
    const result = validateSettingValuePatch(BUILTIN_WORKFLOW_SETTINGS, {
      executionFallbackModels: "",
      planningFallbackModels: "",
      validatorFallbackModels: "",
    });
    expect(result.accepted).toEqual({
      executionFallbackModels: "",
      planningFallbackModels: "",
      validatorFallbackModels: "",
    });
    expect(result.rejections).toEqual([]);
  });

  it("rejects an array payload as type-mismatch (locks the text encoding decision)", () => {
    const result = validateSettingValuePatch(BUILTIN_WORKFLOW_SETTINGS, {
      executionFallbackModels: [
        { provider: "openrouter", modelId: "anthropic/claude-3.5-sonnet" },
      ],
    });
    const rejection = result.rejections.find((r) => r.settingId === "executionFallbackModels");
    expect(rejection?.code).toBe("type-mismatch");
    expect(result.accepted.executionFallbackModels).toBeUndefined();
  });

  it("rejects a non-string non-array payload as type-mismatch", () => {
    const result = validateSettingValuePatch(BUILTIN_WORKFLOW_SETTINGS, {
      planningFallbackModels: { provider: "openrouter", modelId: "minimax/minimax-m3:free" },
    });
    const rejection = result.rejections.find((r) => r.settingId === "planningFallbackModels");
    expect(rejection?.code).toBe("type-mismatch");
  });

  it("preserves an unknown-setting rejection for unrelated keys", () => {
    const result = validateSettingValuePatch(BUILTIN_WORKFLOW_SETTINGS, {
      notARealSetting: "value",
      executionFallbackModels: "openrouter:anthropic/claude-3.5-sonnet",
    });
    const unknownRejection = result.rejections.find((r) => r.settingId === "notARealSetting");
    expect(unknownRejection?.code).toBe("unknown-setting");
    expect(result.accepted.executionFallbackModels).toBe("openrouter:anthropic/claude-3.5-sonnet");
  });

  it("treats null/undefined as the delete sentinel (always accepted)", () => {
    const result = validateSettingValuePatch(BUILTIN_WORKFLOW_SETTINGS, {
      executionFallbackModels: null,
      planningFallbackModels: undefined,
    });
    expect(result.accepted.executionFallbackModels).toBeNull();
    expect(result.accepted.planningFallbackModels).toBeNull();
    expect(result.rejections).toEqual([]);
  });
});
