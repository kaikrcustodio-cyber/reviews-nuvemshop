/*
 * Regina Rios - sincroniza avaliacoes do Lily para JSON estatico (sem dados pessoais).
 * Uso:  node sync-reviews.js --all [--out docs/reviews] [--per-page 10]
 *       node sync-reviews.js --ids 276894708,374364910
 * --all usa a lista de produtos com avaliacao da API do Lily e remove os JSON de produtos que nao tem mais.
 * Saida: <out>/<idNuvemshop>.json e <out>/index.json
 * Sem dependencias (Node 18+).
 */
const fs = require('fs');
const path = require('path');

const STORE = 5985915;
const BASE = 'https://avalie.meuarquivodigital.com';
const API = 'https://api.lily.com.br';
const UA = 'Mozilla/5.0 (compatible; ReginaRiosReviewSync/1.0)';
const DELAY_MS = 400;

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i > -1 ? args[i + 1] : def; };
const all = args.includes('--all');
let ids = (opt('ids', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const outDir = path.resolve(opt('out', 'docs/reviews'));
const perPage = parseInt(opt('per-page', '10'), 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, asText) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: asText ? 'text/html' : 'application/json' } });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return asText ? r.text() : r.json();
}

// produtos da loja que possuem avaliacao (id Nuvemshop)
async function listProductsWithReviews() {
  const j = await get(`${API}/review/product/${STORE}?platform=nuvemshop`);
  if (j.actived === false) throw new Error('Lily desativado (actived=false)');
  return Object.keys(j).filter(k => /^\d+$/.test(k) && j[k] && Number(j[k].count) > 0);
}

async function getBuildId(sampleId) {
  const html = await get(`${BASE}/reviews/${STORE}/${sampleId}/nuvemshop`, true);
  const m = html.match(/"buildId":"([^"]+)"/);
  if (!m) throw new Error('buildId nao encontrado');
  return m[1];
}

// ID interno do Lily para um produto da Nuvemshop (a leitura do _next/data traz dados pessoais: so o id e usado)
async function internalId(buildId, nsId) {
  const j = await get(`${BASE}/_next/data/${buildId}/reviews/${STORE}/${nsId}/nuvemshop.json?store=${STORE}&product_id=${nsId}&platform=nuvemshop`);
  const m = JSON.stringify(j).match(/"product_id":"?(\d+)/);
  return m ? m[1] : null;
}

function shortName(full) {
  const parts = String(full || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!parts.length) return 'Cliente';
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  if (parts.length === 1) return first;
  return first + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
}

// remove e-mails/telefones digitados pelo cliente no proprio texto
function scrub(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[contato removido]')
    .replace(/(\+?\d[\d\s().-]{8,}\d)/g, '[contato removido]')
    .replace(/\s+\n/g, '\n').trim();
}

async function fetchAllReviews(lilyId) {
  const out = [];
  for (let page = 1; ; page++) {
    const j = await get(`${API}/review/pagination/${lilyId}?page=${page}&per_page=${perPage}&order_reviews=recent`);
    const rv = j.reviews || {};
    (rv.data || []).forEach(r => out.push(r));
    if (!rv.meta || page >= rv.meta.last_page || !(rv.data || []).length) break;
    await sleep(DELAY_MS);
  }
  return out;
}

function toPublic(r) {
  return {
    author: shortName(r.client && r.client.name),
    rating: Number(r.rating),
    text: scrub(r.message),
    date: String(r.created_at || '').slice(0, 10),
    verified: !!r.verified
  };
}

(async () => {
  if (all) ids = await listProductsWithReviews();
  if (!ids.length) { console.error('Informe --ids id1,id2 ou --all'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  const buildId = await getBuildId(ids[0]);
  const index = {};
  let errors = 0;
  const failed = new Set();

  for (const nsId of ids) {
    try {
      const lilyId = await internalId(buildId, nsId);
      if (!lilyId) { console.log(nsId, 'sem id interno (sem avaliacoes?)'); continue; }
      const raw = await fetchAllReviews(lilyId);
      const reviews = raw
        .filter(r => r.status === 'approved' && r.active !== 0 && r.active !== false && Number(r.rating) >= 1 && String(r.message || '').trim())
        .map(toPublic);
      const count = reviews.length;
      if (!count) { console.log(nsId, 'sem avaliacoes aprovadas com texto'); continue; }
      const avg = Math.round(reviews.reduce((s, r) => s + r.rating, 0) / count * 10) / 10;

      const file = path.join(outDir, nsId + '.json');
      const body = { productId: nsId, avg, count, reviews };
      let updatedAt = new Date().toISOString().slice(0, 10);
      // mantem a data antiga quando nada mudou, para o Git nao gerar commit a toa
      if (fs.existsSync(file)) {
        try {
          const old = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (JSON.stringify({ productId: old.productId, avg: old.avg, count: old.count, reviews: old.reviews }) === JSON.stringify(body)) updatedAt = old.updatedAt;
        } catch (e) { /* arquivo antigo ilegivel: sera reescrito */ }
      }

      const json = JSON.stringify({ productId: nsId, avg, count, updatedAt, reviews }, null, 2);
      if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(json) || /\b\d{10,13}\b/.test(json)) throw new Error('possivel dado pessoal no resultado - abortado');
      fs.writeFileSync(file, json);
      index[nsId] = { avg, count };
      console.log(nsId, '-> lily', lilyId, '| recebidos', raw.length, '| publicados', count, '| media', avg);
    } catch (e) {
      errors++;
      failed.add(nsId);
      console.error(nsId, 'ERRO', e.message);
    }
    await sleep(DELAY_MS);
  }

  // falha geral (ex.: Lily mudou a API): nao altera nada no repositorio
  if (errors > Math.max(3, ids.length * 0.1)) {
    console.error('Muitos erros (' + errors + '/' + ids.length + '), abortando sem gravar o indice.');
    process.exit(1);
  }

  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));

  if (all) {
    fs.readdirSync(outDir)
      .filter(f => /^\d+\.json$/.test(f) && !index[f.replace('.json', '')] && !failed.has(f.replace('.json', '')))
      .forEach(f => { fs.unlinkSync(path.join(outDir, f)); console.log('removido (sem avaliacoes):', f); });
  }
})();
