# BR LIFT — API

Backend único Node.js/TypeScript + Express + PostgreSQL 16.
Web: stg-system-web. Mobile: stg-inspector-mobile. STG/Supabase e Nex são separados.

Conferência V0/proposta e correções de 09/10/2026:
matriz de funcionalidades, testes e limites na documentação local, fora deste repositório.
Esta revisão exige as migrations aditivas `002_schedule_periods.sql`,
`003_day_participants.sql`, `004_user_technician_invariant.sql` e
`005_inspection_signers_and_capacity.sql`, sem reset nem
recriação do login. Pare a API, execute `npm run db:migrate`, reinicie a API e
atualize web/mobile juntos (contrato 4). Clientes antigos são impedidos de gravar
para não descartar os períodos adicionais; rascunhos offline legados continuam
compatíveis após atualizar o mobile. Não apague os dados locais.

`service_order_day_periods` guarda cada período do dia em colunas relacionais
(tipo, início, fim e pausa em minutos), com FK para `service_order_days`.
A migration copia os períodos antigos e mantém as colunas históricas. Horímetros
antigos dos dias são preservados no banco, mas não são mais editados no cronograma
nem exibidos no resumo/PDF; o atendimento continua tendo suas leituras de equipamento.

O cronograma aceita observações por dia e a seleção de quem trabalhou entre os
profissionais da equipe. `service_order_day_participants` registra presença,
leituras de KM e referências de mesmo horário/carro; `service_order_participant_periods`
registra os períodos individuais (sem JSON). Horários compartilhados acompanham
a referência; cada pessoa presente soma suas horas, enquanto caronas não duplicam
KM. Desmarcar “Mesmo horário” restaura os horários próprios, ou copia os da referência
se ainda não houver horários próprios. Ausentes não entram nos totais. Finalizar um
dia informado exige ao menos um participante e horários completos dos presentes.
Dias antigos permanecem intactos: ao editar, seus horários são atribuídos apenas
ao primeiro técnico, sem inventar presença para o restante da equipe. Retirar um
profissional da equipe exige revisar quem trabalhou nos dias afetados.

## Desenvolvimento: somente o banco no Docker

Use Node 22.12+ ou 24, npm e Docker. Confira com `node -v`.
Na pasta stg-inspector-api, na primeira configuração:

    cp -n .env.example .env
    npm ci
    docker compose up -d postgres
    npm run db:migrate
    npm run create:admin
    npm run dev

Se a API Docker estiver ligada, pare somente ela com `docker compose stop api`.
Não execute as duas APIs na porta 3333 ao mesmo tempo.

create:admin pede e-mail, nome, CPF e senha oculta (mínimo 10 caracteres).
Não existe senha padrão nem seed de clientes, técnicos ou equipamentos. Toda
conta de login recebe também um cadastro técnico com o mesmo nome e CPF. No web,
administradores criam contas pela aba Cadastros. O comando de
terminal cria ou vincula o técnico na mesma transação do usuário.
Usuários não administradores editam os próprios nome, CPF, e-mail e senha por
`GET/PUT /api/profile`, confirmando a senha atual. O endpoint não aceita mudança
de perfil de acesso; a listagem e edição de outros usuários continuam
exclusivas dos admins.
As rotas de atendimentos, inspeções, documentos e fotos vinculadas respeitam o
cadastro técnico ligado ao login: técnicos veem e alteram apenas registros da
própria equipe (atendimentos) ou vistoria (inspeções); admins mantêm visão total.
Não reutilize uma senha já publicada em conversa.

No dia a dia:

    docker compose up -d postgres
    npm run dev

Enquanto o PostgreSQL estiver ligado, pode encerrar e executar somente
`npm run dev` quantas vezes quiser. O código é recarregado automaticamente.
Migrations só são necessárias quando o schema mudar; não resetam o banco.

- API: http://localhost:3333/health
- PostgreSQL: localhost:5440; banco/usuário brlift.
- DATABASE_URL na .env deve apontar para localhost:5440 fora do Docker.
- Senha brlift_local do exemplo é APENAS de desenvolvimento.
- Web autorizado por padrão: http://localhost:5174.
- CORS_ALLOW_ALL_ORIGINS=false (padrão) limita o acesso a WEB_ORIGIN, que aceita
  origens separadas por vírgula. true aceita qualquer Origin, inclusive com
  credenciais; use com cautela e reinicie a API após alterar essa variável.
- PDF de inspeção precisa de LibreOffice instalado e SOFFICE_PATH configurado.
  PDF de atendimento e DOCX não precisam do LibreOffice.

## Abrir web e Android

Em outro terminal, na pasta stg-system-web:

    npm ci
    npm run dev

Abra http://localhost:5174. Entre com o login criado. Em Novo atendimento ou
Nova inspeção, crie cliente, técnico e equipamento no próprio formulário.
Para testar tudo, preencha, fotografe, assine, finalize e gere o PDF.

Na pasta stg-inspector-mobile:

    npm ci
    cp -n .env.example .env
    npm start

EXPO_PUBLIC_API_URL: http://10.0.2.2:3333/api no emulador Android; no celular,
http://IP-DO-COMPUTADOR:3333/api. Primeiro login requer internet.
Consulte o README mobile para development build/Expo Go SDK 54 e APK.

## Modelo relacional novo

SQL: database/001_relational.sql. Mapa de dados na documentação local.

Clientes, técnicos, equipamentos, peças, atendimentos, equipe, serviços,
peças usadas/solicitadas, cronograma, inspeções, respostas e arquivos têm
tabelas próprias com chaves estrangeiras. Datas, horários, números e booleanos
não ficam em JSON. Ausência, zero e N/A são distintos.

Não existem tabelas genéricas catalog/records. JSONB fica somente na auditoria
e nos recibos idempotentes de sincronização. O JSON enviado pela API é um DTO
montado por consultas relacionais, não um documento persistido.

O primeiro profissional é Técnico; os demais podem ser Técnico ou Auxiliar.
O filtro considera a equipe inteira. Snapshots em colunas preservam nomes,
documentos, equipamento e peças do relatório histórico. KM e horímetros
pertencem ao atendimento, nunca ao cadastro permanente do equipamento.
O cronograma registra KM por dia; horímetros ficam somente em Equipamento.
O checklist oficial está no código e suas 141 respostas são linhas da inspeção.
Na inspeção, capacidade nominal pertence ao cadastro do equipamento; o resultado
é Aprovada ou Rejeitada, e o documento traz assinaturas separadas do técnico e
do cliente. A migration 005 preserva assinaturas antigas e aproveita a última
capacidade registrada em cada equipamento para iniciar seu cadastro.

### Reset local explícito — APAGA os dados

Não é inicialização diária. A mudança aprovada parte de banco vazio, sem
importar dados STG. O migrador se recusa a executar sobre catalog/records antigos.

1. Pare a API local com Ctrl+C; no Docker, use docker compose stop api.
2. Com o banco ligado, execute SOMENTE quando quiser apagar a BR LIFT:

       node scripts/reset-local-db.mjs brlift --confirm-delete
       npm run db:migrate
       npm run create:admin
       npm run dev

O script aceita APENAS brlift/brlift_test do Compose local BR LIFT em 5440.
Faz dump custom, valida com pg_restore e copia arquivos locais e do contêiner
da API existente antes de apagar brlift. Backup: pasta irmã .brlift-backups;
trate-o como privado. Em falha de backup, não apaga o banco.
Não serve para produção. Não use docker compose down -v.

Após reset, recrie o admin e recarregue o web. Atualize os três projetos juntos.
Clientes antigos não podem gravar. No mobile, novo login detecta a troca de
banco e pede “Arquivar e começar”. Formulários e imagens antigos ficam preservados
localmente, mas não são enviados ao banco novo. Não desinstale o app.
A recuperação desse arquivo lógico é técnica/manual; não existe tela de importação.

## Alternativa: banco e API no Docker

    cp -n .env.example .env
    docker compose --profile app up -d --build
    docker compose exec api node dist/server/create-user.js

LibreOffice vem na imagem. Docker aplica migrations e inicia a API.
Após alterar a API nesse modo, reconstrua com --build.
Não reutilize uma imagem antiga com o schema novo.

## Testes

    npm run build
    npm test

npm test executa unitários sem tocar no banco da .env.
Integração exige brlift_test (guardas impedem usar brlift):

    docker compose exec postgres createdb -U brlift brlift_test
    DATABASE_URL=postgresql://brlift:brlift_local@localhost:5440/brlift_test TEST_PDF=1 npm run test:integration

createdb só uma vez. Se brlift_test tiver schema legado, use o reset acima com
brlift_test, não brlift. Configure SOFFICE_PATH. QA vai para tests-output/.

E2E com Chrome instalado e web na pasta irmã:

    DATABASE_URL=postgresql://brlift:brlift_local@localhost:5440/brlift_test E2E_CHROME_CHANNEL=chrome npm run test:e2e

Alternativa: Chromium do Playwright. WEB_REPO altera o diretório web.
QA nunca cria usuários no banco de uso.

## Usuários e operação

USER_ROLE=technician npm run create:user

`USER_CPF` e `USER_NAME` podem ser informados pelo ambiente; sem isso, o comando
pergunta os dados no terminal. Reexecutar create:admin/create:user com o mesmo
e-mail redefine senha/perfil e atualiza o vínculo técnico; revoga sessões.
Faça conscientemente.

Produção: compose.production.yml; instruções de implantação na documentação local.
Não use senha local. Arquitetura, aceite e validação também estão na documentação local.
O código histórico foi arquivado fora deste repositório e não entra no build/deploy.
