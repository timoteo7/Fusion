import {randomUUID} from "node:crypto";
import {mkdir, rename, unlink, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";

/*
FNXC:TaskDetailPlan 2026-08-28-15:31:
A truncating PROMPT.md write lets getTask, the narrow prompt route, and step parsing observe an empty or prefix-truncated plan. Publish through a same-directory unique temporary file so the Definition summary never disappears because a reader raced plan publication.
*/
export async function writePromptFileAtomic(promptPath: string, content: string): Promise<void> {
  // FNXC:PromptFileNeverEmpty 2026-09-24-04:52:
  // Root cause (operator board): a failed spec regeneration wrote an EMPTY PROMPT.md (0B), which then failed the
  // deterministic validation ('Specification failed deterministic validation') -> needs-replan -> the sweep
  // re-seeded planning -> a loop (FUSI-011, GDPR-074/075). A truncating/empty write must NEVER replace a real plan:
  // refuse an empty write and keep the previous PROMPT.md (the FNXC:TaskDetailPlan atomic write is preserved).
  if (!content || !content.trim()) {
    return;
  }
  const parentDir = dirname(promptPath);
  const tmpPath = join(parentDir, `PROMPT.md.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(parentDir, {recursive: true});
  await writeFile(tmpPath, content);
  try {
    await rename(tmpPath, promptPath);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      // The temporary file may already be absent; preserve the rename failure.
    }
    throw error;
  }
}
