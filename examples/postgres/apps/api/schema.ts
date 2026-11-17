import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const messages = pgTable("mensagens", {
  id: serial("id").primaryKey(),
  texto: text("texto").notNull(),
});
