import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const forbidden = [
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b(?:npm_[a-z0-9]{20,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|Bearer\s+[a-z0-9._~-]{20,})\b/i,
  /\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i,
];

export function checkContent(content: string): boolean {
  return forbidden.some((pattern) => pattern.test(content));
}

export async function checkPackage(directory: string): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "dangus-pack-"));
  try {
    const pack = Bun.spawnSync(
      ["npm", "pack", "--ignore-scripts", "--pack-destination", temporary],
      {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (pack.exitCode !== 0) throw new Error(pack.stderr.toString());
    const archives = await readdir(temporary);
    if (archives.length !== 1 || !archives[0])
      throw new Error("Pacote não gerado");
    const archive = join(temporary, archives[0]);
    const listing = Bun.spawnSync(["tar", "-tzf", archive]);
    if (listing.exitCode !== 0) throw new Error(listing.stderr.toString());
    for (const file of listing.stdout.toString().trim().split("\n")) {
      const content = Bun.spawnSync(["tar", "-xOzf", archive, file]);
      if (content.exitCode !== 0) throw new Error(content.stderr.toString());
      if (checkContent(file) || checkContent(content.stdout.toString())) {
        throw new Error(`Valor proibido no pacote: ${file}`);
      }
      console.log(file);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  for (const name of ["cli", "server", "web", "native"]) {
    console.log(`@dangus-box/${name}`);
    await checkPackage(join(import.meta.dir, "..", "packages", name));
  }
}
