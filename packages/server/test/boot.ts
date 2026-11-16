import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { migratePostgres, migrateSqlite, observability } from "../src";

const [kind, connection, folder, port] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const observation = observability();
if (kind === "sqlite") {
  const db = new Database(connection, { create: true });
  migrateSqlite(db, folder);
  db.close();
} else {
  await migratePostgres(connection, folder);
}
observation.markReady();
new Elysia().use(observation.plugin).listen(Number(port));
