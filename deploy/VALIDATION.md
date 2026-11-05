# Validação da API para o piloto local — 05/11/2026

Alvo: VPS Hostinger KVM 1, Ubuntu 24.04, 1 vCPU, 4 GB RAM e 50 GB SSD.
Os ensaios abaixo foram executados localmente; a instalação na VPS ainda precisa
ser feita com o domínio e as credenciais de produção.

## Verificado

- Build TypeScript concluído.
- 47 testes unitários aprovados, sem skips na execução com `RUN_STORAGE_PDF=1`.
- 9 testes/subtestes de integração aprovados com PostgreSQL exclusivo `brlift_test`.
- Conversão real de inspeção para PDF com LibreOffice.
- Controle de concorrência rejeita excesso com 429 e libera a vaga após falhas.
- Escrita local publica arquivos completos, não sobrescreve chaves e limpa
  temporários, inclusive quando dois escritores disputam a mesma chave.
- Inicialização confere gravação e leitura do volume; arquivos novos usam 0600.
- Pool de conexões reduzido e recuperação de erros ociosos do PostgreSQL.

`npm run test:production` também passou usando a imagem real construída do
Dockerfile e o `compose.production.yml`, com um override apenas para abrir a
API em porta local aleatória. Foram conferidos:

- API com teto de 1536 MiB, 1 CPU, processo init e logs com rotação.
- Armazenamento `local/local`, sem bucket ou credenciais externas.
- Criação de administrador e técnico vinculado, login e cadastros.
- Upload de foto JPEG e bloqueio de download sem autenticação.
- Finalização de atendimento e inspeção com foto/assinaturas locais.
- PDFs reais de atendimento (6557 bytes) e inspeção (91179 bytes).
- Recriação de API e PostgreSQL preservando identidade do banco, sessão,
  registros finalizados e bytes da foto.
- Reinício somente do PostgreSQL, com recuperação da API sem recriá-la.

O teste usou volumes e projeto Compose exclusivos, removidos ao terminar.
Não foram alterados bancos de uso ou configuradas rotinas de backup.

## Limite do aceite

Este é um ensaio funcional para o piloto de baixo volume, não um teste de carga.
DNS, certificado HTTPS e acesso externo devem ser conferidos na instalação.
O procedimento está em [PRODUCTION.md](PRODUCTION.md).

## E2E web — aprovado

O E2E completo foi concluído em Chrome headless com PostgreSQL exclusivo de QA
e LibreOffice real. A execução foi repetida após atualizar as dependências do
web e passou novamente. Não foram usadas credenciais ou banco de produção.

- Corrigida a abertura de accordion para direcionar ao descendente pendente e
  focar o preenchimento (incluindo `Profissional 1`).
- Corrigidos nomes acessíveis dos inputs de fotos e do resultado da inspeção.
- Bootstrap cria usuário e técnico vinculado; seletores acompanham o formulário atual.
- Calendários/horários segmentados, Tab/Enter, equipe mista, cadastros por modal,
  equipamento por cliente e leituras próprias do atendimento.
- Peças, motivos/serviços e cronograma com períodos e participação individual.
- Assinaturas em modal, confirmação de finalização com/sem baixar PDF e retorno à gestão.
- Checklist completo, modos lista/guiado, filtro de pendentes e avanço que pula
  respostas existentes; fotos complementares e duas assinaturas da inspeção.
- Downloads reais de ambos os PDFs e conferência de seus cabeçalhos; telas responsivas.

O web também passou em build e 17 testes unitários. Não existe script `lint`
nesse repositório; não foi contabilizado como uma checagem aprovada.
Artefatos E2E ficam em `tests-output/e2e` na API, ignorados pelo Git.

## Segurança da publicação

- API e web: `npm audit` completo sem alertas, incluindo dependências de desenvolvimento.
- Sem credenciais reais reconhecidas em arquivos publicáveis, índice ou histórico
  local de branches/remotes/tags dos três repositórios. Os valores locais/fixtures
  foram distinguidos dos segredos de produção. Não é prova de ausência absoluta.
- `.env`, chaves de serviço/assinatura e dumps excluídos do Git e do contexto Docker.
- Adicionada checagem repetível `npm run security:check -- --history . ../stg-system-web ../stg-inspector-mobile`.
- Proteção de login, limites de JSON, CORS/origens HTTPS e proxy explícito cobertos
  por regressões. Detalhes e procedimento para eventual vazamento em [../SECURITY.md](../SECURITY.md).

## Mobile — verificação complementar

- Instalação limpa `npm ci`, TypeScript, lint e 23 testes aprovados.
- Bundle Android de produção gerado com sucesso; isso não é APK nem homologação
  de câmera/assinatura/offline em aparelho físico.
- Corrigida a visibilidade de registros locais após revogação de acesso na próxima
  sincronização. Edições offline e arquivos são preservados, não apagados.
- Corrigidas dependências com alertas críticos/altos/moderados, mantendo Expo SDK54.
  O parser de imagens seguro exige um patch mínimo compatível com Metro 0.83.3,
  aplicado automaticamente e coberto por teste de carregamento de PNG real.
- **Ressalva:** `npm audit` ainda apresenta 11 alertas baixos na cadeia Expo,
  todos derivados de `deepmerge` usado na configuração. Não há alertas moderados,
  altos ou críticos nessa árvore. O advisory não publica versão corrigida de
  `deepmerge`; não foi feito downgrade inseguro nem migração forçada do SDK para
  esconder o alerta. Não processe configurações/projetos Expo de fontes não
  confiáveis e acompanhe a correção upstream.
  [Advisory GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).

Esta revisão não é um pentest, não inclui auditoria completa dos pacotes de SO
da imagem Docker e não verifica o estado de segurança de uma VPS ainda não
implantada. API e web podem seguir para o piloto conforme o roteiro; a
homologação física Android e o aceite da ressalva acima continuam separados.
