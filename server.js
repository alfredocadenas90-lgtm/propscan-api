// PropScan CDMX — Backend v4.0
// ML: https nativo | I24 + Lamudi: axios + cheerio
const express = require("express");
const cors    = require("cors");
const https   = require("https");
const http    = require("http");
const axios   = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());

const REMATE_KW = ["remate","adjudicado","adjudicacion","recuperado","banco vende"];

const BROWSER_HDR = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
  "Accept-Language": "es-MX,es;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ── Utilidades ────────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "PropScanCDMX/4.0" } }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error("JSON parse error: " + raw.slice(0, 100))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function slugify(str) {
  const map = { á:"a",é:"e",í:"i",ó:"o",ú:"u",ü:"u",ñ:"n",Á:"a",É:"e",Í:"i",Ó:"o",Ú:"u" };
  return str.toLowerCase()
    .replace(/[áéíóúüñÁÉÍÓÚ]/g, c => map[c] || c)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function safeNum(val) {
  const n = parseFloat(String(val || "").replace(/[^0-9.]/g, ""));
  return isNaN(n) || n <= 0 ? null : n;
}

// ── 1. MercadoLibre (https nativo — garantizado funcionar) ────────────────────
async function scrapeML(zoneList, op, type) {
  const ops      = op === "ambas" ? ["venta","renta"] : [op];
  const typeWord = type === "ambos" ? "propiedad" : type;
  const all      = [];

  for (const zone of zoneList.slice(0, 3)) {
    for (const operation of ops) {
      try {
        const q   = encodeURIComponent(`${typeWord} en ${operation} ${zone} Ciudad de Mexico`);
        const url = `https://api.mercadolibre.com/sites/MLM/search?category=MLM1459&q=${q}&limit=48`;
        console.log("[ML] GET", url);
        const data = await fetchJSON(url);
        const results = data.results || [];
        console.log("[ML]", zone, operation, "->", results.length, "resultados");
        results.forEach(item => all.push(normalizeML(item, operation)));
      } catch (e) {
        console.error("[ML] ERROR", zone, e.message);
      }
    }
  }
  return all;
}

function normalizeML(item, operation) {
  const attrs = item.attributes || [];
  const num = id => {
    const a = attrs.find(x => x.id === id);
    const v = a?.value_struct?.number ?? parseFloat(String(a?.value_name || "").replace(/[^\d.]/g, ""));
    return isNaN(v) ? null : v;
  };
  const m2   = num("TOTAL_AREA") || num("COVERED_AREA");
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

// ── 2. Inmuebles24 (axios + cheerio + __NEXT_DATA__) ─────────────────────────
async function scrapeInmuebles24(zoneList, op, type) {
  const typeMap = { departamento:"departamentos", casa:"casas", ambos:"propiedades" };
  const opMap   = { venta:"en-venta", renta:"en-renta", ambas:"en-venta" };
  const all     = [];

  for (const zone of zoneList.slice(0, 3)) {
    try {
      const zSlug  = slugify(zone);
      const tStr   = typeMap[type]  || "departamentos";
      const opStr  = opMap[op]      || "en-venta";
      const url    = `https://www.inmuebles24.com/${tStr}-${opStr}-en-${zSlug}-ciudad-de-mexico.html`;
      console.log("[I24] GET", url);

      const { data } = await axios.get(url, { headers: BROWSER_HDR, timeout: 15000 });
      const $        = cheerio.load(data);
      const nextRaw  = $("#__NEXT_DATA__").html();

      if (nextRaw) {
        const nd       = JSON.parse(nextRaw);
        const postings =
          nd?.props?.pageProps?.searchResults?.postings ||
          nd?.props?.pageProps?.listings               ||
          nd?.props?.pageProps?.initialState?.listings  ||
          [];
        console.log("[I24]", zone, "NEXT_DATA ->", postings.length);
        postings.forEach(p => all.push(normalizeI24(p, op === "ambas" ? "venta" : op)));
      } else {
        // Fallback HTML
        let count = 0;
        $("[data-posting-id]").each((_, el) => {
          const $e  = $(el);
          const id  = $e.attr("data-posting-id");
          const ttl = $e.find("h2,h3").first().text().trim();
          const prc = parseFloat(($e.find("[class*='price']").first().text().replace(/[^0-9]/g,"")) || "0");
          const href = $e.find("a[href]").first().attr("href") || "";
          if (id && prc > 0) {
            all.push({ id:"i24-"+id, title:ttl, price:prc, currency:"MXN", m2:null, rooms:null, bathrooms:null,
              neighborhood:zone, operation: op==="ambas"?"venta":op,
              url: href.startsWith("http") ? href : "https://www.inmuebles24.com"+href,
              img:null, source:"Inmuebles24", ppm2:null });
            count++;
          }
        });
        console.log("[I24]", zone, "HTML ->", count);
      }
    } catch (e) { console.error("[I24] ERROR", zone, e.message); }
  }
  return all;
}

function normalizeI24(p, operation) {
  const priceObj = p.priceOperationTypes?.[0]?.prices?.[0];
  const price    = priceObj?.amount || p.price?.amount || 0;
  const feats    = p.mainFeatures || {};
  const m2       = safeNum(feats.CFT100 || feats.totalArea || feats.coveredArea);
  const permalink = p.permalink || p.url || "";
  return {
    id:           `i24-${p.postingId || p.id}`,
    title:        p.title || "",
    price,
    currency:     priceObj?.currency || "MXN",
    m2,
    rooms:        safeNum(feats.CFT2 || feats.rooms),
    bathrooms:    safeNum(feats.CFT3 || feats.bathrooms),
    neighborhood: p.location?.label || p.location?.name || "",
    operation,
    url:          permalink.startsWith("http") ? permalink : "https://www.inmuebles24.com"+permalink,
    img:          p.photos?.[0]?.url || null,
    source:       "Inmuebles24",
    ppm2:         m2 && price ? Math.round(price / m2) : null,
  };
}

// ── 3. Lamudi ─────────────────────────────────────────────────────────────────
async function scrapeLamudi(zoneList, op, type) {
  const opStr   = op === "renta" ? "for-rent" : "for-sale";
  const typeStr = type === "casa" ? "house" : "apartment";
  const all     = [];

  for (const zone of zoneList.slice(0, 3)) {
    try {
      const zSlug = slugify(zone);
      const url   = `https://www.lamudi.com.mx/ciudad-de-mexico/${zSlug}/${typeStr}/${opStr}/`;
      console.log("[LAM] GET", url);

      const { data } = await axios.get(url, { headers: BROWSER_HDR, timeout: 15000 });
      const $        = cheerio.load(data);
      const nextRaw  = $("#__NEXT_DATA__").html();

      if (nextRaw) {
        const nd       = JSON.parse(nextRaw);
        const listings =
          nd?.props?.pageProps?.listings                          ||
          nd?.props?.pageProps?.searchResults?.listings           ||
          nd?.props?.pageProps?.data?.listings                    ||
          [];
        console.log("[LAM]", zone, "NEXT_DATA ->", listings.length);
        listings.forEach(l => all.push(normalizeLamudi(l, op === "ambas" ? "venta" : op)));
      } else {
        let count = 0;
        $(".js-listing-link, [class*='ListingCell'], [data-listing-id]").each((_, el) => {
          const $e  = $(el);
          const ttl = $e.find("h2,h3,[class*='title']").first().text().trim();
          const prc = parseFloat(($e.find("[class*='price']").first().text().replace(/[^0-9]/g,"")) || "0");
          const href = $e.find("a").first().attr("href") || "";
          if (ttl && prc > 0) {
            all.push({ id:"lam-"+count, title:ttl, price:prc, currency:"MXN", m2:null, rooms:null, bathrooms:null,
              neighborhood:zone, operation: op==="ambas"?"venta":op,
              url: href.startsWith("http") ? href : "https://www.lamudi.com.mx"+href,
              img:null, source:"Lamudi", ppm2:null });
            count++;
          }
        });
        console.log("[LAM]", zone, "HTML ->", count);
      }
    } catch (e) { console.error("[LAM] ERROR", zone, e.message); }
  }
  return all;
}

function normalizeLamudi(l, operation) {
  const price = l.price?.value || l.price?.amount || l.offerPrice || 0;
  const m2    = safeNum(l.floorSize || l.area || l.lotSize);
  return {
    id:           `lam-${l.id || l.slug || Math.random().toString(36).slice(2)}`,
    title:        l.title || l.name || "",
    price:        typeof price === "string" ? parseFloat(price.replace(/[^0-9.]/g,"")) : price,
    currency:     "MXN",
    m2,
    rooms:        safeNum(l.bedrooms || l.rooms),
    bathrooms:    safeNum(l.bathrooms),
    neighborhood: l.location?.district || l.neighborhood || "",
    operation,
    url:          l.url || l.canonicalUrl || "",
    img:          l.mainImage || l.thumbnail || null,
    source:       "Lamudi",
    ppm2:         m2 && price ? Math.round(price / m2) : null,
  };
}

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({
  status: "PropScan API v4.0",
  sources: ["MercadoLibre","Inmuebles24","Lamudi"],
}));

app.get("/search", async (req, res) => {
  const t0 = Date.now();
  try {
    const { zones="Roma Norte", op="venta", type="departamento",
            minP, maxP, minM2, maxM2, minPPM2, maxPPM2, minR,
            excluirRemates="true" } = req.query;

    const zoneList = zones.split(",").map(z => z.trim()).filter(Boolean);
    console.log("[SEARCH] zones:", zoneList, "op:", op, "type:", type);

    const [mlRes, i24Res, lamRes] = await Promise.allSettled([
      scrapeML(zoneList, op, type),
      scrapeInmuebles24(zoneList, op, type),
      scrapeLamudi(zoneList, op, type),
    ]);

    const mlAll  = mlRes.status  === "fulfilled" ? mlRes.value  : [];
    const i24All = i24Res.status === "fulfilled" ? i24Res.value : [];
    const lamAll = lamRes.status === "fulfilled" ? lamRes.value : [];

    console.log("[SEARCH] raw counts — ML:", mlAll.length, "I24:", i24All.length, "LAM:", lamAll.length);

    const seen = new Set();
    let listings = [...mlAll, ...i24All, ...lamAll].filter(l => {
      if (!l.id || seen.has(l.id) || l.price <= 0) return false;
      seen.add(l.id); return true;
    });

    if (excluirRemates === "true")
      listings = listings.filter(l => !REMATE_KW.some(kw => (l.title||"").toLowerCase().includes(kw)));

    if (minP)    listings = listings.filter(l => l.price     >= +minP);
    if (maxP)    listings = listings.filter(l => l.price     <= +maxP);
    if (minM2)   listings = listings.filter(l => !l.m2 || l.m2 >= +minM2);
    if (maxM2)   listings = listings.filter(l => !l.m2 || l.m2 <= +maxM2);
    if (minPPM2) listings = listings.filter(l => !l.ppm2 || l.ppm2 >= +minPPM2);
    if (maxPPM2) listings = listings.filter(l => !l.ppm2 || l.ppm2 <= +maxPPM2);
    if (minR && +minR > 1) listings = listings.filter(l => !l.rooms || l.rooms >= +minR);

    console.log("[SEARCH] after filters:", listings.length, "| elapsed:", Date.now()-t0, "ms");

    res.json({
      listings,
      total: listings.length,
      sources: { mercadolibre: mlAll.length, inmuebles24: i24All.length, lamudi: lamAll.length },
      elapsed_ms: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[SEARCH] FATAL", e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PropScan API v4.0 en puerto ${PORT}`));
