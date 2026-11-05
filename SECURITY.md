# Segurança e publicação — BR LIFT

Revisão local em 05/11/2026 da API, web e mobile. Resultados funcionais em
[deploy/VALIDATION.md](deploy/VALIDATION.md).

## Credenciais no Git

Foram examinados os arquivos versionados, arquivos novos não ignorados, o
índice e os blobs alcançáveis por branches, remotes e tags presentes nos três
clones. Os heads públicos da API e web foram conferidos contra os clones;
o remoto público mobile consultado não tinha branches/tags.

Não foram encontradas credenciais reais reconhecíveis. As senhas/URLs locais
`brlift_local`, valores de fixtures e placeholders dos exemplos não são
credenciais de produção. Não devem ser reaproveitados no servidor. A análise
não prova ausência de todo segredo nem cobre forks, caches do provedor, refs
não disponíveis no clone ou informações compartilhadas fora do Git.

Arquivos `.env*` reais, chaves privadas, certificados privados, credenciais de
serviço e cópias do banco são ignorados. Os contextos Docker da API/web também
excluem esses arquivos. Exemplos `.env.example` e `.env.production.example`
podem ser versionados, sem valores reais. Não foi necessário mover uma chave
real do código para `.env` nesta revisão.

Antes de publicar, na API:

```sh
npm run security:check -- --history . ../stg-system-web ../stg-inspector-mobile
npm audit
```

A checagem examina working tree e índice mesmo sem `--history`; com essa opção,
inclui o histórico local. Ela imprime somente arquivo/linha/tipo, nunca o valor
suspeito. Reconhece formatos comuns de token, chaves privadas, JWTs, URLs com
credenciais e nomes de arquivos sensíveis. É uma barreira adicional, não um
scanner universal de segredos. Não use `git add -f` em arquivos privados.

Se uma credencial real já tiver sido publicada, **revogue/substitua primeiro**.
Só colocar em `.env` ou apagar o arquivo no commit seguinte não remove a cópia
histórica. A limpeza do histórico e de cópias deve ser coordenada depois.
[Orientação do GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

## O que pode ser público

URLs da API, nomes de tabelas, migrations, regras de negócio e estrutura Docker
não são credenciais. Autorizações são impostas no backend, não pelo segredo do
código. `VITE_*` e `EXPO_PUBLIC_*` entram no bundle: até quando vêm de `.env`,
**não podem conter senhas, tokens privilegiados ou chaves privadas**.
[Vite](https://vite.dev/guide/env-and-mode),
[Expo](https://docs.expo.dev/guides/environment-variables/).

## Proteções da instalação

- Somente Caddy publica 80/443 no Compose de produção; banco/API ficam internos.
- CORS aberto e origens HTTP são recusados em produção. `TRUST_PROXY=1` vale
  somente para a topologia com um Caddy confiável e sem porta pública da API.
- Login tem teto por IP e por conta/IP, com memória limitada. É proteção local
  ao processo, não um serviço distribuído; reiniciar a API zera os contadores.
- JSON público de autenticação tem teto de 16 KiB; JSON dos formulários passa
  pela autenticação antes de ser interpretado e mantém teto de 16 MiB. Corpos
  comprimidos são recusados. Erros de JSON não refletem o corpo da requisição.
- Senhas usam scrypt com salt aleatório; comparações usam tempo constante.
  Sessões aleatórias são persistidas como hash; web recebe cookie HttpOnly,
  SameSite=Lax e Secure em produção. HTTPS é obrigatório para o transporte.
- Rotas de registros, arquivos e documentos conferem permissão de técnico/admin.
  O mobile oculta registros sincronizados cujo acesso foi retirado na próxima
  sincronização bem-sucedida. Rascunhos locais não são apagados. Um aparelho
  offline não tem revogação instantânea: dados já copiados não são recuperáveis
  remotamente por esse mecanismo.
- Fotos/assinaturas usam volume privado, sem rota estática pública; arquivos
  locais novos usam modo 0600. Logs e processamento têm limites para a VPS.

## Dependências e operação

Use `npm ci`, preserve os lockfiles e repita auditorias antes de cada release.
API e web tiveram alertas corrigidos nesta revisão; não use `audit fix --force`
para trocar a stack sem verificar compatibilidade. O relatório de validação
registra eventuais alertas residuais do tooling mobile.

Não exponha Vite/Metro, PostgreSQL, Docker socket ou portas de desenvolvimento
na internet. Configure uma senha de banco exclusiva na `.env.production`
(permissões 0600); crie o administrador pelo comando interativo. Não coloque
senha em argumentos de shell nem em logs. Não há backup configurado neste piloto:
um volume persistente não protege contra perda da VPS/disco ou exclusão acidental.
