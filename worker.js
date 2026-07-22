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
// Retrabalho por rejeição (changelog): conta quantas vezes a issue ENTROU em cada status abaixo.
// Nomes reais confirmados no Jira (changelog de OE-140): "CODE REVIEW REJECTED" e "REJECTED BY QA".
const REJECT_CODE_RE = /CODE\s*REVIEW\s*REJECTED/i;
const REJECT_QA_RE = /REJECTED\s*BY\s*QA|QA\s*DENIED/i;
// Nenhuma squad pontua subtarefas — os pontos já vêm somados (DEV+QA) no campo Story Points
// das histórias/tarefas/bugs. Regra igual para AE, OE e EE (confirmado com o time em 20/07/2026).
const PROJECTS = ['AE', 'OE', 'EE'];
// Board de cada squad — necessário para puxar o relatório oficial de sprint do Jira (fonte da
// verdade para Scope/Completed/Remaining SP e % de progresso, pedido em 20/07/2026).
const BOARD_BY_PROJECT = { AE: 479, OE: 474, EE: 475 };

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
      const body = { jql, fields: FIELDS, expand: ['changelog'], maxResults: 100, ...(token ? { nextPageToken: token } : {}) };
      const d = await jiraPost(auth, '/rest/api/3/search/jql', body);
      out.push(...(d.issues || []));
      if (d.isLast === false && d.nextPageToken) token = d.nextPageToken; else break;
    }
    return out;
  } catch (e) {
    let startAt = 0;
    for (let i = 0; i < 20; i++) {
      const d = await jiraPost(auth, '/rest/api/3/search', { jql, fields: FIELDS, expand: ['changelog'], maxResults: 100, startAt });
      out.push(...(d.issues || []));
      startAt += (d.issues || []).length;
      if (startAt >= (d.total || 0) || !(d.issues || []).length) break;
    }
    return out;
  }
}

// Conta quantas vezes a issue ENTROU em "CODE REVIEW REJECTED" (retrabalho de código) e em
// "REJECTED BY QA"/"QA DENIED" (retrabalho de QA), a partir do changelog completo do Jira.
function countRejections(issue) {
  const histories = issue.changelog?.histories || [];
  let rejCode = 0, rejQA = 0, lastAt = null, lastWhat = null;
  for (const h of histories) {
    for (const it of (h.items || [])) {
      if (it.field !== 'status') continue;
      if (REJECT_CODE_RE.test(it.toString || '')) { rejCode++; lastAt = h.created; lastWhat = 'CODE REVIEW REJECTED'; }
      else if (REJECT_QA_RE.test(it.toString || '')) { rejQA++; lastAt = h.created; lastWhat = 'REJECTED BY QA'; }
    }
  }
  return { rejCode, rejQA, lastRejAt: lastAt, lastRejWhat: lastWhat };
}

async function jiraGet(auth, path) {
  const r = await fetch(`https://${JIRA_SITE}${path}`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`${r.status} ${path} :: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Relatório OFICIAL de sprint do Jira — o mesmo endpoint que alimenta os widgets nativos
// "Progresso do sprint" e "Burndown" no board. Usado como fonte da verdade para Scope/Completed/
// Remaining SP da sprint ativa, em vez de recalcularmos por conta própria (pedido do time em
// 20/07/2026, para eliminar qualquer divergência com o que aparece direto no Jira). Endpoint
// legado (greenhopper) mas estável; se falhar, o front-end cai de volta pro cálculo via JQL.
async function getSprintReport(auth, boardId) {
  try {
    const sprints = await jiraGet(auth, `/rest/agile/1.0/board/${boardId}/sprint?state=active`);
    const sprint = (sprints.values || [])[0];
    if (!sprint) return null;
    const report = await jiraGet(auth, `/rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId=${boardId}&sprintId=${sprint.id}`);
    const c = report.contents || {};
    const completedSP = c.completedIssuesEstimateSum?.value || 0;
    const notCompletedSP = c.issuesNotCompletedEstimateSum?.value || 0;
    let todoSP = 0, inprogSP = 0, todoN = 0, inprogN = 0;
    for (const it of (c.issuesNotCompletedInCurrentSprint || [])) {
      const sp = it.currentEstimateStatistic?.statFieldValue?.value ?? it.estimateStatistic?.statFieldValue?.value ?? 0;
      const catKey = it.status?.statusCategory?.key || 'new';
      if (catKey === 'indeterminate') { inprogSP += sp; inprogN++; } else { todoSP += sp; todoN++; }
    }
    return {
      sprintId: sprint.id, sprintName: sprint.name,
      completedSP, notCompletedSP, scopeSP: completedSP + notCompletedSP,
      todoSP, inprogSP, doneN: (c.completedIssues || []).length, todoN, inprogN,
    };
  } catch (e) {
    return null;
  }
}

// Mantém exatamente os caminhos de campo que o front-end (processSquad) usa
function slim(issue) {
  const f = issue.fields || {};
  const rej = countRejections(issue);
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
    rejCode: rej.rejCode,
    rejQA: rej.rejQA,
    lastRejAt: rej.lastRejAt,
    lastRejWhat: rej.lastRejWhat,
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
      const sprintReport = {};
      for (const p of PROJECTS) {
        const jql = `project = ${p} AND sprint is not EMPTY AND issuetype NOT IN subtaskIssueTypes()`;
        const issues = await searchAll(auth, jql);
        squads[p] = issues.map(slim);
        sprintReport[p] = await getSprintReport(auth, BOARD_BY_PROJECT[p]);
      }
      const data = { generatedAt: new Date().toISOString(), squads, sprintReport, live: true };
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
