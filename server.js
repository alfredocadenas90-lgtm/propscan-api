const express = require("express");
const cors    = require("cors");
const https   = require("https");
 
const app = express();
app.use(cors());
app.use(express.json());
 
// Palabras que indican remate bancario — se excluyen siempre
const REMATE_KEYWORDS = ["remate", "adjudicado", "adjudicacion", "recuperado", "banco vende", "hsbc vende", "bbva vende", "banamex vende"];
 
app.get("/", (_, res) => res.json({ status: "PropScan API ✅", version: "2.0" }));
 
app.get("/search", async (req, res) => {
  try {
    const {
      zones = "Roma Norte", op = "venta", type = "departamento",
      minP, maxP,           // precio total
      minM2, maxM2,         // superficie m²
      minPPM2, maxPPM2,     // precio por m²
      minR,                 // recámaras
      excluirRemates = "true"
    } = req.query;
 
    const zoneList  = zones.split(",").map(z => z.trim()).filter(Boolean).slice(0, 3);
    const ops       = op === "ambas" ? ["venta","renta"] : [op];
    const typeWords = type === "ambos" ? ["departamento","casa"] : [type];
    const all = [];
 
    for (const zone of zoneList) {
      for (const operation of ops) {
        for (const typeWord of typeWords) {
          const q   = `${typeWord} en ${operation} ${zone} Ciudad de Mexico`;
          const url = `https://api.mercadolibre.com/sites/MLM/search?category=MLM1459&q=${encodeURIComponent(q)}&limit=48`;
          try {
            const data = await fetchJSON(url);
            (data.results || []).forEach(item => all.push(normalizeML(item, operation)));
          } catch (e) { console.error(`[ML] error:`, e.message); }
        }
      }
    }
 
    // Deduplicar
    const seen = new Set();
    let listings = all.filter(l => { if (seen.has(l.id)) return false; seen.add(l.id); return true; });
 
    // Excluir remates bancarios
    if (excluirRemates === "true") {
      listings = listings.filter(l => {
        const titleLow = (l.title || "").toLowerCase();
        return !REMATE_KEYWORDS.some(kw => titleLow.includes(kw));
      });
    }
 
    // Filtros numéricos
    if (minP)    listings = listings.filter(l => l.price  >= Number(minP));
    if (maxP)    listings = listings.filter(l => l.price  <= Number(maxP));
    if (minM2)   listings = listings.filter(l => l.m2 && l.m2   >= Number(minM2));
    if (maxM2)   listings = listings.filter(l => l.m2 && l.m2   <= Number(maxM2));
    if (minPPM2) listings = listings.filter(l => l.ppm2 && l.ppm2 >= Number(minPPM2));
    if (maxPPM2) listings = listings.filter(l => l.ppm2 && l.ppm2 <= Number(maxPPM2));
    if (minR && Number(minR) > 1) listings = listings.filter(l => !l.rooms || l.rooms >= Number(minR));
 
    res.json({ listings, total: listings.length, zones: zoneList, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
 
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "PropScanCDMX/2.0" } }, r => {
      let raw = "";
      r.on("data", c => raw += c);
      r.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}
 
function normalizeML(item, operation) {
  const attrs = item.attributes || [];
  const num = id => {
    const a = attrs.find(x => x.id === id);
    const v = a?.value_struct?.number ?? parseFloat(String(a?.value_name || "").replace(/[^\d.]/g, ""));
    return isNaN(v) ? null : v;
  };
  const m2    = num("TOTAL_AREA") || num("COVERED_AREA");
  const rooms = num("ROOMS");
  const price = item.price;
  const m2ok  = m2 && m2 > 10 ? m2 : null;
  return {
    id:           item.id,
    title:        item.title,
    price,
    currency:     item.currency_id || "MXN",
    m2:           m2ok,
    rooms:        rooms && rooms < 20 ? rooms : null,
    bathrooms:    num("BATHROOMS"),
    neighborhood: item.location?.neighborhood?.name || item.location?.city?.name || "",
    operation,
    url:          item.permalink,
    img:          item.thumbnail?.replace("I.jpg","O.jpg") || null,
    source:       "MercadoLibre",
    ppm2:         m2ok && price ? Math.round(price / m2ok) : null,
  };
}
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PropScan API v2.0 corriendo en puerto ${PORT}`));
 
