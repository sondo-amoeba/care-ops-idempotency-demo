export function buildPostgresConnectionString(): string {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (url) return url;
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = process.env.POSTGRES_PORT ?? "5432";
  const user = process.env.POSTGRES_USER ?? "careops";
  const password = process.env.POSTGRES_PASSWORD ?? "careops";
  const database = process.env.POSTGRES_DB ?? "careops_demo";
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}
