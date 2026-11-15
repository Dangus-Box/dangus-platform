import { expect, test } from "bun:test";

for (const file of [
  "packages/cli/templates/deploy.yml",
  ".github/workflows/deploy-example.yml",
]) {
  test(`workflow ${file} fixa checkout e credenciais e serializa deploys`, async () => {
    const text = await Bun.file(file).text();
    expect(text).toContain("branches: [main]");
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("inputs.sha");
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
  });
}
