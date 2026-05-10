import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

let postgres: StartedPostgreSqlContainer | undefined;

export default async function setup(): Promise<() => Promise<void>> {
  if (!process.env.DATABASE_URL) {
    postgres = await new PostgreSqlContainer("postgres:17-alpine")
      .withDatabase("recondo_test")
      .withUsername("recondo")
      .withPassword("recondo_dev")
      .start();
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.RECONDO_TESTCONTAINERS_POSTGRES = "1";
  }

  return async () => {
    await postgres?.stop();
    postgres = undefined;
  };
}
