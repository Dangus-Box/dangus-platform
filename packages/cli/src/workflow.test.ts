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
    const workflow = Bun.YAML.parse(text) as { jobs: { deploy: Job } };
    return { text, job: workflow.jobs.deploy };
  };

  test(`workflow ${file} fixa checkout e credenciais e serializa deploys`, async () => {
    const { text } = await load();
    expect(text).toContain("branches: [main]");
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("bun install --frozen-lockfile");
    expect(text).toContain("bun run dangus deploy --skip-build");
    expect(text).toContain("cancel-in-progress: false");
    expect(text).toContain("packages: write");
    expect(
      [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]).sort(),
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

  test(`workflow ${file} expõe secrets só nos passos que os usam`, async () => {
    const { job } = await load();
    expect(JSON.stringify(job.env ?? {})).not.toContain("secrets.");
    const holders = (secret: string) =>
      job.steps
        .filter((step) => JSON.stringify(step.env ?? {}).includes(secret))
        .map((step) => step.name);
    expect(holders("secrets.BWS_ACCESS_TOKEN")).toEqual([
      "Preparar credenciais",
      "Deploy",
    ]);
    expect(holders("secrets.GITHUB_TOKEN")).toEqual([
      "Autenticar no GHCR",
      "Deploy",
    ]);
  });

  test(`workflow ${file} só aceita SHA completo alcançável pela main`, async () => {
    const { job } = await load();
    const steps = job.steps.filter(
      (step) => step.if === "github.event_name == 'workflow_dispatch'",
    );
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

  test(`workflow ${file} remove o nó efêmero da tailnet ao final`, async () => {
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
