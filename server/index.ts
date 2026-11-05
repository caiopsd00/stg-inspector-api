import { createApp } from "./app.js";
import { pool } from "./db.js";
import { assertStorageReady } from "./object-storage/index.js";

async function start() {
  await assertStorageReady();
  const server = createApp().listen(
    Number(process.env.PORT || 3333),
    "0.0.0.0",
    () => console.log("BR LIFT API pronta."),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () =>
      server.close(() => pool.end().then(() => process.exit())),
    );
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  pool.end().catch(console.error);
});
