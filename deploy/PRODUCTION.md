# Piloto BR LIFT na VPS

Ambiente contratado: Hostinger KVM 1, Ubuntu 24.04 com Docker, 1 vCPU,
4 GB RAM e 50 GB SSD. Este roteiro usa somente essa VPS.

Resultados executados e limites do aceite: [VALIDATION.md](VALIDATION.md).

## Estrutura

Uma API Node/Express mantém as regras de negócio, autenticação e permissões.
PostgreSQL guarda as entidades relacionais e os metadados dos arquivos.
O adaptador `LocalStorage` guarda fotos/assinaturas no volume Docker `media`;
clientes recebem URLs da API, nunca caminhos físicos nem acesso público ao volume.
O contrato `ObjectStorage` separa o armazenamento da aplicação sem exigir nuvem.

Web e `/api` ficam no mesmo domínio por meio do Caddy. Somente 80/443 são
publicadas pelo Compose. PostgreSQL e API comunicam-se pela rede Docker.
O mobile usa `https://DOMINIO/api`.

O banco usa o volume `database`. Documentos são gerados sob demanda;
arquivos temporários de conversão usam diretório exclusivo e são removidos
ao terminar, inclusive em falhas. Não existe fila, Redis, worker separado,
armazenamento externo nem rotina de backup neste piloto.

## Recursos

| Serviço                                     | Teto de memória |
| ------------------------------------------- | --------------: |
| API, processamento de imagens e LibreOffice |        1536 MiB |
| PostgreSQL                                  |         768 MiB |
| Web                                         |         128 MiB |
| Caddy                                       |         128 MiB |

O total de tetos é 2,5 GiB, deixando margem para Ubuntu, Docker e agentes do
provedor. Não é pré-alocação nem garantia de capacidade para qualquer volume.
O build inicial também consome recursos; execute-o sem outros builds simultâneos.

A API permite um documento e um upload em processamento por vez. Excesso
recebe HTTP 429 com orientação para tentar novamente. A conversão PDF tem
timeout de 120 segundos. O Node limita seu old-space a 512 MiB; o limite do
container também contempla o restante do heap, memória nativa e LibreOffice. Sharp usa uma thread
por imagem e cache de 16 MiB. O pool PostgreSQL tem até cinco conexões.
Cada serviço retém no máximo três arquivos de log de 10 MiB.

## Instalação

1. Publique a versão revisada de API e web no Git e clone ambos como irmãos:

   ```text
   /opt/brlift/stg-inspector-api
   /opt/brlift/stg-system-web
   ```

2. Aponte um domínio/subdomínio para o IP da VPS. Garanta que 80 e 443 estão
   disponíveis para o Caddy. Mantenha o acesso SSH que já foi configurado.

3. Na pasta da API, crie a configuração exclusiva do servidor:

   ```sh
   cp .env.production.example .env.production
   chmod 600 .env.production
   nano .env.production
   ```

   Preencha `DOMAIN` com o hostname, sem `https://` ou caminho, e
   `POSTGRES_PASSWORD` com uma senha forte exclusiva. Mantenha:

   ```dotenv
   WEB_REPO=../stg-system-web
   CORS_ALLOW_ALL_ORIGINS=false
   STORAGE_WRITE_BACKEND=local
   STORAGE_READ_BACKENDS=local
   ```

   Não configure `GCS_BUCKET` ou credenciais de armazenamento externo.
   Não envie `.env.production` ao Git nem copie a `.env` de desenvolvimento.
   A produção recusa CORS aberto e origens não HTTPS. `TRUST_PROXY=1` é definido
   pelo Compose porque há exatamente um Caddy confiável antes da API; não exponha
   a porta 3333 nesse modo. Revisão de publicação: [../SECURITY.md](../SECURITY.md).

4. Valide a configuração e inicie os serviços:

   ```sh
   docker compose --env-file .env.production -f compose.production.yml config --quiet
   docker compose --parallel 1 --env-file .env.production -f compose.production.yml up -d --build
   docker compose --env-file .env.production -f compose.production.yml ps
   ```

   O banco inicia vazio e a API aplica migrations antes de aceitar conexões.
   O volume de mídia é verificado com gravação/leitura antes de abrir a porta.
   Se o volume não permitir escrita, a API falha na inicialização em vez de
   anunciar que está pronta. Caddy configura HTTPS quando DNS/portas estão corretos.

5. Crie o primeiro administrador interativamente:

   ```sh
   docker compose --env-file .env.production -f compose.production.yml exec api node dist/server/create-user.js
   ```

   Informe nome, CPF, e-mail e senha. O técnico vinculado é criado junto.
   Não há seed demonstrativo. Reexecutar para um e-mail existente redefine
   senha/perfil; não é um comando de inicialização diária.

## Conferência inicial

Antes de publicar, é possível ensaiar a API com os limites reais do Compose:

```sh
npm run test:production
```

Esse teste exige Docker local. Cria um projeto `brlift-smoke-*` exclusivo,
sem usar `.env.production`, publica a API somente em uma porta local aleatória
e testa login, cadastros, upload privado, finalização e os dois PDFs reais.
Recria os containers para conferir persistência e remove somente seus próprios
volumes ao terminar. Não inicia Caddy/web nem testa o HTTPS público.

- Abra `https://DOMINIO/health`: deve retornar `ok: true` e contrato 4.
- Entre no web e crie cliente, equipamento e um atendimento/inspeção de teste.
- Anexe fotos e assinaturas, finalize e baixe os documentos dos dois módulos.
- Confira que um técnico não consulta os registros de outro.
- Reinicie a API e confira que login, registros e arquivos continuam disponíveis.

```sh
docker compose --env-file .env.production -f compose.production.yml logs --tail=100 api
docker compose --env-file .env.production -f compose.production.yml restart api
docker stats --no-stream
df -h
```

Volumes preservam dados ao reiniciar/recriar containers; não são backups.
Não use `down -v` nem o script de reset local nessa instalação.

## Atualizações

Após revisar/testar e enviar a nova versão ao Git, atualize os dois repositórios
na VPS e execute o mesmo `up -d --build`. Migrations são aplicadas sem reset.
O Compose usa `init` e permite até 130 segundos para encerrar a API,
para não interromper imediatamente uma conversão de documento em andamento.
Não é necessário instalar Node, npm ou PostgreSQL diretamente no host.

O APK é gerado separadamente com `EXPO_PUBLIC_API_URL=https://DOMINIO/api`.
Publicar web/API não atualiza automaticamente um APK já instalado.
