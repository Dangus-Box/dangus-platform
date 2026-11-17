import { expect, test } from "bun:test";
import { latestKey, parseRestoreArgs } from "./restore";

test("selects the latest daily Product Backup", () => {
  const xml =
    "<ListBucketResult><Contents><Key>daily/a/produto/20261101-x.sql.gz.age</Key></Contents><Contents><Key>daily/a/produto/20261102-x.sql.gz.age</Key></Contents><Contents><Key>daily/b/produto/20261103-x.sql.gz.age</Key></Contents></ListBucketResult>";
  expect(latestKey(xml, "daily/a/produto/")).toBe(
    "daily/a/produto/20261102-x.sql.gz.age",
  );
});

test("validates options and prevents an explicit target during Restore Verification", () => {
  expect(
    parseRestoreArgs([
      "--from",
      "daily/a/produto/a",
      "--target",
      "data.sqlite",
      "--yes",
    ]),
  ).toEqual({ from: "daily/a/produto/a", target: "data.sqlite", yes: true });
  expect(() => parseRestoreArgs(["--target", "data", "--verify"])).toThrow();
  expect(() => parseRestoreArgs(["--from"])).toThrow();
  expect(() => parseRestoreArgs(["--yes", "--yes"])).toThrow();
});

test("weekly workflow runs Restore Verification with the BWS token", async () => {
  const workflow = await Bun.file(
    new URL("../templates/restore.yml", import.meta.url),
  ).text();
  expect(workflow).toContain("0 6 * * 0");
  expect(workflow).toContain("bun run dangus db restore --verify");
  expect(workflow).toContain("secrets.BWS_ACCESS_TOKEN");
});
