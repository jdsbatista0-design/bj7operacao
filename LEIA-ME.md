# Central Comercial — Worker com atualização automática

Substitui o HTML estático. O Worker chama o Pipedrive no servidor, guarda o
resultado no KV e serve a página já preenchida. A chave do Pipedrive fica como
secret na Cloudflare e nunca chega ao navegador.

## Publicar (uma vez)

Precisa de Node instalado. No terminal, dentro desta pasta:

```
npm install
npx wrangler login
npx wrangler kv namespace create CENTRAL
```

O último comando devolve um `id`. Cole esse id em `wrangler.jsonc`,
no lugar de `COLE_AQUI_O_ID_DO_KV`.

Depois guarde a chave do Pipedrive como secret — ela não vai para o código:

```
npx wrangler secret put PIPEDRIVE_TOKEN
```

Cole o token quando pedir. Ele está em Pipedrive → foto do perfil →
Preferências pessoais → API.

Publique:

```
npx wrangler deploy
```

## Depois de publicar

- A primeira visita já sincroniza, então pode demorar alguns segundos.
- `/{endereço}/saude` mostra quando foi a última sincronização e quantos
  registros existem. Serve para conferir sem abrir o painel.
- `/{endereço}/atualizar` força uma sincronização na hora. É a rota que o
  botão Atualizar do painel usa.

## Horários

Configurados em `wrangler.jsonc`, em UTC. Hoje: 8 execuções por dia útil, às
9h, 10h, 11h, 12h, 14h, 15h, 17h e 18h de Brasília.

Para mudar, edite a linha `crons` e rode `npx wrangler deploy` de novo.

## Proteger o acesso

O Worker é público por padrão. Antes de compartilhar:

Painel Cloudflare → Zero Trust → Access → Applications → Add an application →
Self-hosted → cole o domínio do Worker → política permitindo apenas os e-mails
do time. Sem isso, qualquer pessoa com o link vê a base de clientes inteira.

## O que o Worker faz a cada sincronização

1. Usuários, funis e etapas
2. Pessoas, para nome e telefone de cada cliente
3. Negócios de todos os status, abertos e fechados
4. Atividades concluídas do ano corrente e do anterior
5. Classifica motivo de perda: descarte operacional fica fora da conversão
6. Declara a cobertura: de quando a quando existe dado, e quantas atividades
   apontam para negócios apagados
