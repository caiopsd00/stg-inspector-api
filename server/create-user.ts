import readline from "node:readline/promises";
import { pool } from "./db.js";
import { createUserAndTechnician } from "./users.js";
function hiddenPassword():Promise<string>{
 if(!process.stdin.isTTY)throw Error('Use um terminal interativo ou ADMIN_PASSWORD fornecida pelo ambiente.');
 process.stdout.write('Senha (mínimo 10 caracteres, entrada oculta): ');
 process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
 return new Promise((resolve,reject)=>{
  let value='';
  const finish=(error?:Error)=>{
   process.stdin.off('data',data);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');
   if(error)reject(error);else resolve(value);
  };
  const data=(chunk:string)=>{for(const char of chunk){if(char==='\u0003'){finish(Error('Cancelado.'));return;}if(char==='\r'||char==='\n'){finish();return;}if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(char>=' ')value+=char;}};
  process.stdin.on('data',data);
 });
}
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const email =
      process.env.USER_EMAIL ||
      process.env.ADMIN_EMAIL ||
      (await rl.question("E-mail: "));
    const normalizedEmail = email
      .trim()
      .toLowerCase();
    const name =
      process.env.USER_NAME ||
      process.env.ADMIN_NAME ||
      (await rl.question("Nome: "));
    const cpf =
      process.env.USER_CPF ||
      process.env.ADMIN_CPF ||
      (await rl.question("CPF: "));
    rl.close();
    const password =
      process.env.ADMIN_PASSWORD ||
      (await hiddenPassword());
    const role = process.env.USER_ROLE || "admin";
    if (
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail) ||
      password.length < 10 ||
      !["admin", "technician"].includes(role)
    )
      throw Error(
        "Informe e-mail, nome, CPF, senha de 10 caracteres e perfil válido.",
      );
    const result = await createUserAndTechnician(
      { email: normalizedEmail, name, cpf, password, role },
      { updateExisting: true },
    );
    console.log(
      `Usuário ${result.user.email} e cadastro técnico vinculados. Sessões anteriores revogadas se existentes.`,
    );
  } finally {
    rl.close();
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
