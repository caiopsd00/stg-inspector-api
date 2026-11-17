# Atualização com `brlift-deploy`

Ferramenta para **atualizar uma instalação existente** na VPS Ubuntu com Docker.
Não é bootstrap de banco/usuários e não precisa de Node/npm instalados no host.
Só altera os repositórios de API/web e os containers desse projeto Compose.
Não cria backup, timer, webhook, armazenamento externo nem deploy no boot/push.

## Instalar uma vez

Primeiro envie este código ao GitHub, a partir do computador de desenvolvimento.
Depois, na VPS, como root (ou usando sudo no instalador):

```sh
cd /opt/brlift/stg-inspector-api
git status --short
```

O status deve estar vazio. Se houver alterações, revise-as; não use reset/clean.

```sh
git pull --ff-only origin main
bash deploy/install-deploy.sh --health-url https://admin.brlift.com.br/health
```

O instalador **não faz deploy nem reinicia a aplicação**. Conserva o conteúdo do
`.env.production` existente e restringe suas permissões a 0600. Instala:

- `/usr/local/bin/brlift-deploy`: comando administrativo.
- `/usr/local/lib/brlift-deploy/run.sh`: executor independente do checkout Git.
- `/etc/systemd/system/brlift-deploy.service`: serviço manual do tipo oneshot.
- `/etc/brlift-deploy.conf`: caminhos, branch e URL de verificação; nenhuma senha.
- `/var/lib/brlift-deploy/`: trava e registro da última execução.
- `/var/log/brlift-deploy/`: log atual e quatro anteriores, acessíveis só por root.

API padrão: pasta do repositório que contém o instalador. Web padrão:
`../stg-system-web`. Para uma instalação diferente, informe `--api-repo CAMINHO`
e `--web-repo CAMINHO`. A branch padrão é `main`; aceita `--branch NOME`.
O projeto Compose continua sendo `brlift-production`, preservando seus volumes.
O caminho web configurado no instalador é o usado pelo build (exporta `WEB_REPO`).

Pré-requisitos do host: Linux com systemd ativo, Bash, Git, Docker com Compose
v2+ e suporte a `up --wait --wait-timeout`, curl, flock, timeout e coreutils.
No Ubuntu contratado esses utilitários normalmente já estão disponíveis. Se
o instalador acusar um utilitário ausente, instale o pacote correspondente;
não execute o instalador no Mac nem dentro de um container comum.

## Usar no dia a dia

1. Desenvolva, teste, faça commit e push nos repositórios alterados.
2. Na VPS, execute de qualquer pasta:

   ```sh
   brlift-deploy
   ```

3. Consulte o resultado ou acompanhe ao vivo:

   ```sh
   brlift-deploy status
   brlift-deploy logs
   ```

O primeiro comando apenas **agenda** a execução; não confirma sucesso. Pode
desconectar o SSH. `logs` acompanha as últimas 120 linhas; Ctrl+C fecha apenas
a visualização, não o deploy. O log persiste em disco e também vai ao journal.
Como o serviço é oneshot, terminar em `inactive/dead` é normal. Sucesso exige
`RESULTADO=sucesso`, `Result=success` e `ExecMainStatus=0`. Durante a execução,
o status mostra `activating` e a etapa atual; não inicie outro deploy.

Não precisa dar pull, executar migrations, instalar dependências ou recriar
usuários manualmente: o processo faz fetch + fast-forward dos dois repositórios,
constrói as imagens Docker e inicia a API com o migrador já existente.
Mantenha o `.env.production` no servidor; ele não é baixado do Git, executado
como shell nem impresso no log.

### Acesso ao Git sem interação

O serviço roda como root e não herda o agente SSH da sua sessão. Os clones HTTPS
de repositórios públicos funcionam sem credenciais. Para repositórios privados,
configure antes o acesso de leitura do usuário root (por exemplo, deploy key).
A autenticação não pode solicitar senha, passphrase nem confirmação de host.
O processo usa `BatchMode=yes`, mantém a verificação normal de known_hosts e
interrompe em erro; não desativa a segurança do SSH e não embute tokens.

## Etapas e proteções

1. Trava exclusiva via flock, além da exclusividade do serviço systemd.
2. Confere branch, checkout limpo (inclui staged/unstaged/arquivos novos), espaço
   livre mínimo de 2 GiB, configuração e identidade do PostgreSQL existente.
3. Atualiza as referências dos dois repositórios e valida os dois históricos
   antes de avançar qualquer checkout. Não faz merge de branches, force-pull,
   reset ou clean. Recusa commits que tentem versionar `.env.production`.
4. Registra os hashes anteriores e os hashes exatos escolhidos para a release.
   Um push durante o build só será considerado no próximo deploy.
5. Constrói API e web em **comandos separados**, sem builds simultâneos. Até
   essa etapa, a versão atual continua atendendo. Não limpa imagens/volumes.
6. Só depois das duas imagens prontas, para o gateway e atualiza os containers.
   Há uma breve indisponibilidade: combine uma janela sem preenchimentos.
7. Antes de reabrir, confirma banco original, migrations aplicadas e health
   interno da API. Recria o gateway para carregar inclusive mudanças no Caddyfile,
   mantendo os volumes TLS. Valida HTTPS sem ignorar o certificado, JSON/identidade
   do health público, HTML do web e download do bundle JavaScript principal.

O processo tem teto de 45 minutos. O build não é executado dentro dos limites
de CPU/memória dos containers da aplicação; evite outros builds na VPS pequena.
Os testes completos de aplicação/E2E continuam sendo executados **antes do push**,
em desenvolvimento/CI. A verificação do deploy não cadastra dados fictícios na
produção nem substitui o aceite manual dos formulários/PDFs.

## Se falhar

```sh
brlift-deploy status
brlift-deploy logs
journalctl -u brlift-deploy.service -n 100 --no-pager
```

- Antes da publicação: o script não para o gateway nem troca containers.
  Os checkouts/imagens locais podem já estar atualizados; os commits ficam no log.
- Depois de iniciada a publicação: o gateway pode continuar parado ou a nova
  versão estar parcialmente ativa. Não reabre se o banco/migrations falharem.
  Corrija a causa e rode `brlift-deploy` novamente; não há loop de retentativa.
- Erro na verificação pública: não é declarado sucesso, mesmo com API saudável
  internamente. Confira DNS, certificado, gateway e log.
- Não há rollback automático de banco: voltar apenas um commit pode não ser
  compatível com uma migration já aplicada. Não use reset de banco nem `down -v`.
- Nenhum backup foi criado; volumes persistentes não são cópias de segurança.

## Atualizar a própria ferramenta

O executor instalado é uma cópia estável fora do Git: não muda enquanto está
rodando. Quando este instalador/executor/unit forem alterados no repositório,
aguarde o deploy terminar e repita o comando de instalação com a mesma URL.
Isso atualiza a ferramenta, sem reiniciar aplicação ou apagar logs/configurações
da aplicação. Não precisa reinstalar a cada mudança normal do web/backend.

## Testes da ferramenta (no computador de desenvolvimento)

```sh
npm run test:deploy
```

Constrói um Linux descartável com Bash, ShellCheck, Git e systemd-analyze.
Testa o instalador real e repositórios Git reais em fixtures. Valida a unidade
systemd estaticamente; Docker/curl/systemctl são dublês de teste para simular
sucesso, concorrência e falhas. **Não** monta o socket Docker, volumes, chaves
ou pastas do host no container de testes, que roda sem rede. Não executa um
systemd como PID 1 nem um deploy/ensaio contra a VPS real. O funcionamento da
aplicação/Compose é coberto separadamente por `npm run test:production`.

Referências: [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html),
[docker compose up](https://docs.docker.com/reference/cli/docker/compose/up/).
