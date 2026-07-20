// Weekly Product Hub — Cloudflare Worker (proxy Jira em tempo real)
//
// O QUE FAZ: recebe um GET do site (lousada-shippify.github.io) e, na hora, consulta o Jira
// com o token guardado aqui como "secret" (nunca exposto ao navegador de quem acessa o site) e
// devolve o mesmo formato de data.json que o build.mjs gera. Assim o botão "Atualizar dados"
// fica realmente em tempo real — sem depender do cron do GitHub Actions (que não é confiável
// abaixo de ~1h) e sem pedir token a quem visita o site.
//
// CONFIGURAÇÃO NO DASHBOARD DO CLOUDFLARE (uma única vez):
//   Settings → Variables and Secrets → adicionar como "Secret" (não "Variable" comum):
//     JIRA_EMAIL      = e-mail da conta usada para gerar o token do Jira
//     JIRA_API_TOKEN  = o mesmo token que já está no secret JIRA_API_TOKEN do GitHub
//   (JIRA_SITE fica fixo no código abaixo — não precisa cadastrar.)
//
// Depois de configurar os 2 secrets acima e fazer o Deploy, copie a URL pública
// (algo como https://weekly-hub-proxy.<seu-usuario>.workers.dev) e me envie — eu conecto
// essa URL no site e publico a versão final com atualização 100% em tempo real.

const JIRA_SITE = 'shippify.atlassian.net';
const ALLOWED_ORIGIN = 'https://lousada-shippify.github.io';

// Campos de pontos (validados em 17/07/2026 contra OE Sprint 5):
//   customfield_10028 "Story Points"   = TOTAL da issue (já é a somatória DEV + QA)
//   customfield_10546 "Story point QA" = parcela de QA
const FIELDS = ['status', 'customfield_10028', 'customfield_10546', 'customfield_10020', 'resolutiondate', 'summary', 'parent', 'assignee'];
// Nenhuma squad pontua subtarefas — os pontos já vêm somados (DEV+QA) no campo Story Points
// das histórias/tarefas/bugs. Regra igual para AE, OE e EE (confirmado com o time em 20/07/2026).
const PROJECTS = ['AE', 'OE', 'EE'];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

async function jiraPost(auth, path, body) {
  const r = await fetch(`https://${JIRA_SITE}${path}`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${path} :: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Endpoint novo (/search/jql, paginação por nextPageToken) com fallback para o legado (/search, startAt)
// — mesma lógica do build.mjs usado pelo GitHub Actions.
async function searchAll(auth, jql) {
  const out = [];
  try {
    let token = null;
    for (let i = 0; i < 20; i++) {
      const body = { jql, fields: FIELDS, maxResults: 100, ...(token ? { nextPageToken: token } : {}) };
      const d = await jiraPost(auth, '/rest/api/3/search/jql', body);
      out.push(...(d.issues || []));
      if (d.isLast === false && d.nextPageToken) token = d.nextPageToken; else break;
    }
    return out;
  } catch (e) {
    let startAt = 0;
    for (let i = 0; i < 20; i++) {
      const d = await jiraPost(auth, '/rest/api/3/search', { jql, fields: FIELDS, maxResults: 100, startAt });
      out.push(...(d.issues || []));
      startAt += (d.issues || []).length;
      if (startAt >= (d.total || 0) || !(d.issues || []).length) break;
    }
    return out;
  }
}

// Mantém exatamente os caminhos de campo que o front-end (processSquad) usa
function slim(issue) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    fields: {
      summary: f.summary || '',
      customfield_10028: typeof f.customfield_10028 === 'number' ? f.customfield_10028 : null,
      customfield_10546: typeof f.customfield_10546 === 'number' ? f.customfield_10546 : null,
      resolutiondate: f.resolutiondate || null,
      status: f.status ? { name: f.status.name, statusCategory: { key: f.status.statusCategory?.key || 'new' } } : null,
      customfield_10020: Array.isArray(f.customfield_10020)
        ? f.customfield_10020.map(s => ({ id: s.id, name: s.name, state: s.state, boardId: s.boardId, goal: s.goal || '', startDate: s.startDate || null, endDate: s.endDate || null }))
        : null,
      parent: f.parent?.fields?.summary ? { fields: { summary: f.parent.fields.summary } } : null,
      assignee: f.assignee?.displayName ? { displayName: f.assignee.displayName } : null,
    },
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
    }
    if (!env.JIRA_EMAIL || !env.JIRA_API_TOKEN) {
      return new Response(JSON.stringify({ error: 'JIRA_EMAIL / JIRA_API_TOKEN não configurados nos Secrets do Worker' }), {
        status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }
    try {
      const auth = 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
      const squads = {};
      for (const p of PROJECTS) {
        const jql = `project = ${p} AND sprint is not EMPTY AND issuetype NOT IN subtaskIssueTypes()`;
        const issues = await searchAll(auth, jql);
        squads[p] = issues.map(slim);
      }
      const data = { generatedAt: new Date().toISOString(), squads, live: true };
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e) }), {
        status: 502, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }
  },
};
