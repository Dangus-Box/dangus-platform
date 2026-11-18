import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Step = {
  name?: string;
  id?: string;
  run?: string;
  env?: Record<string, string>;
};
const root = resolve(import.meta.dir, "..");
const workflow = Bun.YAML.parse(
  await Bun.file(join(root, ".github/workflows/release.yml")).text(),
) as {
  on: Record<string, unknown>;
  jobs: { release: { if: string; steps: Step[] } };
};
const steps = workflow.jobs.release.steps;
const versioning = steps.find((step) => step.id === "versioning") as Step;
const publish = steps.find((step) =>
  step.name?.endsWith("and publish"),
) as Step;

async function sandbox(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "dangus-release-"));
  try {
    await mkdir(join(cwd, ".changeset"));
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function sh(
  script: string,
  cwd: string,
  env: Record<string, string> = {},
) {
  const child = Bun.spawn(["bash", "-e", "-c", script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await child.exited,
    stderr: await new Response(child.stderr).text(),
  };
}

async function check(cwd: string) {
  const output = join(cwd, "output");
  await Bun.write(output, "");
  const result = await sh(versioning.run ?? "", cwd, { GITHUB_OUTPUT: output });
  return { ...result, output: await Bun.file(output).text() };
}

test("release stays manual on main and passes the checked dist-tag to publish", () => {
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.jobs.release.if).toBe("github.ref == 'refs/heads/main'");
  expect(steps.indexOf(versioning)).toBeLessThan(steps.indexOf(publish));
  expect(publish.env?.NPM_DIST_TAG).toBe(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression
    "${{ steps.versioning.outputs.dist-tag }}",
  );
});

test("stable release permits versioned packages and rejects pending changesets", async () => {
  await sandbox(async (cwd) => {
    await Bun.write(join(cwd, ".changeset/README.md"), "Readme");
    expect(await check(cwd)).toMatchObject({
      code: 0,
      output: "dist-tag=latest\n",
    });
    await Bun.write(join(cwd, ".changeset/pending.md"), "Pending");
    const result = await check(cwd);
    expect(result.code).not.toBe(0);
    expect(result.output).toBe("");
    expect(result.stderr).toContain("Run changeset version");
  });
});

test("pre release accepts retained changesets already consumed by version", async () => {
  await sandbox(async (cwd) => {
    await Bun.write(join(cwd, ".changeset/consumed.md"), "Consumed");
    await Bun.write(
      join(cwd, ".changeset/pre.json"),
      JSON.stringify({
        mode: "pre",
        tag: "rc",
        changesets: ["consumed"],
      }),
    );
    expect(await check(cwd)).toMatchObject({
      code: 0,
      output: "dist-tag=next\n",
    });
    await Bun.write(join(cwd, ".changeset/pending.md"), "Pending");
    expect((await check(cwd)).code).not.toBe(0);
  });
});

test("invalid or exiting pre state cannot fall through to latest", async () => {
  await sandbox(async (cwd) => {
    for (const state of ['{"mode":"exit"}', "invalid json"]) {
      await Bun.write(join(cwd, ".changeset/pre.json"), state);
      const result = await check(cwd);
      expect(result.code).not.toBe(0);
      expect(result.output).toBe("");
    }
  });
});

test("publish exits pre only in the job checkout and always passes next explicitly", async () => {
  await sandbox(async (cwd) => {
    await Bun.write(
      join(cwd, "bws"),
      `#!/bin/bash
case "$1 $2" in
  'project list') echo '[{"name":"ops","id":"project"}]';;
  'secret list') echo '[{"key":"platform__NPM_TOKEN","id":"secret"}]';;
  'secret get') echo '{"value":"test-value"}';;
  *) exit 1;;
esac
`,
    );
    await Bun.write(
      join(cwd, "bunx"),
      `#!/bin/bash
[[ -z "\${BWS_ACCESS_TOKEN+x}" && "$NODE_AUTH_TOKEN" == test-value ]] || exit 2
printf '%s\\n' "$*" >> calls
`,
    );
    await Bun.$`chmod +x ${join(cwd, "bws")} ${join(cwd, "bunx")}`;
    for (const tag of ["next", "latest", "unexpected"]) {
      await Bun.write(join(cwd, "calls"), "");
      const result = await sh(publish.run ?? "", cwd, {
        PATH: `${cwd}:${process.env.PATH}`,
        BWS_ACCESS_TOKEN: "fake",
        NPM_DIST_TAG: tag,
      });
      const calls = await Bun.file(join(cwd, "calls")).text();
      if (tag === "next") {
        expect(result.code).toBe(0);
        expect(calls).toBe(
          "changeset pre exit\nchangeset publish --tag next\n",
        );
      } else if (tag === "latest") {
        expect(result.code).toBe(0);
        expect(calls).toBe("changeset publish\n");
      } else {
        expect(result.code).not.toBe(0);
        expect(calls).toBe("");
      }
    }
  });
});

test("the installed Changesets CLI exits pre without changing package versions", async () => {
  await sandbox(async (cwd) => {
    await Bun.write(
      join(cwd, ".changeset/config.json"),
      JSON.stringify({
        baseBranch: "main",
        linked: [],
        fixed: [],
        access: "public",
      }),
    );
    const manifest = { name: "release-fixture", version: "2.0.0-rc.0" };
    await Bun.write(join(cwd, "package.json"), JSON.stringify(manifest));
    await Bun.write(
      join(cwd, ".changeset/pre.json"),
      JSON.stringify({
        mode: "pre",
        tag: "rc",
        initialVersions: { "release-fixture": "1.0.0" },
        changesets: [],
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        join(root, "node_modules/@changesets/cli/bin.js"),
        "pre",
        "exit",
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const code = await child.exited;
    if (code !== 0) throw new Error(await new Response(child.stderr).text());
    expect((await Bun.file(join(cwd, ".changeset/pre.json")).json()).mode).toBe(
      "exit",
    );
    expect(await Bun.file(join(cwd, "package.json")).json()).toEqual(manifest);
  });
});
