// Weekly Product Hub — data builder
// Consulta o Jira (REST API v3) e gera data.json consumido pelo index.html.
// Env: JIRA_EMAIL, JIRA_API_TOKEN (obrigatórios), JIRA_SITE (default shippify.atlassian.net)
// Executado pelo GitHub Actions (.github/workflows/update-data.yml) a cada hora, como fallback,
// ou via Run workflow. A atualização em tempo real acontece direto no navegador, pelo botão
// 🔄 Atualizar dados, via proxy serverless (Cloudflare Worker) — este script só garante um
// snapshot recente para quando o proxy ainda não estiver configurado ou estiver fora do ar.
//
// Campos de pontos (revalidados em 12/08/2026 contra os 4 boards, 146 cards com os 3 campos):
//   customfield_10028 "Story Points"    = TOTAL da issue (DEV + QA) — é o badge do backlog
//   customfield_10546 "Story point QA"  = parcela de QA (linha 🧪 QA do Desempenho por Dev/QA)
//   customfield_10548 "Story point dev" = parcela de DEV, estimada explicitamente na refinement
// 10028 = 10548 + 10546 em 137/146 cards. Nos 9 restantes o TOTAL ficou igual ao DEV (o QA foi
// somado depois e ninguém atualizou o total), então derivar dev por subtração zerava trabalho
// real de dev — por isso lemos 10548 direto em vez de calcular 10028 − 10546.

const SITE = process.env.JIRA_SITE || 'shippify.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
if (!EMAIL || !TOKEN) { console.error('Defina os secrets JIRA_EMAIL e JIRA_API_TOKEN'); process.exit(1); }

const AUTH = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
const FIELDS = ['status','customfield_10028','customfield_10546','customfield_10548','customfield_10020','resolutiondate','summary','parent','assignee','created'];
// Retrabalho por rejeição (changelog): conta quantas vezes a issue ENTROU em cada status abaixo.
// Nomes reais confirmados no Jira (changelog de OE-140): "CODE REVIEW REJECTED" e "REJECTED BY QA".
// BURNDOWN HISTORICO (27/08/2026): resolutiondate vem NULL em 100% dos cards das 4 squads --
// o workflow nao seta resolution ao concluir. Sem ela nao existe "quando o card ficou pronto".
// A foto real vem do CHANGELOG (mesma busca ja usada pelo indice de retorno): transicoes de
// status, do campo Sprint e de Story Points. Mantido identico ao worker.js.
const CANCEL_STATUS_RE = /cancel|discard|descart/i;
const REJECT_CODE_RE = /CODE\s*REVIEW\s*REJECTED/i;
const REJECT_QA_RE = /REJECTED\s*BY\s*QA|QA\s*DENIED/i;
// Estágios (BASE dos índices de retorno): a issue CHEGOU ao QA / ao code review pelo menos uma vez.
// O denominador do índice é "cards que passaram pelo estágio", não o escopo inteiro da sprint.
const QA_STAGE_RE = /(PENDING\s*QA|ON\s*GOING\s*QA|ON\s*TESTING|APPROVED\s*BY\s*QA|QA\s*VERIFIED|REJECTED\s*BY\s*QA|QA\s*DENIED)/i;
const CR_STAGE_RE = /(CODE\s*REVIEW|PR\s*REVIEW|PULL\s*REQUEST)/i;
// NENHUMA squad inclui subtarefas: com a migração dos pontos para o campo Story Points (DEV + QA)
// nos cards principais, incluir subtasks na AE duplicava pontos (badge AE Sprint 5 = 80 SP; com
// subtasks o hub inflava para 142,5).
// Board de cada squad (necessário para puxar o relatório oficial de sprint do Jira abaixo).
// INF (Infrastructure, board 476) entrou em 28/07/2026 — mesmas métricas das outras squads.
const PROJECTS = [ ['AE', 479], ['OE', 474], ['EE', 475], ['INF', 476] ];

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

async function fetchDeps() {
  try {
    const out = [];
    let token = null;
    for (let i = 0; i < 20; i++) {
      const body = { jql: DEP_JQL, fields: DEP_FIELDS, maxResults: 100, ...(token ? { nextPageToken: token } : {}) };
      const d = await post('https://' + SITE + '/rest/api/3/search/jql', body);
      out.push(...(d.issues || []));
      if (d.isLast === false && d.nextPageToken) token = d.nextPageToken; else break;
    }
    return { issues: out.map(slimDep) };
  } catch (e) {
    console.warn('deps: consulta de links Action item falhou:', e.message);
    return { issues: [], error: String(e.message || e) };
  }
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${url} :: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function get(url) {
  const r = await fetch(url, { headers: { Authorization: AUTH, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${url} :: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Relatório OFICIAL de sprint do Jira — o mesmo endpoint que alimenta os widgets nativos
// "Progresso do sprint" e "Burndown" no board. Usado como fonte da verdade para Scope/Completed/
// Remaining SP da sprint ativa, em vez de recalcularmos por conta própria (evita qualquer
// divergência com o que o time vê direto no Jira). Endpoint legado (greenhopper) mas estável e
// amplamente usado; se falhar (ex.: indisponível), o front-end cai de volta pro cálculo via JQL.
async function getSprintReport(boardId) {
  try {
    const sprints = await get(`https://${SITE}/rest/agile/1.0/board/${boardId}/sprint?state=active`);
    const sprint = (sprints.values || [])[0];
    if (!sprint) return null;
    const report = await get(`https://${SITE}/rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId=${boardId}&sprintId=${sprint.id}`);
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
    console.warn(`sprint report indisponível para board ${boardId}:`, e.message);
    return null;
  }
}

// Endpoint novo (/search/jql, paginação por nextPageToken) com fallback para o legado (/search, startAt)
// expand:['changelog'] traz o histórico de transições — usado para contar retrabalho por rejeição.
async function searchAll(jql) {
  const out = [];
  try {
    let token = null;
    for (let i = 0; i < 20; i++) {
      // No endpoint novo (/search/jql), "expand" é STRING (não array) — enviar array quebra a
      // chamada (erro de deserialização) e derruba pro fallback legado, que a Atlassian já
      // desligou de vez em 2026 (410). Descoberto em 22/07/2026 depois do deploy ficar 502.
      const body = { jql, fields: FIELDS, expand: 'changelog', maxResults: 100, ...(token ? { nextPageToken: token } : {}) };
      const d = await post(`https://${SITE}/rest/api/3/search/jql`, body);
      out.push(...(d.issues || []));
      if (d.isLast === false && d.nextPageToken) token = d.nextPageToken; else break;
    }
    return out;
  } catch (e) {
    console.warn('search/jql falhou, tentando /search legado:', e.message);
    let startAt = 0;
    for (let i = 0; i < 20; i++) {
      const d = await post(`https://${SITE}/rest/api/3/search`, { jql, fields: FIELDS, expand: ['changelog'], maxResults: 100, startAt });
      out.push(...(d.issues || []));
      startAt += (d.issues || []).length;
      if (startAt >= (d.total || 0) || !(d.issues || []).length) break;
    }
    return out;
  }
}

// Subtarefas das histórias informadas (parentKeys), agrupadas por chave do pai. Só status +
// categoria de cada subtarefa — usado no breakdown "Em andamento por status" (o trabalho real
// acontece nas subtarefas). Buscado só para as histórias da sprint ativa para não pesar.
async function fetchSubtasksByParent(project, parentKeys) {
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
      const d = await post(`https://${SITE}/rest/api/3/search/jql`, body);
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
// Inclui rejeições já corrigidas e reincidências (não é só o status atual).
// ── Changelog COMPLETO (endpoint dedicado bulkfetch) ─────────────────────────────
// O expand=changelog do /search devolve no máximo as ~100 transições mais recentes por issue.
// Em cards antigos/longos isso descarta rejeições velhas e SUBESTIMA o índice de retorno
// (descoberto em 27/07/2026: o CODE REVIEW REJECTED de OE-140 aparecia no dashboard OE, que já
// usava este endpoint, e não aqui). Se o bulkfetch falhar, devolve null e caímos no expand.
async function fetchChangelogs(ids) {
  const map = new Map();
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      let token = null;
      for (let page = 0; page < 40; page++) {
        // fieldIds filtra o changelog no servidor. 'status' alimenta o indice de retorno; o campo
        // Sprint (10020) e o Story Points (10028) alimentam a reconstrucao do burndown historico.
        const body = { issueIdsOrKeys: chunk, fieldIds: ['status', 'customfield_10020', 'customfield_10028'], maxResults: 1000, ...(token ? { nextPageToken: token } : {}) };
        const d = await post(`https://${SITE}/rest/api/3/changelog/bulkfetch`, body);
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
    console.warn('changelog/bulkfetch falhou, usando expand=changelog (histórico pode vir truncado):', e.message);
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

// Categoria de cada status do site, resolvida por ID (o changelog devolve o ID e um nome no idioma
// de quem transicionou -- "Done" e "Concluido" convivem no mesmo board). 0 = aberto/em andamento
// 1 = entregue · 2 = cancelado (categoria "done" no Jira, fora do escopo pela regra do painel).
async function fetchStatusKinds() {
  try {
    const arr = await get(`https://${SITE}/rest/api/3/status`);
    const m = {};
    for (const st of (arr || [])) {
      const cat = (st.statusCategory && st.statusCategory.key) || 'new';
      m[String(st.id)] = cat === 'done' ? (CANCEL_STATUS_RE.test(st.name || '') ? 2 : 1) : 0;
    }
    return m;
  } catch (e) {
    console.warn('/rest/api/3/status falhou — classificando status pelo nome:', e.message);
    return null;
  }
}

const DONE_NAME_RE = /^(done|conclu|finaliz|listo|monitoring|pending to release|qa passed|aprovado)/i;
function statusKind(id, name, kinds) {
  if (kinds && kinds[String(id)] !== undefined) return kinds[String(id)];
  const n = name || '';
  if (CANCEL_STATUS_RE.test(n)) return 2;
  return DONE_NAME_RE.test(n) ? 1 : 0;
}
const histNum = v => (v === '' || v === null || v === undefined) ? 0 : (isNaN(parseFloat(v)) ? 0 : parseFloat(v));

// Linha do tempo compacta da issue, para o front reconstruir o burndown dia a dia. Ver worker.js.
function historyLogs(issue, bulk, kinds) {
  const hs = (bulk && bulk.get(String(issue.id))) || issue.changelog?.histories || [];
  const rows = [];
  for (const h of hs) {
    const t = +new Date(h.created);
    if (!t) continue;
    for (const it of (h.items || [])) rows.push([t, it]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const st = [], sp = [], spr = [];
  let st0 = null, sp0 = null, spr0 = null;
  for (const [t, it] of rows) {
    const fid = it.fieldId || '', fname = it.field || '';
    if (fid === 'status' || fname === 'status') {
      if (st0 === null) st0 = statusKind(it.from, it.fromString, kinds);
      const k = statusKind(it.to, it.toString, kinds);
      if (!st.length || st[st.length - 1][1] !== k) st.push([t, k]);
    } else if (fid === 'customfield_10028' || fname === 'Story Points') {
      if (sp0 === null) sp0 = histNum(it.fromString);
      sp.push([t, histNum(it.toString)]);
    } else if (fid === 'customfield_10020' || fname === 'Sprint') {
      if (spr0 === null) spr0 = String(it.from || '');
      spr.push([t, String(it.to || '')]);
    }
  }
  return { st, sp, spr, st0, sp0, spr0 };
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

// Mantém exatamente os caminhos de campo que o front-end (processSquad) usa
function slim(issue, bulk, kinds) {
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
      created: f.created || null,
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
    hist: historyLogs(issue, bulk, kinds),
  };
}

const squads = {};
const sprintReport = {};
// Mapa status -> categoria: uma chamada so, compartilhada pelas 4 squads (burndown historico).
const statusKinds = await fetchStatusKinds();
for (const [p, boardId] of PROJECTS) {
  const jql = `project = ${p} AND sprint is not EMPTY AND issuetype NOT IN subtaskIssueTypes()`;
  const issues = await searchAll(jql);
  // Subtarefas de TODAS as histórias com sprint (não só da ativa): a matriz Dev × Sprint mede
  // alocado/entregue por sprint com a mesma regra DEV = subtarefas, inclusive no histórico
  // (03/08/2026). Custo baixo — lotes de 100 chaves por request.
  const allKeys = issues.map(i => i.key);
  const subByParent = allKeys.length ? await fetchSubtasksByParent(p, allKeys) : {};
  const bulk = await fetchChangelogs(issues.map(i => i.id).filter(Boolean));
  squads[p] = issues.map(i => { const o = slim(i, bulk, statusKinds); o.subs = subByParent[i.key] || []; return o; });
  sprintReport[p] = await getSprintReport(boardId);
  const subCount = Object.values(subByParent).reduce((a, v) => a + v.length, 0);
  const totRej = squads[p].reduce((a, i) => a + i.rejCode + i.rejQA, 0);
  console.log(`${p}: ${issues.length} issues · ${subCount} subtarefas (sprint ativa) · ${totRej} rejeições (changelog ${bulk ? 'completo' : 'truncado — bulkfetch falhou'})` + (sprintReport[p] ? ` · sprint report: ${sprintReport[p].completedSP}/${sprintReport[p].scopeSP} SP` : ''));
}

const deps = await fetchDeps();
console.log('deps: ' + deps.issues.length + ' issues com link Action item em ' + DEP_PROJECTS.join('/') + (deps.error ? ' (erro: ' + deps.error + ')' : ''));
const data = { generatedAt: new Date().toISOString(), squads, sprintReport, deps };
await import('node:fs').then(fs => fs.writeFileSync('data.json', JSON.stringify(data)));
console.log('data.json gerado em', data.generatedAt);
