/**
 * Test setup — runs before all tests.
 *
 * Sets a fallback DATABASE_URL so modules that check it at import time
 * don't throw. Real DB tests (review-concurrency) override this with
 * TEST_DATABASE_URL.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
