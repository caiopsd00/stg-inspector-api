import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { after, test } from "node:test";

// Do not run a root installer on the developer's host by mistake.
if (process.env.BRLIFT_DEPLOY_QA !== "1" || process.platform !== "linux" || process.getuid() !== 0)
  throw Error("Use npm run test:deploy: estes testes exigem o container Linux descartavel.");

const root = path.resolve(".");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "brlift-deploy-qa-"));
const bin = path.join(temp, "bin");
await fs.mkdir(bin);
await fs.mkdir("/run/systemd/system", { recursive: true });

const mock = `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const args=process.argv.slice(2), name=path.basename(process.argv[1]), dir=process.env.QA_STATE;
const flag=n=>fs.existsSync(path.join(dir,n));
fs.appendFileSync(path.join(dir,'calls'),JSON.stringify([name,...args])+'\\n');
if(name==='systemctl') {
  const file=path.join(dir,'service.json');
  const read=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):({ActiveState:'inactive',Result:'success',ExecMainStatus:'0',InvocationID:'',Job:'0'});
  if(args[0]==='__manage') {
    const state=read();
    if(flag('worker-not-started')) {
      state.ActiveState='failed';state.Result='exit-code';state.ExecMainStatus='91';
      fs.writeFileSync(file,JSON.stringify(state));process.exit(0);
    }
    if(flag('startup-delay')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600);
    const child=cp.spawn('bash',['/usr/local/lib/brlift-deploy/run.sh'],{env:{...process.env,INVOCATION_ID:state.InvocationID},stdio:'inherit'});
    child.on('exit',(code,signal)=>{
      state.ActiveState=code===0?'inactive':'failed';state.Result=code===0?'success':'exit-code';state.ExecMainStatus=String(code??143);state.Job='0';
      fs.writeFileSync(file,JSON.stringify(state));process.exit(0);
    });
    return;
  }
  if(args.includes('show')) {
    const state=read();if(flag('active')) state.ActiveState='activating';
    if(args.includes('--value')) console.log(state.ActiveState);
    else for(const [key,value] of Object.entries(state)) console.log(key+'='+value);
  }
  if(args.includes('start')) {
    fs.writeFileSync(path.join(dir,'queued'),'');
    if(flag('auto-run')) {
      const id=require('node:crypto').randomBytes(16).toString('hex');
      fs.writeFileSync(file,JSON.stringify({ActiveState:'activating',Result:'success',ExecMainStatus:'0',InvocationID:id,Job:'0'}));
      const fd=fs.openSync(path.join(dir,'journal'),'a');
      const manager=cp.spawn(process.execPath,[process.argv[1],'__manage'],{detached:true,stdio:['ignore',fd,fd],env:process.env});
      manager.unref();fs.closeSync(fd);
    }
  }
  process.exit(0);
}
if(name==='sleep') {
  // Keep production waits, but accelerate HTTP retries in this offline suite.
  if(args[0]==='1') cp.spawnSync('/bin/sleep',['0.1']);
  process.exit(0);
}
if(name==='curl') {
  if(flag('curl-fail')) process.exit(7);
  const url=args[args.indexOf('-o')-1];
  let body;
  if(url.endsWith('/health')) body=JSON.stringify({ok:true,service:'brlift-api',databaseId:flag('bad-health')?'wrong':process.env.QA_DATABASE_ID});
  else if(url.endsWith('/')) body=flag('bad-web')?'{}':'<!doctype html><html><script type="module" src="/assets/index-qa.js"></script><div id="root"></div></html>';
  else { if(flag('asset-fail')) process.exit(22); body='// QA'; }
  fs.writeFileSync(args[args.indexOf('-o')+1],body);
  process.exit(0);
}
if(name==='docker') {
  if(args[0]==='info') process.exit(0);
  const at=args.findIndex(x=>['config','ps','exec','build','stop','up'].includes(x));
  const command=args[at], tail=args.slice(at+1);
  if(command==='config') {
    if(flag('config-fail')) { console.error(process.env.QA_ENV_SECRET); process.exit(1); }
    process.exit(0);
  }
  if(command==='ps') {console.log(tail.includes('-q')?'qa-postgres':'Servicos QA operacionais');process.exit(0);}
  if(command==='exec' && tail.includes('postgres')) {console.log(process.env.QA_DATABASE_ID);process.exit(0);}
  if(command==='exec' && tail.includes('api')) {
    const code=tail[tail.indexOf('-e')+1];
    if(code.includes('process.stdin')) {
      const result=cp.spawnSync(process.execPath,['--input-type=module','-e',code,process.env.QA_DATABASE_ID],{input:fs.readFileSync(0),encoding:'utf8'});
      process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||''); process.exit(result.status??1);
    }
    if(flag('migration-fail')) process.exit(65);
    console.log('Banco original, migracoes e health interno confirmados.');process.exit(0);
  }
  if(command==='build') {
    if(flag('hold-build')) {
      fs.writeFileSync(path.join(dir,'building'),'');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);
    }
    if(flag('warnings')) {
      console.log('#12 1.20 npm warn deprecated sample-package: aviso QA');
      console.log('#12 1.21 npm warn deprecated sample-package: aviso QA');
      console.log('#12 1.22 1 low severity vulnerability');
      console.log('#12 1.23 found 0 vulnerabilities');
    }
    if(flag('build-fail') && tail.includes('web')) { console.error('ERROR: failed to solve: exemplo de erro de build QA'); process.exit(9); }
    console.log('Imagem QA construida');process.exit(0);
  }
  if(command==='up' && tail.includes('api') && flag('up-fail')) process.exit(12);
  if(command==='stop' && !fs.readFileSync('/var/lib/brlift-deploy/last-result','utf8').includes('CUTOVER=1')) process.exit(90);
  process.exit(0);
}
process.exit(99);
`;
for (const command of ["docker", "curl", "systemctl", "sleep"])
  await fs.writeFile(path.join(bin, command), mock, { mode: 0o755 });

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 20_000, ...options });
}
function ok(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}
function git(repo, ...args) { return ok("git", ["-C", repo, ...args]); }

async function waitForIdle(f) {
  for (let i = 0; i < 200; i++) {
    const text = await fs.readFile(path.join(f.state, "service.json"), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    if (!text) return { ActiveState: "inactive", ExecMainStatus: "not-started" };
    const state = JSON.parse(text);
    if (["inactive", "failed"].includes(state.ActiveState)) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error("Executor QA nao encerrou.");
}

let serial = 0;
async function fixture() {
  const base = path.join(temp, `caso ${++serial}`);
  const state = path.join(base, "mock");
  await fs.mkdir(state, { recursive: true });
  const env = {
    ...process.env, PATH: bin + ":" + process.env.PATH, QA_STATE: state,
    QA_DATABASE_ID: crypto.randomUUID(), QA_ENV_SECRET: crypto.randomBytes(20).toString("hex"),
  };
  const repos = {};
  for (const kind of ["api", "web"]) {
    const origin = path.join(base, kind + ".git");
    const repo = path.join(base, kind);
    ok("git", ["init", "--bare", "-b", "main", origin]);
    ok("git", ["clone", origin, repo]);
    git(repo, "config", "user.email", "qa@example.test");
    git(repo, "config", "user.name", "QA");
    await fs.writeFile(path.join(repo, ".gitignore"), ".env*\n");
    await fs.writeFile(path.join(repo, "app.txt"), "anterior\n");
    if (kind === "api") await fs.copyFile(path.join(root, "compose.production.yml"), path.join(repo, "compose.production.yml"));
    git(repo, "add", "."); git(repo, "commit", "-m", "initial"); git(repo, "push", "origin", "main");
    const before = git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "app.txt"), "atualizado\n");
    git(repo, "commit", "-am", "update"); git(repo, "push", "origin", "main");
    const target = git(repo, "rev-parse", "HEAD");
    // Recreate the server checkout by a normal clone at its old commit.
    const server = path.join(base, kind + " servidor");
    ok("git", ["clone", origin, server]);
    git(server, "config", "user.email", "qa@example.test");
    git(server, "config", "user.name", "QA");
    git(server, "reset", "--hard", before); // disposable test fixture ONLY
    repos[kind] = { repo: server, source: repo, before, target, origin };
  }
  const envPath = path.join(repos.api.repo, ".env.production");
  const envText = `DOMAIN=admin.example.test\nPOSTGRES_PASSWORD='${env.QA_ENV_SECRET}'\n`;
  await fs.writeFile(envPath, envText, { mode: 0o600 });
  await fs.rm("/var/lib/brlift-deploy", { recursive: true, force: true });
  await fs.rm("/var/log/brlift-deploy", { recursive: true, force: true });
  const install = () => run("bash", [path.join(root, "deploy/install-deploy.sh"), "--api-repo", repos.api.repo, "--web-repo", repos.web.repo, "--health-url", "https://admin.example.test/health"], { env });
  const installed = install();
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  await fs.writeFile(path.join(state, "calls"), "");
  return {
    ...repos, state, env, envPath, envText, install,
    flag: name => fs.writeFile(path.join(state, name), ""),
    worker: () => run("bash", ["/usr/local/lib/brlift-deploy/run.sh"], { env }),
    cli: (...args) => run("/usr/local/bin/brlift-deploy", args, { env }),
    calls: async () => (await fs.readFile(path.join(state, "calls"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
    result: () => fs.readFile("/var/lib/brlift-deploy/last-result", "utf8"),
    log: () => fs.readFile("/var/log/brlift-deploy/deploy.log", "utf8"),
  };
}
const commandIs = (call, command) => call[0] === "docker" && call.includes(command);
const stopped = calls => calls.some(call => commandIs(call, "stop"));
const reopened = calls => calls.some(call => commandIs(call, "up") && call.at(-1) === "gateway");

test("Bash, ShellCheck e unidade systemd sem erros", async () => {
  const files = ["deploy/install-deploy.sh", "deploy/automation/brlift-deploy", "deploy/automation/run.sh", "deploy/automation/monitor.sh"];
  for (const file of files) ok("bash", ["-n", file]);
  ok("shellcheck", ["-x", "-e", "SC1091", ...files]);
  const f = await fixture();
  await fs.writeFile("/etc/systemd/system/docker.service", "[Service]\nType=oneshot\nExecStart=/bin/true\n");
  ok("systemd-analyze", ["verify", "/etc/systemd/system/brlift-deploy.service"]);
  assert.equal((await fs.stat("/etc/brlift-deploy.conf")).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.envPath)).mode & 0o777, 0o600);
  assert.equal((await f.calls()).some(c => c.includes("start")), false);
});

test("deploy faz fast-forward dos dois repos, builds separados e health com identidade", async () => {
  const f = await fixture();
  const result = f.worker();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(f.api.repo, "rev-parse", "HEAD"), f.api.target);
  assert.equal(git(f.web.repo, "rev-parse", "HEAD"), f.web.target);
  assert.equal(await fs.readFile(f.envPath, "utf8"), f.envText);
  const calls = await f.calls();
  const apiBuild = calls.findIndex(c => commandIs(c, "build") && c.at(-1) === "api");
  const webBuild = calls.findIndex(c => commandIs(c, "build") && c.at(-1) === "web");
  const stop = calls.findIndex(c => commandIs(c, "stop"));
  assert.ok(apiBuild < webBuild && webBuild < stop);
  assert.equal(reopened(calls), true);
  assert.equal(calls.some(c => c.includes("down") || c.includes("prune") || c.includes("--volumes")), false);
  assert.match(await f.result(), /RESULTADO=sucesso/);
  assert.ok((await f.result()).includes(f.api.target));
  assert.ok(!(await f.log()).includes(f.env.QA_ENV_SECRET));
});

for (const kind of ["staged", "unstaged", "untracked"])
  test(`${kind}: impede deploy sem descartar dados locais`, async () => {
    const f = await fixture();
    const file = path.join(f.web.repo, kind === "untracked" ? "novo.txt" : "app.txt");
    await fs.writeFile(file, "edicao local\n");
    if (kind === "staged") git(f.web.repo, "add", "app.txt");
    assert.notEqual(f.worker().status, 0);
    assert.equal(stopped(await f.calls()), false);
    assert.equal(git(f.api.repo, "rev-parse", "HEAD"), f.api.before);
    assert.equal(await fs.readFile(file, "utf8"), "edicao local\n");
  });

test("divergencia no web impede tambem o fast-forward da API", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.web.repo, "app.txt"), "commit do servidor\n");
  git(f.web.repo, "commit", "-am", "server-only");
  assert.notEqual(f.worker().status, 0);
  assert.equal(git(f.api.repo, "rev-parse", "HEAD"), f.api.before);
  assert.equal(stopped(await f.calls()), false);
});

test("falha no fetch nao usa silenciosamente o commit remoto antigo", async () => {
  const f = await fixture();
  git(f.web.repo, "remote", "set-url", "origin", path.join(temp, "inexistente.git"));
  assert.notEqual(f.worker().status, 0);
  assert.equal(git(f.api.repo, "rev-parse", "HEAD"), f.api.before);
  assert.equal(stopped(await f.calls()), false);
});

test("commit tentando versionar .env.production e recusado antes do merge", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.api.source, ".env.production"), "DOMAIN=incorrect.example.test\n");
  git(f.api.source, "add", "-f", ".env.production");
  git(f.api.source, "commit", "-m", "unsafe env"); git(f.api.source, "push", "origin", "main");
  assert.notEqual(f.worker().status, 0);
  assert.equal(await fs.readFile(f.envPath, "utf8"), f.envText);
  assert.equal(git(f.api.repo, "rev-parse", "HEAD"), f.api.before);
});

test("erro de config omite valores sensiveis e nao para a versao atual", async () => {
  const f = await fixture(); await f.flag("config-fail");
  const result = f.worker();
  assert.notEqual(result.status, 0);
  assert.ok(!(result.stdout + result.stderr + await f.log()).includes(f.env.QA_ENV_SECRET));
  assert.equal(stopped(await f.calls()), false);
});

test("falha de build nao para gateway nem troca containers", async () => {
  const f = await fixture(); await f.flag("build-fail");
  assert.notEqual(f.worker().status, 0);
  assert.equal(stopped(await f.calls()), false);
  assert.equal((await f.calls()).some(c => commandIs(c, "up")), false);
  assert.match(await f.result(), /ETAPA=build-web/);
  assert.match(await f.log(), /Nao houve troca de containers/);
});

for (const flag of ["up-fail", "migration-fail"])
  test(`${flag}: nao reabre o gateway nem tenta rollback de banco`, async () => {
    const f = await fixture(); await f.flag(flag);
    assert.notEqual(f.worker().status, 0);
    const calls = await f.calls();
    assert.equal(stopped(calls), true); assert.equal(reopened(calls), false);
    assert.equal(calls.some(c => c.includes("down") || c.includes("prune")), false);
    assert.match(await f.log(), /Nao houve rollback automatico/);
  });

test("HTTPS com JSON de outro banco nao e considerado sucesso", async () => {
  const f = await fixture(); await f.flag("bad-health");
  assert.notEqual(f.worker().status, 0);
  assert.match(await f.result(), /RESULTADO=erro\nETAPA=https/);
  assert.equal((await f.calls()).filter(c => c[0] === "curl").length, 6);
});

for (const flag of ["bad-web", "asset-fail"])
  test(`${flag}: web ou bundle indisponivel nao e considerado deploy bem sucedido`, async () => {
    const f = await fixture(); await f.flag(flag);
    assert.notEqual(f.worker().status, 0);
    assert.match(await f.result(), /RESULTADO=erro\nETAPA=web/);
  });

test("flock impede segunda execucao mesmo chamando o worker diretamente", async () => {
  const f = await fixture(); await f.flag("hold-build");
  const child = spawn("bash", ["/usr/local/lib/brlift-deploy/run.sh"], { env: f.env, stdio: "ignore" });
  const completed = new Promise(resolve => child.on("exit", resolve));
  for (let i = 0; i < 100; i++) {
    if (await fs.stat(path.join(f.state, "building")).catch(() => null)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const second = f.worker();
  assert.notEqual(second.status, 0);
  assert.match(second.stdout + second.stderr, /Outro deploy ja possui a trava/);
  assert.equal(await completed, 0);
  assert.match(await f.result(), /RESULTADO=sucesso/);
});

test("CLI --detach agenda no systemd sem bloquear; status e reinstalacao preservam o app", async () => {
  const f = await fixture();
  assert.equal(f.cli("--detach").status, 0);
  assert.ok((await f.calls()).some(c => c[0] === "systemctl" && c.includes("--no-block") && c.includes("start")));
  await f.flag("active");
  assert.notEqual(f.cli("--detach").status, 0);
  assert.notEqual(f.install().status, 0);
  await fs.rm(path.join(f.state, "active"));
  assert.equal(f.worker().status, 0);
  assert.equal(f.cli("status").status, 0);
  const previousLog = await f.log();
  assert.equal(f.install().status, 0);
  assert.equal(await f.log(), previousLog);
  assert.equal(await fs.readFile(f.envPath, "utf8"), f.envText);
});

test("repetir deploy e seguro; retem somente os cinco logs e o mesmo .env", async () => {
  const f = await fixture();
  for (let i = 0; i < 6; i++) assert.equal(f.worker().status, 0);
  const files = await fs.readdir("/var/log/brlift-deploy");
  assert.deepEqual(files.sort(), ["deploy.log", "deploy.log.1", "deploy.log.2", "deploy.log.3", "deploy.log.4"]);
  assert.equal(await fs.readFile(f.envPath, "utf8"), f.envText);
  assert.equal((await fs.stat("/var/log/brlift-deploy/deploy.log")).mode & 0o777, 0o600);
  assert.equal(git(f.api.repo, "rev-parse", "HEAD"), f.api.target);
  assert.match(await f.result(), /RESULTADO=sucesso/);
  assert.equal((await fs.readdir('/var/lib/brlift-deploy/runs')).length, 5);
});

test("configuracao gravavel por terceiros e recusada antes de ser executada", async () => {
  const f = await fixture();
  await fs.appendFile("/etc/brlift-deploy.conf", `\ntouch ${JSON.stringify(path.join(f.state, "unsafe-config-executed"))}\n`);
  await fs.chmod("/etc/brlift-deploy.conf", 0o666);
  assert.notEqual(f.worker().status, 0);
  assert.equal(await fs.stat(path.join(f.state, "unsafe-config-executed")).catch(() => null), null);
  assert.equal(stopped(await f.calls()), false);
});

test("avisos conhecidos sao deduplicados, zero vulnerabilidades nao e aviso e ANSI e removido", async () => {
  const dir = path.join(temp, "observer");
  await fs.mkdir(dir);
  const input = [
    "#12 1.1 npm warn deprecated pacote: exemplo",
    "#17 2.2 npm WARN deprecated pacote: exemplo",
    "#12 1.3 found 0 vulnerabilities",
    "#12 1.4 1 low severity vulnerability",
    "\x1b[31mWARNING: aviso colorido\x1b[0m",
    "\x1b]2;titulo\x07normal",
  ].join("\n");
  ok("awk", ["-v", `state_dir=${dir}`, "-f", "deploy/automation/observe.awk"], { input });
  const warnings = (await fs.readFile(path.join(dir, "warnings"), "utf8")).trim().split("\n");
  assert.equal(warnings.length, 3);
  assert.ok(!warnings.join().includes("\x1b"));
  assert.ok(!warnings.join().includes("0 vulnerabilities"));
  const sanitized = ok("awk", ["-v", "sanitize_only=1", "-f", "deploy/automation/observe.awk"], { input });
  assert.ok(!sanitized.includes("\x1b") && !sanitized.includes("titulo"));
});

test("comando padrao acompanha, termina sozinho e resume avisos sem ANSI fora de TTY", async () => {
  const f = await fixture(); await f.flag("auto-run"); await f.flag("warnings");
  try {
    const result = f.cli();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /DEPLOY CONCLUIDO/);
    assert.match(result.stdout, /Erros: 0 \| Avisos identificados: 2/);
    assert.match(result.stdout, /\[OK\].*Git: backend e frontend/);
    assert.ok(!result.stdout.includes("\x1b"));
    assert.ok(!result.stdout.includes("#12 1.20"));
    assert.equal((await f.calls()).filter(c => c[0] === "systemctl" && c.includes("start")).length, 1);
  } finally { await waitForIdle(f); }
});

test("resultado antigo nao vira falso sucesso durante startup; erro atual retorna codigo nao zero", async () => {
  const f = await fixture(); assert.equal(f.worker().status, 0);
  await f.flag("auto-run"); await f.flag("startup-delay"); await f.flag("build-fail");
  try {
    const result = f.cli();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /DEPLOY FALHOU/);
    assert.ok(!result.stdout.includes("DEPLOY CONCLUIDO"));
    assert.match(result.stdout, /exemplo de erro de build QA/);
    assert.match(result.stdout, /nao parou o gateway/);
  } finally { await waitForIdle(f); }
});

test("painel TTY recolhe as linhas anteriores e termina com resumo final", async () => {
  const f = await fixture(); await f.flag("auto-run"); await f.flag("hold-build");
  try {
    const result = run("python3", ["tests/deploy-pty.py", "normal"], { env: f.env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\x1b\[[0-9]+A/);
    assert.match(result.stdout, /DEPLOY CONCLUIDO/);
    assert.ok(!result.stdout.includes("\x1b[2J"));
    assert.match(result.stdout, /Erros: 0/);
  } finally { await waitForIdle(f); }
});

test("Ctrl+C no painel sai do acompanhamento e nao mata o deploy em segundo plano", async () => {
  const f = await fixture(); await f.flag("auto-run"); await f.flag("hold-build");
  try {
    const result = run("python3", ["tests/deploy-pty.py", "interrupt"], { env: f.env });
    assert.equal(result.status, 130, result.stdout + result.stderr);
    assert.match(result.stdout, /Acompanhamento encerrado/);
    assert.equal((await waitForIdle(f)).ExecMainStatus, "0");
    assert.match(await f.result(), /RESULTADO=sucesso/);
    assert.equal(f.cli("watch").status, 0);
  } finally { await waitForIdle(f); }
});

test("terminal pequeno usa painel compacto e TERM=dumb nao recebe escapes", async () => {
  const f = await fixture(); await f.flag("auto-run"); await f.flag("hold-build");
  try {
    const result = run("python3", ["tests/deploy-pty.py", "small"], { env: f.env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const moves = [...result.stdout.matchAll(/\x1b\[(\d+)A/g)].map(m => Number(m[1]));
    assert.ok(moves.length && moves.every(n => n <= 10));
    assert.match(result.stdout, /DEPLOY CONCLUIDO/);
    const plain = f.cli("status");
    assert.equal(plain.status, 0);
    assert.ok(!plain.stdout.includes("\x1b"));
    const dumb = run("python3", ["tests/deploy-pty.py", "dumb"], { env: f.env });
    assert.equal(dumb.status, 0, dumb.stdout + dumb.stderr);
    assert.ok(!dumb.stdout.includes("\x1b"));
  } finally { await waitForIdle(f); }
});

test("redimensionar o terminal nao limpa o historico nem redesenha uma area maior que a tela", async () => {
  const f = await fixture(); await f.flag("auto-run"); await f.flag("hold-build");
  try {
    const result = run("python3", ["tests/deploy-pty.py", "resize"], { env: f.env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const afterResize = result.stdout.split('QA_RESIZE')[1];
    assert.ok(afterResize);
    assert.ok([...afterResize.matchAll(/\x1b\[(\d+)A/g)].every(m => Number(m[1]) <= 10));
    assert.match(result.stdout, /DEPLOY CONCLUIDO/);
  } finally { await waitForIdle(f); }
});

test("reabrir o comando durante um deploy apenas acompanha, sem criar outro job", async () => {
  const f = await fixture(); await f.flag("auto-run"); await f.flag("hold-build");
  try {
    assert.equal(f.cli('--detach').status, 0);
    const attached = f.cli();
    assert.equal(attached.status, 0, attached.stdout + attached.stderr);
    assert.match(attached.stdout, /nenhum outro sera iniciado/);
    assert.match(attached.stdout, /DEPLOY CONCLUIDO/);
    assert.equal((await f.calls()).filter(c => c[0] === 'systemctl' && c.includes('start')).length, 1);
  } finally { await waitForIdle(f); }
});

test("falha anterior ao primeiro resultado do worker nao reaproveita sucesso antigo", async () => {
  const f = await fixture(); assert.equal(f.worker().status, 0);
  await f.flag('auto-run'); await f.flag('worker-not-started');
  try {
    const result = f.cli();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /DEPLOY FALHOU/);
    assert.ok(!result.stdout.includes('DEPLOY CONCLUIDO'));
    assert.match(result.stdout, /sem um resultado final desta execucao/);
  } finally { await waitForIdle(f); }
});

after(async () => { await fs.rm(temp, { recursive: true, force: true }); });
