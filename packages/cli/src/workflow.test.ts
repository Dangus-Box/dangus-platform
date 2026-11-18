import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = { env?: Record<string, string>; steps: Step[] };

const root = resolve(import.meta.dir, "../../..");

async function sh(script: string, env: Record<string, string>, cwd: string) {
  const child = Bun.spawn(["bash", "-e", "-c", script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return child.exited;
}

for (const file of [
  "packages/cli/templates/deploy.yml",
  ".github/workflows/deploy-example.yml",
]) {
  const load = async () => {
    const text = await Bun.file(join(root, file)).text();
    const workflow = Bun.YAML.parse(text) as {
      on: {
        workflow_call: {
          inputs: { sha: { required: boolean; type: string } };
          secrets: { BWS_ACCESS_TOKEN: { required: boolean } };
        };
      };
      jobs: { deploy: Job };
    };
    return { text, workflow, job: workflow.jobs.deploy };
  };

  test(`workflow ${file} pins checkout and credentials and serializes deploys`, async () => {
    const { text } = await load();
    expect(text).toContain("branches: [main]");
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("bun install --frozen-lockfile");
    expect(text).toContain("bun run dangus deploy --skip-build");
    expect(text).toContain("cancel-in-progress: false");
    expect(text).toContain("packages: write");
    expect(
      [
        ...new Set(
          [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]),
        ),
      ].sort(),
    ).toEqual(["BWS_ACCESS_TOKEN", "GITHUB_TOKEN"]);
    expect(text).toContain("platform__TAILSCALE_OAUTH_CLIENT_ID");
    expect(text).toContain("platform__TAILSCALE_OAUTH_CLIENT_SECRET");
    expect(
      [...text.matchAll(/uses:\s*([^\s]+)/g)].every((match) =>
        /@[0-9a-f]{40}$/.test(match[1]),
      ),
    ).toBe(true);
    expect(text).not.toContain("set -x");
  });

  test(`workflow ${file} exposes secrets only to steps that use them`, async () => {
    const { job } = await load();
    expect(JSON.stringify(job.env ?? {})).not.toContain("secrets.");
    const holders = (secret: string) =>
      job.steps
        .filter((step) => JSON.stringify(step.env ?? {}).includes(secret))
        .map((step) => step.name);
    expect(holders("secrets.BWS_ACCESS_TOKEN")).toEqual([
      "Prepare credentials",
      "Deploy",
    ]);
    expect(holders("secrets.GITHUB_TOKEN")).toEqual([
      "Authenticate with GHCR",
      "Deploy",
    ]);
  });

  test(`workflow ${file} accepts only a full SHA reachable from main`, async () => {
    const { job } = await load();
    const steps = job.steps.filter((step) => step.if === "inputs.sha != ''");
    const checkout = job.steps.findIndex((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const install = job.steps.findIndex((step) =>
      step.run?.includes("bun install"),
    );
    expect(steps.length).toBe(2);
    expect(job.steps.indexOf(steps[0])).toBeLessThan(checkout);
    expect(job.steps.indexOf(steps[1])).toBeGreaterThan(checkout);
    expect(job.steps.indexOf(steps[1])).toBeLessThan(install);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression
    for (const step of steps) expect(step.env?.SHA).toBe("${{ inputs.sha }}");

    const repo = await mkdtemp(join(tmpdir(), "dangus-workflow-"));
    try {
      const git = (script: string) =>
        sh(
          `git -c init.defaultBranch=main init -q && git config user.email t@t && git config user.name t && ${script}`,
          {},
          repo,
        );
      await git(
        "git commit -q --allow-empty -m a && git update-ref refs/remotes/origin/main HEAD && git checkout -q -b fork && git commit -q --allow-empty -m b",
      );
      const sha = async (ref: string) =>
        (await Bun.$`git -C ${repo} rev-parse ${ref}`.text()).trim();
      const run = async (value: string) => {
        for (const step of steps)
          if ((await sh(step.run ?? "", { SHA: value }, repo)) !== 0)
            return false;
        return true;
      };
      expect(await run(await sha("origin/main"))).toBe(true);
      expect(await run(await sha("fork"))).toBe(false);
      for (const value of [
        "",
        "main",
        (await sha("origin/main")).slice(0, 7),
        (await sha("origin/main")).toUpperCase(),
        `${await sha("origin/main")}\n`,
        "$(touch pwned)",
        `${await sha("origin/main")}; touch pwned`,
      ])
        expect(await run(value)).toBe(false);
      expect(await Bun.file(join(repo, "pwned")).exists()).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test(`workflow ${file} supports a reusable deploy with optional rollback`, async () => {
    const { workflow, job } = await load();
    expect(workflow.on.workflow_call.inputs.sha).toMatchObject({
      required: false,
      type: "string",
    });
    expect(workflow.on.workflow_call.secrets.BWS_ACCESS_TOKEN.required).toBe(
      true,
    );
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with).toMatchObject({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression
      ref: "${{ inputs.sha || github.sha }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression
      "fetch-depth": "${{ inputs.sha == '' && 2 || 0 }}",
    });
    const deploy = job.steps.find((step) => step.name === "Deploy");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression
    expect(deploy?.env?.SHA).toBe("${{ inputs.sha }}");
    const repo = await mkdtemp(join(tmpdir(), "dangus-deploy-"));
    try {
      await Bun.write(
        join(repo, "bun"),
        '#!/bin/bash\nprintf "%s\\n" "$*" > args\n',
      );
      await Bun.$`chmod +x ${join(repo, "bun")}`;
      for (const sha of ["", "a".repeat(40)]) {
        expect(
          await sh(
            deploy?.run ?? "",
            { SHA: sha, PATH: `${repo}:${process.env.PATH}` },
            repo,
          ),
        ).toBe(0);
        expect((await Bun.file(join(repo, "args")).text()).trim()).toBe(
          sha ? "run dangus deploy --skip-build" : "run dangus deploy",
        );
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test(`workflow ${file} checks the Product against the previous commit before deploy`, async () => {
    const { job } = await load();
    const doctor = job.steps.findIndex((step) =>
      step.run?.includes("dangus doctor"),
    );
    const tailscale = job.steps.findIndex((step) => step.id === "tailscale");
    const deploy = job.steps.findIndex((step) => step.name === "Deploy");
    expect(doctor).toBeGreaterThan(tailscale);
    expect(doctor).toBeLessThan(deploy);
    expect(job.steps[doctor].if).toBe("inputs.sha == ''");
    if (file.endsWith("deploy-example.yml")) {
      // The example uses the workspace CLI: tolerate only the lockfile pin failure.
      const repo = await mkdtemp(join(tmpdir(), "dangus-doctor-gate-"));
      try {
        await Bun.write(
          join(repo, "bun"),
          '#!/bin/bash\n[[ "$*" == "run dangus doctor --base HEAD^" ]] || exit 2\nprintf "%b" "$DOCTOR_OUTPUT"\n[[ "$DOCTOR_OUTPUT" != *"[fail]"* ]] || exit 1\n',
        );
        await Bun.$`chmod +x ${join(repo, "bun")}`;
        const gate = (output: string) =>
          sh(
            job.steps[doctor].run ?? "",
            { DOCTOR_OUTPUT: output, PATH: `${repo}:${process.env.PATH}` },
            repo,
          );
        const pin = "[fail] CLI: pin a published version.\n";
        expect(await gate(`[pass] ok\n${pin}[pass] ok\n`)).toBe(0);
        expect(await gate("[pass] ok\n[warn] w\n")).toBe(0);
        expect(await gate(`${pin}[fail] Migrations: bad\n`)).not.toBe(0);
        expect(await gate("[fail] Tailscale: down\n")).not.toBe(0);
        expect(await gate("")).not.toBe(0);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    } else {
      expect(job.steps[doctor].run).toBe("bun run dangus doctor --base HEAD^");
    }
    const repo = await mkdtemp(join(tmpdir(), "dangus-doctor-base-"));
    try {
      expect(
        await sh(
          "git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m previous && git commit -q --allow-empty -m current",
          {},
          repo,
        ),
      ).toBe(0);
      const checkout = join(repo, "checkout");
      await Bun.$`git clone -q --depth 2 --no-local ${repo} ${checkout}`;
      expect(
        (
          await Bun.$`git -C ${checkout} log -1 --format=%s HEAD^`.text()
        ).trim(),
      ).toBe("previous");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test(`workflow ${file} removes the ephemeral tailnet node at the end`, async () => {
    const { job } = await load();
    const tailscale = job.steps.findIndex((step) =>
      step.uses?.startsWith("tailscale/github-action@"),
    );
    const id = job.steps[tailscale].id;
    const logout = job.steps.at(-1);
    expect(id).toBeString();
    expect(logout?.if).toBe(`always() && steps.${id}.conclusion == 'success'`);
    expect(logout?.run).toBe("sudo tailscale logout");
  });
}
