// Weekly Product Hub — Gate Worker (proxy espelhando o GitHub Pages)
//
// O QUE FAZ: espelha o conteúdo do GitHub Pages (lousada-shippify.github.io/shippify-weekly-
// squads-team) sob um domínio *.workers.dev. Não tem credenciais nem lógica própria — só existe
// para que o Cloudflare Access (Zero Trust) tenha um domínio na infraestrutura Cloudflare para
// proteger com login (GitHub Pages puro não aceita Access na frente, só domínios/rotas
// Cloudflare). O acesso em si continua sendo o mesmo site; só passa a exigir login antes.
//
// CONFIGURAÇÃO (depois de colar este código e dar Deploy) — SEM precisar criar nada no Google
// Cloud Console. O login é por código enviado por e-mail (One-Time PIN), restrito a @shippify.co:
//   1) Workers & Pages → este Worker → Settings → Domains & Routes → anote a URL pública
//      (algo como https://weekly-hub-gate.<seu-usuario>.workers.dev) — essa passa a ser a URL
//      oficial pra compartilhar com o time.
//   2) Abra "Zero Trust" no menu lateral do Cloudflare (primeira vez: escolha um nome de
//      equipe, qualquer um, ex.: "shippify-weekly"). Não precisa mexer em Authentication —
//      o método "One-time PIN" já vem habilitado por padrão.
//   3) Zero Trust → Access → Applications → Add an application → Self-hosted:
//        - Application domain: cole a URL do Worker (do passo 1), sem o "https://".
//        - Identity providers: deixe marcado só "One-time PIN".
//   4) Na política (Policy) da aplicação:
//        - Nome: "Só Shippify"
//        - Action: Allow
//        - Include → selecione "Emails ending in" → digite: @shippify.co
//   5) Salve. Pronto — quem abrir a URL do Worker vai digitar o e-mail @shippify.co, receber um
//      código de 6 dígitos por e-mail e usar isso pra entrar (sem senha, sem conta Google).
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
