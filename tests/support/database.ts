import { Pool } from "pg";
export function testPool() {
  const url = process.env.DNE_TEST_DATABASE_URL;
  if (!url || !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(url).pathname))
    throw new Error("Tests require a dedicated, generated dne_test database.");
  return new Pool({ connectionString: url });
}
