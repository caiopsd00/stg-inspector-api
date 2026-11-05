# Armazenamento de mídia: disco local e GCS

A API mantém PostgreSQL, autenticação, URLs `/api/media/<uuid>` e regras de acesso.
Somente os bytes das fotos e assinaturas mudam de backend. A tabela `files`
continua guardando chaves relativas `media/<uuid>`, nunca caminhos físicos ou URLs
do provedor. PDFs são gerados sob demanda; não existe arquivo PDF persistido no
servidor nesta versão. DOCX de conversão e PDF temporário continuam em `/tmp`.

## Configuração

| Fase | `STORAGE_WRITE_BACKEND` | `STORAGE_READ_BACKENDS` |
| --- | --- | --- |
| Atual | `local` | `local` |
| Transição | `gcs` | `gcs,local` |
| Concluída | `gcs` | `gcs` |

Qualquer outra combinação interrompe a inicialização. No modo GCS, defina
`GCS_BUCKET`. A API confere na inicialização que o bucket tem **Public Access
Prevention enforced** e **Uniform Bucket-Level Access** ativo; precisa da
permissão `storage.buckets.get`. Use uma conta de serviço com apenas os acessos
necessários a objetos desse bucket. As credenciais usam Application Default
Credentials; no Docker, o arquivo de credenciais fica fora do repositório e é
montado somente para leitura por `compose.gcs.yml`. No Linux, conceda leitura
ao UID do processo `node` no container (1000) sem tornar o arquivo público.
Nunca o coloque no Git.
O bucket não recebe ACL pública nem URLs assinadas. Toda leitura do cliente
continua passando pela API autenticada.

Para a instalação local, mantenha `STORAGE_DIR=/app/storage` no container e o
volume `media` do Compose. Configure `local/local` e suba normalmente com
`docker compose -f compose.production.yml --env-file .env.production up -d --build`.
O arquivo `.env.production` deve ficar fora do Git.

## Ativação e migração

1. Faça backup verificado do PostgreSQL e do volume `media`. Crie o bucket
   privado com Public Access Prevention e Uniform Bucket-Level Access. Configure
   credenciais fora do Git e `GCS_BUCKET`, `GCS_CREDENTIALS_PATH` (caminho
   absoluto no host) em `.env.production`. Mantenha `local/local` nesta fase.
2. Execute o ensaio sem gravar:

   ```sh
   docker compose -f compose.production.yml -f compose.gcs.yml --env-file .env.production run --rm api node dist/server/migrate-media-to-gcs.js --dry-run
   ```

   O comando exige a imagem atualizada. Ele emite um JSON por arquivo e um
   resumo final (`copied`, `skipped`, `would-copy`, `missing`, `error`). Resolva
   `missing` e `error` antes de avançar.
   Para testar **o bucket real** antes da troca, execute:

   ```sh
   docker compose -f compose.production.yml -f compose.gcs.yml --env-file .env.production run --rm api node dist/server/smoke-gcs.js
   ```

   O smoke cria uma foto temporária no bucket, lê essa foto durante a geração
   real do PDF de inspeção e remove o objeto no final. Não usa o banco.
3. Execute a cópia real, repetindo-a quantas vezes for necessário:

   ```sh
   docker compose -f compose.production.yml -f compose.gcs.yml --env-file .env.production run --rm api node dist/server/migrate-media-to-gcs.js
   ```

   Cada objeto já válido é ignorado. Antes de copiar, o comando compara
   tamanho e SHA-256 da origem com o banco; depois verifica o objeto remoto.
   Se o objeto remoto existir com conteúdo divergente, reporta erro e **não o
   sobrescreve**. Interromper o processo não apaga os arquivos locais.
4. Configure `gcs/gcs,local` e reinicie a API usando **os dois** arquivos
   Compose. Faça upload de uma foto nova; confirme no GCS, no endpoint
   autenticado e em um PDF. Confirme também a leitura de uma foto antiga que
   exista apenas no disco local. O fallback ocorre só para objeto ausente no
   GCS; erro de permissão ou indisponibilidade não é mascarado.
5. Rode novamente a migração real durante a transição. Para encerrá-la, pause
   gravações por uma janela curta, rode a migração até `missing=0`, `error=0`,
   `would-copy=0` e todos os objetos `skipped`, confira amostras de PDFs com
   fotos antigas e novas, e só então mude para `gcs/gcs`. Mantenha o volume
   local e seu backup durante a janela de rollback acordada; **não há remoção
   automática do local**.

O relatório considera registros da tabela `files`, inclusive anexos de
rascunhos ainda não ligados a documentos. Ele não descobre arquivos órfãos
existentes no volume sem linha correspondente no banco; faça inventário
separado antes de descartar o volume.

## Rollback

- De `gcs/gcs` para `gcs/gcs,local`: basta alterar a configuração; os arquivos
  locais antigos voltam a servir como fallback, sem mudar onde novas fotos são
  gravadas.
- Para voltar a `local/local` **após** gravar arquivos no GCS: pause gravações,
  execute o comando abaixo até não haver `missing` ou `error`, teste leitura
  e PDF com fotos novas, e só então altere as variáveis e reinicie:

  ```sh
  docker compose -f compose.production.yml -f compose.gcs.yml --env-file .env.production run --rm api node dist/server/migrate-media-to-gcs.js --reverse --dry-run
  docker compose -f compose.production.yml -f compose.gcs.yml --env-file .env.production run --rm api node dist/server/migrate-media-to-gcs.js --reverse
  ```

  O sentido reverso também preserva chaves e não sobrescreve destino divergente.
  Não basta trocar as variáveis: fotos criadas durante a fase GCS ficariam
  inacessíveis. Se o GCS estiver indisponível antes da cópia reversa, não
  existe rollback sem perda de acesso às fotos GCS-only.

Monitore erros de upload/leitura, espaço do volume local e custos/operações do
GCS. A camada não substitui backup nem política de retenção. Antes de desligar
o volume local, guarde backup restaurável e confirme o inventário final.
