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

// Campos de pontos (revalidados em 12/08/2026 contra os 4 boards, 146 cards com os 3 campos):
//   customfield_10028 "Story Points"    = TOTAL da issue (DEV + QA) — é o badge do backlog
//   customfield_10546 "Story point QA"  = parcela de QA
//   customfield_10548 "Story point dev" = parcela de DEV, estimada explicitamente na refinement
// A relação 10028 = 10548 + 10546 vale em 137/146 cards. Nos 9 restantes o TOTAL ficou igual ao
// DEV (ninguém somou o QA depois), então derivar dev por subtração zerava trabalho real de dev
// (ex.: AE-245 total 1 / QA 1 / dev 1 → subtração dava 0). Por isso lemos 10548 direto.
const FIELDS = ['status', 'customfield_10028', 'customfield_10546', 'customfield_10548', 'customfield_10020', 'resolutiondate', 'summary', 'parent', 'assignee'];
// Retrabalho por rejeição (changelog): conta quantas vezes a issue ENTROU em cada status abaixo.
// Nomes reais confirmados no Jira (changelog de OE-140): "CODE REVIEW REJECTED" e "REJECTED BY QA".
const REJECT_CODE_RE = /CODE\s*REVIEW\s*REJECTED/i;
const REJECT_QA_RE = /REJECTED\s*BY\s*QA|QA\s*DENIED/i;
// Estágios (BASE dos índices de retorno): a issue CHEGOU ao QA / ao code review pelo menos uma vez.
// O denominador do índice é "cards que passaram pelo estágio", não o escopo inteiro da sprint.
const QA_STAGE_RE = /(PENDING\s*QA|ON\s*GOING\s*QA|ON\s*TESTING|APPROVED\s*BY\s*QA|QA\s*VERIFIED|REJECTED\s*BY\s*QA|QA\s*DENIED)/i;
const CR_STAGE_RE = /(CODE\s*REVIEW|PR\s*REVIEW|PULL\s*REQUEST)/i;
// Nenhuma squad pontua subtarefas — os pontos já vêm somados (DEV+QA) no campo Story Points
// das histórias/tarefas/bugs. Regra igual para AE, OE e EE (confirmado com o time em 20/07/2026).
// INF (Infrastructure, board 476) entrou em 28/07/2026 — mesmas métricas das outras squads.
const PROJECTS = ['AE', 'OE', 'EE', 'INF'];
// Board de cada squad — necessário para puxar o relatório oficial de sprint do Jira (fonte da
// verdade para Scope/Completed/Remaining SP e % de progresso, pedido em 20/07/2026).
const BOARD_BY_PROJECT = { AE: 479, OE: 474, EE: 475, INF: 476 };

// ── DEPENDÊNCIAS ENTRE SQUADS (aba Dependências, 20/08/2026) ─────────────────────
// Consulta separada das métricas de sprint: as dependências vivem nos links "Action item"
// e aparecem também em SUBTAREFAS e em cards SEM sprint — que a JQL das squads exclui
// (project = X AND sprint is not EMPTY AND issuetype NOT IN subtaskIssueTypes()). Por isso
// esta busca não filtra sprint nem tipo, e inclui o projeto SEC (squad SRG, board 405).
// Os dois lados de cada link caem no mesmo resultado (a JQL casa pelas duas pontas), então
// o front consegue ler duedate/sprint do provedor sem uma segunda consulta.
// Quem entrega × quem espera NÃO é decidido aqui: a direção gravada no Jira é inconsistente
// e a regra (precedência SRG > INF) vive no front, em processDeps().
const DEP_PROJECTS = ['AE', 'OE', 'EE', 'INF', 'SEC'];
const DEP_FIELDS = ['summary', 'status', 'duedate', 'customfield_10020', 'assignee', 'issuetype', 'issuelinks', 'resolutiondate'];
const DEP_JQL = 'project in (' + DEP_PROJECTS.join(',') + ') AND issueLinkType in ("has action item","action item from") ORDER BY key ASC';

function slimDep(issue) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    summary: f.summary || '',
    duedate: f.duedate || null,
    resolutiondate: f.resolutiondate || null,
    type: f.issuetype?.name || '',
    assignee: f.assignee?.displayName || null,
    status: f.status ? { name: f.status.name, cat: f.status.statusCategory?.key || 'new' } : null,
    sprints: Array.isArray(f.customfield_10020)
      ? f.customfield_10020.map(s => ({ name: s.name, state: s.state, startDate: s.startDate || null, endDate: s.endDate || null }))
      : null,
    links: (f.issuelinks || []).map(l => {
      const other = l.outwardIssue || l.inwardIssue;
      if (!other) return null;
      const st = other.fields?.status;
      return {
        type: l.type?.name || '',
        dir: l.outwardIssue ? 'out' : 'in',
        key: other.key,
        summary: other.fields?.summary || '',
        status: st ? { name: st.name, cat: st.statusCategory?.key || 'new' } : null,
      };
    }).filter(Boolean),
  };
}

async function fetchDeps(auth) {
  try {
    const out = [];
    let token = null;
    for (let i = 0; i < 20; i++) {
      const body = { jql: DEP_JQL, fields: DEP_FIELDS, maxResults: 100, ...(token ? { nextPageToken: token } : {}) };
      const d = await jiraPost(auth, '/rest/api/3/search/jql', body);
      out.push(...(d.issues || []));
      if (d.isLast === false && d.nextPageToken) token = d.nextPageToken; else break;
    }
    return { issues: out.map(slimDep) };
  } catch (e) {
    // Falha aqui não pode derrubar o payload inteiro: o resto do painel continua no ar e a aba
    // Dependências mostra o aviso de "bloco deps ainda não chegou".
    return { issues: [], error: String(e.message || e) };
  }
}

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
      // No endpoint novo (/search/jql), "expand" é STRING (não array) — enviar array quebra a
      // chamada (erro de deserialização) e derruba pro fallback legado, que a Atlassian já
      // desligou de vez em 2026 (410). Descoberto em 22/07/2026 depois do deploy ficar 502.
      const body = { jql, fields: FIELDS, expand: 'changelog', maxResults: 100, ...(token ? { nextPageToken: token } : {}) };
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

// Subtarefas das histórias informadas (parentKeys), agrupadas por chave do pai. Só status +
// categoria de cada subtarefa — usado no breakdown "Em andamento por status" (o trabalho real
// acontece nas subtarefas, não na história inteira). Buscado só para as histórias da sprint ativa
// (parentKeys já vem filtrado) para não pesar na latência.
async function fetchSubtasksByParent(auth, project, parentKeys) {
  const byParent = {};
  const CHUNK = 100;
  for (let i = 0; i < parentKeys.length; i += CHUNK) {
    const chunk = parentKeys.slice(i, i + CHUNK);
    const jql = `project = ${project} AND issuetype IN subtaskIssueTypes() AND parent IN (${chunk.join(',')})`;
    let token = null;
    for (let pg = 0; pg < 20; pg++) {
      // Subtarefa carrega SP próprio (customfield_10028) e responsável próprio — é onde o trabalho
      // de DEV realmente está alocado (a soma das subtarefas = porção dev da história).
      const body = { jql, fields: ['status', 'parent', 'customfield_10028', 'assignee'], maxResults: 100, ...(token ? { nextPageToken: token } : {}) };
      const d = await jiraPost(auth, '/rest/api/3/search/jql', body);
      for (const st of (d.issues || [])) {
        const pk = st.fields?.parent?.key; if (!pk) continue;
        (byParent[pk] = byParent[pk] || []).push({
          s: st.fields.status?.name || '—',
          c: st.fields.status?.statusCategory?.key || 'new',
          sp: typeof st.fields.customfield_10028 === 'number' ? st.fields.customfield_10028 : null,
          assignee: st.fields.assignee?.displayName || null,
        });
      }
      if (d.isLast === false && d.nextPageToken) token = d.nextPageToken; else break;
    }
  }
  return byParent;
}

// Conta quantas vezes a issue ENTROU em "CODE REVIEW REJECTED" (retrabalho de código) e em
// "REJECTED BY QA"/"QA DENIED" (retrabalho de QA), a partir do changelog completo do Jira.
// ── Changelog COMPLETO (endpoint dedicado bulkfetch) ─────────────────────────────
// O expand=changelog do /search devolve no máximo as ~100 transições mais recentes por issue.
// Em cards antigos/longos isso descarta rejeições velhas e SUBESTIMA o índice de retorno
// (descoberto em 27/07/2026: o CODE REVIEW REJECTED de OE-140 aparecia no dashboard OE, que já
// usava este endpoint, e não aqui). Se o bulkfetch falhar, devolve null e caímos no expand.
async function fetchChangelogs(auth, ids) {
  const map = new Map();
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      let token = null;
      for (let page = 0; page < 40; page++) {
        const body = { issueIdsOrKeys: chunk, fieldIds: ['status'], maxResults: 1000, ...(token ? { nextPageToken: token } : {}) };
        const d = await jiraPost(auth, '/rest/api/3/changelog/bulkfetch', body);
        for (const entry of (d.issueChangeLogs || [])) {
          const k = String(entry.issueId);
          if (!map.has(k)) map.set(k, []);
          map.get(k).push(...(entry.changeHistories || []));
        }
        if (d.isLast === false && d.nextPageToken) token = d.nextPageToken; else break;
      }
    }
    return map;
  } catch (e) {
    
    return null;
  }
}

// Transições de status da issue, do changelog completo (bulkfetch) ou, em fallback, do expand.
function statusTransitions(issue, bulk) {
  const out = [];
  const hs = (bulk && bulk.get(String(issue.id))) || issue.changelog?.histories || [];
  for (const h of hs) {
    for (const it of (h.items || [])) {
      if (it.field !== 'status' && it.fieldId !== 'status') continue;
      out.push({ to: it.toString || '', at: h.created });
    }
  }
  return out;
}

function countRejections(issue, bulk) {
  let rejCode = 0, rejQA = 0, lastAt = null, lastWhat = null;
  // touchQA / touchCR: a issue entrou pelo menos uma vez no estágio (base do índice de retorno).
  let touchQA = false, touchCR = false;
  for (const t of statusTransitions(issue, bulk)) {
    const to = t.to;
    if (QA_STAGE_RE.test(to)) touchQA = true;
    if (CR_STAGE_RE.test(to)) touchCR = true;
    if (REJECT_CODE_RE.test(to)) { rejCode++; lastAt = t.at; lastWhat = 'CODE REVIEW REJECTED'; }
    else if (REJECT_QA_RE.test(to)) { rejQA++; lastAt = t.at; lastWhat = 'REJECTED BY QA'; }
  }
  // Fallbacks: status atual já no estágio (issue criada direto nele) ou rejeição registrada.
  const cur = issue.fields?.status?.name || '';
  if (QA_STAGE_RE.test(cur) || rejQA > 0) touchQA = true;
  if (CR_STAGE_RE.test(cur) || rejCode > 0) touchCR = true;
  return { rejCode, rejQA, touchQA, touchCR, lastRejAt: lastAt, lastRejWhat: lastWhat };
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
function slim(issue, bulk) {
  const f = issue.fields || {};
  const rej = countRejections(issue, bulk);
  return {
    key: issue.key,
    fields: {
      summary: f.summary || '',
      customfield_10028: typeof f.customfield_10028 === 'number' ? f.customfield_10028 : null,
      customfield_10546: typeof f.customfield_10546 === 'number' ? f.customfield_10546 : null,
      customfield_10548: typeof f.customfield_10548 === 'number' ? f.customfield_10548 : null,
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
    touchQA: rej.touchQA,
    touchCR: rej.touchCR,
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
      // Dependências (links Action item): dispara em paralelo com as squads e é aguardada no fim.
      const depsP = fetchDeps(auth);
      // As 4 squads são independentes → rodam EM PARALELO (antes era um laço sequencial e o tempo
      // total somava: com INF + subtarefas de todas as sprints passou de 18s e começou a estourar
      // o timeout de 25s do front, caindo pro snapshot. Dentro de cada squad, subtarefas/changelog/
      // sprint report também vão em paralelo. Corrigido em 03/08/2026.
      await Promise.all(PROJECTS.map(async (p) => {
        const board = BOARD_BY_PROJECT[p];
        const jql = `project = ${p} AND sprint is not EMPTY AND issuetype NOT IN subtaskIssueTypes()`;
        const issues = await searchAll(auth, jql);
        // Subtarefas de TODAS as histórias com sprint (não só da ativa): a matriz Dev × Sprint mede
        // alocado/entregue por sprint com a mesma regra DEV = subtarefas, inclusive no histórico.
        const allKeys = issues.map(i => i.key);
        const [subByParent, bulk, report] = await Promise.all([
          allKeys.length ? fetchSubtasksByParent(auth, p, allKeys) : Promise.resolve({}),
          fetchChangelogs(auth, issues.map(i => i.id).filter(Boolean)),
          getSprintReport(auth, board),
        ]);
        squads[p] = issues.map(i => { const o = slim(i, bulk); o.subs = subByParent[i.key] || []; return o; });
        sprintReport[p] = report;
      }));
      const deps = await depsP;
      const data = { generatedAt: new Date().toISOString(), squads, sprintReport, deps, live: true };
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
