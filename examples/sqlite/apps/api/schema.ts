import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const mensagens = sqliteTable("mensagens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  texto: text("texto").notNull(),
});
