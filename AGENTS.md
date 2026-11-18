# Database changes

- New migrations are for schema changes only: tables, columns, indexes,
  constraints and database functions required by the application.
- Never create, merge, backfill, delete or correct business records in a migration.
- Do not add procedural preflight blocks just to enforce this development policy.
  Keep the schema's normal integrity constraints.
- When existing data needs correction, explain the SQL and execution order to the
  user separately. Only the operator runs those corrections, unless explicitly
  authorized otherwise; startup and deploy must not run them automatically.
- Do not rewrite migrations already applied in production.
