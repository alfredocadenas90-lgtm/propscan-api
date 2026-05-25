// PropScan CDMX — Backend Multi-Fuente v3.0
// Fuentes: MercadoLibre API + Inmuebles24 + Lamudi
const express  = require("express");
const cors     = require("cors");
const axios    = require("axios");
const cheerio  = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Constantes ──────────────────────────────────────────────────────────────
const REMATE_KW = ["remate","adjudicado","adjudicacion","recuperado","banco vende"];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-MX,es;q=0.9,en-US;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function slugify(str) {
  const map = { á:"a",é:"e",í:"i",ó:"o",ú:"u",ü:"u",ñ:"n",Á:"a",É:"e",Í:"i",Ó:"o",Ú:"u" };
  return str.toLowerCase()
    .replace(/[áéíóúüñÁÉÍÓÚ]/g, c => map[c] || c)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function parsePrice(str) {
  if (!str) return 0;
  const s = String(str).replace(/[^0-9.]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function safeNum(val) {
  const n = parseFloat(String(val).replace(/[^0-9.]/g,""));
  return isNaN(n) || n <= 0 ? null : n;
}

// ─── 1. MercadoLibre ──────────────────────────────────────────────────────────
async function scrapeML(zoneList, op, type) {
  const ops      = op === "ambas" ? ["venta","renta"] : [op];
  const typeWord = type === "ambos" ? "propiedad" : type;
  const all = [];

  for (const zone of zoneList.slice(0, 3)) {
    for (const operation of ops) {
      try {
        const q = `${typeWord} en ${operation} ${zone} Ciudad de Mexico`;
        const url = `https://api.mercadolibre.com/sites/MLM/search?category=MLM1459&q=${encodeURIComponent(q)}&limit=48`;
        const { data } = await axios.get(url, { timeout: 12000 });
        (data.results || []).forEach(item => all.push(normalizeML(item, operation)));
      } catch (e) { console.error("[ML]", e.message); }
    }
  }
  return all;
}

function normalizeML(item, operation) {
  const attrs = item.attributes || [];
  const num = id => {
    const a = attrs.find(x => x.id === id);
    const v = a?.value_struct?.number ?? parseFloat(String(a?.value_name || "").replace(/[^\d.]/g,""));
    return isNaN(v) ? null : v;
  };
  const m2  = num("TOTAL_AREA") || num("COVERED_AREA");
  const m2ok = m2 && m2 > 10 ? m2 : null;
  return {
    id:           item.id,
    title:        item.title,
    price:        item.price,
    currency:     item.currency_id || "MXN",
    m2:           m2ok,
    rooms:        num("ROOMS"),
    bathrooms:    num("BATHROOMS"),
    neighborhood: item.location?.neighborhood?.name || item.location?.city?.name || "",
    operation,
    url:          item.permalink,
    img:          item.thumbnail?.replace("I.jpg","O.jpg") || null,
    source:       "MercadoLibre",
    ppm2:         m2ok && item.price ? Math.round(item.price / m2ok) : null,
  };
}

// ─── 2. Inmuebles24 ───────────────────────────────────────────────────────────
async function scrapeInmuebles24(zoneList, op, type) {
  const typeMap = { departamento:"departamentos", casa:"casas", ambos:"propiedades" };
  const opMap   = { venta:"en-venta", renta:"en-renta", ambas:"en-venta" };
  const typeStr = typeMap[type] || "departamentos";
  const opStr   = opMap[op]    || "en-venta";
  const all = [];

  for (const zone of zoneList.slice(0, 3)) {
    try {
      const zSlug = slugify(zone);
      const url = `https://www.inmuebles24.com/${typeStr}-${opStr}-en-${zSlug}-ciudad-de-mexico.html`;
      console.log("[I24] Fetching:", url);

      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);

      // Intento 1: extraer __NEXT_DATA__ (Next.js)
      const nextRaw = $("#__NEXT_DATA__").html();
      if (nextRaw) {
        try {
          const nd = JSON.parse(nextRaw);
          const postings =
            nd?.props?.pageProps?.searchResults?.postings ||
            nd?.props?.pageProps?.listings ||
            nd?.props?.pageProps?.results ||
            [];
          if (postings.length) {
            postings.forEach(p => all.push(normalizeI24(p, op === "ambas" ? "venta" : op)));
            console.log(`[I24] ${zone}: ${postings.length} via NEXT_DATA`);
            continue;
          }
        } catch (_) {}
      }

      // Intento 2: HTML clásico
      let count = 0;
      $("[data-posting-id]").each((_, el) => {
        const $e = $(el);
        const id    = $e.attr("data-posting-id");
        const title = $e.find("h2, h3").first().text().trim();
        const priceText = $e.find("[class*='price']").first().text().trim();
        const price = parsePrice(priceText);
        const href  = $e.find("a[href*='/propiedades/']").first().attr("href") || "";
        if (id && price > 0) {
          all.push({
            id: `i24-${id}`, title, price, currency: "MXN",
            m2: null, rooms: null, bathrooms: null,
            neighborhood: zone, operation: op === "ambas" ? "venta" : op,
            url: href.startsWith("http") ? href : `https://www.inmuebles24.com${href}`,
            img: null, source: "Inmuebles24", ppm2: null,
          });
          count++;
        }
      });
      console.log(`[I24] ${zone}: ${count} via HTML`);
    } catch (e) { console.error("[I24]", zone, e.message); }
  }
  return all;
}

function normalizeI24(p, operation) {
  const priceObj = p.priceOperationTypes?.[0]?.prices?.[0];
  const price    = priceObj?.amount || p.price?.amount || 0;
  const currency = priceObj?.currency || "MXN";
  const feats    = p.mainFeatures || {};
  const m2       = safeNum(feats.CFT100 || feats.totalArea || feats.coveredArea);
  const rooms    = safeNum(feats.CFT2   || feats.rooms);
  const baths    = safeNum(feats.CFT3   || feats.bathrooms);
  const img      = p.photos?.[0]?.url || p.mainImage?.url || null;
  const hood     = p.location?.label   || p.location?.name || "";
  const permalink= p.permalink         || p.url            || "";

  return {
    id:           `i24-${p.postingId || p.id}`,
    title:        p.title || "",
    price,
    currency,
    m2,
    rooms,
    bathrooms:    baths,
    neighborhood: hood,
    operation,
    url:          permalink.startsWith("http") ? permalink : `https://www.inmuebles24.com${permalink}`,
    img,
    source:       "Inmuebles24",
    ppm2:         m2 && price ? Math.round(price / m2) : null,
  };
}

// ─── 3. Lamudi ────────────────────────────────────────────────────────────────
async function scrapeLamudi(zoneList, op, type) {
  const opStr   = op === "renta" ? "for-rent" : "for-sale";
  const typeStr = type === "casa" ? "house" : "apartment";
  const all = [];

  for (const zone of zoneList.slice(0, 3)) {
    try {
      const zSlug = slugify(zone);
      // Lamudi URL con colonia
      const url = `https://www.lamudi.com.mx/ciudad-de-mexico/${zSlug}/${typeStr}/${opStr}/`;
      console.log("[LAM] Fetching:", url);

      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);

      // Intento 1: __NEXT_DATA__
      const nextRaw = $("#__NEXT_DATA__").html();
      if (nextRaw) {
        try {
          const nd = JSON.parse(nextRaw);
          const listings =
            nd?.props?.pageProps?.listings ||
            nd?.props?.pageProps?.searchResults?.listings ||
            nd?.props?.pageProps?.data?.listings ||
            [];
          if (listings.length) {
            listings.forEach(l => all.push(normalizeLamudi(l, op === "ambas" ? "venta" : op)));
            console.log(`[LAM] ${zone}: ${listings.length} via NEXT_DATA`);
            continue;
          }
        } catch (_) {}
      }

      // Intento 2: HTML
      let count = 0;
      $(".js-listing-link, [class*='ListingCell'], [data-listing-id]").each((_, el) => {
        const $e = $(el);
        const title = $e.find("h2, h3, [class*='title']").first().text().trim();
        const priceText = $e.find("[class*='price']").first().text().trim();
        const price = parsePrice(priceText);
        const href  = $e.find("a").first().attr("href") || "";
        if (title && price > 0) {
          all.push({
            id: `lam-html-${count}`, title, price, currency: "MXN",
            m2: null, rooms: null, bathrooms: null,
            neighborhood: zone, operation: op === "ambas" ? "venta" : op,
            url: href.startsWith("http") ? href : `https://www.lamudi.com.mx${href}`,
            img: null, source: "Lamudi", ppm2: null,
          });
          count++;
        }
      });
      console.log(`[LAM] ${zone}: ${count} via HTML`);
    } catch (e) { console.error("[LAM]", zone, e.message); }
  }
  return all;
}

function normalizeLamudi(l, operation) {
  const price = l.price?.value || l.price?.amount || l.offerPrice || 0;
  const m2    = safeNum(l.floorSize || l.area || l.lotSize);
  return {
    id:           `lam-${l.id || l.slug || Math.random().toString(36).slice(2)}`,
    title:        l.title || l.name || "",
    price:        typeof price === "string" ? parsePrice(price) : price,
    currency:     l.price?.currency || "MXN",
    m2,
    rooms:        safeNum(l.bedrooms || l.rooms),
    bathrooms:    safeNum(l.bathrooms),
    neighborhood: l.location?.district || l.neighborhood || "",
    operation,
    url:          l.url || l.canonicalUrl || l.slug || "",
    img:          l.mainImage || l.thumbnail || l.photos?.[0] || null,
    source:       "Lamudi",
    ppm2:         m2 && price ? Math.round(price / m2) : null,
  };
}

// ─── Endpoints ────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({
  status: "PropScan API ✅",
  version: "3.0",
  sources: ["MercadoLibre","Inmuebles24","Lamudi"],
}));

app.get("/search", async (req, res) => {
  try {
    const {
      zones = "Roma Norte", op = "venta", type = "departamento",
      minP, maxP, minM2, maxM2, minPPM2, maxPPM2,
      minR, excluirRemates = "true",
    } = req.query;

    const zoneList = zones.split(",").map(z => z.trim()).filter(Boolean);

    // Ejecutar las 3 fuentes en paralelo
    const [mlRes, i24Res, lamRes] = await Promise.allSettled([
      scrapeML(zoneList, op, type),
      scrapeInmuebles24(zoneList, op, type),
      scrapeLamudi(zoneList, op, type),
    ]);

    const extract = r => r.status === "fulfilled" ? r.value : [];
    const mlAll   = extract(mlRes);
    const i24All  = extract(i24Res);
    const lamAll  = extract(lamRes);

    // Unir y deduplicar
    const seen = new Set();
    let listings = [...mlAll, ...i24All, ...lamAll].filter(l => {
      if (!l.id || seen.has(l.id) || l.price <= 0) return false;
      seen.add(l.id);
      return true;
    });

    // Excluir remates
    if (excluirRemates === "true") {
      listings = listings.filter(l =>
        !REMATE_KW.some(kw => (l.title || "").toLowerCase().includes(kw))
      );
    }

    // Filtros numéricos
    if (minP)    listings = listings.filter(l => l.price     >= +minP);
    if (maxP)    listings = listings.filter(l => l.price     <= +maxP);
    if (minM2)   listings = listings.filter(l => l.m2  && l.m2  >= +minM2);
    if (maxM2)   listings = listings.filter(l => l.m2  && l.m2  <= +maxM2);
    if (minPPM2) listings = listings.filter(l => l.ppm2 && l.ppm2 >= +minPPM2);
    if (maxPPM2) listings = listings.filter(l => l.ppm2 && l.ppm2 <= +maxPPM2);
    if (minR && +minR > 1) listings = listings.filter(l => !l.rooms || l.rooms >= +minR);

    res.json({
      listings,
      total: listings.length,
      sources: {
        mercadolibre: mlAll.length,
        inmuebles24:  i24All.length,
        lamudi:       lamAll.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PropScan API v3.0 corriendo en puerto ${PORT}`));
