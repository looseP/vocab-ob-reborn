import { getDb } from "../src/db/client";
import { words } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  const db = getDb();
  const row = await db.select({ id: words.id, slug: words.slug, lemma: words.lemma })
    .from(words)
    .where(eq(words.slug, "aboard"))
    .limit(1);
  console.log("findBySlug('aboard'):", JSON.stringify(row[0]));

  const all = await db.select({ id: words.id }).from(words);
  console.log("Total words:", all.length);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
