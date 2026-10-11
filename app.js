/* ═══════════════════════════════════════════════════════════════
   COD ANALYTICS — app.js   v2
   Full CSV-upload, multi-page, data-driven dashboard
═══════════════════════════════════════════════════════════════ */
'use strict';

// ─── CONSTANTS ────────────────────────────────────────────────────
const BUCKET_ORDER = ['0-5 min','5-10 min','10-15 min','15-20 min','20-25 min','25-30 min'];
const BUCKET_COLORS = {
  '0-5 min':'#22c55e','5-10 min':'#84cc16','10-15 min':'#f59e0b',
  '15-20 min':'#f97316','20-25 min':'#ef4444','25-30 min':'#dc2626'
};
const COD_COLS = BUCKET_ORDER.map(b => BUCKET_COLORS[b]);
const CHART_PAL = ['#4facfe','#a855f7','#f7c59f','#22c55e','#f59e0b','#ec4899',
  '#ff6b35','#84cc16','#6366f1','#14b8a6','#f97316','#e879f9','#38bdf8','#fb923c','#00d4aa'];

const REQUIRED_COLS = ['employeelogin','change_over_time_minutes','processed_day'];
const OPTIONAL_COLS = ['ppr_process_group','floor','mod_type','shift','cod_bucket',
  'week_number','stowdate','bin_id','lc_category','drop_zone','bin_usage_type',
  'sourcescannableid','next_scannable_id','next_stow_date','change_over_time'];

Chart.defaults.color = '#8b92a8';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.legend.labels.padding = 14;

// ─── DATA STORE ───────────────────────────────────────────────────
const DS = {
  files: [],        // array of stored files: { id, name, size, uploadTime, records: [], invalidRows: 0, missingCols: [], dateMin, dateMax }
  activeFileId: 'all', // 'all' or specific file id
  raw: [],          // combined active records
  filtered: [],     // after global filters
  filename: 'No file',
  recordsTotal: 0,
  invalidRows: 0,
  missingCols: [],
  dateMin: '', dateMax: '',
  processes: [], floors: [], mods: [], shifts: [], dates: [], weeks: [],
};

// ─── GLOBAL FILTER STATE ──────────────────────────────────────────
const GF = {
  dateFrom: '', dateTo: '',
  shift: '', process: '', floor: '', mod: '',
  minEvents: 1,
  threshold: 10,   // high-duration threshold in minutes
};

// ─── ACTIVE PAGE & CHARTS ─────────────────────────────────────────
let currentPage = 'overview';
const activeCharts = {};

// ─── HELPERS ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if(cls) e.className=cls; if(html) e.innerHTML=html; return e; };
const fmt = (n, d=2) => n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-IN',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtI = n => n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-IN');
const fmtPct = n => n == null || isNaN(n) ? '—' : fmt(n,1)+'%';
const codClass = v => v <= 3 ? 'cod-low' : v <= 7 ? 'cod-mid' : 'cod-high';
const gradeOf = v => v <= 2 ? 'S' : v <= 3.5 ? 'A' : v <= 5 ? 'B' : v <= 8 ? 'C' : 'D';
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function formatDay(str) {
  if (!str) return '—';
  const s = String(str).trim();
  // If already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // If M/D/YYYY or MM/DD/YYYY or M-D-YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    const mm = m[1].padStart(2, '0');
    const dd = m[2].padStart(2, '0');
    const yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  return s;
}

function formatTime(str) {
  if (!str) return '—';
  const s = String(str).trim();
  
  // Extract time portion from timestamp like "2026-10-04 14:08:13" or "8/17/2026 0:53"
  let timeStr = s;
  if (s.includes(' ') || s.includes('T')) {
    timeStr = s.split(/[ T]+/)[1] || s;
  }
  
  // Match hours, minutes, and optional seconds
  const m = timeStr.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2].padStart(2, '0');
    const ss = (m[3] !== undefined) ? m[3].padStart(2, '0') : '00';
    
    // Check for PM/AM if present
    if (/pm/i.test(timeStr) && hh < 12) hh += 12;
    if (/am/i.test(timeStr) && hh === 12) hh = 0;
    
    return `${String(hh).padStart(2, '0')}:${mm}:${ss}`;
  }
  
  return timeStr;
}


function pColor(i) { return CHART_PAL[i % CHART_PAL.length]; }
function destroyChart(key) { if(activeCharts[key]) { activeCharts[key].destroy(); delete activeCharts[key]; } }
function buildChart(key, ctx, config) { destroyChart(key); activeCharts[key] = new Chart(ctx, config); return activeCharts[key]; }

const baseTooltip = {
  backgroundColor:'rgba(10,13,20,.95)', titleColor:'#e8eaf0', bodyColor:'#8b92a8',
  borderColor:'rgba(255,255,255,.1)', borderWidth:1, padding:12, cornerRadius:8
};
const baseScales = {
  x:{ grid:{color:'rgba(255,255,255,.04)'}, ticks:{color:'#8b92a8',font:{size:11}} },
  y:{ grid:{color:'rgba(255,255,255,.04)'}, ticks:{color:'#8b92a8',font:{size:11}}, beginAtZero:true }
};

function barConfig(labels, datasets, opts={}) {
  return {
    type: opts.horizontal ? 'bar' : 'bar',
    data:{ labels, datasets },
    options:{
      indexAxis: opts.horizontal ? 'y' : 'x',
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:opts.legend||false}, tooltip:{...baseTooltip,...(opts.tooltip||{})} },
      scales: opts.horizontal
        ? { x:{...baseScales.y, ticks:{...baseScales.y.ticks, callback:v=>fmt(v,1)}},
            y:{...baseScales.x, grid:{display:false}} }
        : { x:baseScales.x, y:{...baseScales.y, ticks:{...baseScales.y.ticks, callback:v=>fmt(v,1)}} }
    }
  };
}
function lineConfig(labels, datasets, opts={}) {
  return {
    type:'line',
    data:{ labels, datasets },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:opts.legend||false}, tooltip:{...baseTooltip,...(opts.tooltip||{})} },
      scales:{ x:{...baseScales.x, ticks:{...baseScales.x.ticks, maxRotation:45}}, y:{...baseScales.y, ticks:{...baseScales.y.ticks, callback:v=>fmt(v,1)}} },
      elements:{ line:{tension:.4,borderWidth:2.5}, point:{radius:3,hoverRadius:6} }
    }
  };
}
function pieConfig(labels, data, colors, opts={}) {
  return {
    type: opts.doughnut ? 'doughnut' : 'pie',
    data:{ labels, datasets:[{ data, backgroundColor:colors, borderColor:'#0a0d14', borderWidth:2, hoverOffset:6 }] },
    options:{
      responsive:true, maintainAspectRatio:false, cutout: opts.doughnut ? '55%' : '0%',
      plugins:{ legend:{display:opts.legend!==false,...(opts.legendPos||{})},
        tooltip:{...baseTooltip,...(opts.tooltip||{})} }
    }
  };
}

// ─── DATA AGGREGATIONS ────────────────────────────────────────────
function calcStats(records) {
  if (!records.length) return null;
  const vals = records.map(r => r.change_over_time_minutes);
  const sum = vals.reduce((a,b)=>a+b,0);
  const avg = sum / vals.length;
  return { count:vals.length, sum:+sum.toFixed(2), avg:+avg.toFixed(2) };
}
function calcEmpStats(records, threshold) {
  const byEmp = {};
  records.forEach(r => {
    if (!byEmp[r.employeelogin]) byEmp[r.employeelogin] = [];
    byEmp[r.employeelogin].push(r);
  });
  return Object.entries(byEmp).map(([login, recs]) => {
    const vals = recs.map(r=>r.change_over_time_minutes);
    const sum = vals.reduce((a,b)=>a+b,0);
    const avg = sum/vals.length;
    const hiCount = vals.filter(v=>v>=threshold).length;
    const hiPct = (hiCount/vals.length)*100;
    const procs = [...new Set(recs.map(r=>r.ppr_process_group).filter(Boolean))];
    const floors = [...new Set(recs.map(r=>r.floor).filter(v=>v!==null&&v!==undefined&&v!==''))].sort();
    const mods   = [...new Set(recs.map(r=>r.mod_type).filter(Boolean))].sort();
    const shifts = [...new Set(recs.map(r=>r.shift).filter(Boolean))].sort();
    const freqProc = procs.length ? (mode => mode)(
      (() => { const cnt={}; recs.forEach(r=>r.ppr_process_group&&(cnt[r.ppr_process_group]=(cnt[r.ppr_process_group]||0)+1)); return Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0]?.[0]||''; })()
    ) : '';
    return { login, count:vals.length, sum:+sum.toFixed(2), avg:+avg.toFixed(2),
      hiCount, hiPct:+hiPct.toFixed(1), freqProc, floors, mods, shifts, records:recs };
  });
}
function calcGroupStats(records, key, threshold) {
  const groups = {};
  records.forEach(r => {
    let k = r[key];
    if (k === null || k === undefined || String(k).trim() === '') {
      k = (key === 'ppr_process_group') ? 'Unassigned (No PPR Track)' : 'Unknown';
    }
    if (!groups[k]) groups[k] = [];
    groups[k].push(r);
  });
  return Object.entries(groups).map(([name, recs]) => {
    const vals = recs.map(r=>r.change_over_time_minutes);
    const sum = vals.reduce((a,b)=>a+b,0);
    const avg = sum/vals.length;
    const hiCount = vals.filter(v=>v>=(threshold||10)).length;
    const hiPct = (hiCount/vals.length)*100;
    const empCount = new Set(recs.map(r=>r.employeelogin)).size;
    return { name, count:vals.length, sum:+sum.toFixed(2), avg:+avg.toFixed(2),
      hiCount, hiPct:+hiPct.toFixed(1), empCount };
  });
}
function calcDailyStats(records) {
  const byDay = {};
  records.forEach(r => {
    const d = r.processed_day;
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(r);
  });
  return Object.entries(byDay).sort((a,b)=>a[0]<b[0]?-1:1).map(([day,recs]) => {
    const vals = recs.map(r=>r.change_over_time_minutes);
    const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
    return { day, count:vals.length, avg:+avg.toFixed(2) };
  });
}
function calcWeeklyStats(records) {
  const byWeek = {};
  records.forEach(r => {
    const w = r.week_number || 'Unknown';
    if (!byWeek[w]) byWeek[w] = { records:[], weekStart: r.processed_day };
    byWeek[w].records.push(r);
    if (r.processed_day < byWeek[w].weekStart) byWeek[w].weekStart = r.processed_day;
  });
  return Object.entries(byWeek)
    .sort((a,b) => a[1].weekStart < b[1].weekStart ? -1 : 1)
    .map(([week, { records:recs, weekStart }]) => {
      const vals = recs.map(r=>r.change_over_time_minutes);
      const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
      return { week, weekStart, count:vals.length, avg:+avg.toFixed(2) };
    });
}
function calcBucketStats(records) {
  const counts = {}, sums = {};
  BUCKET_ORDER.forEach(b => { counts[b]=0; sums[b]=0; });
  records.forEach(r => {
    const b = r.cod_bucket;
    if (counts[b] !== undefined) { counts[b]++; sums[b]+=r.change_over_time_minutes; }
  });
  return { counts, sums, total:records.length };
}

// ─── GLOBAL FILTER APPLICATION ────────────────────────────────────
function applyFilters() {
  DS.filtered = DS.raw.filter(r => {
    if (GF.dateFrom && r.processed_day < GF.dateFrom) return false;
    if (GF.dateTo   && r.processed_day > GF.dateTo)   return false;
    if (GF.shift   && r.shift           !== GF.shift)   return false;
    if (GF.process && r.ppr_process_group !== GF.process) return false;
    if (GF.floor   && String(r.floor)   !== GF.floor)  return false;
    if (GF.mod     && r.mod_type        !== GF.mod)     return false;
    return true;
  });
  const fc = $('filtered-count');
  if (fc) {
    fc.innerHTML = `<span class="pulse-dot"></span><span class="badge-text"><b>${fmtI(DS.filtered.length)}</b> / ${fmtI(DS.raw.length)} rows</span>`;
  }
}

// ─── CSV PARSING ──────────────────────────────────────────────────
// Column name aliases to tolerate different naming conventions & export formats
const COLUMN_ALIASES = {
  employeelogin: ['employeelogin', 'employee_login', 'login', 'user_id', 'userid', 'associate_id', 'associate_login'],
  change_over_time_minutes: ['change_over_time_minutes', 'changeover_duration_minutes', 'changeover_minutes', 'change_over_duration', 'cod_minutes', 'cod_min', 'cod'],
  processed_day: ['processed_day', 'processed_date', 'date', 'day', 'stow_day', 'stow_date', 'event_date'],
  ppr_process_group: ['ppr_process_group', 'process_group', 'process', 'ppr_function_name', 'function_name'],
  floor: ['floor', 'bin_level', 'level'],
  mod_type: ['mod_type', 'mod', 'module'],
  shift: ['shift', 'shift_type'],
  cod_bucket: ['cod_bucket', 'bucket'],
  week_number: ['week_number', 'week'],
  stowdate: ['stowdate', 'stow_date', 'timestamp', 'time'],
  bin_id: ['bin_id', 'bin'],
  lc_category: ['lc_category', 'bin_type', 'bintype', 'bin_type_name', 'category'],
  bin_usage_type: ['bin_usage_type', 'bin_usage', 'binusage', 'bin_usage_name', 'usage_type'],
  drop_zone: ['drop_zone', 'dropzone'],
  change_over_time: ['change_over_time', 'cod_seconds', 'duration_seconds']
};

function detectDelimiter(headerLine) {
  const commas = (headerLine.match(/,/g) || []).length;
  const tabs = (headerLine.match(/\t/g) || []).length;
  const semis = (headerLine.match(/;/g) || []).length;
  if (tabs > commas && tabs > semis) return '\t';
  if (semis > commas && semis > tabs) return ';';
  return ',';
}

function parseCSV(text, filename = 'Uploaded file') {
  if (!text) throw new Error(`${filename}: File is empty.`);
  // Strip UTF-8 Byte Order Mark (BOM) if present
  let cleanText = text.replace(/^\uFEFF/, '');
  const lines = cleanText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error(`${filename}: Contains no data rows (less than 2 lines).`);

  const delimiter = detectDelimiter(lines[0]);
  const rawHeaders = splitDelimitedLine(lines[0], delimiter).map(h => 
    h.trim().replace(/^["']|["']$/g, '').toLowerCase().replace(/[\s\-_]+/g, '_')
  );

  // Map each standard column to the matched index in rawHeaders
  const headerMap = {};
  Object.entries(COLUMN_ALIASES).forEach(([canonical, aliases]) => {
    const idx = rawHeaders.findIndex(h => aliases.includes(h) || h === canonical);
    if (idx !== -1) headerMap[canonical] = idx;
  });

  // Check required columns
  const missing = REQUIRED_COLS.filter(c => headerMap[c] === undefined);
  if (missing.length) {
    throw new Error(
      `File "${filename}" is missing required column(s): [${missing.join(', ')}]. Found headers: [${rawHeaders.slice(0, 8).join(', ')}${rawHeaders.length > 8 ? '...' : ''}]`
    );
  }

  const missingOpt = OPTIONAL_COLS.filter(c => headerMap[c] === undefined);
  const records = [];
  let invalidRows = 0;

  for (let i = 1; i < lines.length; i++) {
    const vals = splitDelimitedLine(lines[i], delimiter);
    if (vals.length < 2) { invalidRows++; continue; }

    const row = {};
    // Extract canonical fields
    Object.keys(COLUMN_ALIASES).forEach(canon => {
      const idx = headerMap[canon];
      row[canon] = idx !== undefined && vals[idx] !== undefined ? vals[idx].trim().replace(/^["']|["']$/g, '') : '';
    });

    // Also preserve any unmapped original headers
    rawHeaders.forEach((h, j) => {
      if (!row[h] && vals[j] !== undefined) {
        row[h] = vals[j].trim().replace(/^["']|["']$/g, '');
      }
    });

    // Parse numeric change_over_time_minutes
    const cod = parseFloat(row.change_over_time_minutes);
    if (isNaN(cod) || cod < 0) { invalidRows++; continue; }
    row.change_over_time_minutes = cod;

    row.change_over_time = parseInt(row.change_over_time) || Math.round(cod * 60);
    row.floor = row.floor !== '' && row.floor !== null && !isNaN(row.floor) ? parseFloat(row.floor) : null;
    row.ppr_process_group = (row.ppr_process_group || '').trim() || 'Unassigned (No PPR Track)';

    // Normalize required identity
    row.processed_day = formatDay(row.processed_day);
    row.employeelogin = row.employeelogin || '';
    if (!row.processed_day || !row.employeelogin) { invalidRows++; continue; }

    // Derive mod_type if missing in CSV (mirrors SQL: UPPER(SUBSTRING(bin_id, 5, 1)))
    if (!row.mod_type && row.bin_id) {
      const b = row.bin_id.trim();
      // Case 1: Standard P-4-L153B321 or P-2-C219C443 format -> letter after second dash
      const stdMatch = b.match(/^P-\d+-([A-Za-z])/i);
      if (stdMatch) {
        row.mod_type = stdMatch[1].toUpperCase();
      } else {
        // Case 2: dm-prefix bins like dmP4M125c
        const dmMatch = b.match(/^dmP\d([A-Za-z])/i);
        if (dmMatch) {
          row.mod_type = dmMatch[1].toUpperCase();
        } else if (b.length >= 5 && /[A-Za-z]/.test(b.charAt(4))) {
          // Case 3: 5th character fallback
          row.mod_type = b.charAt(4).toUpperCase();
        }
      }
    }

    // Derive cod_bucket if missing
    if (!row.cod_bucket) {
      if (cod < 5) row.cod_bucket = '0-5 min';
      else if (cod < 10) row.cod_bucket = '5-10 min';
      else if (cod < 15) row.cod_bucket = '10-15 min';
      else if (cod < 20) row.cod_bucket = '15-20 min';
      else if (cod < 25) row.cod_bucket = '20-25 min';
      else row.cod_bucket = '25-30 min';
    }

    records.push(row);
  }

  return { records, invalidRows, missingCols: missingOpt };
}

function splitDelimitedLine(line, delimiter = ',') {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } // Escaped quote
      else { inQ = !inQ; }
    } else if (ch === delimiter && !inQ) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// ─── INDEXEDDB STORAGE (PERSISTENT MULTI-FILE STORE) ─────────────
const DB_NAME = 'COD_Analytics_DB';
const DB_VERSION = 1;
const STORE_NAME = 'csv_files';

function openCODDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      console.warn('IndexedDB not supported in this browser.');
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('IndexedDB error:', req.error);
      resolve(null);
    };
  });
}

async function dbSaveFile(fileObj) {
  try {
    const db = await openCODDatabase();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(fileObj);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (err) {
    console.warn('dbSaveFile failed:', err);
  }
}

async function dbDeleteFile(fileId) {
  try {
    const db = await openCODDatabase();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(fileId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (err) {
    console.warn('dbDeleteFile failed:', err);
  }
}

async function dbGetAllFiles() {
  try {
    const db = await openCODDatabase();
    if (!db) return [];
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (err) {
    console.warn('dbGetAllFiles failed:', err);
    return [];
  }
}

function hideStartupLoader() {
  const sl = $('startup-loader');
  if (sl) {
    sl.style.opacity = '0';
    sl.style.transition = 'opacity 0.2s ease';
    setTimeout(() => sl.remove(), 200);
  }
}

async function loadPersistedFilesOnStartup() {
  const stored = await dbGetAllFiles();
  if (stored && stored.length > 0) {
    DS.files = stored;
    DS.activeFileId = 'all';
    rebuildDSFromActiveFile();
    initFilters();
    applyFilters();
    updateDSInfo();
    showApp();
    navigateTo('overview');
    hideStartupLoader();
    return true;
  }
  // No files stored yet — reveal upload screen
  showUploadScreen();
  hideStartupLoader();
  return false;
}

// ─── UPLOAD WORKFLOW ──────────────────────────────────────────────
function initUpload() {
  const dz = $('drop-zone');
  const fi = $('file-input');

  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    if (files.length) processFiles(files);
  });
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => {
    const files = Array.from(fi.files);
    if (files.length) processFiles(files);
    fi.value = '';
  });
  $('btn-new-upload').addEventListener('click', showUploadScreen);
}

function showUploadScreen() {
  $('upload-screen').style.display = 'flex';
  $('upload-screen').classList.add('active');
  $('app-shell').style.display = 'none';
}
function showApp() {
  $('upload-screen').style.display = 'none';
  $('upload-screen').classList.remove('active');
  $('app-shell').style.display = 'flex';
}

function readFileAsync(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve({ file, content: e.target.result });
    reader.onerror = () => reject(new Error(`Failed to read "${file.name}"`));
    reader.readAsText(file);
  });
}

async function processFiles(filesList) {
  const errEl = $('upload-error');
  const progEl = $('upload-progress');
  errEl.style.display = 'none';
  progEl.style.display = 'block';

  try {
    let loadedCount = 0;
    const newStoredFiles = [];

    const skippedFiles = [];

    for (let i = 0; i < filesList.length; i++) {
      const file = filesList[i];
      setProgress(Math.round(((i + 0.3) / filesList.length) * 80), `Reading ${file.name} (${i + 1}/${filesList.length})...`);
      const { content } = await readFileAsync(file);

      setProgress(Math.round(((i + 0.7) / filesList.length) * 80), `Parsing ${file.name}...`);
      try {
        const { records, invalidRows, missingCols } = parseCSV(content, file.name);
        if (!records.length) {
          skippedFiles.push(`${file.name} (no valid changeover records)`);
          continue;
        }

        const days = [...new Set(records.map(r => r.processed_day).filter(Boolean))].sort();
        const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

        newStoredFiles.push({
          id: fileId,
          name: file.name,
          size: file.size,
          uploadTime: new Date().toLocaleTimeString(),
          records: records,
          invalidRows: invalidRows,
          missingCols: missingCols,
          dateMin: days[0] || '—',
          dateMax: days[days.length - 1] || '—',
          count: records.length
        });
        loadedCount++;
      } catch (parseErr) {
        skippedFiles.push(parseErr.message);
      }
    }

    if (!newStoredFiles.length && skippedFiles.length) {
      throw new Error(`Upload failed:\n${skippedFiles.join('\n')}`);
    }

    setProgress(90, 'Storing & saving datasets locally...');
    // Append or store files
    DS.files = DS.files.concat(newStoredFiles);
    for (const f of newStoredFiles) {
      await dbSaveFile(f);
    }
    DS.activeFileId = 'all'; // view combined by default, or user can toggle per file
    rebuildDSFromActiveFile();

    setProgress(100, 'Complete!');
    setTimeout(() => {
      progEl.style.display = 'none';
      initFilters();
      applyFilters();
      updateDSInfo();
      showApp();
      navigateTo('overview');
    }, 300);
  } catch (err) {
    progEl.style.display = 'none';
    errEl.style.display = 'block';
    errEl.textContent = '❌ ' + err.message;
  }
}

function rebuildDSFromActiveFile() {
  let targetRecords = [];
  let totalInvalid = 0;
  let allMissing = new Set();
  let displayName = '';

  if (DS.activeFileId === 'all') {
    DS.files.forEach(f => {
      // Normalize dates for legacy or previously stored files on the fly
      f.records.forEach(r => {
        r.processed_day = formatDay(r.processed_day);
      });
      targetRecords = targetRecords.concat(f.records);
      totalInvalid += f.invalidRows;
      f.missingCols.forEach(m => allMissing.add(m));
    });
    displayName = `${DS.files.length} File${DS.files.length === 1 ? '' : 's'} Combined`;
  } else {
    const f = DS.files.find(x => x.id === DS.activeFileId);
    if (f) {
      f.records.forEach(r => {
        r.processed_day = formatDay(r.processed_day);
      });
      targetRecords = f.records;
      totalInvalid = f.invalidRows;
      f.missingCols.forEach(m => allMissing.add(m));
      displayName = f.name;
    }
  }

  DS.raw = targetRecords;
  DS.filename = displayName;
  DS.recordsTotal = targetRecords.length;
  DS.invalidRows = totalInvalid;
  DS.missingCols = Array.from(allMissing);

  const days = [...new Set(targetRecords.map(r => r.processed_day).filter(Boolean))].sort();
  DS.dateMin = days[0] || '';
  DS.dateMax = days[days.length - 1] || '';
  DS.dates = days;
  DS.processes = [...new Set(targetRecords.map(r => r.ppr_process_group).filter(Boolean))].sort();
  DS.floors = [...new Set(targetRecords.map(r => r.floor).filter(v => v !== null && v !== undefined))].sort((a,b) => a - b);
  DS.mods = [...new Set(targetRecords.map(r => r.mod_type).filter(Boolean))].sort();
  DS.shifts = [...new Set(targetRecords.map(r => r.shift).filter(Boolean))].sort();
  DS.weeks = [...new Set(targetRecords.map(r => r.week_number).filter(Boolean))];
  DS.binTypes = [...new Set(targetRecords.map(r => r.lc_category).filter(Boolean))].sort();
  DS.binUsages = [...new Set(targetRecords.map(r => r.bin_usage_type).filter(Boolean))].sort();

  GF.dateFrom = DS.dateMin;
  GF.dateTo = DS.dateMax;
  GF.shift = '';
  GF.process = '';
  GF.floor = '';
  GF.mod = '';
  GF.minEvents = 1;
  GF.threshold = 10;
}

window.selectFileSource = function(fileId) {
  DS.activeFileId = fileId;
  rebuildDSFromActiveFile();
  initFilters();
  applyFilters();
  updateDSInfo();
  renderCurrentPage();
};

window.removeStoredFile = async function(fileId) {
  DS.files = DS.files.filter(f => f.id !== fileId);
  await dbDeleteFile(fileId);
  if (!DS.files.length) {
    showUploadScreen();
    return;
  }
  if (DS.activeFileId === fileId) {
    DS.activeFileId = 'all';
  }
  rebuildDSFromActiveFile();
  initFilters();
  applyFilters();
  updateDSInfo();
  renderCurrentPage();
};

function setProgress(pct, txt) {
  $('progress-fill').style.width = pct + '%';
  $('progress-text').textContent = txt;
}

// ─── FILTERS UI ───────────────────────────────────────────────────
function initFilters() {
  // Date selects
  const dateFrom = $('gf-date-from'), dateTo = $('gf-date-to');
  dateFrom.innerHTML = dateTo.innerHTML = '';
  DS.dates.forEach(d => {
    dateFrom.appendChild(new Option(d, d));
    dateTo.appendChild(new Option(d, d));
  });
  dateFrom.value = GF.dateFrom;
  dateTo.value = GF.dateTo;

  // Process
  const pSel = $('gf-process');
  pSel.innerHTML = '<option value="">All Processes</option>';
  DS.processes.forEach(p => pSel.appendChild(new Option(p, p)));

  // Floor
  const fSel = $('gf-floor');
  fSel.innerHTML = '<option value="">All Floors</option>';
  DS.floors.forEach(f => fSel.appendChild(new Option('Floor '+f, f)));

  // Mod
  const mSel = $('gf-mod');
  mSel.innerHTML = '<option value="">All MODs</option>';
  DS.mods.forEach(m => mSel.appendChild(new Option(m, m)));

  // Events
  if ($('gf-min-events')) $('gf-min-events').value = GF.minEvents;

  // Listeners
  ['gf-date-from','gf-date-to','gf-shift','gf-process','gf-floor','gf-mod'].forEach(id => {
    const el2 = $(id);
    el2.addEventListener('change', () => {
      GF.dateFrom = $('gf-date-from').value;
      GF.dateTo   = $('gf-date-to').value;
      GF.shift    = $('gf-shift').value;
      GF.process  = $('gf-process').value;
      GF.floor    = $('gf-floor').value;
      showPageLoader('Applying filters...');
      setTimeout(() => {
        applyFilters();
        renderCurrentPage();
        hidePageLoader();
      }, 20);
    });
  });
  const minEvEl = $('gf-min-events');
  if (minEvEl) {
    minEvEl.addEventListener('change', () => {
      GF.minEvents = parseInt(minEvEl.value) || 1;
      showPageLoader('Updating calculations...');
      setTimeout(() => {
        renderCurrentPage();
        hidePageLoader();
      }, 20);
    });
  }
  $('btn-clear-filters').addEventListener('click', () => {
    GF.dateFrom=DS.dateMin; GF.dateTo=DS.dateMax;
    GF.shift=''; GF.process=''; GF.floor=''; GF.mod=''; GF.minEvents=1;
    $('gf-date-from').value=GF.dateFrom; $('gf-date-to').value=GF.dateTo;
    $('gf-shift').value=''; $('gf-process').value=''; $('gf-floor').value=''; $('gf-mod').value='';
    if ($('gf-min-events')) $('gf-min-events').value=1;
    showPageLoader('Resetting filters...');
    setTimeout(() => {
      applyFilters();
      renderCurrentPage();
      hidePageLoader();
    }, 20);
  });

  // Open dropdown/input on clicking anywhere on the pill or label
  document.querySelectorAll('.tf-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      // If clicked element is already the select or input, let native handling proceed
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
      const targetControl = pill.querySelector('select, input');
      if (targetControl) {
        targetControl.focus();
        if (targetControl.tagName === 'SELECT') {
          if (typeof targetControl.showPicker === 'function') {
            try { targetControl.showPicker(); } catch (err) { /* fallback to focus */ }
          }
        }
      }
    });
  });
}

function updateDSInfo() {
  $('sb-warehouse').textContent = DS.raw[0]?.warehouse_id || 'Warehouse';
  const countEl = $('sb-file-count');
  if (countEl) countEl.textContent = DS.files.length;
  $('ds-info').innerHTML = `<b>${escHtml(DS.filename)}</b><br>${fmtI(DS.recordsTotal)} records<br>${DS.dateMin} → ${DS.dateMax}`;
}

// ─── NAVIGATION ───────────────────────────────────────────────────
function showPageLoader(msg = 'Analyzing dataset...') {
  const pl = $('page-loader');
  const txt = $('page-loader-text');
  if (txt) txt.textContent = msg;
  if (pl) pl.style.display = 'flex';
}

function hidePageLoader() {
  const pl = $('page-loader');
  if (pl) pl.style.display = 'none';
}

function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page===page));
  
  // Format page name for loading message
  const pageTitles = {
    overview: 'Overview', defaulter: 'Defaulters', process: 'Process Trends',
    daily: 'Daily Analysis', weekly: 'Weekly Trends', floor: 'Floor Dimensions',
    mod: 'MOD Analysis', bin: 'Bin Type & Usage', bucket: 'COD Buckets',
    emp360: 'Associate 360', explorer: 'Event Explorer', quality: 'Data Quality', files: 'Files Manager'
  };
  
  showPageLoader(`Loading ${pageTitles[page] || page}...`);

  // Allow browser to render the spinner before executing heavy calculations
  setTimeout(() => {
    // Destroy existing chart instances
    Object.keys(activeCharts).forEach(k => destroyChart(k));
    renderCurrentPage();
    hidePageLoader();
  }, 25);
}

function renderCurrentPage() {
  const container = $('page-container');
  const pages = {
    overview: renderOverview, defaulter: renderDefaulter, process: renderProcess,
    daily: renderDaily, weekly: renderWeekly, floor: renderFloor, mod: renderMod,
    bin: renderBin,
    bucket: renderBucket, emp360: renderEmp360, explorer: renderExplorer, quality: renderQuality,
    files: renderFilesManager
  };
  const fn = pages[currentPage];
  if (fn) fn(container);
}
document.addEventListener('DOMContentLoaded', async () => {
  initUpload();
  document.querySelectorAll('.nav-item').forEach(n => {
    n.addEventListener('click', e => { e.preventDefault(); navigateTo(n.dataset.page); });
  });
  const sbt = $('sidebar-toggle');
  if (sbt) {
    sbt.addEventListener('click', () => {
      $('sidebar').classList.toggle('open');
    });
  }
  // Auto-restore previously uploaded files from browser IndexedDB
  await loadPersistedFilesOnStartup();
});

// ─── PAGE: OVERVIEW ───────────────────────────────────────────────
function renderOverview(c) {
  const data = DS.filtered;
  if (!data.length) { c.innerHTML = emptyState('No data — upload a CSV'); return; }
  const stats = calcStats(data);
  const good = data.filter(r=>r.cod_bucket==='0-5 min').length;
  const goodPct = (good/data.length*100).toFixed(1);
  const processes = new Set(data.map(r=>r.ppr_process_group).filter(Boolean));
  const empStats = calcEmpStats(data, GF.threshold).filter(e=>e.count>=GF.minEvents);
  empStats.sort((a,b)=>b.avg-a.avg);
  const top10 = empStats.slice(0,10);
  const dailyS = calcDailyStats(data);
  const weeklyS = calcWeeklyStats(data);
  const floorS = calcGroupStats(data,'floor',GF.threshold);
  const modS = calcGroupStats(data,'mod_type',GF.threshold);
  const bktS = calcBucketStats(data);

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">📈</span>Overview</div>
    <p class="page-desc">Summary metrics across all filtered data · ${DS.dateMin} to ${DS.dateMax}</p>
    <div class="kpi-strip cols-4 mb20">
      ${kpiCard('📦',fmtI(data.length),'Total Events')}
      ${kpiCard('⏱',fmt(stats.avg),'Mean COD (min)')}
      ${kpiCard('👥',fmtI(empStats.length),'Active Employees')}
      ${kpiCard('🎯',goodPct+'%','In 0-5 min Bucket')}
    </div>
    <div class="kpi-strip cols-4 mb20">
      ${kpiCard('🕰',fmtI(Math.round(stats.sum)),'Total Changeover (min)')}
      ${kpiCard('⚙',fmtI(processes.size),'Active Processes')}
      ${kpiCard('🚩',fmtI(empStats.filter(e=>e.avg>GF.threshold).length),'Employees > Threshold','','')}
      ${kpiCard('📅',fmtI(DS.dates.filter(d=>d>=GF.dateFrom&&d<=GF.dateTo).length),'Days in Range')}
    </div>

    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Daily Avg COD Trend</span></div>
        <div class="chart-wrap h240"><canvas id="ov-daily"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">COD Bucket Distribution</span></div>
        <div class="chart-wrap h240"><canvas id="ov-pie"></canvas></div>
      </div>
    </div>
    <div class="grid-3 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">By Process</span></div>
        <div class="chart-wrap h180"><canvas id="ov-proc"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">By Floor</span></div>
        <div class="chart-wrap h180"><canvas id="ov-floor"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">By MOD</span></div>
        <div class="chart-wrap h180"><canvas id="ov-mod"></canvas></div>
      </div>
    </div>

    <div class="table-wrap">
      <div class="table-header">
        <span class="table-title">🚩 Top 10 Defaulters (Highest Avg COD First)</span>
        <button class="btn-sm btn-primary" onclick="navigateTo('defaulter')">View Full Analysis →</button>
      </div>
      <div class="t-scroll">${empTableHTML(top10, true)}</div>
    </div>
  </div>`;

  // Charts
  const dLabels = dailyS.map(d=>d.day);
  const dVals = dailyS.map(d=>d.avg);
  buildChart('ov-daily', $('ov-daily'), lineConfig(dLabels,[{
    label:'Mean COD', data:dVals, borderColor:'#ff6b35',
    backgroundColor:'rgba(255,107,53,.15)', fill:true, pointBackgroundColor:'#ff6b35'
  }]));

  const bCounts = BUCKET_ORDER.map(b=>bktS.counts[b]||0);
  buildChart('ov-pie', $('ov-pie'), pieConfig(BUCKET_ORDER, bCounts, COD_COLS, {doughnut:true, legend:true}));

  const procS = calcGroupStats(data,'ppr_process_group',GF.threshold).sort((a,b)=>b.avg-a.avg).slice(0,10);
  buildChart('ov-proc', $('ov-proc'), barConfig(procS.map(p=>p.name), [{
    label:'Avg COD', data:procS.map(p=>p.avg),
    backgroundColor:procS.map((_,i)=>pColor(i)+'b0'), borderColor:procS.map((_,i)=>pColor(i)), borderWidth:1.5, borderRadius:5
  }], {horizontal:true}));

  const fS = floorS.filter(f=>f.name!=='null'&&f.name!=='NaN').sort((a,b)=>b.avg-a.avg);
  buildChart('ov-floor', $('ov-floor'), barConfig(fS.map(f=>'Floor '+f.name), [{
    label:'Avg COD', data:fS.map(f=>f.avg),
    backgroundColor:['#14b8a6b0','#6366f1b0','#ec4899b0','#f59e0bb0'], borderColor:['#14b8a6','#6366f1','#ec4899','#f59e0b'], borderWidth:1.5, borderRadius:5
  }]));

  const mS = modS.sort((a,b)=>b.avg-a.avg);
  buildChart('ov-mod', $('ov-mod'), barConfig(mS.map(m=>m.name), [{
    label:'Avg COD', data:mS.map(m=>m.avg),
    backgroundColor:mS.map((_,i)=>pColor(i)+'b0'), borderColor:mS.map((_,i)=>pColor(i)), borderWidth:1.5, borderRadius:5
  }]));
}

// ─── PAGE: DEFAULTER ANALYSIS ─────────────────────────────────────
let defPage=1, defPageSize=25, defSort='avg', defProcessSel='';

function renderDefaulter(c) {
  const data = DS.filtered;
  if (!data.length) { c.innerHTML = emptyState('No data'); return; }

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">🚩</span>Defaulter Analysis</div>
    <p class="page-desc">Associates ranked by changeover duration across current filters.</p>

    <div class="filter-row">
      <div class="ctrl-group"><span class="ctrl-lbl">Rank by</span>
        <select id="def-sort" class="ctrl-sel">
          <option value="avg" ${defSort==='avg'?'selected':''}>Avg COD (highest first)</option>
          <option value="sum" ${defSort==='sum'?'selected':''}>Total Minutes (highest first)</option>
        </select>
      </div>
      <div class="ctrl-group"><span class="ctrl-lbl">Min Events</span>
        <input type="number" id="def-min-ev" class="ctrl-inp" value="${GF.minEvents}" min="1" style="width:60px">
      </div>
      <div class="ctrl-group"><span class="ctrl-lbl">Show</span>
        <select id="def-top" class="ctrl-sel">
          <option value="10">Top 10</option>
          <option value="20">Top 20</option>
          <option value="50">Top 50</option>
          <option value="all">All Associates</option>
        </select>
      </div>
      <button class="btn-export" id="def-export">⬇ Export CSV</button>
    </div>
    <div id="def-table-container"></div>
  </div>`;

  renderDefTable(data);

  $('def-sort').addEventListener('change', e => { defSort=e.target.value; renderDefTable(data); });
  $('def-min-ev').addEventListener('change', e => {
    GF.minEvents = parseInt(e.target.value) || 1;
    if ($('gf-min-events')) $('gf-min-events').value = GF.minEvents;
    renderDefTable(data);
  });
  $('def-top').addEventListener('change', () => renderDefTable(data));
  $('def-export').addEventListener('click', () => exportDefaulters(data));
}

function renderDefTable(data) {
  let stats = calcEmpStats(data, GF.threshold).filter(e => e.count >= GF.minEvents);
  stats.sort((a,b) => b[defSort] - a[defSort]);
  const topVal = $('def-top')?.value || '10';
  if (topVal !== 'all') stats = stats.slice(0, parseInt(topVal));

  const activeProcess = GF.process || 'All Processes';
  const html = `
    <div class="table-wrap">
      <div class="table-header">
        <span class="table-title">${escHtml(activeProcess)} · ${fmtI(stats.length)} associates shown</span>
      </div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr>
            <th>#</th><th>Employee Login</th><th class="th-right">Events</th>
            <th class="th-right">Avg COD (min)</th>
            <th class="th-right">Total Min</th>
            <th>Shift</th><th>Top Process</th><th>Floors</th><th>MODs</th><th>Action</th>
          </tr></thead>
          <tbody>${stats.map((e,i) => `
            <tr>
              <td class="td-num">${i+1}</td>
              <td class="td-mono">${escHtml(e.login)}</td>
              <td class="td-num">${fmtI(e.count)}</td>
              <td class="td-num ${codClassTd(e.avg)}">${fmt(e.avg)}</td>
              <td class="td-num">${fmt(e.sum)}</td>
              <td>${e.shifts.join(', ') || '—'}</td>
              <td>${escHtml(e.freqProc)}</td>
              <td>${e.floors.join(', ')}</td>
              <td>${e.mods.join(', ')}</td>
              <td><button class="btn-sm btn-ghost" onclick="openEmp360('${escHtml(e.login)}')">360°</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  $('def-table-container').innerHTML = html;
}

function exportDefaulters(data) {
  const stats = calcEmpStats(data, GF.threshold).filter(e => e.count >= GF.minEvents).sort((a,b) => b.avg - a.avg);
  const rows = stats.map(e => ({
    login: e.login,
    avg_cod: e.avg,
    events: e.count,
    total_min: e.sum,
    shift: e.shifts.join(';'),
    top_process: e.freqProc,
    floors: e.floors.join(';'),
    mods: e.mods.join(';')
  }));
  exportCSV(rows, 'cod_defaulters.csv');
}

// ─── PAGE: PROCESS ANALYSIS ───────────────────────────────────────
function renderProcess(c) {
  const data = DS.filtered;
  if (!data.length) { c.innerHTML = emptyState('No data'); return; }
  const procStats = calcGroupStats(data,'ppr_process_group',GF.threshold).sort((a,b)=>b.avg-a.avg);

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">⚙</span>Process Analysis</div>
    <div class="grid-2-1 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Avg COD by Process</span></div>
        <div class="chart-wrap h320"><canvas id="proc-bar"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Event Share</span></div>
        <div class="chart-wrap h320"><canvas id="proc-pie"></canvas></div>
      </div>
    </div>
    <div class="table-wrap mb16">
      <div class="table-header"><span class="table-title">All Processes Summary</span></div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr>
            <th>#</th><th>Process</th><th class="th-right">Events</th><th class="th-right">Avg COD</th>
            <th class="th-right">Total Min</th>
            <th class="th-right">Employees</th><th>Drill-down</th>
          </tr></thead>
          <tbody>${procStats.map((p,i)=>`
            <tr>
              <td>${i+1}</td>
              <td><b>${escHtml(p.name)}</b></td>
              <td class="td-num">${fmtI(p.count)}</td>
              <td class="td-num ${codClassTd(p.avg)}">${fmt(p.avg)}</td>
              <td class="td-num">${fmt(p.sum)}</td>
              <td class="td-num">${fmtI(p.empCount)}</td>
              <td><button class="btn-sm btn-ghost" onclick="openProcessDrill('${escHtml(p.name)}')">Details →</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div id="process-drill-panel"></div>
  </div>`;

  buildChart('proc-bar', $('proc-bar'), barConfig(procStats.map(p=>p.name),[{
    label:'Avg COD', data:procStats.map(p=>p.avg),
    backgroundColor:procStats.map((_,i)=>pColor(i)+'b0'), borderColor:procStats.map((_,i)=>pColor(i)), borderWidth:1.5, borderRadius:5
  }],{horizontal:true}));

  buildChart('proc-pie', $('proc-pie'), pieConfig(procStats.map(p=>p.name), procStats.map(p=>p.count),
    procStats.map((_,i)=>pColor(i)), {doughnut:true, legend:false}));
}

window.closeDrillPanel = function(panelId) {
  const panel = $(panelId);
  if (panel) {
    const prev = panel.previousElementSibling;
    panel.innerHTML = '';
    if (prev) {
      prev.scrollIntoView({ behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
};

window.openProcessDrill = function(procName) {
  const data = DS.filtered.filter(r=>(r.ppr_process_group || 'Unassigned (No PPR Track)')===procName);
  const empStats = calcEmpStats(data,GF.threshold).filter(e=>e.count>=GF.minEvents).sort((a,b)=>b.avg-a.avg);
  const daily = calcDailyStats(data);
  const floors = calcGroupStats(data,'floor',GF.threshold);
  const mods = calcGroupStats(data,'mod_type',GF.threshold);
  const bkt = calcBucketStats(data);

  const html = `
    <div class="chart-card">
      <div class="card-header">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span class="card-title">⚙ ${escHtml(procName)} — Deep Dive</span>
          <span class="card-badge">${fmtI(data.length)} events · ${fmtI(empStats.length)} employees</span>
        </div>
        <button class="btn-sm btn-ghost" onclick="closeDrillPanel('process-drill-panel')" title="Close details" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;">✕ Close</button>
      </div>
      <div class="kpi-strip cols-3 mb16">
        ${kpiCard('⏱',fmt(calcStats(data)?.avg),'Avg COD')}
        ${kpiCard('👥',fmtI(empStats.length),'Employees')}
        ${kpiCard('📦',fmtI(data.length),'Events')}
      </div>
      <div class="grid-2 mb16">
        <div class="chart-card">
          <div class="card-header"><span class="card-title">Daily Trend</span></div>
          <div class="chart-wrap h180"><canvas id="pd-daily"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="card-header"><span class="card-title">Bucket Distribution</span></div>
          <div class="chart-wrap h180"><canvas id="pd-bkt"></canvas></div>
        </div>
      </div>
      <div class="grid-2 mb16">
        <div class="chart-card">
          <div class="card-header"><span class="card-title">By Floor</span></div>
          <div class="chart-wrap h180"><canvas id="pd-floor"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="card-header"><span class="card-title">By MOD</span></div>
          <div class="chart-wrap h180"><canvas id="pd-mod"></canvas></div>
        </div>
      </div>
      <div class="table-wrap">
        <div class="table-header"><span class="table-title">Top Employees in ${escHtml(procName)} (Highest Avg First)</span></div>
        <div class="t-scroll">${empTableHTML(empStats.slice(0,20), false)}</div>
      </div>
      <div style="display:flex;justify-content:center;margin-top:16px;">
        <button class="btn-sm btn-ghost" onclick="closeDrillPanel('process-drill-panel')" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 16px;">
          ✕ Close Details
        </button>
      </div>
    </div>`;

  const panel = $('process-drill-panel');
  if (panel) {
    panel.innerHTML = html;
    panel.scrollIntoView({ behavior: 'smooth' });
  }

  setTimeout(() => {
    if ($('pd-daily')) buildChart('pd-daily',$('pd-daily'),lineConfig(daily.map(d=>d.day),[{
      label:'Avg COD',data:daily.map(d=>d.avg),borderColor:'#4facfe',
      backgroundColor:'rgba(79,172,254,.15)',fill:true,pointBackgroundColor:'#4facfe'}]));
    if ($('pd-bkt')) buildChart('pd-bkt',$('pd-bkt'),pieConfig(BUCKET_ORDER,
      BUCKET_ORDER.map(b=>bkt.counts[b]||0),COD_COLS,{doughnut:true,legend:false}));
    if ($('pd-floor')) buildChart('pd-floor',$('pd-floor'),barConfig(floors.map(f=>`Floor ${f.name}`),[{
      label:'Avg COD',data:floors.map(f=>f.avg),
      backgroundColor:floors.map((_,i)=>pColor(i)+'b0'),borderColor:floors.map((_,i)=>pColor(i)),borderWidth:1.5,borderRadius:5
    }]));
    if ($('pd-mod')) buildChart('pd-mod',$('pd-mod'),barConfig(mods.map(m=>`MOD ${m.name}`),[{
      label:'Avg COD',data:mods.map(m=>m.avg),
      backgroundColor:mods.map((_,i)=>pColor(i)+'b0'),borderColor:mods.map((_,i)=>pColor(i)),borderWidth:1.5,borderRadius:5
    }]));
  }, 50);
};

// ─── PAGE: DAILY ANALYSIS ─────────────────────────────────────────
function renderDaily(c) {
  const data = DS.filtered;
  if (!data.length) { c.innerHTML = emptyState('No data'); return; }
  const daily = calcDailyStats(data);
  const days = daily.map(d => d.day);

  // Single-pass aggregation across all records for daily analysis
  const empByDay = {};
  const empOverall = {};
  const dayStatsMap = {};
  const procDayMap = {};
  const floorDayMap = {};

  data.forEach(r => {
    const day = r.processed_day;
    const emp = r.employeelogin;
    const cod = r.change_over_time_minutes;

    // Emp x Day
    if (!empByDay[emp]) empByDay[emp] = {};
    if (!empByDay[emp][day]) empByDay[emp][day] = { sum: 0, count: 0 };
    empByDay[emp][day].sum += cod;
    empByDay[emp][day].count++;

    // Emp overall
    if (!empOverall[emp]) empOverall[emp] = { sum: 0, count: 0 };
    empOverall[emp].sum += cod;
    empOverall[emp].count++;

    // Day emp stats for Top Defaulters
    if (!dayStatsMap[day]) dayStatsMap[day] = {};
    if (!dayStatsMap[day][emp]) dayStatsMap[day][emp] = { sum: 0, count: 0, hiCount: 0 };
    dayStatsMap[day][emp].sum += cod;
    dayStatsMap[day][emp].count++;
    if (cod >= GF.threshold) dayStatsMap[day][emp].hiCount++;

    // Process Day
    if (r.ppr_process_group) {
      const p = r.ppr_process_group;
      if (!procDayMap[p]) procDayMap[p] = {};
      if (!procDayMap[p][day]) procDayMap[p][day] = { sum: 0, count: 0 };
      procDayMap[p][day].sum += cod;
      procDayMap[p][day].count++;
    }

    // Floor Day
    if (r.floor !== null && r.floor !== undefined) {
      const f = r.floor;
      if (!floorDayMap[f]) floorDayMap[f] = {};
      if (!floorDayMap[f][day]) floorDayMap[f][day] = { sum: 0, count: 0 };
      floorDayMap[f][day].sum += cod;
      floorDayMap[f][day].count++;
    }
  });

  // Calculate top defaulter per day efficiently
  const topPerDay = days.map(day => {
    const dayEmps = dayStatsMap[day] || {};
    let topEmp = null;
    let maxAvg = -1;
    Object.entries(dayEmps).forEach(([login, st]) => {
      if (st.count >= GF.minEvents) {
        const avg = st.sum / st.count;
        if (avg > maxAvg) {
          maxAvg = avg;
          topEmp = { login, count: st.count, avg: +avg.toFixed(2), hiCount: st.hiCount };
        }
      }
    });
    return { day, top: topEmp };
  }).filter(d => d.top);

  // Sorted list of employees
  const allEmployees = Object.keys(empOverall).sort();
  const maxInitialRows = 100;
  const initialEmployees = allEmployees.slice(0, maxInitialRows);

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">📅</span>Daily Analysis</div>
    <p class="page-desc">${days.length} days in selected range &bull; ${fmtI(allEmployees.length)} active associates</p>
    
    <div class="chart-card mb16">
      <div class="card-header"><span class="card-title">Daily Average COD Trend</span><span class="card-badge">All Employees</span></div>
      <div class="chart-wrap h280"><canvas id="daily-trend"></canvas></div>
    </div>
    
    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Daily Trend by Process</span></div>
        <div class="chart-wrap h280"><canvas id="daily-proc"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Daily Trend by Floor</span></div>
        <div class="chart-wrap h280"><canvas id="daily-floor"></canvas></div>
      </div>
    </div>

    <div class="table-wrap mb16">
      <div class="table-header">
        <span class="table-title">Top Defaulter Each Day</span>
      </div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr><th>Date</th><th>Top Employee</th><th class="th-right">Events</th><th class="th-right">Avg COD</th><th>Action</th></tr></thead>
          <tbody>${topPerDay.map(d=>`
            <tr>
              <td><b>${d.day}</b></td>
              <td class="td-mono">${escHtml(d.top.login)}</td>
              <td class="td-num">${fmtI(d.top.count)}</td>
              <td class="td-num ${codClassTd(d.top.avg)}">${fmt(d.top.avg)}</td>
              <td><button class="btn-sm btn-ghost" onclick="openEmp360('${escHtml(d.top.login)}')">360°</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="table-wrap">
      <div class="table-header">
        <span class="table-title">Employee × Day Matrix (Avg COD)</span>
        <span class="card-badge" id="daily-matrix-badge">Showing ${Math.min(maxInitialRows, allEmployees.length)} of ${fmtI(allEmployees.length)}</span>
      </div>
      <div class="t-scroll" style="max-height: 480px;">
        <table class="data-table">
          <thead><tr>
            <th>Employee</th>
            ${days.map(d=>`<th class="th-right">${d.slice(5)}</th>`).join('')}
            <th class="th-right">Overall</th>
          </tr></thead>
          <tbody id="daily-matrix-tbody">
            ${renderMatrixRows(initialEmployees, days, empByDay, empOverall)}
          </tbody>
        </table>
      </div>
      ${allEmployees.length > maxInitialRows ? `
        <div style="padding: 10px 16px; text-align: center; border-top: 1px solid var(--border);">
          <button id="btn-load-all-matrix" class="btn-sm btn-ghost" style="padding: 6px 18px; font-weight:700;">
            Load all ${fmtI(allEmployees.length)} employees
          </button>
        </div>
      ` : ''}
    </div>
  </div>`;

  // Attach "Load all" button listener if needed
  const btnLoadAll = $('btn-load-all-matrix');
  if (btnLoadAll) {
    btnLoadAll.addEventListener('click', () => {
      btnLoadAll.disabled = true;
      btnLoadAll.textContent = 'Rendering all rows...';
      setTimeout(() => {
        const tbody = $('daily-matrix-tbody');
        if (tbody) {
          tbody.innerHTML = renderMatrixRows(allEmployees, days, empByDay, empOverall);
        }
        $('daily-matrix-badge').textContent = `${fmtI(allEmployees.length)} employees`;
        btnLoadAll.parentElement.remove();
      }, 30);
    });
  }

  // Charts
  buildChart('daily-trend', $('daily-trend'), lineConfig(daily.map(d=>d.day), [{
    label: 'Mean COD', data: daily.map(d=>d.avg), borderColor: '#ff6b35',
    backgroundColor: 'rgba(255,107,53,.15)', fill: true, pointBackgroundColor: '#ff6b35'
  }]));

  // Process daily lines
  const procList = DS.processes.filter(p => procDayMap[p]).slice(0, 7);
  buildChart('daily-proc', $('daily-proc'), lineConfig(days, procList.map((p, i) => {
    const pDays = procDayMap[p] || {};
    return {
      label: p, borderColor: pColor(i), backgroundColor: 'transparent',
      data: days.map(day => {
        const st = pDays[day];
        return st && st.count ? +(st.sum / st.count).toFixed(2) : null;
      }),
      spanGaps: true
    };
  }), { legend: true }));

  // Floor daily lines
  const floorList = DS.floors.slice(0, 5);
  buildChart('daily-floor', $('daily-floor'), lineConfig(days, floorList.map((f, i) => {
    const fDays = floorDayMap[f] || {};
    return {
      label: 'Floor ' + f, borderColor: pColor(i + 4), backgroundColor: 'transparent',
      data: days.map(day => {
        const st = fDays[day];
        return st && st.count ? +(st.sum / st.count).toFixed(2) : null;
      }),
      spanGaps: true
    };
  }), { legend: true }));
}

function renderMatrixRows(empList, days, empByDay, empOverall) {
  return empList.map(emp => {
    const ov = empOverall[emp];
    const ovAvg = ov && ov.count ? +(ov.sum / ov.count).toFixed(2) : null;
    return `<tr>
      <td class="td-mono">${escHtml(emp)}</td>
      ${days.map(day => {
        const st = empByDay[emp]?.[day];
        if (!st || !st.count) return '<td class="td-num" style="color:var(--text3)">—</td>';
        const avg = st.sum / st.count;
        return `<td class="td-num ${codClassTd(avg)}">${fmt(avg, 1)}</td>`;
      }).join('')}
      <td class="td-num ${codClassTd(ovAvg)}">${fmt(ovAvg)}</td>
    </tr>`;
  }).join('');
}

// ─── PAGE: WEEKLY ANALYSIS ────────────────────────────────────────
function renderWeekly(c) {
  const data = DS.filtered;
  if (!data.length) { c.innerHTML = emptyState('No data'); return; }
  const weekly = calcWeeklyStats(data);
  const weeks = weekly.map(w=>w.week);

  // WoW change
  const wowRows = weekly.map((w,i) => {
    const prev = weekly[i-1];
    const delta = prev ? +(w.avg - prev.avg).toFixed(2) : null;
    const deltaPct = prev ? +((delta/prev.avg)*100).toFixed(1) : null;
    return { ...w, delta, deltaPct };
  });

  const procList = DS.processes.filter(p=>data.some(r=>r.ppr_process_group===p)).slice(0,7);

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">📆</span>Weekly Analysis</div>
    <p class="page-desc">${weeks.length} weeks in selected range</p>
    <div class="chart-card mb16">
      <div class="card-header"><span class="card-title">Weekly Average COD Trend</span></div>
      <div class="chart-wrap h260"><canvas id="wk-trend"></canvas></div>
    </div>
    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Weekly by Process</span></div>
        <div class="chart-wrap h280"><canvas id="wk-proc"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Weekly by Floor</span></div>
        <div class="chart-wrap h280"><canvas id="wk-floor"></canvas></div>
      </div>
    </div>
    <div class="table-wrap mb16">
      <div class="table-header"><span class="table-title">Week-over-Week Analysis</span></div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr>
            <th>Week</th><th>Start Date</th><th class="th-right">Events</th>
            <th class="th-right">Avg COD</th>
            <th class="th-right">vs Prev Week (min)</th><th class="th-right">vs Prev Week (%)</th>
          </tr></thead>
          <tbody>${wowRows.map(w=>`
            <tr>
              <td><b>${escHtml(w.week)}</b></td>
              <td>${w.weekStart}</td>
              <td class="td-num">${fmtI(w.count)}</td>
              <td class="td-num ${codClassTd(w.avg)}">${fmt(w.avg)}</td>
              <td class="td-num ${w.delta===null?'':w.delta>0?'td-bad':'td-good'}">${w.delta===null?'—':(w.delta>0?'+':'')+fmt(w.delta)}</td>
              <td class="td-num ${w.deltaPct===null?'':w.deltaPct>0?'td-bad':'td-good'}">${w.deltaPct===null?'—':(w.deltaPct>0?'+':'')+fmtPct(w.deltaPct)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="table-wrap">
      <div class="table-header"><span class="table-title">Top Defaulter Each Week</span></div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr><th>Week</th><th>Top Employee</th><th class="th-right">Avg COD</th><th class="th-right">Events</th><th>Action</th></tr></thead>
          <tbody>${weeks.map(wk=>{
            const wdata = data.filter(r=>r.week_number===wk);
            const es = calcEmpStats(wdata,GF.threshold).filter(e=>e.count>=GF.minEvents).sort((a,b)=>b.avg-a.avg);
            const top = es[0];
            if (!top) return '';
            return `<tr>
              <td><b>${escHtml(wk)}</b></td>
              <td class="td-mono">${escHtml(top.login)}</td>
              <td class="td-num ${codClassTd(top.avg)}">${fmt(top.avg)}</td>
              <td class="td-num">${fmtI(top.count)}</td>
              <td><button class="btn-sm btn-ghost" onclick="openEmp360('${escHtml(top.login)}')">360°</button></td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;

  buildChart('wk-trend',$('wk-trend'),lineConfig(weeks,[{
    label:'Avg COD',data:weekly.map(w=>w.avg),borderColor:'#a855f7',
    backgroundColor:'rgba(168,85,247,.15)',fill:true,pointBackgroundColor:'#a855f7'}]));

  buildChart('wk-proc',$('wk-proc'),lineConfig(weeks,procList.map((p,i)=>{
    const pData = data.filter(r=>r.ppr_process_group===p);
    return {
      label:p, borderColor:pColor(i), backgroundColor:'transparent',
      data:weeks.map(wk=>{ const recs=pData.filter(r=>r.week_number===wk); return recs.length?+(recs.reduce((a,b)=>a+b.change_over_time_minutes,0)/recs.length).toFixed(2):null; }),
      spanGaps:true
    };
  }),{legend:true}));

  buildChart('wk-floor',$('wk-floor'),lineConfig(weeks,DS.floors.slice(0,5).map((f,i)=>{
    const fData = data.filter(r=>r.floor===f);
    return {
      label:'Floor '+f, borderColor:pColor(i+4), backgroundColor:'transparent',
      data:weeks.map(wk=>{ const recs=fData.filter(r=>r.week_number===wk); return recs.length?+(recs.reduce((a,b)=>a+b.change_over_time_minutes,0)/recs.length).toFixed(2):null; }),
      spanGaps:true
    };
  }),{legend:true}));
}

// ─── PAGE: FLOOR ANALYSIS ─────────────────────────────────────────
function renderFloor(c) {
  const data = DS.filtered;
  if (!data.length) { c.innerHTML = emptyState('No data'); return; }
  const floorStats = calcGroupStats(data,'floor',GF.threshold).filter(f=>f.name!=='null'&&!isNaN(f.name)).sort((a,b)=>a.name-b.name);

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">🏢</span>Floor Analysis</div>
    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Avg COD by Floor</span></div>
        <div class="chart-wrap h240"><canvas id="fl-bar"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Event Distribution by Floor</span></div>
        <div class="chart-wrap h240"><canvas id="fl-pie"></canvas></div>
      </div>
    </div>
    <div class="table-wrap mb16">
      <div class="table-header"><span class="table-title">Floor Summary</span></div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr>
            <th>Floor</th><th class="th-right">Events</th><th class="th-right">Avg COD</th>
            <th class="th-right">Total Min</th>
            <th class="th-right">Employees</th><th>Drill-down</th>
          </tr></thead>
          <tbody>${floorStats.map(f=>`
            <tr>
              <td><b>Floor ${f.name}</b></td>
              <td class="td-num">${fmtI(f.count)}</td>
              <td class="td-num ${codClassTd(f.avg)}">${fmt(f.avg)}</td>
              <td class="td-num">${fmt(f.sum)}</td>
              <td class="td-num">${fmtI(f.empCount)}</td>
              <td><button class="btn-sm btn-ghost" onclick="openFloorDrill(${f.name})">Details →</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div id="floor-drill-panel"></div>
  </div>`;

  buildChart('fl-bar',$('fl-bar'),barConfig(floorStats.map(f=>'Floor '+f.name),[{
    label:'Avg COD',data:floorStats.map(f=>f.avg),
    backgroundColor:['#14b8a6b0','#6366f1b0','#ec4899b0','#f59e0bb0'].slice(0,floorStats.length),
    borderColor:['#14b8a6','#6366f1','#ec4899','#f59e0b'].slice(0,floorStats.length),
    borderWidth:2,borderRadius:8}]));

  buildChart('fl-pie',$('fl-pie'),pieConfig(floorStats.map(f=>'Floor '+f.name),floorStats.map(f=>f.count),
    ['#14b8a6','#6366f1','#ec4899','#f59e0b'],{doughnut:true,legend:true}));
}

window.openFloorDrill = function(floorNum) {
  const data = DS.filtered.filter(r=>r.floor===floorNum);
  const empStats = calcEmpStats(data,GF.threshold).filter(e=>e.count>=GF.minEvents).sort((a,b)=>b.avg-a.avg);
  const daily = calcDailyStats(data);
  const bkt = calcBucketStats(data);
  const procS = calcGroupStats(data,'ppr_process_group',GF.threshold).sort((a,b)=>b.avg-a.avg);
  const modS  = calcGroupStats(data,'mod_type',GF.threshold).sort((a,b)=>b.avg-a.avg);

  const html = `
    <div class="chart-card">
      <div class="card-header">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span class="card-title">🏢 Floor ${floorNum} — Deep Dive</span>
          <span class="card-badge">${fmtI(data.length)} events</span>
        </div>
        <button class="btn-sm btn-ghost" onclick="closeDrillPanel('floor-drill-panel')" title="Close details" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;">✕ Close</button>
      </div>
      <div class="kpi-strip cols-3 mb16">
        ${kpiCard('⏱',fmt(calcStats(data)?.avg),'Avg COD')}
        ${kpiCard('👥',fmtI(empStats.length),'Employees')}
        ${kpiCard('📦',fmtI(data.length),'Events')}
      </div>
      <div class="grid-2 mb16">
        <div class="chart-card">
          <div class="card-header"><span class="card-title">Daily Trend</span></div>
          <div class="chart-wrap h180"><canvas id="fld-daily"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="card-header"><span class="card-title">Bucket Distribution</span></div>
          <div class="chart-wrap h180"><canvas id="fld-bkt"></canvas></div>
        </div>
      </div>
      <div class="grid-2 mb16">
        <div class="chart-card">
          <div class="card-header"><span class="card-title">By Process</span></div>
          <div class="chart-wrap h180"><canvas id="fld-proc"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="card-header"><span class="card-title">By MOD</span></div>
          <div class="chart-wrap h180"><canvas id="fld-mod"></canvas></div>
        </div>
      </div>
      <div class="table-wrap">
        <div class="table-header"><span class="table-title">Top Employees on Floor ${floorNum}</span></div>
        <div class="t-scroll">${empTableHTML(empStats.slice(0,20),false)}</div>
      </div>
      <div style="display:flex;justify-content:center;margin-top:16px;">
        <button class="btn-sm btn-ghost" onclick="closeDrillPanel('floor-drill-panel')" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 16px;">
          ✕ Close Details
        </button>
      </div>
    </div>`;
  $('floor-drill-panel').innerHTML = html;
  $('floor-drill-panel').scrollIntoView({behavior:'smooth'});

  setTimeout(()=>{
    if($('fld-daily')) buildChart('fld-daily',$('fld-daily'),lineConfig(daily.map(d=>d.day),[{
      label:'Avg COD',data:daily.map(d=>d.avg),borderColor:'#14b8a6',
      backgroundColor:'rgba(20,184,166,.15)',fill:true,pointBackgroundColor:'#14b8a6'}]));
    if($('fld-bkt')) buildChart('fld-bkt',$('fld-bkt'),pieConfig(BUCKET_ORDER,
      BUCKET_ORDER.map(b=>bkt.counts[b]||0),COD_COLS,{doughnut:true,legend:false}));
    if($('fld-proc')) buildChart('fld-proc',$('fld-proc'),barConfig(procS.map(p=>p.name),[{
      label:'Avg COD',data:procS.map(p=>p.avg),
      backgroundColor:procS.map((_,i)=>pColor(i)+'b0'),borderColor:procS.map((_,i)=>pColor(i)),borderWidth:1.5,borderRadius:5
    }],{horizontal:true}));
    if($('fld-mod')) buildChart('fld-mod',$('fld-mod'),barConfig(modS.map(m=>m.name),[{
      label:'Avg COD',data:modS.map(m=>m.avg),
      backgroundColor:modS.map((_,i)=>pColor(i)+'b0'),borderColor:modS.map((_,i)=>pColor(i)),borderWidth:1.5,borderRadius:5
    }]));
  },50);
};

// ─── PAGE: MOD ANALYSIS ───────────────────────────────────────────
function renderMod(c) {
  const data = DS.filtered;
  if (!data.length) { c.innerHTML = emptyState('No data'); return; }
  const modStats = calcGroupStats(data,'mod_type',GF.threshold).sort((a,b)=>b.avg-a.avg);

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">📦</span>MOD Analysis</div>
    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Avg COD by MOD Type</span></div>
        <div class="chart-wrap h280"><canvas id="mod-bar"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Event Share by MOD</span></div>
        <div class="chart-wrap h280"><canvas id="mod-pie"></canvas></div>
      </div>
    </div>
    <div class="table-wrap mb16">
      <div class="table-header"><span class="table-title">MOD Summary</span></div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr>
            <th>MOD</th><th class="th-right">Events</th><th class="th-right">Avg COD</th>
            <th class="th-right">Total Min</th>
            <th class="th-right">Employees</th><th>Drill-down</th>
          </tr></thead>
          <tbody>${modStats.map(m=>`
            <tr>
              <td><b>MOD ${m.name}</b></td>
              <td class="td-num">${fmtI(m.count)}</td>
              <td class="td-num ${codClassTd(m.avg)}">${fmt(m.avg)}</td>
              <td class="td-num">${fmt(m.sum)}</td>
              <td class="td-num">${fmtI(m.empCount)}</td>
              <td><button class="btn-sm btn-ghost" onclick="openModDrill('${escHtml(m.name)}')">Details →</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div id="mod-drill-panel"></div>
  </div>`;

  buildChart('mod-bar',$('mod-bar'),barConfig(modStats.map(m=>m.name),[{
    label:'Avg COD',data:modStats.map(m=>m.avg),
    backgroundColor:modStats.map((_,i)=>pColor(i)+'b0'),borderColor:modStats.map((_,i)=>pColor(i)),borderWidth:1.5,borderRadius:8}]));

  buildChart('mod-pie',$('mod-pie'),pieConfig(modStats.map(m=>m.name),modStats.map(m=>m.count),
    modStats.map((_,i)=>pColor(i)),{doughnut:true,legend:true}));
}

window.openModDrill = function(modName) {
  const data = DS.filtered.filter(r=>r.mod_type===modName);
  const empStats = calcEmpStats(data,GF.threshold).filter(e=>e.count>=GF.minEvents).sort((a,b)=>b.avg-a.avg);
  const daily = calcDailyStats(data);
  const bkt = calcBucketStats(data);
  const procS = calcGroupStats(data,'ppr_process_group',GF.threshold).sort((a,b)=>b.avg-a.avg);

  const html = `
    <div class="chart-card">
      <div class="card-header">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span class="card-title">📦 MOD ${escHtml(modName)} — Deep Dive</span>
          <span class="card-badge">${fmtI(data.length)} events</span>
        </div>
        <button class="btn-sm btn-ghost" onclick="closeDrillPanel('mod-drill-panel')" title="Close details" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;">✕ Close</button>
      </div>
      <div class="kpi-strip cols-3 mb16">
        ${kpiCard('⏱',fmt(calcStats(data)?.avg),'Avg COD')}
        ${kpiCard('👥',fmtI(empStats.length),'Employees')}
        ${kpiCard('📦',fmtI(data.length),'Events')}
      </div>
      <div class="grid-2 mb16">
        <div class="chart-card">
          <div class="card-header"><span class="card-title">Daily Trend</span></div>
          <div class="chart-wrap h180"><canvas id="mdd-daily"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="card-header"><span class="card-title">Bucket Distribution</span></div>
          <div class="chart-wrap h180"><canvas id="mdd-bkt"></canvas></div>
        </div>
      </div>
      <div class="table-wrap">
        <div class="table-header"><span class="table-title">Top Employees in MOD ${escHtml(modName)}</span></div>
        <div class="t-scroll">${empTableHTML(empStats.slice(0,20),false)}</div>
      </div>
      <div style="display:flex;justify-content:center;margin-top:16px;">
        <button class="btn-sm btn-ghost" onclick="closeDrillPanel('mod-drill-panel')" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 16px;">
          ✕ Close Details
        </button>
      </div>
    </div>`;
  $('mod-drill-panel').innerHTML = html;
  $('mod-drill-panel').scrollIntoView({behavior:'smooth'});
  setTimeout(()=>{
    if($('mdd-daily')) buildChart('mdd-daily',$('mdd-daily'),lineConfig(daily.map(d=>d.day),[{
      label:'Avg COD',data:daily.map(d=>d.avg),borderColor:'#f59e0b',
      backgroundColor:'rgba(245,158,11,.15)',fill:true,pointBackgroundColor:'#f59e0b'}]));
    if($('mdd-bkt')) buildChart('mdd-bkt',$('mdd-bkt'),pieConfig(BUCKET_ORDER,
      BUCKET_ORDER.map(b=>bkt.counts[b]||0),COD_COLS,{doughnut:true,legend:false}));
  },50);
};

// ─── PAGE: BIN ANALYSIS (Bin Type & Bin Usage) ────────────────────
function renderBin(c) {
  const data = DS.filtered;
  if (!data.length) { c.innerHTML = emptyState('No data'); return; }

  const typeStats = calcGroupStats(data, 'lc_category', GF.threshold)
    .filter(t => t.name && t.name !== 'Unknown')
    .sort((a,b) => b.avg - a.avg);

  const usageStats = calcGroupStats(data, 'bin_usage_type', GF.threshold)
    .filter(u => u.name && u.name !== 'Unknown')
    .sort((a,b) => b.avg - a.avg);

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">&#128452;</span>Bin Analysis (Bin Type &amp; Bin Usage)</div>

    <!-- KPI SUMMARY -->
    <div class="kpi-strip cols-4 mb16">
      ${kpiCard('🗂', fmtI(typeStats.length), 'Active Bin Types')}
      ${kpiCard('🏷', fmtI(usageStats.length), 'Bin Usage Categories')}
      ${kpiCard('⏱', fmt(calcStats(data)?.avg), 'Overall Avg COD (min)')}
      ${kpiCard('📦', fmtI(data.length), 'Total Stowed Events')}
    </div>

    <!-- CHARTS: BIN TYPE vs BIN USAGE -->
    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Avg COD by Bin Type (lc_category)</span></div>
        <div class="chart-wrap h280"><canvas id="bintype-bar"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Event Share by Bin Type</span></div>
        <div class="chart-wrap h280"><canvas id="bintype-pie"></canvas></div>
      </div>
    </div>

    <!-- BIN TYPE DATA TABLE -->
    <div class="table-wrap mb24">
      <div class="table-header">
        <span class="table-title">Bin Type Performance (lc_category)</span>
        <span class="card-badge">${fmtI(typeStats.length)} types</span>
      </div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr>
            <th>Bin Type</th><th class="th-right">Events</th><th class="th-right">Avg COD</th>
            <th class="th-right">Total Min</th><th class="th-right">Employees</th><th>Drill-down</th>
          </tr></thead>
          <tbody>${typeStats.map(t=>`
            <tr>
              <td><b>${escHtml(t.name)}</b></td>
              <td class="td-num">${fmtI(t.count)}</td>
              <td class="td-num ${codClassTd(t.avg)}">${fmt(t.avg)}</td>
              <td class="td-num">${fmt(t.sum)}</td>
              <td class="td-num">${fmtI(t.empCount)}</td>
              <td><button class="btn-sm btn-ghost" onclick="openBinDrill('lc_category','${escHtml(t.name)}')">Details →</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- CHARTS: BIN USAGE -->
    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Avg COD by Bin Usage (bin_usage_type)</span></div>
        <div class="chart-wrap h280"><canvas id="binusage-bar"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Event Share by Bin Usage</span></div>
        <div class="chart-wrap h280"><canvas id="binusage-pie"></canvas></div>
      </div>
    </div>

    <!-- BIN USAGE DATA TABLE -->
    <div class="table-wrap mb16">
      <div class="table-header">
        <span class="table-title">Bin Usage Performance (bin_usage_type)</span>
        <span class="card-badge">${fmtI(usageStats.length)} categories</span>
      </div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr>
            <th>Bin Usage</th><th class="th-right">Events</th><th class="th-right">Avg COD</th>
            <th class="th-right">Total Min</th><th class="th-right">Employees</th><th>Drill-down</th>
          </tr></thead>
          <tbody>${usageStats.map(u=>`
            <tr>
              <td><b>${escHtml(u.name)}</b></td>
              <td class="td-num">${fmtI(u.count)}</td>
              <td class="td-num ${codClassTd(u.avg)}">${fmt(u.avg)}</td>
              <td class="td-num">${fmt(u.sum)}</td>
              <td class="td-num">${fmtI(u.empCount)}</td>
              <td><button class="btn-sm btn-ghost" onclick="openBinDrill('bin_usage_type','${escHtml(u.name)}')">Details →</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div id="bin-drill-panel"></div>
  </div>`;

  // Render Bin Type charts
  buildChart('bintype-bar', $('bintype-bar'), barConfig(typeStats.map(t=>t.name), [{
    label: 'Avg COD', data: typeStats.map(t=>t.avg),
    backgroundColor: typeStats.map((_,i)=>pColor(i)+'b0'), borderColor: typeStats.map((_,i)=>pColor(i)), borderWidth: 1.5, borderRadius: 6
  }], { horizontal: true }));

  buildChart('bintype-pie', $('bintype-pie'), pieConfig(typeStats.map(t=>t.name), typeStats.map(t=>t.count),
    typeStats.map((_,i)=>pColor(i)), { doughnut: true, legend: true }));

  // Render Bin Usage charts
  buildChart('binusage-bar', $('binusage-bar'), barConfig(usageStats.map(u=>u.name), [{
    label: 'Avg COD', data: usageStats.map(u=>u.avg),
    backgroundColor: usageStats.map((_,i)=>pColor(i+5)+'b0'), borderColor: usageStats.map((_,i)=>pColor(i+5)), borderWidth: 1.5, borderRadius: 6
  }]));

  buildChart('binusage-pie', $('binusage-pie'), pieConfig(usageStats.map(u=>u.name), usageStats.map(u=>u.count),
    usageStats.map((_,i)=>pColor(i+5)), { doughnut: true, legend: true }));
}

window.openBinDrill = function(field, val) {
  const isType = field === 'lc_category';
  const label = isType ? 'Bin Type' : 'Bin Usage';
  const data = DS.filtered.filter(r => r[field] === val);
  const empStats = calcEmpStats(data, GF.threshold).filter(e => e.count >= GF.minEvents).sort((a,b) => b.avg - a.avg);
  const daily = calcDailyStats(data);
  const bkt = calcBucketStats(data);
  const floorS = calcGroupStats(data, 'floor', GF.threshold).filter(f => f.name !== 'null' && !isNaN(f.name)).sort((a,b) => a.name - b.name);
  const modS = calcGroupStats(data, 'mod_type', GF.threshold).sort((a,b) => b.avg - a.avg);

  const html = `
    <div class="chart-card">
      <div class="card-header">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span class="card-title">&#128452; ${label}: ${escHtml(val)} — Deep Dive</span>
          <span class="card-badge">${fmtI(data.length)} events</span>
        </div>
        <button class="btn-sm btn-ghost" onclick="closeDrillPanel('bin-drill-panel')" title="Close details" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;">✕ Close</button>
      </div>
      <div class="kpi-strip cols-3 mb16">
        ${kpiCard('⏱', fmt(calcStats(data)?.avg), 'Avg COD')}
        ${kpiCard('👥', fmtI(empStats.length), 'Employees')}
        ${kpiCard('📦', fmtI(data.length), 'Events')}
      </div>
      <div class="grid-2 mb16">
        <div class="chart-card">
          <div class="card-header"><span class="card-title">Daily Trend</span></div>
          <div class="chart-wrap h180"><canvas id="bd-daily"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="card-header"><span class="card-title">COD Bucket Breakdown</span></div>
          <div class="chart-wrap h180"><canvas id="bd-bkt"></canvas></div>
        </div>
      </div>
      <div class="grid-2 mb16">
        <div class="chart-card">
          <div class="card-header"><span class="card-title">Floor Breakdown</span></div>
          <div class="chart-wrap h180"><canvas id="bd-floor"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="card-header"><span class="card-title">MOD Breakdown</span></div>
          <div class="chart-wrap h180"><canvas id="bd-mod"></canvas></div>
        </div>
      </div>
      <div class="table-wrap">
        <div class="table-header"><span class="table-title">Top Employees in ${label}: ${escHtml(val)}</span></div>
        <div class="t-scroll">${empTableHTML(empStats.slice(0, 20), false)}</div>
      </div>
      <div style="display:flex;justify-content:center;margin-top:16px;">
        <button class="btn-sm btn-ghost" onclick="closeDrillPanel('bin-drill-panel')" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 16px;">
          ✕ Close Details
        </button>
      </div>
    </div>`;

  $('bin-drill-panel').innerHTML = html;
  $('bin-drill-panel').scrollIntoView({ behavior: 'smooth' });

  setTimeout(() => {
    if ($('bd-daily')) buildChart('bd-daily', $('bd-daily'), lineConfig(daily.map(d=>d.day), [{
      label: 'Avg COD', data: daily.map(d=>d.avg), borderColor: '#14b8a6',
      backgroundColor: 'rgba(20,184,166,.15)', fill: true, pointBackgroundColor: '#14b8a6'
    }]));
    if ($('bd-bkt')) buildChart('bd-bkt', $('bd-bkt'), pieConfig(BUCKET_ORDER,
      BUCKET_ORDER.map(b=>bkt.counts[b]||0), COD_COLS, { doughnut: true, legend: false }));
    if ($('bd-floor')) buildChart('bd-floor', $('bd-floor'), barConfig(floorS.map(f=>'Floor '+f.name), [{
      label: 'Avg COD', data: floorS.map(f=>f.avg),
      backgroundColor: floorS.map((_,i)=>pColor(i)+'b0'), borderColor: floorS.map((_,i)=>pColor(i)), borderWidth: 1.5, borderRadius: 5
    }]));
    if ($('bd-mod')) buildChart('bd-mod', $('bd-mod'), barConfig(modS.map(m=>m.name), [{
      label: 'Avg COD', data: modS.map(m=>m.avg),
      backgroundColor: modS.map((_,i)=>pColor(i+2)+'b0'), borderColor: modS.map((_,i)=>pColor(i+2)), borderWidth: 1.5, borderRadius: 5
    }]));
  }, 50);
};

// ─── PAGE: COD BUCKET ANALYSIS ────────────────────────────────────
function renderBucket(c) {
  const data = DS.filtered;
  if (!data.length) { c.innerHTML = emptyState('No data'); return; }
  const bkt = calcBucketStats(data);
  const total = data.length;
  const daily = calcDailyStats(data);
  const weekly = calcWeeklyStats(data);

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">⭐</span>COD Bucket Analysis</div>
    <div class="kpi-strip cols-6 mb16">
      ${BUCKET_ORDER.map(b=>{
        const cnt = bkt.counts[b]||0;
        const pct = (cnt/total*100).toFixed(1);
        return kpiCard('',fmtPct(parseFloat(pct)),b,'','');
      }).join('')}
    </div>
    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Bucket Distribution (Count)</span></div>
        <div class="chart-wrap h280"><canvas id="bkt-pie"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Total Changeover Time by Bucket</span></div>
        <div class="chart-wrap h280"><canvas id="bkt-sum-bar"></canvas></div>
      </div>
    </div>
    <div class="chart-card mb16">
      <div class="card-header"><span class="card-title">Daily Bucket Trend (Stacked %)</span></div>
      <div class="chart-wrap h300"><canvas id="bkt-daily-stack"></canvas></div>
    </div>
    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Bucket by Process (Avg %)</span></div>
        <div class="chart-wrap h300"><canvas id="bkt-proc-stack"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Bucket by Floor</span></div>
        <div class="chart-wrap h300"><canvas id="bkt-floor-stack"></canvas></div>
      </div>
    </div>
    <div class="table-wrap">
      <div class="table-header"><span class="table-title">Bucket Summary Table</span></div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr><th>Bucket</th><th class="th-right">Count</th><th class="th-right">%</th><th class="th-right">Total Time (min)</th><th class="th-right">Avg Duration (min)</th></tr></thead>
          <tbody>${BUCKET_ORDER.map(b=>{
            const cnt=bkt.counts[b]||0; const sm=bkt.sums[b]||0;
            return `<tr>
              <td style="color:${BUCKET_COLORS[b]};font-weight:700">${b}</td>
              <td class="td-num">${fmtI(cnt)}</td>
              <td class="td-num" style="color:${BUCKET_COLORS[b]}">${(cnt/total*100).toFixed(1)}%</td>
              <td class="td-num">${fmt(sm)}</td>
              <td class="td-num">${cnt?fmt(sm/cnt):'—'}</td>
            </tr>`;
          }).join('')}
          <tr style="font-weight:700"><td>Total</td><td class="td-num">${fmtI(total)}</td><td class="td-num">100%</td><td class="td-num">${fmt(data.reduce((a,r)=>a+r.change_over_time_minutes,0))}</td><td></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`;

  buildChart('bkt-pie',$('bkt-pie'),pieConfig(BUCKET_ORDER,BUCKET_ORDER.map(b=>bkt.counts[b]||0),COD_COLS,{doughnut:true,legend:true}));

  buildChart('bkt-sum-bar',$('bkt-sum-bar'),barConfig(BUCKET_ORDER,[{
    label:'Total Time',data:BUCKET_ORDER.map(b=>bkt.sums[b]||0),
    backgroundColor:COD_COLS.map(c=>c+'b0'),borderColor:COD_COLS,borderWidth:1.5,borderRadius:6}]));

  // Daily stacked
  const days = daily.map(d=>d.day);
  buildChart('bkt-daily-stack',$('bkt-daily-stack'),{
    type:'bar',
    data:{ labels:days, datasets:BUCKET_ORDER.map((b,i)=>({
      label:b, data:days.map(day=>{
        const dayR=data.filter(r=>r.processed_day===day);
        const cnt=dayR.filter(r=>r.cod_bucket===b).length;
        return dayR.length?(cnt/dayR.length*100).toFixed(1):0;
      }), backgroundColor:COD_COLS[i]+'cc', borderColor:COD_COLS[i], borderWidth:0, stack:'s'
    }))},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true},tooltip:{...baseTooltip}},
      scales:{x:{...baseScales.x,stacked:true,ticks:{...baseScales.x.ticks,maxRotation:45}},
        y:{...baseScales.y,stacked:true,ticks:{...baseScales.y.ticks,callback:v=>v+'%'},max:100}}}
  });

  // Process stacked
  const procList = DS.processes.filter(p=>data.some(r=>r.ppr_process_group===p));
  buildChart('bkt-proc-stack',$('bkt-proc-stack'),{
    type:'bar',
    data:{ labels:procList, datasets:BUCKET_ORDER.map((b,i)=>({
      label:b, data:procList.map(p=>{
        const pR=data.filter(r=>r.ppr_process_group===p);
        const cnt=pR.filter(r=>r.cod_bucket===b).length;
        return pR.length?(cnt/pR.length*100).toFixed(1):0;
      }), backgroundColor:COD_COLS[i]+'cc', borderColor:COD_COLS[i], borderWidth:0, stack:'s'
    }))},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true},tooltip:{...baseTooltip}},
      scales:{x:{...baseScales.x,stacked:true,ticks:{...baseScales.x.ticks,maxRotation:45}},
        y:{...baseScales.y,stacked:true,ticks:{...baseScales.y.ticks,callback:v=>v+'%'},max:100}}}
  });

  const floorList = DS.floors.filter(f=>data.some(r=>r.floor===f));
  buildChart('bkt-floor-stack',$('bkt-floor-stack'),{
    type:'bar',
    data:{ labels:floorList.map(f=>'Floor '+f), datasets:BUCKET_ORDER.map((b,i)=>({
      label:b, data:floorList.map(f=>{
        const fR=data.filter(r=>r.floor===f);
        const cnt=fR.filter(r=>r.cod_bucket===b).length;
        return fR.length?(cnt/fR.length*100).toFixed(1):0;
      }), backgroundColor:COD_COLS[i]+'cc', borderColor:COD_COLS[i], borderWidth:0, stack:'s'
    }))},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true},tooltip:{...baseTooltip}},
      scales:{x:{...baseScales.x,stacked:true},
        y:{...baseScales.y,stacked:true,ticks:{...baseScales.y.ticks,callback:v=>v+'%'},max:100}}}
  });
}

// ─── PAGE: EMPLOYEE 360 ───────────────────────────────────────────
let emp360Login = '';

function renderEmp360(c) {
  const data = DS.filtered;
  if (!data.length) { c.innerHTML = emptyState('No data'); return; }
  const employees = [...new Set(data.map(r=>r.employeelogin).filter(Boolean))].sort();
  if (!emp360Login || !employees.includes(emp360Login)) emp360Login = employees[0] || '';

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">👤</span>Employee 360</div>
    <div class="filter-row mb16">
      <div class="ctrl-group">
        <span class="ctrl-lbl">Select Employee</span>
        <input list="emp360-list" id="emp360-input" class="ctrl-inp" value="${escHtml(emp360Login)}" style="width:220px" placeholder="Type or select...">
        <datalist id="emp360-list">${employees.map(e=>`<option value="${escHtml(e)}">`).join('')}</datalist>
      </div>
      <button class="btn-sm btn-primary" id="emp360-go">View →</button>
    </div>
    <div id="emp360-content"></div>
  </div>`;

  $('emp360-go').addEventListener('click', () => {
    emp360Login = $('emp360-input').value.trim();
    renderEmp360Content($('emp360-content'), data);
  });
  $('emp360-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { emp360Login=$('emp360-input').value.trim(); renderEmp360Content($('emp360-content'),data); }
  });
  renderEmp360Content($('emp360-content'), data);
}

function renderEmp360Content(container, allData) {
  const login = emp360Login;
  if (!login) { container.innerHTML = '<p class="empty-state">Select an employee above.</p>'; return; }
  const empData = allData.filter(r=>r.employeelogin===login);
  if (!empData.length) { container.innerHTML = `<p class="empty-state">No records for "${escHtml(login)}" in current filters.</p>`; return; }

  const stats = calcStats(empData);
  const warehouseAvg = calcStats(allData)?.avg;
  const deltaWh = stats ? +(stats.avg - warehouseAvg).toFixed(2) : null;
  const daily = calcDailyStats(empData);
  const weekly = calcWeeklyStats(empData);
  const procS = calcGroupStats(empData,'ppr_process_group',GF.threshold).sort((a,b)=>b.avg-a.avg);
  const floorS = calcGroupStats(empData,'floor',GF.threshold);
  const modS = calcGroupStats(empData,'mod_type',GF.threshold).sort((a,b)=>b.avg-a.avg);
  const shiftS = calcGroupStats(empData,'shift',GF.threshold);
  const bkt = calcBucketStats(empData);
  const hiCount = empData.filter(r=>r.change_over_time_minutes>=GF.threshold).length;
  const hiPct = (hiCount/empData.length*100).toFixed(1);

  container.innerHTML = `
    <div class="kpi-strip cols-4 mb16">
      ${kpiCard('👤',escHtml(login),'Employee Login')}
      ${kpiCard('⏱',fmt(stats?.avg),'Avg COD (min)',deltaWh!==null?`vs wh: ${deltaWh>0?'+':''}${fmt(deltaWh)} min`:'')}
      ${kpiCard('📦',fmtI(empData.length),'Total Events')}
      ${kpiCard('🚩',fmtPct(parseFloat(hiPct)),'High-Duration %')}
    </div>
    <div class="kpi-strip cols-4 mb16">
      ${kpiCard('🕰',fmt(stats?.sum),'Total Changeover (min)')}
      ${kpiCard('🔄',fmtI(hiCount),'High-Duration Events')}
      ${kpiCard('📊',fmtI(new Set(empData.map(r=>r.processed_day)).size),'Days Active')}
      ${kpiCard('⚙',fmtI(new Set(empData.map(r=>r.ppr_process_group).filter(Boolean)).size),'Processes Used')}
    </div>
    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Daily COD Trend</span></div>
        <div class="chart-wrap h240"><canvas id="e360-daily"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">COD Bucket Distribution</span></div>
        <div class="chart-wrap h240"><canvas id="e360-bkt"></canvas></div>
      </div>
    </div>
    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Avg COD by Process</span></div>
        <div class="chart-wrap h220"><canvas id="e360-proc"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Avg COD by MOD</span></div>
        <div class="chart-wrap h220"><canvas id="e360-mod"></canvas></div>
      </div>
    </div>
    <div class="grid-2 mb16">
      <div class="chart-card">
        <div class="card-header"><span class="card-title">Weekly Trend</span></div>
        <div class="chart-wrap h180"><canvas id="e360-weekly"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="card-header"><span class="card-title">By Shift</span></div>
        <div class="chart-wrap h180"><canvas id="e360-shift"></canvas></div>
      </div>
    </div>
    <div class="table-wrap mb16">
      <div class="table-header"><span class="table-title">Process-wise Performance</span></div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr><th>Process</th><th class="th-right">Events</th><th class="th-right">Avg COD</th></tr></thead>
          <tbody>${procS.map(p=>`<tr>
            <td>${escHtml(p.name)}</td>
            <td class="td-num">${fmtI(p.count)}</td>
            <td class="td-num ${codClassTd(p.avg)}">${fmt(p.avg)}</td>
          </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="table-wrap">
      <div class="table-header">
        <span class="table-title">Event History</span>
        <button class="btn-export" onclick="exportRecords(${JSON.stringify([login])})">⬇ Export</button>
      </div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr><th>Date</th><th>Stow Time</th><th>Process</th><th>Floor</th><th>MOD</th><th>Shift</th><th class="th-right">COD (min)</th><th>Bucket</th></tr></thead>
          <tbody>${empData.slice(0,200).map(r=>`<tr>
            <td>${r.processed_day}</td>
            <td class="td-mono">${formatTime(r.stowdate)}</td>
            <td>${escHtml(r.ppr_process_group||'—')}</td>
            <td>${r.floor??'—'}</td>
            <td>${escHtml(r.mod_type||'—')}</td>
            <td>${escHtml(r.shift||'—')}</td>
            <td class="td-num ${codClassTd(r.change_over_time_minutes)}">${fmt(r.change_over_time_minutes)}</td>
            <td style="color:${BUCKET_COLORS[r.cod_bucket]||'inherit'}">${r.cod_bucket||'—'}</td>
          </tr>`).join('')}
          </tbody>
        </table>
        ${empData.length>200?`<p style="padding:12px;color:var(--text3);font-size:12px">Showing 200 of ${fmtI(empData.length)} records. Export for full data.</p>`:''}
      </div>
    </div>`;

  setTimeout(()=>{
    if($('e360-daily')) buildChart('e360-daily',$('e360-daily'),lineConfig(daily.map(d=>d.day),[{
      label:'Avg COD',data:daily.map(d=>d.avg),borderColor:'#ff6b35',
      backgroundColor:'rgba(255,107,53,.15)',fill:true,pointBackgroundColor:'#ff6b35'}]));
    if($('e360-bkt')) buildChart('e360-bkt',$('e360-bkt'),pieConfig(BUCKET_ORDER,
      BUCKET_ORDER.map(b=>bkt.counts[b]||0),COD_COLS,{doughnut:true,legend:true}));
    if($('e360-proc')) buildChart('e360-proc',$('e360-proc'),barConfig(procS.map(p=>p.name),[{
      label:'Avg COD',data:procS.map(p=>p.avg),
      backgroundColor:procS.map((_,i)=>pColor(i)+'b0'),borderColor:procS.map((_,i)=>pColor(i)),borderWidth:1.5,borderRadius:5
    }],{horizontal:true}));
    if($('e360-mod')) buildChart('e360-mod',$('e360-mod'),barConfig(modS.map(m=>m.name),[{
      label:'Avg COD',data:modS.map(m=>m.avg),
      backgroundColor:modS.map((_,i)=>pColor(i)+'b0'),borderColor:modS.map((_,i)=>pColor(i)),borderWidth:1.5,borderRadius:5
    }]));
    if($('e360-weekly')) buildChart('e360-weekly',$('e360-weekly'),lineConfig(weekly.map(w=>w.week),[{
      label:'Avg COD',data:weekly.map(w=>w.avg),borderColor:'#a855f7',
      backgroundColor:'rgba(168,85,247,.15)',fill:true,pointBackgroundColor:'#a855f7'}]));
    if($('e360-shift')) buildChart('e360-shift',$('e360-shift'),barConfig(shiftS.map(s=>s.name),[{
      label:'Avg COD',data:shiftS.map(s=>s.avg),
      backgroundColor:['rgba(79,172,254,.7)','rgba(168,85,247,.7)'],
      borderColor:['#4facfe','#a855f7'],borderWidth:2,borderRadius:8}]));
  },50);
}

window.openEmp360 = function(login) {
  emp360Login = login;
  navigateTo('emp360');
};

// ─── PAGE: EVENT EXPLORER ─────────────────────────────────────────
let explorerPage = 1, explorerPageSize = 50, explorerSearch = '', explorerSort = 'date_asc';
function renderExplorer(c) {
  const data = DS.filtered;
  if (!data.length) { c.innerHTML = emptyState('No data'); return; }
  const allCols = DS.raw.length ? Object.keys(DS.raw[0]) : [];

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">🔍</span>Event Explorer</div>
    <div class="filter-row">
      <div class="ctrl-group">
        <span class="ctrl-lbl">Search</span>
        <input type="text" id="ex-search" class="ctrl-inp" placeholder="Employee, bin, process..." style="width:200px" value="${escHtml(explorerSearch)}">
      </div>
      <div class="ctrl-group">
        <span class="ctrl-lbl">Show</span>
        <select id="ex-pg-size" class="ctrl-sel">
          <option value="25">25</option>
          <option value="50" selected>50</option>
          <option value="100">100</option>
          <option value="200">200</option>
        </select>
      </div>
      <button class="btn-export" id="ex-export">⬇ Export All Filtered (CSV)</button>
    </div>
    <div class="table-wrap">
      <div class="table-header">
        <span class="table-title">Events</span>
        <span class="card-badge" id="ex-count">${fmtI(data.length)} records</span>
      </div>
      <div class="t-scroll">
        <table class="data-table" id="ex-table">
          <thead><tr>
            <th>#</th><th>Date</th><th>Stow Time</th><th>Employee</th>
            <th>Process</th><th>Floor</th><th>MOD</th><th>Shift</th>
            <th class="th-right">COD (min)</th><th>Bucket</th><th>Bin</th>
          </tr></thead>
          <tbody id="ex-tbody"></tbody>
        </table>
      </div>
      <div class="pagination" id="ex-pg"></div>
    </div>
  </div>`;

  function renderExTable() {
    let recs = DS.filtered;
    if (explorerSearch) {
      const q = explorerSearch.toLowerCase();
      recs = recs.filter(r => (r.employeelogin||'').toLowerCase().includes(q) ||
        (r.ppr_process_group||'').toLowerCase().includes(q) ||
        (r.bin_id||'').toLowerCase().includes(q));
    }
    $('ex-count').textContent = `${fmtI(recs.length)} records`;
    const ps = explorerPageSize;
    const totalPages = Math.ceil(recs.length / ps);
    if (explorerPage > totalPages) explorerPage = 1;
    const slice = recs.slice((explorerPage-1)*ps, explorerPage*ps);
    const tbody = $('ex-tbody');
    tbody.innerHTML = slice.map((r,i) => `<tr>
      <td class="td-num">${(explorerPage-1)*ps+i+1}</td>
      <td>${r.processed_day}</td>
      <td class="td-mono">${formatTime(r.stowdate)}</td>
      <td class="td-mono">${escHtml(r.employeelogin)}</td>
      <td>${escHtml(r.ppr_process_group||'—')}</td>
      <td>${r.floor??'—'}</td>
      <td>${escHtml(r.mod_type||'—')}</td>
      <td>${escHtml(r.shift||'—')}</td>
      <td class="td-num ${codClassTd(r.change_over_time_minutes)}">${fmt(r.change_over_time_minutes)}</td>
      <td style="color:${BUCKET_COLORS[r.cod_bucket]||'inherit'}">${r.cod_bucket||'—'}</td>
      <td class="td-mono" style="font-size:10px">${escHtml(r.bin_id||'—')}</td>
    </tr>`).join('');
    // Pagination
    const pg = $('ex-pg');
    if (totalPages<=1) { pg.innerHTML=''; return; }
    let html = `<button class="pg-btn" ${explorerPage===1?'disabled':''} onclick="exPg(${explorerPage-1})">←</button>`;
    const pages=[];
    for(let i=1;i<=totalPages;i++){ if(i===1||i===totalPages||(i>=explorerPage-2&&i<=explorerPage+2)) pages.push(i); else if(pages[pages.length-1]!=='…') pages.push('…'); }
    pages.forEach(p=>{
      if(p==='…') html+=`<span style="padding:0 4px;color:var(--text3)">…</span>`;
      else html+=`<button class="pg-btn ${p===explorerPage?'active':''}" onclick="exPg(${p})">${p}</button>`;
    });
    html+=`<button class="pg-btn" ${explorerPage===totalPages?'disabled':''} onclick="exPg(${explorerPage+1})">→</button>`;
    pg.innerHTML=html;
  }
  window.exPg = function(p){explorerPage=p;renderExTable();};
  $('ex-search').addEventListener('input', e=>{explorerSearch=e.target.value;explorerPage=1;renderExTable();});
  $('ex-pg-size').addEventListener('change', e=>{explorerPageSize=parseInt(e.target.value);explorerPage=1;renderExTable();});
  $('ex-export').addEventListener('click', ()=>exportAllFiltered());
  renderExTable();
}

// ─── PAGE: DATA QUALITY ───────────────────────────────────────────
function renderQuality(c) {
  const total = DS.recordsTotal + DS.invalidRows;
  const missingCols = DS.missingCols;
  const data = DS.raw;
  const nullCounts = {};
  const cols = data.length ? Object.keys(data[0]) : [];
  cols.forEach(col => { nullCounts[col] = data.filter(r=>r[col]===null||r[col]===undefined||r[col]==='').length; });

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">✅</span>Data Quality</div>
    <div class="kpi-strip cols-4 mb16">
      ${kpiCard('📦',fmtI(DS.recordsTotal),'Valid Records')}
      ${kpiCard('❌',fmtI(DS.invalidRows),'Invalid / Skipped Rows')}
      ${kpiCard('📋',fmtI(cols.length),'Columns Found')}
      ${kpiCard('⚠',fmtI(missingCols.length),'Optional Cols Missing')}
    </div>
    ${missingCols.length ? `<div class="chart-card mb16" style="border-color:rgba(245,158,11,.3)">
      <div class="card-header"><span class="card-title">⚠ Missing Optional Columns</span></div>
      <p style="font-size:12px;color:var(--text2);margin-top:4px">These columns were not found in your CSV. Related analyses are disabled.</p>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${missingCols.map(c=>`<span style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);color:var(--yellow);padding:3px 10px;border-radius:4px;font-family:var(--mono);font-size:11px">${c}</span>`).join('')}</div>
    </div>` : '<div class="chart-card mb16" style="border-color:rgba(34,197,94,.3)"><div class="card-header"><span class="card-title">✅ All Expected Columns Present</span></div></div>'}
    <div class="table-wrap">
      <div class="table-header"><span class="table-title">Column Completeness Report</span></div>
      <div class="t-scroll">
        <table class="data-table">
          <thead><tr><th>Column</th><th class="th-right">Total Records</th><th class="th-right">Non-null</th><th class="th-right">Missing</th><th class="th-right">Completeness %</th><th>Status</th></tr></thead>
          <tbody>${cols.map(col=>{
            const missing=nullCounts[col]||0;
            const pct=((DS.recordsTotal-missing)/DS.recordsTotal*100).toFixed(1);
            const req=REQUIRED_COLS.includes(col);
            return `<tr>
              <td class="td-mono">${col}</td>
              <td class="td-num">${fmtI(DS.recordsTotal)}</td>
              <td class="td-num">${fmtI(DS.recordsTotal-missing)}</td>
              <td class="td-num ${missing>0?'td-warn':''}">${fmtI(missing)}</td>
              <td class="td-num ${parseFloat(pct)<80?'td-bad':parseFloat(pct)<95?'td-warn':'td-good'}">${pct}%</td>
              <td><span style="padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:${req?'rgba(79,172,254,.1)':'rgba(255,255,255,.05)'};color:${req?'#4facfe':'var(--text3)'}">${req?'REQUIRED':'OPTIONAL'}</span></td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="chart-card" style="margin-top:16px">
      <div class="card-header"><span class="card-title">Source Information</span></div>
      <table class="data-table">
        <tbody>
          <tr><td style="color:var(--text2)">Filename</td><td class="td-mono">${escHtml(DS.filename)}</td></tr>
          <tr><td style="color:var(--text2)">Date Range</td><td>${DS.dateMin} → ${DS.dateMax}</td></tr>
          <tr><td style="color:var(--text2)">Employees</td><td>${fmtI(new Set(data.map(r=>r.employeelogin)).size)}</td></tr>
          <tr><td style="color:var(--text2)">Processes</td><td>${DS.processes.join(', ')}</td></tr>
          <tr><td style="color:var(--text2)">Floors</td><td>${DS.floors.join(', ')}</td></tr>
          <tr><td style="color:var(--text2)">MOD Types</td><td>${DS.mods.join(', ')}</td></tr>
          <tr><td style="color:var(--text2)">Weeks</td><td>${DS.weeks.join(', ')}</td></tr>
        </tbody>
      </table>
    </div>
  </div>`;
}

// ─── SHARED HELPERS ───────────────────────────────────────────────
function kpiCard(icon, val, lbl, sub='', valCls='') {
  return `<div class="kpi-card">
    ${icon?`<div class="kpi-icon">${icon}</div>`:''}
    <div class="kpi-body">
      <span class="kpi-val ${valCls}">${val}</span>
      <span class="kpi-lbl">${lbl}</span>
      ${sub?`<span class="kpi-sub">${sub}</span>`:''}
    </div>
  </div>`;
}

function codClassTd(v) {
  if (v == null || isNaN(v)) return '';
  if (v <= 3) return 'td-good';
  if (v <= 7) return 'td-warn';
  return 'td-bad';
}

function empTableHTML(empStats, showProcess=false) {
  if (!empStats.length) return '<p class="empty-state">No employees match current criteria.</p>';
  return `<table class="data-table">
    <thead><tr>
      <th>#</th><th>Login</th><th class="th-right">Events</th>
      <th class="th-right">Avg COD</th>
      ${showProcess?'<th>Top Process</th>':''}
      <th style="min-width:120px">Bucket Bar</th>
      <th>Action</th>
    </tr></thead>
    <tbody>${empStats.map((e,i)=>{
      const bar = `<div class="bbar">${[e.b0||e.records?.filter(r=>r.cod_bucket==='0-5 min').length/e.count*100,
        e.records?.filter(r=>r.cod_bucket==='5-10 min').length/e.count*100||0,
        e.records?.filter(r=>r.cod_bucket==='10-15 min').length/e.count*100||0,
        e.records?.filter(r=>r.cod_bucket==='15-20 min').length/e.count*100||0,
        e.records?.filter(r=>r.cod_bucket==='20-25 min').length/e.count*100||0,
        e.records?.filter(r=>r.cod_bucket==='25-30 min').length/e.count*100||0].map((pct,bi)=>
        `<div class="bbar-seg" style="width:${pct||0}%;background:${COD_COLS[bi]}"></div>`).join('')}</div>`;
      return `<tr>
        <td class="td-num">${i+1}</td>
        <td class="td-mono">${escHtml(e.login)}</td>
        <td class="td-num">${fmtI(e.count)}</td>
        <td class="td-num ${codClassTd(e.avg)}">${fmt(e.avg)}</td>
        ${showProcess?`<td>${escHtml(e.freqProc)}</td>`:''}
        <td>${bar}</td>
        <td><button class="btn-sm btn-ghost" onclick="openEmp360('${escHtml(e.login)}')">360°</button></td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>`;
}

function emptyState(msg) {
  return `<div class="empty-state"><div class="es-icon">📭</div><p>${msg}</p></div>`;
}

function openDrillOverlay(html) {
  let overlay = $('drill-overlay');
  if (!overlay) {
    overlay = el('div','drill-overlay');
    overlay.id = 'drill-overlay';
    overlay.innerHTML = `<div class="drill-panel"><div class="drill-header"><span class="drill-title">Details</span><button class="btn-close-drill" onclick="closeDrill()">✕</button></div><div id="drill-content"></div></div>`;
    document.body.appendChild(overlay);
  }
  $('drill-content').innerHTML = html;
  overlay.classList.add('open');
}
window.closeDrill = () => { const o=$('drill-overlay'); if(o) o.classList.remove('open'); };

// ─── EXPORTS ──────────────────────────────────────────────────────
function exportCSV(rows, filename) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(','), ...rows.map(r=>headers.map(h=>{
    const v = r[h]; return v===null||v===undefined?'':String(v).includes(',')?`"${v}"`:v;
  }).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download = filename;
  a.click();
}
function exportAllFiltered() {
  exportCSV(DS.filtered, 'cod_filtered_export.csv');
}
window.exportRecords = function(logins) {
  const data = DS.filtered.filter(r=>logins.includes(r.employeelogin));
  exportCSV(data, `cod_employee_${logins.join('_')}.csv`);
};

// ─── PAGE: FILES MANAGER ──────────────────────────────────────────
function renderFilesManager(c) {
  const files = DS.files;
  const totalRecs = files.reduce((s,f) => s + f.count, 0);

  c.innerHTML = `
  <div class="fade-in">
    <div class="page-title"><span class="page-title-icon">📂</span>Stored CSV Files</div>
    <p class="page-desc">Manage multiple datasets permanently stored in your browser. Data persists across page reloads and browser restarts.</p>

    <div class="kpi-strip cols-3 mb20">
      ${kpiCard('📁', fmtI(files.length), 'Stored Files')}
      ${kpiCard('📦', fmtI(totalRecs), 'Combined Records')}
      ${kpiCard('👁', DS.activeFileId === 'all' ? 'All (Combined)' : escHtml(DS.files.find(f=>f.id===DS.activeFileId)?.name||'Single'), 'Active View')}
    </div>

    <div class="chart-card mb20">
      <div class="card-header">
        <span class="card-title">Add More CSV Files</span>
      </div>
      <p style="font-size:12px;color:var(--text2)">Append additional daily or weekly CSV files to your current workspace without losing existing files.</p>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
        <label class="btn-upload" for="add-files-input" style="padding:8px 18px;font-size:12px">+ Add CSV Files</label>
        <input type="file" id="add-files-input" accept=".csv,.xls,.xlsx,.txt" multiple style="display:none">
        <button class="btn-sm btn-ghost" onclick="selectFileSource('all')" ${DS.activeFileId==='all'?'style="border-color:var(--accent);color:var(--accent)"':''}>✓ View All Combined</button>
      </div>
    </div>

    <div class="table-wrap">
      <div class="table-header">
        <span class="table-title">File Repository (${files.length})</span>
      </div>
      <div style="padding:16px">
        ${!files.length ? '<p class="empty-state">No files uploaded yet.</p>' : files.map((f,idx) => {
          const isActive = DS.activeFileId === f.id;
          const kbSize = (f.size / 1024).toFixed(1) + ' KB';
          return `
            <div class="file-card" style="${isActive ? 'border-color:var(--accent);background:rgba(255,107,53,0.04)' : ''}">
              <div class="file-meta">
                <div style="display:flex;align-items:center;gap:8px">
                  <span style="font-size:18px">📄</span>
                  <span class="file-name">${escHtml(f.name)}</span>
                  ${isActive ? '<span class="file-badge">ACTIVE VIEW</span>' : ''}
                </div>
                <div class="file-stats">
                  <span><b>${fmtI(f.count)}</b> records</span>
                  <span>Size: ${kbSize}</span>
                  <span>Range: <b>${f.dateMin} → ${f.dateMax}</b></span>
                  <span>Uploaded at: ${f.uploadTime}</span>
                  ${f.invalidRows > 0 ? `<span style="color:var(--yellow)">(${f.invalidRows} skipped rows)</span>` : ''}
                </div>
              </div>
              <div class="file-actions">
                ${isActive
                  ? '<button class="btn-sm btn-primary" disabled>Active</button>'
                  : `<button class="btn-sm btn-ghost" onclick="selectFileSource('${f.id}')">View Only This</button>`}
                <button class="btn-danger" onclick="removeStoredFile('${f.id}')">Delete</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  </div>`;

  const addInp = $('add-files-input');
  if (addInp) {
    addInp.addEventListener('change', () => {
      const fl = Array.from(addInp.files);
      if (fl.length) processFiles(fl);
      addInp.value = '';
    });
  }
}
