import pg from "pg";
import { E2E_DATABASE_URL, E2E_OWNER_EMAIL, E2E_OWNER_ID } from "./constants";

export default async function globalSetup(): Promise<void> {
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO users (id, email)
       VALUES ($1::uuid, $2)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
      [E2E_OWNER_ID, E2E_OWNER_EMAIL],
    );
    await client.query(
      `INSERT INTO profiles (id, email, display_name, role)
       VALUES ($1::uuid, $2, 'Playwright Owner', 'admin')
       ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email,
           display_name = EXCLUDED.display_name,
           role = EXCLUDED.role,
           updated_at = now()`,
      [E2E_OWNER_ID, E2E_OWNER_EMAIL],
    );
    await client.query("DELETE FROM auth_sessions WHERE user_id = $1::uuid", [E2E_OWNER_ID]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
