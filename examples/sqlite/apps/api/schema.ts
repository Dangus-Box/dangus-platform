import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const messages = sqliteTable("mensagens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  texto: text("texto").notNull(),
});
