import PAGINA from './pagina.html';

/* ------------------------------------------------------------------
   Central Comercial — Grupo BJ7
   Lê o Pipedrive, monta o conjunto de dados e guarda no KV.
   O navegador nunca fala com o Pipedrive: a chave vive só aqui.
------------------------------------------------------------------- */

const CHAVE_KV = 'dados:atual';
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

  return {
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
