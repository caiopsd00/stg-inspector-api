// The test container has NO Docker socket, host mounts, credentials or network.
// Git fixtures, the installer and its /etc /usr/local files live only in it.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const name = `brlift-deploy-qa-${crypto.randomUUID().slice(0, 8)}`;
let status = 1;
try {
  let result = spawnSync("docker", ["build", "-t", name, "-f", "deploy/automation/Dockerfile.test", "."], {
    cwd, stdio: "inherit", timeout: 600_000,
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    result = spawnSync("docker", ["run", "--rm", "--name", name, "--network", "none", name], {
      cwd, stdio: "inherit", timeout: 300_000,
    });
    if (result.error) throw result.error;
  }
  status = result.status ?? 1;
} finally {
  spawnSync("docker", ["rm", "-f", name], { cwd, stdio: "ignore" });
  spawnSync("docker", ["image", "rm", name], { cwd, stdio: "ignore" });
}
process.exitCode = status;
