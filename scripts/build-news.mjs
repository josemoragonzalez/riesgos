// Builds data/news.json from the public data each Hugging Face Space publishes.
// Runs daily from .github/workflows/news.yml. Node 20+, no dependencies.
//
// If one source fails, its previous items are kept so the feed never goes empty.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../data/news.json', import.meta.url);
const SITES = {
  municipal:   'https://datajose-radar-municipal.static.hf.space',
  obras:       'https://datajose-radar-de-obras.static.hf.space',
  presupuesto: 'https://datajose-alertas-ejecucion-presupuestaria.static.hf.space',
  conflictos:  'https://datajose-conflictos.static.hf.space',
};
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const get = async (url, as = 'text') => {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return as === 'json' ? r.json() : r.text();
};

// The Spaces ship some data as `window.X = {...};` scripts: evaluate them in a sandboxed object.
const fromScript = (src) => {
  const window = {};
  new Function('window', src)(window);
  return window;
};

const clip = (s, n = 230) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return s.slice(0, s.lastIndexOf(' ', n)).replace(/[,;:.\s…]+$/, '') + '…';
};
const day = (s) => String(s ?? '').slice(0, 10);

// RFC 4180 CSV → array of objects
const parseCSV = (text) => {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

// Alerts about private individuals stay inside each app, with their context; the public feed skips them.
const NATURAL = /persona natural|apellidos/i;

// Keep one item per place so the feed is not dominated by a single comuna.
const distinctBy = (arr, key, n) => {
  const seen = new Set(), out = [];
  for (const x of arr) { const k = key(x); if (seen.has(k)) continue; seen.add(k); out.push(x); if (out.length === n) break; }
  return out;
};

/* ---------------- Radar Municipal ---------------- */
async function municipal() {
  const base = SITES.municipal, items = [];

  // Press coverage of documented cases
  const casos = parseCSV(await get(`${base}/data/casos_publicos.csv`)).map(c => {
    const f1 = c.fuente_1_fecha || '', f2 = c.fuente_2_fecha || '';
    const latest = f2 > f1 ? 2 : 1;
    return { ...c, fecha: latest === 2 ? f2 : f1, titular: c[`fuente_${latest}_titulo`] || c.fuente_1_titulo };
  }).filter(c => c.fecha && c.titular && c.cut);
  casos.sort((a, b) => b.fecha.localeCompare(a.fecha));
  for (const c of distinctBy(casos, c => c.cut, 3)) {
    items.push({
      app: 'municipal', kind: 'prensa', date: day(c.fecha), place: c.comuna,
      title: clip(c.titular, 120), summary: clip(c.descripcion_breve),
      note: clip(c.estado_procesal, 90), url: `${base}/#/comuna/${c.cut}`,
    });
  }

  // Newest high-severity alerts
  const { ALERTAS = [] } = fromScript(await get(`${base}/data/alertas_top.js`));
  const altas = ALERTAS.filter(a => a.severidad >= 3 && a.fecha && !NATURAL.test(`${a.titulo} ${a.detalle}`)).sort((a, b) => b.fecha.localeCompare(a.fecha));
  for (const a of distinctBy(altas, a => a.cut, 3)) {
    items.push({
      app: 'municipal', kind: 'alerta', date: day(a.fecha), place: a.comuna, severity: a.severidad,
      title: clip(a.titulo, 120), summary: clip(a.detalle), note: clip(a.fuente, 90), url: `${base}/#/comuna/${a.cut}`,
    });
  }
  return items;
}

/* ---------------- Radar de Obras ---------------- */
async function obras() {
  const base = SITES.obras;
  const [meta, alertas, comunas] = await Promise.all([
    get(`${base}/data/meta.json`, 'json'),
    get(`${base}/data/alertas.json`, 'json'),
    get(`${base}/data/comunas.json`, 'json'),
  ]);
  const nombre = Object.fromEntries(comunas.features.map(f => [f.properties.cut, f.properties.n]));
  const titulo = Object.fromEntries(meta.catalogo.map(c => [c.codigo, c.titulo]));
  const col = Object.fromEntries(alertas.cols.map((c, i) => [c, i]));
  const rows = alertas.rows
    .map(r => ({ cut: r[col.cut], codigo: r[col.codigo], sev: r[col.sev], fecha: r[col.fecha], texto: r[col.texto] }))
    .filter(a => a.sev >= 3 && a.fecha && !NATURAL.test(a.texto))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
  return distinctBy(rows, a => a.cut, 4).map(a => ({
    app: 'obras', kind: 'alerta', date: day(a.fecha), place: nombre[a.cut] || '', severity: a.sev,
    title: clip(titulo[a.codigo] || 'Alerta en obra municipal', 120), summary: clip(a.texto),
    note: `Datos al ${meta.fecha_datos}`, url: `${base}/#c${a.cut}`,
  }));
}

/* ---------------- Alertas presupuestarias ---------------- */
async function presupuesto() {
  const base = SITES.presupuesto;
  const { EP_META: meta } = fromScript(await get(`${base}/data/meta.js`));
  const { anio, mes, publicado } = meta.ultimo;
  const { EP_ANALISIS } = fromScript(await get(`${base}/data/analisis_${anio}.js`));
  const an = EP_ANALISIS[String(anio)];
  const items = [{
    app: 'presupuesto', kind: 'datos', date: day(publicado),
    title: `DIPRES publicó la ejecución presupuestaria a ${MESES[mes - 1]} de ${anio}`,
    summary: `El centro de alertas se actualizó con los datos oficiales de ${MESES[mes - 1]}: ejecución por ministerio, servicio y programa, y las alertas recalculadas.`,
    note: meta.fuente, url: `${base}/#/${anio}`,
  }];
  // Plain-language findings: "**Title.** body with [[term|label]] links"
  for (const r of (an.resumen || []).slice(0, 3)) {
    const m = r.match(/^\*\*(.+?)\*\*\s*(.*)$/s);
    const strip = s => s.replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\*\*/g, '');
    items.push({
      app: 'presupuesto', kind: 'hallazgo', date: day(an.generado),
      title: strip(m ? m[1] : r).replace(/\.$/, ''), summary: clip(strip(m ? m[2] : '')),
      note: `Análisis con datos a ${MESES[mes - 1]} de ${anio}`, url: `${base}/#/${anio}`,
    });
  }
  return items;
}

/* ---------------- Conflictos ---------------- */
// Individual cases name officials and their relatives, so the feed only uses the aggregate summary.
const DATASET = 'https://huggingface.co/datasets/datajose/conflictos-datos/resolve/main';
const num = (n) => Math.round(n).toLocaleString('es-CL');
const plata = (n) => n >= 1e12 ? `$${(n / 1e12).toLocaleString('es-CL', { maximumFractionDigits: 1 })} billones`
  : n >= 1e9 ? `$${num(n / 1e9)} mil millones` : `$${num(n / 1e6)} millones`;

async function conflictos() {
  const base = SITES.conflictos;
  const r = await get(`${DATASET}/resumen.json`, 'json');
  const date = day(r.corte), rel = r.relevantes;
  const items = [{
    app: 'conflictos', kind: 'datos', date,
    title: `${num(rel.casos)} casos para revisar: organismos que le compran a sus propios funcionarios`,
    summary: `En ${num(rel.organismos)} organismos hay compras por ${plata(rel.monto)} a sus funcionarios, a sus familias o a empresas ligadas a ellos, hechas mientras estaban en el cargo. Son casos para revisar, no infracciones probadas.`,
    note: `Cruce de ${num(r.cobertura.funcionarios)} funcionarios y ${num(r.cobertura.proveedores)} proveedores`, url: `${base}/#/casos`,
  }];
  const cats = r.categorias.filter(c => c.relevante).sort((a, b) => b.casos - a.casos).slice(0, 2);
  for (const c of cats) {
    items.push({
      app: 'conflictos', kind: 'hallazgo', date,
      title: `${c.titulo}: ${num(c.casos)} casos en ${num(c.organismos)} organismos`,
      summary: clip(c.descripcion), note: `Monto involucrado: ${plata(c.monto)}`, url: `${base}/#/casos`,
    });
  }
  return items;
}

/* ---------------- main ---------------- */
let previous = { items: [] };
try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch {}

const sources = { conflictos, municipal, obras, presupuesto };
const items = [], status = {};
for (const [app, fn] of Object.entries(sources)) {
  try {
    const got = await fn();
    items.push(...got); status[app] = `ok (${got.length})`;
  } catch (e) {
    const kept = previous.items.filter(i => i.app === app);
    items.push(...kept); status[app] = `error: ${e.message}; kept ${kept.length}`;
  }
}
// Newest first, but interleave the sites so no single one takes over the top of the feed.
const groups = Object.values(Object.groupBy(items, i => i.app)).map(g => g.sort((a, b) => b.date.localeCompare(a.date)));
groups.sort((a, b) => b[0].date.localeCompare(a[0].date));
const feed = [];
for (let k = 0; groups.some(g => g[k]); k++) for (const g of groups) if (g[k]) feed.push(g[k]);

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), sites: SITES, items: feed }, null, 1) + '\n');
console.log(status);
