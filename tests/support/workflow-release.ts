// #769: a fixture copy of the reviewed workflow release that a browser test
// can change the way an editor's source release would.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const workflowFiles = {
  "WF-001": "WF-001-requirements.md",
  "WF-002": "WF-002-test-review.md",
  "WF-003": "WF-003-meeting-actions.md",
} as const;
export type WorkflowId = keyof typeof workflowFiles;

export async function workflowRelease() {
  const folder = await mkdtemp(join(tmpdir(), "dne-workflow-release-"));
  const path = (id: WorkflowId) => join(folder, workflowFiles[id]);
  for (const id of Object.keys(workflowFiles) as WorkflowId[]) {
    const text = await readFile(
      new URL(
        `../../assets/docs/content/reviewed-v2/workflows/${workflowFiles[id]}`,
        import.meta.url,
      ),
      "utf8",
    );
    // Start every template within its review date, whatever today is.
    await writeFile(
      path(id),
      text.replace(
        /^next_review:.*$/m,
        "next_review: 2999-01-01 or earlier when sources change",
      ),
    );
  }
  return {
    folder,
    // Set one metadata field, adding it after the version when absent.
    async set(id: WorkflowId, key: string, value: string) {
      const text = await readFile(path(id), "utf8");
      const line = new RegExp(`^${key}:.*$`, "m");
      await writeFile(
        path(id),
        line.test(text)
          ? text.replace(line, `${key}: ${value}`)
          : text.replace(/^version: 2$/m, `version: 2\n${key}: ${value}`),
      );
    },
    async title(id: WorkflowId) {
      return /^title: (.*)$/m.exec(await readFile(path(id), "utf8"))![1]!;
    },
    close: () => rm(folder, { recursive: true }),
  };
}
