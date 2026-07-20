// Weekly Product Hub — data builder
// Consulta o Jira (REST API v3) e gera data.json consumido pelo index.html.
// Env: JIRA_EMAIL, JIRA_API_TOKEN (obrigatórios), JIRA_SITE (default shippify.atlassian.net)
// Executado pelo GitHub Actions (.github/workflows/update-data.yml) a cada hora, como fallback,
// ou via Run workflow. A atualização em tempo real acontece direto no navegador, pelo botão
// 🔄 Atualizar dados, via proxy serverless (Cloudflare Worker) — este script só garante um
// snapshot recente para quando o proxy ainda não estiver configurado ou estiver fora do ar.
//
// Campos de pontos (validados em 17/07/2026):
//   customfield_10028 "Story Points"   = TOTAL da issue (já é a somatória DEV + QA)
//   customfield_10546 "Story point QA" = parcela de QA (linha 🧪 QA do Desempenho por Dev/QA)

const SITE = process.env.JIRA_SITE || 'shippify.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
if (!EMAIL || !TOKEN) { console.error('Defina os secrets JIRA_EMAIL e JIRA_API_TOKEN'); process.exit(1); }

const AUTH = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
const FIELDS = ['status','customfield_10028','customfield_10546','customfield_10020','resolutiondate','summary','parent','assignee'];
// NENHUMA squad inclui subtarefas: com a migração dos pontos para o campo Story Points (DEV + QA)
// nos cards principais, incluir subtasks na AE duplicava pontos (badge AE Sprint 5 = 80 SP; com
// subtasks o hub inflava para 142,5).
const PROJECTS = [ ['AE', false], ['OE', false], ['EE', false] ];

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${url} :: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Endpoint novo (/search/jql, paginação por nextPageToken) com fallback para o legado (/search, startAt)
async function searchAll(jql) {
  const out = [];
  try {
    let token = null;
    for (let i = 0; i < 20; i++) {
      const body = { jql, fields: FIELDS, maxResults: 100, ...(token ? { nextPageToken: token } : {}) };
      const d = await post(`https://${SITE}/rest/api/3/search/jql`, body);
      out.push(...(d.issues || []));
      if (d.isLast === false && d.nextPageToken) token = d.nextPageToken; else break;
    }
    return out;
  } catch (e) {
    console.warn('search/jql falhou, tentando /search legado:', e.message);
    let startAt = 0;
    for (let i = 0; i < 20; i++) {
      const d = await post(`https://${SITE}/rest/api/3/search`, { jql, fields: FIELDS, maxResults: 100, startAt });
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

const squads = {};
for (const [p, incSub] of PROJECTS) {
  const jql = `project = ${p} AND sprint is not EMPTY` + (incSub ? '' : ' AND issuetype NOT IN subtaskIssueTypes()');
  const issues = await searchAll(jql);
  squads[p] = issues.map(slim);
  console.log(`${p}: ${issues.length} issues`);
}

const data = { generatedAt: new Date().toISOString(), squads };
await import('node:fs').then(fs => fs.writeFileSync('data.json', JSON.stringify(data)));
console.log('data.json gerado em', data.generatedAt);
