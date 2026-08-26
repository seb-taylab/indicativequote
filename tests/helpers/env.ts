import { config } from 'dotenv';

/**
 * Load .env.local, then .env.
 *
 * `import 'dotenv/config'` reads .env ONLY, which silently leaves DATABASE_URL
 * undefined when the secrets live in .env.local -- the file .gitignore protects
 * and .env.example tells you to create. The suite then fails to collect with
 * "DATABASE_URL is not set" while the value is sitting right there.
 *
 * dotenv does not override an already-set variable, so .env.local wins and real
 * environment variables (CI) win over both.
 */
config({ path: '.env.local' });
config();
