// Weekly Product Hub — Gate Worker (proxy espelhando o GitHub Pages)
//
// O QUE FAZ: espelha o conteúdo do GitHub Pages (lousada-shippify.github.io/shippify-weekly-
// squads-team) sob um domínio *.workers.dev. Não tem credenciais nem lógica própria — só existe
// para que o Cloudflare Access (Zero Trust) tenha um domínio na infraestrutura Cloudflare para
// proteger com login (GitHub Pages puro não aceita Access na frente, só domínios/rotas
// Cloudflare). O acesso em si continua sendo o mesmo site; só passa a exigir login antes.
//
// CONFIGURAÇÃO (depois de colar este código e dar Deploy):
//   1) Workers & Pages → este Worker → Settings → Domains & Routes → anote a URL pública
//      (algo como https://weekly-hub-gate.<seu-usuario>.workers.dev) — essa passa a ser a URL
//      oficial pra compartilhar com o time (não mais o link direto do GitHub Pages).
//   2) No Cloudflare, abra o "Zero Trust" (menu lateral esquerdo do dashboard principal).
//      Se for a primeira vez, escolha um nome de equipe (qualquer um, ex.: "shippify-weekly").
//   3) Zero Trust → Settings → Authentication → Add new → Google:
//        - Siga o passo a passo do próprio Cloudflare pra criar um OAuth Client ID no Google
//          Cloud Console (console.cloud.google.com → APIs & Services → Credentials → Create
//          Credentials → OAuth client ID → Web application). A "Authorized redirect URI" que o
//          Google pede é a que o Cloudflare mostra na tela (algo como
//          https://<seu-time>.cloudflareaccess.com/cdn-cgi/access/callback).
//        - Cole o Client ID e o Client Secret gerados no Google de volta no Cloudflare.
//   4) Zero Trust → Access → Applications → Add an application → Self-hosted:
//        - Application domain: cole a URL do Worker (do passo 1), sem o "https://".
//        - Identity providers: marque só "Google" (desmarque o login por PIN, se aparecer).
//   5) Na política (Policy) da aplicação:
//        - Nome: "Só Shippify"
//        - Action: Allow
//        - Include → selecione "Emails ending in" → digite: @shippify.co
//   6) Salve. Pronto — quem tentar abrir a URL do Worker vai ver a tela de login do Google, e só
//      quem logar com e-mail @shippify.co consegue entrar.
//
// Me envie a URL final do Worker (passo 1) que eu confirmo se está tudo funcionando.

const ORIGIN = 'https://lousada-shippify.github.io/shippify-weekly-squads-team';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = ORIGIN + url.pathname + url.search;
    const resp = await fetch(target, { cf: { cacheTtl: 0 } });
    const headers = new Headers(resp.headers);
    headers.delete('content-security-policy');
    headers.delete('x-frame-options');
    headers.set('Cache-Control', 'no-store');
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  },
};
