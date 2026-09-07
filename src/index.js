import PAGINA from './pagina.html';

/* ------------------------------------------------------------------
   Central Comercial — Grupo BJ7
   Lê o Pipedrive, monta o conjunto de dados e guarda no KV.
   O navegador nunca fala com o Pipedrive: a chave vive só aqui.
------------------------------------------------------------------- */

const CHAVE_KV = 'dados:atual';
const CHAVE_ESTADO = 'estado:grupo';   /* o que as pessoas digitam, compartilhado */
const API = 'https://api.pipedrive.com';

/* Quem é quem.
   O Pipedrive devolve o nome completo ("Nicolas Klein"). O painel usa o primeiro
   nome, senão a mesma pessoa aparece duas vezes no filtro. Jonathas é a conta do
   dono; quem opera por ela é a Keth. */
const APELIDO = { Jonathas: 'Keth' };
function nomeCurto(completo) {
  const primeiro = (completo || '').trim().split(/\s+/)[0] || '—';
  return APELIDO[primeiro] || primeiro;
}

/* Etapas que não contam como oportunidade viva. */
const MORTAS = ['Sem interesse', 'Arquivado', 'Não respondeu - IA', 'Longo prazo',
  'Longo Prazo', 'Nutrição', 'Sem número', 'Lead novo', 'Lead'];

/* Etapas avançadas por nome — usado para marcar av:1 */
const AVANCADAS = ['Respondeu', 'Apresentando oportunidades', 'Proposta', 'Fechamento',
  'Análise Documentação', 'Portfólio', 'Qualificados', 'Qualificado', 'Mídia Kit',
  'Visita', 'Fechado'];

/* Nome curto do funil, a partir do nome no Pipedrive */
function funilCurto(nome) {
  const n = (nome || '').toLowerCase();
  if (n.includes('painel') || n.includes('painéis') || n.includes('paineis')) return 'Painéis';
  if (n.includes('angaria')) return 'Angariação';
  if (n.includes('sdr')) return 'SDR';
  if (n.includes('venda')) return 'Vendas';
  return nome || '—';
}

/* Classifica o motivo da perda. Descarte operacional fica fora da conversão. */
const REGRA_OPERACIONAL =
  /(duplic|teste|repit|n[uú]mero|numero|sem celular|falha|desqualific|bloquead)/i;

const CATEGORIAS = [
  [/(j[áa] compr|comprou|vendido|j[áa] encontrou|j[áa] deu certo|outro corretor|com amigo)/i,
    'Comprou em outro lugar'],
  [/(sem interesse|n[ãa]o tem mais interesse|desist|n[ãa]o interess|zero interesse|n[ãa]o estou mais buscando)/i,
    'Desistiu'],
  [/(sc\b|santa catarina|pi[çc]arras|itapema|camb[ée]|barra velha|outra cidade|n[ãa]o pretende vir)/i,
    'Fora da nossa praça'],
  [/(n[ãa]o anuncia|n[ãa]o quer anunciar|n[ãa]o assina|n[ãa]o vai vender|n[ãa]o vai mais vender|n[ãa]o tem interesse em vender)/i,
    'Proprietário não quis anunciar'],
  [/(saiu corretor|n[ãa]o recebeu|demorou|n[ãa]o chegou)/i, 'Falha nossa'],
  [/(n[ãa]o respond|n[ãa]o responde|sumiu)/i, 'Parou de responder'],
  [/(pre[çc]o|parcelad|valor|permuta|entrada)/i, 'Preço ou condição'],
  [/(adiou|agora n[ãa]o|n[ãa]o pode comprar agora|longo prazo)/i, 'Timing do cliente'],
  [/(document)/i, 'Documentação'],
];

function categoriaPerda(motivo, operacional) {
  if (operacional) return 'Descarte operacional';
  const m = motivo || '';
  for (const [re, cat] of CATEGORIAS) if (re.test(m)) return cat;
  return 'Outro';
}

function limpaHtml(t) {
  return (t || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

/* ---------- chamadas ao Pipedrive ---------- */

async function pd(env, caminho, params = {}) {
  const u = new URL(API + caminho);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { 'x-api-token': env.PIPEDRIVE_TOKEN } });
  if (!r.ok) throw new Error('Pipedrive ' + caminho + ' devolveu ' + r.status);
  return r.json();
}

/* v2 pagina por cursor */
async function pdTodosV2(env, caminho, params = {}) {
  const out = [];
  let cursor;
  for (let i = 0; i < 40; i++) {
    const j = await pd(env, caminho, { ...params, limit: 500, cursor });
    out.push(...(j.data || []));
    cursor = j.additional_data && j.additional_data.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/* v1 pagina por start */
async function pdTodosV1(env, caminho, params = {}) {
  const out = [];
  for (let start = 0; start < 20000; start += 500) {
    const j = await pd(env, caminho, { ...params, limit: 500, start });
    out.push(...(j.data || []));
    const p = j.additional_data && j.additional_data.pagination;
    if (!p || !p.more_items_in_collection) break;
  }
  return out;
}

/* ---------- montagem do conjunto de dados ---------- */

export async function montar(env) {
  const hoje = new Date().toISOString().slice(0, 10);

  /* usuários, funis e etapas */
  const usuarios = {};
  for (const u of (await pd(env, '/v1/users')).data || []) {
    usuarios[u.id] = nomeCurto(u.name);
  }
  const funis = {};
  for (const p of await pdTodosV2(env, '/api/v2/pipelines')) funis[p.id] = funilCurto(p.name);
  const etapas = {};
  for (const e of await pdTodosV2(env, '/api/v2/stages')) {
    etapas[e.id] = { nome: e.name.trim(), funil: funis[e.pipeline_id] || '—' };
  }

  /* pessoas: nome e telefone */
  const pessoas = {};
  for (const p of await pdTodosV2(env, '/api/v2/persons')) {
    const tel = (p.phones || []).find(x => x.value);
    pessoas[p.id] = { n: p.name || '', t: tel ? tel.value : '' };
  }

  /* negócios, todos os status */
  const brutos = await pdTodosV2(env, '/api/v2/deals');
  const negocios = [], resultado = [];
  for (const d of brutos) {
    const et = etapas[d.stage_id] || { nome: '?', funil: '—' };
    const p = pessoas[d.person_id] || { n: '', t: '' };
    const base = {
      id: d.id, t: d.title, e: et.nome, f: et.funil,
      d: usuarios[d.owner_id] || '—',
      cl: p.n, tel: p.t, cr: (d.add_time || '').slice(0, 10),
    };
    if (d.status === 'open') {
      negocios.push({ ...base, av: AVANCADAS.includes(et.nome) ? 1 : 0,
        u: (d.update_time || '').slice(0, 10) });
    } else {
      const fim = (d.won_time || d.lost_time || d.close_time || '').slice(0, 10);
      const motivo = d.lost_reason || '';
      const op = d.status === 'lost' &&
        (REGRA_OPERACIONAL.test(motivo) || motivo.trim().length < 5);
      resultado.push({ ...base, a: base.cr, q: fim,
        c: fim && base.cr ? Math.round((new Date(fim) - new Date(base.cr)) / 864e5) : null,
        r: d.status === 'won' ? 'ganho' : 'perdido',
        m: motivo, op, cat: d.status === 'won' ? '' : categoriaPerda(motivo, op) });
    }
  }
  resultado.sort((a, b) => (a.q < b.q ? 1 : -1));

  /* atividades concluídas do ano corrente e do anterior */
  const ano = +hoje.slice(0, 4);
  const ativ = [];
  const vistos = new Set();
  for (const a of await pdTodosV1(env, '/v1/activities',
      { user_id: 0, done: 1, start_date: (ano - 1) + '-01-01', end_date: hoje })) {
    const quem = usuarios[a.user_id];
    if (!quem || vistos.has(a.id)) continue;
    vistos.add(a.id);
    const md = a.marked_as_done_time;
    ativ.push({
      i: a.deal_id || 0,
      d: a.deal_title || a.person_name || a.org_name || '',
      q: (md || a.due_date || '').slice(0, 10),
      h: md ? md.slice(11, 16) : (a.due_time || ''),
      t: (a.type_name || '').trim() || 'Sem tipo',
      a: quem,
      n: limpaHtml(a.note).slice(0, 300),
    });
  }
  ativ.sort((a, b) => (a.q + a.h < b.q + b.h ? 1 : -1));

  /* cobertura declarada — a camada de verdade do painel */
  const qs = ativ.map(x => x.q).filter(Boolean).sort();
  const crs = [...negocios, ...resultado].map(x => x.cr).filter(Boolean).sort();
  const idsVivos = new Set([...negocios, ...resultado].map(x => x.id));
  const orfasIds = [...new Set(ativ.filter(x => x.i && !idsVivos.has(x.i)).map(x => x.i))];

  const meses = [];
  if (crs.length) {
    let [y, m] = [+crs[0].slice(0, 4), +crs[0].slice(5, 7)];
    const fimY = +hoje.slice(0, 4), fimM = +hoje.slice(5, 7);
    while (y < fimY || (y === fimY && m <= fimM)) {
      meses.push(y + '-' + String(m).padStart(2, '0'));
      m++; if (m > 12) { m = 1; y++; }
    }
  }

  /* fontes externas: falha de uma não pode derrubar a sincronização das outras */
  const [trelloR, reunioesR, sheetsR] = await Promise.all([
    lerTrello(env).catch(e => ({ ligado: false, erro: String(e.message || e) })),
    lerReunioesTrello(env).catch(e => ({ ligado: false, erro: String(e.message || e) })),
    lerSheets(env).catch(e => ({ ligado: false, erro: String(e.message || e) })),
  ]);

  return {
    trello: trelloR, trelloReunioes: reunioesR, sheets: sheetsR,
    negocios, resultado, ativ, mortas: MORTAS, hoje,
    janela: { ini: crs[0] || hoje, fim: hoje },
    meses,
    cobertura: {
      ativDe: qs[0] || hoje, ativAte: qs[qs.length - 1] || hoje,
      negDe: crs[0] || hoje,
      orfas: ativ.filter(x => x.i && !idsVivos.has(x.i)).length,
      orfasIds,
    },
    extracao: hoje.slice(8, 10) + '/' + hoje.slice(5, 7) + '/' + hoje.slice(0, 4),
    sincronizadoEm: new Date().toISOString(),
  };
}

async function sincronizar(env) {
  const dados = await montar(env);
  await env.CENTRAL.put(CHAVE_KV, JSON.stringify(dados));
  return dados;
}

/* ------------------------------------------------------------------
   Fontes externas. Cada dado tem um dono, e a Central só lê.
     Tarefas e reuniões  → Trello
     Financeiro          → Google Sheets
   Quando o segredo da fonte não está configurado, o Worker devolve
   { ligado:false } e o painel diz isso na tela em vez de mostrar zero.
------------------------------------------------------------------- */

/* ---------- Trello ---------- */
async function trello(env, caminho, params = {}) {
  const u = new URL('https://api.trello.com/1' + caminho);
  u.searchParams.set('key', env.TRELLO_KEY);
  u.searchParams.set('token', env.TRELLO_TOKEN);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (!r.ok) throw new Error('Trello ' + caminho + ' devolveu ' + r.status);
  return r.json();
}

/* Lista do Trello vira situação. O nome da lista manda: se contém "conclu",
   "feito" ou "done", a tarefa está fechada. */
function situacaoDaLista(nome) {
  const n = (nome || '').toLowerCase();
  if (/(conclu|feito|done|pronto|entregue)/.test(n)) return 'concluida';
  if (/(fazendo|doing|andamento|execu)/.test(n)) return 'fazendo';
  if (/(cancel|descart)/.test(n)) return 'cancelada';
  return 'aberta';
}
function prioridadeDosRotulos(labels) {
  const n = (labels || []).map(l => (l.name || '').toLowerCase()).join(' ');
  if (/(urgent|alta|cr[íi]tic)/.test(n)) return 'alta';
  if (/(baixa|low)/.test(n)) return 'baixa';
  return 'média';
}

async function lerTrello(env) {
  if (!env.TRELLO_KEY || !env.TRELLO_TOKEN || !env.TRELLO_BOARD) {
    return { ligado: false, motivo: 'TRELLO_KEY, TRELLO_TOKEN e TRELLO_BOARD não configurados' };
  }
  const [listas, cartoes, membros] = await Promise.all([
    trello(env, '/boards/' + env.TRELLO_BOARD + '/lists', { fields: 'name' }),
    trello(env, '/boards/' + env.TRELLO_BOARD + '/cards',
      { fields: 'name,desc,due,dueComplete,idList,idMembers,labels,dateLastActivity,shortUrl',
        limit: 1000 }),
    trello(env, '/boards/' + env.TRELLO_BOARD + '/members', { fields: 'fullName,username' }),
  ]);
  const nomeLista = Object.fromEntries(listas.map(l => [l.id, l.name]));
  const nomeMembro = Object.fromEntries(membros.map(m => [m.id, nomeCurto(m.fullName || m.username)]));
  const tarefas = cartoes.map(c => ({
    id: 'tr' + c.id,
    titulo: c.name,
    obs: (c.desc || '').slice(0, 800),
    prazo: c.due ? c.due.slice(0, 10) : '',
    status: c.dueComplete ? 'concluida' : situacaoDaLista(nomeLista[c.idList]),
    lista: nomeLista[c.idList] || '',
    responsavel: (c.idMembers || []).map(id => nomeMembro[id]).filter(Boolean)[0] || '',
    prioridade: prioridadeDosRotulos(c.labels),
    etiquetas: (c.labels || []).map(l => l.name).filter(Boolean),
    atualizado: (c.dateLastActivity || '').slice(0, 10),
    link: c.shortUrl || '',
    origem: 'trello',
  }));
  return { ligado: true, tarefas, listas: listas.map(l => l.name), board: env.TRELLO_BOARD };
}

/* Reuniões: um quadro separado, um cartão por reunião.
   A descrição é a ata; cada item de checklist é um combinado, e item marcado é
   combinado cumprido. */
async function lerReunioesTrello(env) {
  if (!env.TRELLO_KEY || !env.TRELLO_TOKEN || !env.TRELLO_BOARD_REUNIOES) {
    return { ligado: false, motivo: 'TRELLO_BOARD_REUNIOES não configurado' };
  }
  const [listas, cartoes, membros] = await Promise.all([
    trello(env, '/boards/' + env.TRELLO_BOARD_REUNIOES + '/lists', { fields: 'name' }),
    trello(env, '/boards/' + env.TRELLO_BOARD_REUNIOES + '/cards',
      { fields: 'name,desc,due,idList,idMembers,labels,shortUrl', checklists: 'all', limit: 500 }),
    trello(env, '/boards/' + env.TRELLO_BOARD_REUNIOES + '/members', { fields: 'fullName,username' }),
  ]);
  const nomeLista = Object.fromEntries(listas.map(l => [l.id, l.name]));
  const nomeMembro = Object.fromEntries(membros.map(m => [m.id, nomeCurto(m.fullName || m.username)]));
  const reunioes = cartoes.map(c => ({
    id: 'tr' + c.id,
    assunto: c.name,
    ata: (c.desc || '').slice(0, 4000),
    data: c.due ? c.due.slice(0, 10) : '',
    tipo: nomeLista[c.idList] || '',
    pessoas: (c.idMembers || []).map(id => nomeMembro[id]).filter(Boolean),
    etiquetas: (c.labels || []).map(l => l.name).filter(Boolean),
    comp: (c.checklists || []).flatMap(ck => (ck.checkItems || []).map(it => ({
      oque: it.name, feito: it.state === 'complete', quem: '', quando: '' }))),
    link: c.shortUrl || '',
    origem: 'trello',
  })).sort((a, b) => (b.data || '').localeCompare(a.data || ''));
  return { ligado: true, reunioes, listas: listas.map(l => l.name),
    board: env.TRELLO_BOARD_REUNIOES };
}

/* ---------- Google Sheets, via conta de serviço ---------- */
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function tokenGoogle(env) {
  const conta = JSON.parse(env.GOOGLE_SA);           /* json da conta de serviço */
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const corpo = b64url(new TextEncoder().encode(JSON.stringify({
    iss: conta.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: agora + 3600, iat: agora,
  })));
  const pem = conta.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey('pkcs8', bin,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const assin = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave,
    new TextEncoder().encode(cab + '.' + corpo));
  const jwt = cab + '.' + corpo + '.' + b64url(assin);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
  });
  if (!r.ok) throw new Error('Google recusou o token: ' + r.status);
  return (await r.json()).access_token;
}

/* Cabeçalho esperado, em qualquer ordem e sem diferenciar acento:
   data | descricao | valor | tipo | empresa | categoria | vencimento | pago em */
const COLUNAS = {
  data: ['data', 'competencia', 'competência'],
  descricao: ['descricao', 'descrição', 'historico', 'histórico', 'lancamento', 'lançamento'],
  valor: ['valor'],
  tipo: ['tipo', 'entrada/saida', 'e/s'],
  empresa: ['empresa', 'operacao', 'operação', 'unidade'],
  categoria: ['categoria', 'conta', 'plano de contas'],
  vencimento: ['vencimento', 'vence em'],
  pagoEm: ['pago em', 'pagoem', 'pagamento', 'baixa'],
  rateio: ['rateio'],
};
const semAcento = t => (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
function mapaColunas(cabecalho) {
  const m = {};
  cabecalho.forEach((c, i) => {
    const limpo = semAcento(c);
    for (const [campo, nomes] of Object.entries(COLUNAS)) {
      if (nomes.some(n => semAcento(n) === limpo)) m[campo] = i;
    }
  });
  return m;
}
function numeroBR(v) {
  if (typeof v === 'number') return v;
  const t = String(v || '').replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}
function dataBR(v) {
  const t = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return '';
  const ano = m[3].length === 2 ? '20' + m[3] : m[3];
  return ano + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[1]).padStart(2, '0');
}
const OPS = { izi: ['izi', 'izi imoveis', 'imoveis'], paineis: ['paineis', 'bj7 paineis', 'painel'],
  stone: ['stone', 'consultoria', 'bj7 consultoria'], incorp: ['incorporacao', 'incorporadora'],
  casas: ['izi casas', 'casas', 'temporada'], corp: ['corporativo', 'grupo', 'holding'] };
function operacaoDe(v) {
  const t = semAcento(v);
  if (!t) return 'corp';
  for (const [id, nomes] of Object.entries(OPS)) if (nomes.some(n => t.includes(n))) return id;
  return 'corp';
}
function rateioDe(v) {
  /* aceita "izi 60, paineis 40" ou "izi:60;paineis:40" */
  const out = {};
  String(v || '').split(/[,;]/).forEach(p => {
    const m = p.match(/([^\d:%]+)[:\s]+(\d{1,3})/);
    if (m) out[operacaoDe(m[1])] = +m[2];
  });
  return out;
}

/* Uma planilha, uma aba por módulo. O nome da aba é o nome do módulo. */
const ABAS_MODULOS = ['Financeiro', 'Juridico', 'Marketing', 'Documentos', 'Procedimentos'];

async function lerSheets(env) {
  if (!env.GOOGLE_SA || !env.SHEETS_ID) {
    return { ligado: false, motivo: 'GOOGLE_SA e SHEETS_ID não configurados' };
  }
  const token = await tokenGoogle(env);
  const cab = { Authorization: 'Bearer ' + token };
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + env.SHEETS_ID;

  /* quais abas existem de fato */
  const rMeta = await fetch(base + '?fields=sheets.properties.title', { headers: cab });
  if (!rMeta.ok) throw new Error('Sheets devolveu ' + rMeta.status);
  const abas = ((await rMeta.json()).sheets || [])
    .map(x => x.properties.title);
  const querer = ABAS_MODULOS.filter(a =>
    abas.some(b => semAcento(b) === semAcento(a)));
  const nomeReal = a => abas.find(b => semAcento(b) === semAcento(a));

  const modulos = {};
  for (const aba of querer) {
    const u = base + '/values/' + encodeURIComponent("'" + nomeReal(aba) + "'!A:Z")
      + '?valueRenderOption=UNFORMATTED_VALUE';
    const r = await fetch(u, { headers: cab });
    if (!r.ok) continue;
    modulos[semAcento(aba)] = (await r.json()).values || [];
  }

  const linhas = modulos['financeiro'] || [];
  const outros = {};
  Object.entries(modulos).forEach(([k, v]) => { if (k !== 'financeiro') outros[k] = linhasEmObjetos(v); });
  if (!linhas.length) return { ligado: true, lancamentos: [], aviso: 'planilha vazia' };
  const col = mapaColunas(linhas[0]);
  const faltando = ['data', 'descricao', 'valor'].filter(c => col[c] === undefined);
  if (faltando.length) {
    return { ligado: true, lancamentos: [],
      aviso: 'a planilha precisa das colunas ' + faltando.join(', ') };
  }
  const lancamentos = linhas.slice(1).filter(l => l.length).map((l, i) => {
    const val = numeroBR(l[col.valor]);
    const tipoTxt = semAcento(l[col.tipo]);
    const tipo = tipoTxt ? (/(entrada|receita|credito|\+)/.test(tipoTxt) ? 'entrada' : 'saida')
      : (val >= 0 ? 'entrada' : 'saida');
    return {
      id: 'sh' + i,
      descricao: String(l[col.descricao] || ''),
      valor: Math.abs(val),
      tipo,
      competencia: dataBR(l[col.data]),
      vencimento: col.vencimento !== undefined ? dataBR(l[col.vencimento]) : '',
      pagoEm: col.pagoEm !== undefined ? dataBR(l[col.pagoEm]) : '',
      categoria: col.categoria !== undefined ? String(l[col.categoria] || '') : '',
      op: col.empresa !== undefined ? operacaoDe(l[col.empresa]) : 'corp',
      rateio: col.rateio !== undefined ? rateioDe(l[col.rateio]) : {},
      origem: 'sheets',
    };
  }).filter(l => l.descricao || l.valor);
  return { ligado: true, lancamentos, modulos: outros, abas };
}

/* Para os módulos que não são financeiro, o cabeçalho vira campo direto:
   a primeira coluna é o título, e cada coluna com nome de data vira prazo. */
function linhasEmObjetos(linhas) {
  if (!linhas || linhas.length < 2) return [];
  const cab = linhas[0].map(c => String(c || '').trim());
  return linhas.slice(1).filter(l => l.length && String(l[0] || '').trim()).map((l, i) => {
    const o = { id: 'sh' + i, origem: 'sheets' };
    cab.forEach((c, j) => {
      if (!c) return;
      const chave = semAcento(c).replace(/\s+/g, '_');
      const bruto = l[j];
      o[chave] = /(data|prazo|vencimento|revisao|proxima|inicio|fim)/.test(chave)
        ? dataBR(bruto) : (typeof bruto === 'number' ? bruto : String(bruto || ''));
    });
    o.titulo = String(l[0] || '');
    return o;
  });
}

/* ---------- servidor ---------- */

export default {
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(sincronizar(env));
  },

  async fetch(req, env) {
    /* Acesso restrito. Usuário e senha ficam como secret na Cloudflare:
         npx wrangler secret put PANEL_USER
         npx wrangler secret put PANEL_PASSWORD
       Se qualquer um dos dois faltar, o Worker recusa tudo — é melhor ficar
       fora do ar do que servir a base de clientes sem proteção. */
    if (!env.PANEL_USER || !env.PANEL_PASSWORD) {
      return new Response(
        'Painel sem usuário e senha configurados. Grave PANEL_USER e PANEL_PASSWORD ' +
        'como secrets antes de usar.',
        { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    const esperado = 'Basic ' + btoa(env.PANEL_USER + ':' + env.PANEL_PASSWORD);
    const credencial = req.headers.get('Authorization') || '';
    /* comparação de tempo constante: não vaza o tamanho nem o prefixo da senha */
    let iguais = credencial.length === esperado.length;
    for (let i = 0; i < esperado.length; i++) {
      iguais = (credencial.charCodeAt(i) === esperado.charCodeAt(i)) && iguais;
    }
    if (!iguais) {
      return new Response('Acesso restrito', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="Central Comercial BJ7"',
          'cache-control': 'no-store',
        },
      });
    }

    const url = new URL(req.url);

    /* botão Atualizar do painel */
    if (url.pathname === '/atualizar') {
      try {
        const d = await sincronizar(env);
        return Response.json({ ok: true, extracao: d.extracao,
          negocios: d.negocios.length, atividades: d.ativ.length });
      } catch (e) {
        return Response.json({ ok: false, erro: String(e.message || e) }, { status: 500 });
      }
    }

    /* Estado compartilhado: tarefas, contas, reuniões, objetivos, pauta, feedback,
       lançamentos. Fica no servidor, não no navegador — senão cada pessoa vê um
       número diferente e o financeiro do grupo deixa de existir. */
    if (url.pathname === '/estado') {
      if (req.method === 'GET') {
        const bruto = await env.CENTRAL.get(CHAVE_ESTADO);
        return Response.json(bruto ? JSON.parse(bruto) : { rev: 0, dados: {} });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const corpo = await req.json();
        const atualBruto = await env.CENTRAL.get(CHAVE_ESTADO);
        const atual = atualBruto ? JSON.parse(atualBruto) : { rev: 0, dados: {} };
        /* Número de versão: se alguém salvou no meio do caminho, devolvemos o
           estado atual em vez de sobrescrever o trabalho da outra pessoa. */
        if (typeof corpo.rev === 'number' && corpo.rev !== atual.rev) {
          return Response.json({ conflito: true, ...atual }, { status: 409 });
        }
        const novo = { rev: atual.rev + 1, dados: corpo.dados || {},
          por: corpo.por || '', em: new Date().toISOString() };
        await env.CENTRAL.put(CHAVE_ESTADO, JSON.stringify(novo));
        return Response.json({ rev: novo.rev, em: novo.em });
      }
      return new Response('Método não suportado', { status: 405 });
    }

    if (url.pathname === '/saude') {
      const bruto = await env.CENTRAL.get(CHAVE_KV);
      if (!bruto) return Response.json({ ok: false, motivo: 'ainda não sincronizou' }, { status: 503 });
      const d = JSON.parse(bruto);
      return Response.json({ ok: true, sincronizadoEm: d.sincronizadoEm,
        negocios: d.negocios.length, fechados: d.resultado.length, atividades: d.ativ.length });
    }

    /* a página */
    let bruto = await env.CENTRAL.get(CHAVE_KV);
    if (!bruto) bruto = JSON.stringify(await sincronizar(env));

    const html = PAGINA.replace('__DADOS__', bruto);
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow, noarchive',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    });
  },
};
