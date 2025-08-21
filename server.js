const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const axios = require('axios');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

// 서버리스 환경 지연을 줄이기 위한 기본 타임아웃 설정
const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 8000);
axios.defaults.timeout = AXIOS_TIMEOUT_MS;

const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY || '';
// 카카오모빌리티 내비 Directions API 키(없으면 KAKAO_REST_KEY 사용 시도)
const KAKAO_MOBILITY_REST_KEY = process.env.KAKAO_MOBILITY_REST_KEY || KAKAO_REST_KEY || '';
const TMAP_APP_KEY = process.env.TMAP_APP_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

if (!KAKAO_REST_KEY || !TMAP_APP_KEY) {
  console.warn('환경변수 KAKAO_REST_KEY, TMAP_APP_KEY 를 .env 에 설정하세요.');
}
if (!KAKAO_MOBILITY_REST_KEY) {
  console.warn('환경변수 KAKAO_MOBILITY_REST_KEY 가 없으면 Kakao Directions 호출이 실패할 수 있습니다.');
}
if (!GEMINI_API_KEY) {
  console.warn('환경변수 GEMINI_API_KEY 가 없으면 주소 전처리를 건너뜁니다.');
}

async function normalizeAddressWithGemini(rawText) {
  if (!GEMINI_API_KEY) return rawText;
  const input = String(rawText || '').trim();
  if (!input) return input;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = [
      '다음 입력을 한국 지도 API 지오코딩이 이해하기 좋은 형태로 정규화하세요.',
      '지침:',
      '- 불필요한 설명/따옴표/코드블록 없이 한 줄만 출력',
      '- 도로명 주소가 있으면 도로명으로, 없으면 지번/명칭 유지',
      '- 역/관광지 등 POI는 일반적으로 많이 쓰는 명칭으로 간결하게',
      `입력: ${input}`
    ].join('\n');
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const res = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' } });
    const candidates = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const text = String(candidates).replace(/^```[\s\S]*?\n|```$/g, '').replace(/^"|"$/g, '').trim();
    return text || input;
  } catch (_) {
    return input;
  }
}

// 주소 유형 분석 + 정규화
async function analyzeAddressWithGemini(rawText) {
  if (!GEMINI_API_KEY) return { normalized: rawText, type: null };
  const input = String(rawText || '').trim();
  if (!input) return { normalized: input, type: null };
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = [
      '다음 문자열의 주소 유형을 판별하고 지도 API 지오코딩에 적합한 형태로 정규화하세요.',
      '반드시 아래 JSON 형식으로만 출력하세요.',
      '{"type":"도로명|지번|구주소|POI","normalized":"정규화된 한 줄 주소 또는 명칭"}',
      '규칙:',
      '- 상세동/호수/층/동호수 등은 제거',
      '- 도로명/지번이 모두 있는 경우 도로명 우선',
      '- POI(역/건물/학교 등)는 일반적으로 통용되는 명칭으로 간결하게',
      '입력:',
      input
    ].join('\n');
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const res = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' } });
    const text = String(res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return {
        normalized: String(parsed.normalized || input).trim(),
        type: parsed.type || null
      };
    }
    return { normalized: input, type: null };
  } catch (_) {
    return { normalized: input, type: null };
  }
}

// 전처리 후 불필요한 아파트/건물명/부가설명 제거 및 핵심 패턴만 남기기
function stripApartmentAndExtras(text) {
  if (!text) return text;
  let s = String(text)
    .replace(/\([^)]*\)/g, ' ') // 괄호 안 제거
    .replace(/\s+/g, ' ')
    .trim();
  // 아파트/건물/단지 등 토큰 이후 잘라내기
  const tokens = ['아파트', '오피스텔', '빌딩', '빌라', '단지', '프라자', '타워', '시티', '상가', '주공', '자이', '힐스테이트', '래미안', 'e편한세상', '롯데캐슬'];
  for (const t of tokens) {
    const idx = s.indexOf(` ${t}`);
    if (idx > -1) {
      s = s.slice(0, idx).trim();
      break;
    }
  }
  // 동/호/층 제거 (예: 109동 1202호 3층)
  s = s
    .replace(/\b\d+\s*동\b/g, '')
    .replace(/\b\d+\s*호\b/g, '')
    .replace(/\b\d+\s*층\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function extractRoadAddress(text) {
  if (!text) return text;
  const s = stripApartmentAndExtras(text);
  // 도로명 + 건물번호 패턴 추출
  const m = s.match(/(.+?(?:로|길|대로|거리|가)\s*\d+(?:-\d+)?)/);
  return m ? m[1].trim() : s;
}

function extractJibunAddress(text) {
  if (!text) return text;
  const s = stripApartmentAndExtras(text);
  // 지번(동/리/가 + (산)?번지) 패턴 추출
  const m = s.match(/(.+?(?:동|리|가)\s*(?:산\s*)?\d+(?:-\d+)?)/);
  return m ? m[1].trim() : s;
}

// 도로명 우선, 실패 시 지번(구주소)로 정규화 리스트 생성
async function normalizePriorityListWithGemini(rawText) {
  if (!GEMINI_API_KEY) return { list: [rawText].filter(Boolean), primary: rawText, primaryType: null };
  const input = String(rawText || '').trim();
  if (!input) return { list: [], primary: '', primaryType: null };
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = [
      '아래 문자열을 지도 API용 주소로 전처리하세요.',
      '반드시 다음 JSON만 출력합니다(설명/코드블록 금지):',
      '{"road":"도로명 주소(없으면 빈문자열)","jibun":"지번 주소(없으면 빈문자열)"}',
      '규칙:',
      '1) 도로명 주소를 최우선으로 추출합니다. 도로명 + 건물번호만 남기고 아파트/건물명/상세(동/호/층/호수/단지/상가 등) 제거',
      '2) 도로명 주소가 불가하면 지번 주소를 추출합니다. (동/리/가 + (산)번지 형태)',
      '3) 공백은 한 칸으로 정규화, 행정구역은 유지',
      '입력:',
      input
    ].join('\n');
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const res = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' } });
    const text = String(res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    let road = '', jibun = '';
    try {
      const obj = JSON.parse(text);
      road = extractRoadAddress(String(obj.road || '').trim());
      jibun = extractJibunAddress(String(obj.jibun || '').trim());
    } catch (_) {
      // 실패 시 기존 분석기로 보정
      const analyzed = await analyzeAddressWithGemini(input);
      road = analyzed.type === '도로명' ? extractRoadAddress(analyzed.normalized) : '';
      jibun = analyzed.type && analyzed.type.includes('지번') ? extractJibunAddress(analyzed.normalized) : '';
    }
    // 로컬 정규식으로도 한 번 더 보정하여 후보 추가
    const localRoad = extractRoadAddress(input);
    const localJibun = extractJibunAddress(input);
    const seen = new Set();
    const list = [];
    const pushUnique = (s) => { if (s && !seen.has(s)) { seen.add(s); list.push(s); } };
    pushUnique(road);
    pushUnique(localRoad);
    pushUnique(jibun);
    pushUnique(localJibun);
    if (list.length === 0) pushUnique(stripApartmentAndExtras(input));
    return { list, primary: list[0], primaryType: list[0] === road || list[0] === localRoad ? '도로명' : '지번' };
  } catch (_) {
    return { list: [input], primary: input, primaryType: null };
  }
}

// Gemini로 주소 후보를 몇 개 생성 (도로명/지번/POI 단순화). JSON 배열 문자열만 반환하도록 강제
async function generateAddressCandidatesWithGemini(rawText) {
  if (!GEMINI_API_KEY) return [];
  const input = String(rawText || '').trim();
  if (!input) return [];
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = [
      '다음 입력을 지도 API 지오코딩 성공 확률을 높이기 위한 후보 주소 목록으로 변환하세요.',
      '규칙:',
      '1) JSON 배열 형식만 출력 (문자 설명 금지)',
      '2) 도로명/지번/POI를 간결하게 정규화',
      '3) 불필요한 동/호수/블록/상세호수는 제거',
      '4) 가능한 경우 행정구역 + 도로명 + 번지 형태 제공',
      '입력:',
      input
    ].join('\n');
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const res = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' } });
    const text = String(res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    // JSON 파싱 시도
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        return arr
          .map((s) => String(s || '').trim())
          .filter((s) => s.length > 0)
          .slice(0, 5);
      }
    } catch (_) {}
    return [];
  } catch (_) {
    return [];
  }
}

async function robustGeocodeWithKakao(raw, preferredList) {
  // 1차: 원문 → 2차: normalize → 3차: 후보들 순회
  // 우선순위 리스트가 제공되면 그 순서대로 시도
  if (Array.isArray(preferredList) && preferredList.length > 0) {
    for (const cand of preferredList) {
      const r = await geocodeWithKakao(cand);
      if (r) return { ...r, used: cand };
    }
  }
  // 없으면 원문부터 시도
  const first = await geocodeWithKakao(raw);
  if (first) return { ...first, used: raw };
  // Gemini 우선순위 리스트 생성 후 재시도
  const prio = await normalizePriorityListWithGemini(raw);
  for (const cand of prio.list) {
    const r = await geocodeWithKakao(cand);
    if (r) return { ...r, used: cand };
  }
  const normalized = await normalizeAddressWithGemini(raw);
  if (normalized && normalized !== raw) {
    const second = await geocodeWithKakao(normalized);
    if (second) return { ...second, used: normalized };
  }
  const candidates = await generateAddressCandidatesWithGemini(raw);
  for (const cand of candidates) {
    const r = await geocodeWithKakao(cand);
    if (r) return { ...r, used: cand };
  }
  return null;
}

async function robustGeocodeWithTmap(raw, preferredList) {
  if (Array.isArray(preferredList) && preferredList.length > 0) {
    for (const cand of preferredList) {
      const r = await geocodeWithTmap(cand);
      if (r) return { ...r, used: cand };
    }
  }
  const first = await geocodeWithTmap(raw);
  if (first) return { ...first, used: raw };
  const prio = await normalizePriorityListWithGemini(raw);
  for (const cand of prio.list) {
    const r = await geocodeWithTmap(cand);
    if (r) return { ...r, used: cand };
  }
  const normalized = await normalizeAddressWithGemini(raw);
  if (normalized && normalized !== raw) {
    const second = await geocodeWithTmap(normalized);
    if (second) return { ...second, used: normalized };
  }
  const candidates = await generateAddressCandidatesWithGemini(raw);
  for (const cand of candidates) {
    const r = await geocodeWithTmap(cand);
    if (r) return { ...r, used: cand };
  }
  return null;
}

async function geocodeWithKakao(addressOrKeyword) {
  // 1) 주소 지오코딩
  try {
    const url = 'https://dapi.kakao.com/v2/local/search/address.json';
    const res = await axios.get(url, {
      params: { query: addressOrKeyword },
      headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` }
    });
    const doc = res.data.documents?.[0];
    if (doc) {
      return { lon: Number(doc.x), lat: Number(doc.y) };
    }
  } catch (_) {}
  // 2) 키워드(POI) 검색 fallback
  try {
    const url = 'https://dapi.kakao.com/v2/local/search/keyword.json';
    const res = await axios.get(url, {
      params: { query: addressOrKeyword },
      headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` }
    });
    const doc = res.data.documents?.[0];
    if (!doc) return null;
    return { lon: Number(doc.x), lat: Number(doc.y) };
  } catch (_) {
    return null;
  }
}

async function geocodeWithTmap(addressOrKeyword) {
  // 1) 주소 지오코딩
  try {
    const url = 'https://apis.openapi.sk.com/tmap/geo/fullAddrGeo';
    const res = await axios.get(url, {
      params: {
        version: 1,
        format: 'json',
        appKey: TMAP_APP_KEY,
        coordType: 'WGS84GEO',
        fullAddr: addressOrKeyword
      }
    });
    const items = res.data?.coordinateInfo?.coordinate;
    if (items && items.length > 0) {
      const item = items[0];
      let addrCoord = null;
      // lon/lat(WGS84)가 없고 noor*(TM, EPSG:5179)만 있는 경우 변환 API 사용
      if (item.lon != null && item.lat != null) {
        const lon = Number(item.lon);
        const lat = Number(item.lat);
        if (!Number.isNaN(lon) && !Number.isNaN(lat)) addrCoord = { lon, lat };
      }
      if (!addrCoord && item.noorLon != null && item.noorLat != null) {
        const conv = await tmapConvertToWgs84(Number(item.noorLon), Number(item.noorLat), 'EPSG5179');
        if (conv) addrCoord = conv;
      }
      // 동일 문자열로 POI를 조회해 front 좌표가 근처에 있으면 front 좌표 우선 사용
      try {
        const poiFront = await tmapPoiFrontCoord(addressOrKeyword);
        if (poiFront && addrCoord) {
          const gap = haversineMeters(addrCoord.lat, addrCoord.lon, poiFront.lat, poiFront.lon);
          if (gap <= 500) return poiFront; // 500m 이내면 front 진입 좌표 우선
        }
      } catch (_) {}
      if (addrCoord) return addrCoord;
    }
  } catch (_) {}
  // 2) 키워드(POI) 검색 fallback
  try {
    const url = 'https://apis.openapi.sk.com/tmap/pois';
    const res = await axios.get(url, {
      params: {
        version: 1,
        format: 'json',
        count: 1,
        searchKeyword: addressOrKeyword,
        appKey: TMAP_APP_KEY
      }
    });
    const poi = res.data?.searchPoiInfo?.pois?.poi?.[0];
    if (!poi) return null;
    // POI는 도로 진입 좌표(frontLon/Lat)를 우선 사용 → 라우팅 일치도 향상
    if (poi.frontLon != null && poi.frontLat != null) {
      const lon = Number(poi.frontLon);
      const lat = Number(poi.frontLat);
      if (!Number.isNaN(lon) && !Number.isNaN(lat)) return { lon, lat };
    }
    if (poi.lon != null && poi.lat != null) {
      const lon = Number(poi.lon);
      const lat = Number(poi.lat);
      if (!Number.isNaN(lon) && !Number.isNaN(lat)) return { lon, lat };
    }
    if (poi.noorLon != null && poi.noorLat != null) {
      const conv = await tmapConvertToWgs84(Number(poi.noorLon), Number(poi.noorLat), 'EPSG5179');
      if (conv) return conv;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Tmap 좌표계(TM/기타) → WGS84GEO로 변환
async function tmapConvertToWgs84(x, y, sourceCoord = 'EPSG5179') {
  try {
    const url = 'https://apis.openapi.sk.com/tmap/geo/transcoord';
    const res = await axios.get(url, {
      params: {
        version: 1,
        format: 'json',
        appKey: TMAP_APP_KEY,
        coordType: sourceCoord,
        toCoordType: 'WGS84GEO',
        x: String(x),
        y: String(y)
      }
    });
    const lon = Number(res.data?.coordinate?.lon);
    const lat = Number(res.data?.coordinate?.lat);
    if (!Number.isNaN(lon) && !Number.isNaN(lat)) return { lon, lat };
    return null;
  } catch (_) {
    return null;
  }
}

async function tmapPoiFrontCoord(keyword) {
  try {
    const url = 'https://apis.openapi.sk.com/tmap/pois';
    const res = await axios.get(url, {
      params: {
        version: 1,
        format: 'json',
        count: 1,
        searchKeyword: keyword,
        appKey: TMAP_APP_KEY
      }
    });
    const poi = res.data?.searchPoiInfo?.pois?.poi?.[0];
    if (poi && poi.frontLon != null && poi.frontLat != null) {
      const lon = Number(poi.frontLon);
      const lat = Number(poi.frontLat);
      if (!Number.isNaN(lon) && !Number.isNaN(lat)) return { lon, lat };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function routeSummaryKakao(from, to) {
  const url = 'https://apis-navi.kakaomobility.com/v1/directions';
  // 최소시간 경로의 거리/시간을 선택해 반환
  async function call(priorityValue) {
    const res = await axios.get(url, {
      params: {
        origin: `${from.lon},${from.lat}`,
        destination: `${to.lon},${to.lat}`,
        ...(priorityValue ? { priority: priorityValue } : {})
      },
      headers: { Authorization: `KakaoAK ${KAKAO_MOBILITY_REST_KEY}` }
    });
    const routes = Array.isArray(res.data?.routes) ? res.data.routes : [];
    if (routes.length === 0) return { distance: null, duration: null };
    let best = null;
    for (const r of routes) {
      const dur = r?.summary?.duration;
      if (typeof dur === 'number') {
        if (!best || dur < best.summary.duration) best = r;
      }
    }
    if (!best) best = routes[0];
    const distance = typeof best?.summary?.distance === 'number' ? best.summary.distance : null; // meters
    const durationMs = typeof best?.summary?.duration === 'number' ? best.summary.duration : null; // ms
    const duration = durationMs != null ? Math.round(durationMs / 1000) : null; // seconds
    return { distance, duration };
  }

  try {
    // 추천(시간 가중) 우선 시도 → 실패 시 다른 옵션
    return await call('RECOMMEND');
  } catch (e) {
    const msg = e?.response?.data?.msg || e?.response?.data?.message || '';
    if (String(msg).toLowerCase().includes('priority')) {
      try { return await call(null); } catch (_) {}
      try { return await call('DISTANCE'); } catch (_) {}
      try { return await call('SHORTEST'); } catch (_) {}
    }
    throw e;
  }
}

function parseTmapDistanceAndTime(data) {
  const features = data?.features;
  if (!features || features.length === 0) return { distance: null, time: null };
  for (const f of features) {
    const d = f?.properties?.totalDistance;
    const t = f?.properties?.totalTime;
    if (typeof d === 'number' || typeof t === 'number') {
      return {
        distance: typeof d === 'number' ? d : null,
        time: typeof t === 'number' ? t : null
      };
    }
  }
  let sumDist = 0;
  let sumTime = 0;
  let hasDist = false;
  let hasTime = false;
  for (const f of features) {
    const segD = f?.properties?.distance;
    const segT = f?.properties?.time;
    if (typeof segD === 'number') { sumDist += segD; hasDist = true; }
    if (typeof segT === 'number') { sumTime += segT; hasTime = true; }
  }
  return {
    distance: hasDist ? sumDist : null,
    time: hasTime ? sumTime : null
  };
}

async function routeTmapOptionSummary(from, to, searchOption) {
  const baseUrl = 'https://apis.openapi.sk.com/tmap/routes?version=1&format=json';
  async function call(body) {
    const res = await axios.post(baseUrl, body, {
      headers: {
        'Content-Type': 'application/json',
        appKey: TMAP_APP_KEY
      }
    });
    return parseTmapDistanceAndTime(res.data);
  }
  const common = {
    startX: String(from.lon),
    startY: String(from.lat),
    endX: String(to.lon),
    endY: String(to.lat),
    reqCoordType: 'WGS84GEO',
    resCoordType: 'WGS84GEO'
  };
  // 오직 교통 미반영(순수 거리)으로 호출
  try {
    const { distance, time } = await call({ ...common, searchOption, trafficInfo: 'N', tollgateFareOption: 0 });
    if (distance != null || time != null) {
      return { distanceMeters: distance, timeSeconds: time };
    }
  } catch (_) { /* continue */ }
  // 마지막 폴백: GET(거리 위주)
  try {
    const params = { ...common, searchOption, trafficInfo: 'N', tollgateFareOption: 0 };
    const res = await axios.get(baseUrl, { params, headers: { appKey: TMAP_APP_KEY } });
    const { distance, time } = parseTmapDistanceAndTime(res.data);
    return { distanceMeters: distance, timeSeconds: time };
  } catch (_) {
    return { distanceMeters: null, timeSeconds: null };
  }
}

app.post('/api/compare', async (req, res) => {
  try {
    const { destinationAddress, rows } = req.body; // rows: [{ address: string }]
    if (!destinationAddress || !Array.isArray(rows)) {
      return res.status(400).json({ message: 'destinationAddress 와 rows 필요' });
    }

    const isKakaoKeyMissing = !KAKAO_REST_KEY;
    const isTmapKeyMissing = !TMAP_APP_KEY;

    // 도착지 좌표 (두 API 각각 지오코딩) - 실패해도 각각 개별 처리
    let kakaoDestination = null;
    let tmapDestination = null;
    const prioDest = await normalizePriorityListWithGemini(destinationAddress);
    const analyzedDest = { normalized: prioDest.primary, type: prioDest.primaryType };
    const normalizedDest = analyzedDest.normalized;
    if (!isKakaoKeyMissing) {
      const kakaoDestRes = await Promise.resolve(robustGeocodeWithKakao(normalizedDest)).then(
        (v) => ({ status: 'fulfilled', value: v }),
        (e) => ({ status: 'rejected', reason: e })
      );
      kakaoDestination = kakaoDestRes.status === 'fulfilled' ? kakaoDestRes.value : null;
    }
    if (!isTmapKeyMissing) {
      const tmapDestRes = await Promise.resolve(robustGeocodeWithTmap(normalizedDest)).then(
        (v) => ({ status: 'fulfilled', value: v }),
        (e) => ({ status: 'rejected', reason: e })
      );
      tmapDestination = tmapDestRes.status === 'fulfilled' ? tmapDestRes.value : null;
    }
    if (!kakaoDestination && !tmapDestination) {
      return res.status(400).json({
        message: '도착지 지오코딩 실패',
        detail: {
          kakao: isKakaoKeyMissing ? 'KAKAO_REST_KEY 미설정' : 'fail',
          tmap: isTmapKeyMissing ? 'TMAP_APP_KEY 미설정' : 'fail'
        }
      });
    }

    // 각 API는 자체 지오코딩 좌표를 사용해 경로를 계산한다(앱과의 일치도 향상)

    const results = await Promise.all(rows.map(async (row) => {
      const address = row.address?.trim();
      if (!address) {
        return { address: row.address, kakao: null, tmap: null, error: '빈 주소' };
      }
      // 각 행의 주소는 출발지. 실패해도 개별 처리
      let kakaoOrigin = null;
      let tmapOrigin = null;
      const prioOrigin = await normalizePriorityListWithGemini(address);
      const analyzedOrigin = { normalized: prioOrigin.primary, type: prioOrigin.primaryType };
      const normalizedOrigin = analyzedOrigin.normalized;
      if (!isKakaoKeyMissing) {
        const kakaoOriRes = await Promise.resolve(robustGeocodeWithKakao(normalizedOrigin, prioOrigin.list)).then(
          (v) => ({ status: 'fulfilled', value: v }),
          (e) => ({ status: 'rejected', reason: e })
        );
        kakaoOrigin = kakaoOriRes.status === 'fulfilled' ? kakaoOriRes.value : null;
      }
      if (!isTmapKeyMissing) {
        const tmapOriRes = await Promise.resolve(robustGeocodeWithTmap(normalizedOrigin, prioOrigin.list)).then(
          (v) => ({ status: 'fulfilled', value: v }),
          (e) => ({ status: 'rejected', reason: e })
        );
        tmapOrigin = tmapOriRes.status === 'fulfilled' ? tmapOriRes.value : null;
      }

      let kakaoDistance = null;
      let kakaoTime = null;
      let tmapDistance = null;
      let tmapTime = null;
      let kakaoError = null;
      let tmapError = null;

      // 지오코딩 실패 시에도 명확한 에러를 남겨 테이블에 표시되도록 함
      if (isKakaoKeyMissing) {
        kakaoError = '카카오 키 미설정';
      } else if (!kakaoOrigin || !kakaoDestination) {
        kakaoError = '카카오 지오코딩 실패';
      }
      if (isTmapKeyMissing) {
        tmapError = 'T맵 키 미설정';
      } else if (!tmapOrigin || !tmapDestination) {
        tmapError = 'T맵 지오코딩 실패';
      }

      if (kakaoOrigin && kakaoDestination) {
        try {
          const kakao = await routeSummaryKakao(kakaoOrigin, kakaoDestination);
          kakaoDistance = kakao?.distance ?? null;
          kakaoTime = kakao?.duration ?? null;
        } catch (e) {
          kakaoError = e?.response?.data?.msg || e?.response?.data?.message || e.message;
        }
        if (kakaoDistance == null && kakaoTime == null && !kakaoError) {
          kakaoError = '카카오 경로 없음';
        }
      }
      if (tmapOrigin && tmapDestination) {
        try {
          // T맵 최단거리: searchOption = 2
          const attempts = [];
          const base1 = await routeTmapOptionSummary(tmapOrigin, tmapDestination, 2);
          attempts.push({ label: 'T->T', ...base1 });
          // 지오코딩 편차 보정을 위해 카카오 좌표 조합도 시도해 더 짧은 경로를 채택
          if (kakaoOrigin) {
            const a = await routeTmapOptionSummary(kakaoOrigin, tmapDestination, 2);
            attempts.push({ label: 'K->T', ...a });
          }
          if (kakaoDestination) {
            const b = await routeTmapOptionSummary(tmapOrigin, kakaoDestination, 2);
            attempts.push({ label: 'T->K', ...b });
          }
          if (kakaoOrigin && kakaoDestination) {
            const c = await routeTmapOptionSummary(kakaoOrigin, kakaoDestination, 2);
            attempts.push({ label: 'K->K', ...c });
          }
          // 최단거리 기준 최적 시나리오 선택
          let best = attempts
            .filter(x => typeof x.distanceMeters === 'number')
            .sort((a, b) => a.distanceMeters - b.distanceMeters)[0] || attempts[0];
          tmapDistance = best?.distanceMeters ?? null;
          tmapTime = best?.timeSeconds ?? null;
        } catch (e) {
          tmapError = e?.response?.data?.msg || e?.response?.data?.message || e.message;
        }
        if (tmapDistance == null && tmapTime == null && !tmapError) {
          tmapError = 'T맵 경로 없음';
        }
      }

      const error = kakaoError || tmapError || null;
      return {
        address,
        kakao: kakaoDistance,
        tmap: tmapDistance,
        kakaoTime: kakaoTime,
        tmapTime: tmapTime,
        kakaoType: analyzedOrigin?.type || null,
        tmapType: analyzedOrigin?.type || null,
        normalizedOrigin,
        normalizedDestination: normalizedDest,
        kakaoError,
        tmapError,
        error
      };
    }));

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 에러', detail: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// 간단 T맵 키/권한 상태 점검용 디버그
app.get('/api/debug/tmap', async (req, res) => {
  try {
    if (!TMAP_APP_KEY) return res.status(400).json({ ok: false, message: 'TMAP_APP_KEY 미설정' });
    // 가벼운 키 검증: transcoord 호출(짧고 빠름)
    const url = 'https://apis.openapi.sk.com/tmap/geo/transcoord';
    const r = await axios.get(url, {
      params: { version: 1, format: 'json', appKey: TMAP_APP_KEY, coordType: 'WGS84GEO', toCoordType: 'WGS84GEO', x: '127.0', y: '37.5' }
    });
    const ok = !!r.data?.coordinate;
    res.json({ ok, sample: r.data?.coordinate || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

const port = process.env.PORT || 3000;
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}


