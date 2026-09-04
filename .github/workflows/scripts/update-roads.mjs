// Türkiye'deki motorway/trunk/primary/secondary/tertiary yollarını Overpass'tan
// çekip Supabase'deki road_network tablosuna yazar.
//
// NEDEN GITHUB ACTIONS: Cloudflare Workers'ın paylaşılan IP havuzu Overpass
// sunucuları tarafından engelleniyor (test edildi — tüm mirror'lar Workers'tan
// hemen reddediyor/susuyor, aynı sorgu normal bir tarayıcıdan sorunsuz çalışıyor).
// GitHub Actions farklı bir IP aralığından çalıştığı için bu bloğa takılmama
// ihtimali daha yüksek. Eğer bu script de bloklanırsa (ilk çalıştırmada
// Actions loglarına bak), alternatif bir kaynağa (örn. Geofabrik OSM extract)
// geçmemiz gerekir — o zaman haber ver.
//
// Haftada bir çalışacak şekilde ayarlı (bkz. .github/workflows/update-roads.yml)
// çünkü yol ağı sık değişmiyor.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY environment variable eksik.');
  process.exit(1);
}

// residential/unclassified BİLEREK dahil edilmiyor — Türkiye genelinde bu
// sınıflar yüz binlerce way eder, Supabase'i gereksiz şişirir. Sadece
// trafik renklendirmesi için anlamlı olan ana yol sınıfları tutuluyor.
const HIGHWAY_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];

// Türkiye'nin tamamını kapsayan bbox (south,west,north,east — Overpass sırası)
const TURKEY_BBOX = '35.5,25.0,42.5,45.0';

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];

// Tek dev sorgu yerine sınıf başına ayrı sorgu — hem Overpass sunucusuna
// daha nazik davranmış oluyoruz hem de biri hata verirse diğerleri devam edebiliyor.
async function fetchClass(highwayClass) {
  const q = `[out:json][timeout:180];way["highway"="${highwayClass}"](${TURKEY_BBOX});out geom;`;
  let lastErr = null;

  for (const base of OVERPASS_MIRRORS) {
    try {
      console.log(`[${highwayClass}] deneniyor: ${base}`);
      const res = await fetch(base + '?data=' + encodeURIComponent(q), {
        headers: { 'User-Agent': 'HighlyHarita-RoadCache/1.0 (haftalik cron, highly.com.tr)' }
      });
      if (!res.ok) { lastErr = `HTTP ${res.status} @ ${base}`; console.warn(lastErr); continue; }
      const data = await res.json();
      console.log(`[${highwayClass}] ${base} → ${data.elements?.length || 0} way`);
      return data.elements || [];
    } catch (err) {
      lastErr = `${err.message || err} @ ${base}`;
      console.warn(lastErr);
    }
    // Aynı sunucuya art arda çok hızlı istek atmamak için kısa bekleme
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`[${highwayClass}] tüm mirror'lar başarısız: ${lastErr}`);
}

function toRow(element, highwayClass) {
  const geom = element.geometry || [];
  if (geom.length < 2) return null;
  const lats = geom.map(p => p.lat);
  const lons = geom.map(p => p.lon);
  return {
    osm_id: element.id,
    highway_type: highwayClass,
    name: element.tags?.name || null,
    min_lat: Math.min(...lats),
    max_lat: Math.max(...lats),
    min_lon: Math.min(...lons),
    max_lon: Math.max(...lons),
    geometry: geom.map(p => ({ lat: p.lat, lon: p.lon })),
    updated_at: new Date().toISOString()
  };
}

async function upsertBatch(rows) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/road_network?on_conflict=osm_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      console.error('Supabase upsert hatası:', res.status, await res.text());
    } else {
      console.log(`Supabase'e yazıldı: ${chunk.length} satır (${i}-${i + chunk.length})`);
    }
  }
}

async function main() {
  let totalRows = 0;
  for (const highwayClass of HIGHWAY_CLASSES) {
    try {
      const elements = await fetchClass(highwayClass);
      const rows = elements.map(e => toRow(e, highwayClass)).filter(Boolean);
      if (rows.length) {
        await upsertBatch(rows);
        totalRows += rows.length;
      }
    } catch (err) {
      // Bir sınıf tamamen başarısız olsa bile diğerlerine devam et —
      // bir sonraki haftalık çalıştırmada tekrar denenecek.
      console.error(err.message);
    }
    // sınıflar arası da nazik bekleme
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log(`Tamamlandı. Toplam ${totalRows} way yazıldı/güncellendi.`);
}

main().catch(err => {
  console.error('Beklenmeyen hata:', err);
  process.exit(1);
});
        
