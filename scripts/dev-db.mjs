// Local development Postgres — a real Postgres 18 server (same major version
// as Railway) running from node_modules, with data in Backend/.devdb.
// Production never uses this: on Railway the backend connects to the
// project's private Postgres service through DATABASE_URL.
//
//   npm run db:dev     → starts it on localhost:5433 (Ctrl+C to stop)
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "..", ".devdb");
const PORT = 5433;

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "doclocker",
  password: "doclocker-dev",
  port: PORT,
  persistent: true,
  onLog: () => {},
});

const firstRun = !existsSync(path.join(dataDir, "PG_VERSION"));
if (firstRun) await pg.initialise();
await pg.start();
if (firstRun) await pg.createDatabase("doclocker");

console.log(`Dev Postgres ready: postgresql://doclocker:doclocker-dev@localhost:${PORT}/doclocker`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
