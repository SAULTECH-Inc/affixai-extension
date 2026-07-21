/**
 * Signing overlay page — styled to match the dashboard's DocumentEditPage.
 * Light theme, palette panel, click-to-arm placement, font controls on selection.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

const API_BASE = 'https://affixai-backend.vercel.app/api/v1';
const RENDER_WIDTH = 720;

// ─── colours matching dashboard CSS variables ────────────────────────────────
const C = {
  bgBase:      '#f8fafc',
  bgInset:     '#f1f5f9',
  bgElevated:  '#ffffff',
  border:      '#e2e8f0',
  borderStrong:'#cbd5e1',
  fg:          '#0f172a',
  fgMuted:     '#64748b',
  fgSubtle:    '#94a3b8',
  brand500:    '#8b5cf6',
  brand400:    '#a78bfa',
  brandSoft:   'rgba(139,92,246,0.08)',
  brandGrad:   'linear-gradient(135deg,#8b5cf6,#ec4899)',
  danger:      '#dc2626',
  success:     '#16a34a',
};

const FONT_FAMILIES = [
  { value:'helv',        label:'Helvetica',     cssFamily:'Helvetica,Arial,sans-serif',                       category:'sans' },
  { value:'tiro',        label:'Times',          cssFamily:'"Times New Roman",Times,serif',                    category:'serif' },
  { value:'cour',        label:'Courier',        cssFamily:'"Courier New",Courier,monospace',                  category:'mono' },
  { value:'dancing',     label:'Dancing Script', cssFamily:'"Dancing Script","Snell Roundhand",cursive',       category:'script' },
  { value:'great_vibes', label:'Great Vibes',    cssFamily:'"Great Vibes","Apple Chancery",cursive',           category:'calligraphy' },
  { value:'caveat',      label:'Caveat',         cssFamily:'"Caveat","Bradley Hand","Marker Felt",cursive',    category:'handwriting' },
  { value:'sacramento',  label:'Sacramento',     cssFamily:'"Sacramento","Snell Roundhand",cursive',           category:'signature' },
];

const COLOR_PRESETS = ['#000000','#1e3a8a','#7e22ce','#dc2626','#0f766e','#a16207'];

// ─── types ───────────────────────────────────────────────────────────────────

type PlacementKind = 'text'|'number'|'date'|'time'|'signature'|'initials'|'photo';

interface Placement {
  id:          string;
  kind:        PlacementKind;
  page:        number;   // 1-based
  x:           number;   // PDF pts
  y:           number;   // PDF pts (from top)
  value:       string;
  width:       number;   // PDF pts
  height:      number;   // PDF pts
  fontsize:    number;
  font_family: string;
  bold:        boolean;
  italic:      boolean;
  color:       string;
}

interface PaletteItem {
  id:           string;
  label:        string;
  kind:         PlacementKind;
  defaultValue: string;
  width:        number;
  height:       number;
}

interface FontDefaults {
  font_family: string;
  fontsize:    number;
  bold:        boolean;
  italic:      boolean;
  color:       string;
}

interface PageInfo {
  canvas:         HTMLCanvasElement;
  pdfWidth:       number;
  pdfHeight:      number;
  renderedWidth:  number;
  renderedHeight: number;
}

interface VaultField {
  key:   string;
  label: string;
  value: string;
}

const PALETTE: PaletteItem[] = [
  { id:'ph.text',      label:'Text',           kind:'text',      defaultValue:'',  width:160, height:18  },
  { id:'ph.number',    label:'Number',          kind:'number',    defaultValue:'',  width:80,  height:18  },
  { id:'ph.date',      label:'Date',            kind:'date',      defaultValue:'',  width:100, height:18  },
  { id:'ph.time',      label:'Time',            kind:'time',      defaultValue:'',  width:70,  height:18  },
  { id:'ph.signature', label:'Signature',       kind:'signature', defaultValue:'',  width:180, height:40  },
  { id:'ph.photo',     label:'Passport Photo',  kind:'photo',     defaultValue:'',  width:100, height:130 },
  { id:'ph.initials',  label:'Initials',        kind:'initials',  defaultValue:'',  width:80,  height:18  },
];

const ICONS: Record<PlacementKind, string> = {
  text:'T', number:'#', date:'📅', time:'⏰', signature:'✍', photo:'📷', initials:'Ab',
};

function uid() { return Math.random().toString(36).slice(2); }

function b64toBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToRgb(hex: string) {
  const m = hex.replace('#','').match(/.{2}/g) ?? ['00','00','00'];
  return { r: parseInt(m[0],16)/255, g: parseInt(m[1],16)/255, b: parseInt(m[2],16)/255 };
}

function relPos(e: React.MouseEvent|React.TouchEvent, el: HTMLElement) {
  const r = el.getBoundingClientRect();
  if ('touches' in e) return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
  return { x: (e as React.MouseEvent).clientX - r.left, y: (e as React.MouseEvent).clientY - r.top };
}

// ─── main component ───────────────────────────────────────────────────────────

export default function SigningPage() {
  const [pdfBytes,   setPdfBytes]   = useState<Uint8Array|null>(null);
  const [pdfBase64,  setPdfBase64]  = useState<string|null>(null);   // kept for pdf-lib load
  const [pdfDoc,     setPdfDoc]     = useState<pdfjsLib.PDFDocumentProxy|null>(null);
  const [numPages,   setNumPages]   = useState(0);
  const [filename,   setFilename]   = useState('document.pdf');
  const [pageInfos,  setPageInfos]  = useState<PageInfo[]>([]);
  const [vaultFields,setVaultFields]= useState<VaultField[]>([]);

  const [placements,   setPlacements]   = useState<Placement[]>([]);
  const [selectedIdx,  setSelectedIdx]  = useState<number|null>(null);
  const [armedItem,    setArmedItem]    = useState<PaletteItem|null>(null);
  const [defaults,     setDefaults]     = useState<FontDefaults>({
    font_family:'helv', fontsize:10, bold:false, italic:false, color:'#000000',
  });

  const [sigUrl,       setSigUrl]       = useState<string|null>(null);
  const [photoUrl,     setPhotoUrl]     = useState<string|null>(null);
  const [drawingOpen,  setDrawingOpen]  = useState(false);
  const [downloading,  setDownloading]  = useState(false);
  const [status,       setStatus]       = useState<{msg:string;type:'ok'|'err'}|null>(null);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [sourceOpen,   setSourceOpen]   = useState(false);
  const [sourceTab,    setSourceTab]    = useState<'local'|'url'|'drive'|'dropbox'>('local');
  const [cloudUrl,     setCloudUrl]     = useState('');
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudErr,     setCloudErr]     = useState<string|null>(null);

  const canvasRefs   = useRef<Map<number,HTMLCanvasElement>>(new Map());
  const pageInfosRef = useRef<PageInfo[]>([]);
  const dragRef      = useRef<{id:string;mx:number;my:number}|null>(null);
  const drawPadRef   = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastXYRef    = useRef({x:0,y:0});
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { pageInfosRef.current = pageInfos; }, [pageInfos]);

  // ── boot ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    chrome.storage.session.get(['affixai_signing_pdf','affixai_signing_name'], (res) => {
      if (res.affixai_signing_pdf) {
        setPdfBase64(res.affixai_signing_pdf);
        setPdfBytes(b64toBytes(res.affixai_signing_pdf));
        setFilename(res.affixai_signing_name || 'document.pdf');
      }
    });

    chrome.storage.local.get('affixai_token', async (res) => {
      const tok = res.affixai_token ?? null;
      if (!tok) return;

      // Fetch default signature
      try {
        const r1 = await fetch(`${API_BASE}/signatures/default`, { headers:{ Authorization:`Bearer ${tok}` } });
        if (r1.ok) {
          const { id } = await r1.json();
          const r2 = await fetch(`${API_BASE}/signatures/${id}/file`, { headers:{ Authorization:`Bearer ${tok}` } });
          if (r2.ok) setSigUrl(URL.createObjectURL(await r2.blob()));
        }
      } catch { /* no saved sig */ }

      // Fetch default passport photo
      try {
        const p1 = await fetch(`${API_BASE}/passport-photos/default`, { headers:{ Authorization:`Bearer ${tok}` } });
        if (p1.ok) {
          const { id } = await p1.json();
          const p2 = await fetch(`${API_BASE}/passport-photos/${id}/file`, { headers:{ Authorization:`Bearer ${tok}` } });
          if (p2.ok) setPhotoUrl(URL.createObjectURL(await p2.blob()));
        }
      } catch { /* no saved photo */ }

      // Fetch vault data
      try {
        const rv = await fetch(`${API_BASE}/data-vault/flat`, { headers:{ Authorization:`Bearer ${tok}` } });
        if (rv.ok) {
          const flat: Record<string,any> = await rv.json();
          const fields: VaultField[] = Object.entries(flat)
            .filter(([,v]) => v !== null && v !== undefined && String(v).trim() !== '')
            .map(([k, v]) => ({
              key: k,
              label: k.replace(/_/g,' ').replace(/\b\w/g, (c:string) => c.toUpperCase()),
              value: String(v),
            }));
          setVaultFields(fields);
        }
      } catch { /* vault unavailable */ }
    });

    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'AFFIXAI_PDF_DATA') {
        setPdfBase64(e.data.base64);
        setPdfBytes(b64toBytes(e.data.base64));
        setFilename(e.data.filename || 'document.pdf');
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setArmedItem(null); setDrawingOpen(false); setSourceOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── PDF rendering ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!pdfBytes) return;
    pdfjsLib.getDocument({ data: pdfBytes }).promise.then((doc) => {
      setPdfDoc(doc);
      setNumPages(doc.numPages);
    });
  }, [pdfBytes]);

  useEffect(() => {
    if (!pdfDoc) return;
    (async () => {
      const infos: PageInfo[] = [];
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const origVp = page.getViewport({ scale: 1 });
        const scale  = RENDER_WIDTH / origVp.width;
        const vp     = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width  = vp.width;
        canvas.height = vp.height;
        canvasRefs.current.set(i, canvas);
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
        infos.push({
          canvas,
          pdfWidth: origVp.width, pdfHeight: origVp.height,
          renderedWidth: vp.width, renderedHeight: vp.height,
        });
      }
      setPageInfos(infos);
    })();
  }, [pdfDoc]);

  // ── placement helpers ─────────────────────────────────────────────────────

  function buildPlacement(item: PaletteItem, page: number, xPdf: number, yPdf: number): Placement {
    return {
      id: uid(), kind: item.kind, page, x: xPdf, y: yPdf,
      value: item.kind === 'date' ? new Date().toLocaleDateString()
           : item.kind === 'time' ? new Date().toLocaleTimeString()
           : item.defaultValue,
      width: item.width, height: item.height,
      fontsize:    defaults.fontsize,
      font_family: defaults.font_family,
      bold:        defaults.bold,
      italic:      defaults.italic,
      color:       defaults.color,
    };
  }

  function handlePageClick(e: React.MouseEvent<HTMLDivElement>, idx: number) {
    if (!armedItem) return;
    const info = pageInfos[idx];
    if (!info) return;
    const rect  = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = info.pdfWidth / info.renderedWidth;
    const xPdf  = (e.clientX - rect.left) * ratio;
    const yPdf  = (e.clientY - rect.top)  * ratio;
    setPlacements(prev => [...prev, buildPlacement(armedItem, idx + 1, xPdf, yPdf)]);
    // stay armed for rapid placement
  }

  function delPlacement(id: string) {
    const idx = placements.findIndex(p => p.id === id);
    setPlacements(prev => prev.filter(p => p.id !== id));
    if (selectedIdx !== null && (idx === selectedIdx || selectedIdx >= placements.length - 1))
      setSelectedIdx(null);
  }

  function updPlacement(id: string, changes: Partial<Placement>) {
    setPlacements(prev => prev.map(p => p.id === id ? { ...p, ...changes } : p));
  }

  function armItem(item: PaletteItem) {
    if (armedItem?.id === item.id) { setArmedItem(null); return; }
    if (item.kind === 'signature' && !sigUrl) { setDrawingOpen(true); return; }
    if (item.kind === 'photo' && !photoUrl) {
      setStatus({ msg: 'No passport photo saved yet. Upload one on the AffixAI dashboard first.', type: 'err' });
      return;
    }
    setArmedItem(item);
    setSelectedIdx(null);
  }

  function updateDefaults(next: FontDefaults) {
    setDefaults(next);
    setPlacements(prev => prev.map(p => {
      if (['signature'].includes(p.kind)) return p;
      return { ...p, font_family:next.font_family, fontsize:next.fontsize, bold:next.bold, italic:next.italic, color:next.color };
    }));
  }

  // ── drag ─────────────────────────────────────────────────────────────────

  const startDrag = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { id, mx: e.clientX, my: e.clientY };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.mx;
      const dy = ev.clientY - dragRef.current.my;
      setPlacements(prev => prev.map(p => {
        if (p.id !== dragRef.current!.id) return p;
        const info = pageInfosRef.current[p.page - 1];
        if (!info) return p;
        const ratio = info.pdfWidth / info.renderedWidth;
        return { ...p, x: p.x + dx * ratio, y: p.y + dy * ratio };
      }));
      dragRef.current.mx = ev.clientX;
      dragRef.current.my = ev.clientY;
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // ── signature drawing pad ────────────────────────────────────────────────

  function padStart(e: React.MouseEvent|React.TouchEvent) {
    isDrawingRef.current = true;
    lastXYRef.current = relPos(e, drawPadRef.current!);
  }
  function padMove(e: React.MouseEvent|React.TouchEvent) {
    if (!isDrawingRef.current || !drawPadRef.current) return;
    const ctx = drawPadRef.current.getContext('2d')!;
    const pos = relPos(e, drawPadRef.current);
    ctx.beginPath();
    ctx.moveTo(lastXYRef.current.x, lastXYRef.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2.5;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke();
    lastXYRef.current = pos;
  }
  function padEnd() { isDrawingRef.current = false; }
  function clearPad() {
    const c = drawPadRef.current;
    if (!c) return;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  }
  function saveDrawing() {
    if (!drawPadRef.current) return;
    setSigUrl(drawPadRef.current.toDataURL());
    setDrawingOpen(false);
    setArmedItem(PALETTE.find(p => p.kind === 'signature')!);
  }

  // ── cloud / local file open ───────────────────────────────────────────────

  function bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function openPdfBytes(bytes: Uint8Array, name: string) {
    if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
      setStatus({ msg: 'Not a valid PDF file.', type: 'err' });
      return;
    }
    const b64 = bytesToBase64(bytes);
    setPdfBase64(b64);
    setPdfBytes(bytes);
    setFilename(name.endsWith('.pdf') ? name : name + '.pdf');
    setPlacements([]);
    setSelectedIdx(null);
    setArmedItem(null);
    setSourceOpen(false);
    setCloudUrl('');
    setCloudErr(null);
  }

  function handleLocalFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (ev.target?.result instanceof ArrayBuffer) openPdfBytes(new Uint8Array(ev.target.result), file.name);
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  }

  function normalizeCloudUrl(raw: string): string {
    const url = raw.trim();
    // Google Drive share link → direct download
    const gm = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]+)/);
    if (gm) return `https://drive.google.com/uc?export=download&id=${gm[1]}&confirm=t`;
    // Dropbox share link → direct download
    if (/dropbox\.com\/(s|scl)\//.test(url)) return url.split('?')[0] + '?dl=1';
    return url;
  }

  async function fetchCloudPdf() {
    const raw = cloudUrl.trim();
    if (!raw) return;
    setCloudLoading(true);
    setCloudErr(null);
    try {
      const url = normalizeCloudUrl(raw);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} — check the file is shared publicly.`);
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes[0] !== 0x25 || bytes[1] !== 0x50) {
        throw new Error('The link did not return a valid PDF. Make sure the file is publicly shared and the link is correct.');
      }
      const guessName = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'document');
      openPdfBytes(bytes, guessName.includes('.') ? guessName : 'document.pdf');
    } catch (err: any) {
      setCloudErr(err.message);
    } finally {
      setCloudLoading(false);
    }
  }

  // ── download ─────────────────────────────────────────────────────────────

  async function downloadSigned() {
    if (placements.length === 0) return;
    // Prefer loading from the raw base64 string — pdf-lib handles this more
    // reliably than a Uint8Array that may have gone through multiple hops.
    const pdfSource = pdfBase64 ?? pdfBytes;
    if (!pdfSource) return;
    setDownloading(true);
    setStatus(null);
    try {
      const doc  = await PDFDocument.load(pdfSource, { ignoreEncryption: true });
      const helv = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const tiro = await doc.embedFont(StandardFonts.TimesRoman);
      const cour = await doc.embedFont(StandardFonts.Courier);

      function getFont(p: Placement) {
        if (p.font_family === 'tiro') return tiro;
        if (p.font_family === 'cour') return cour;
        return p.bold ? bold : helv;
      }

      for (const p of placements) {
        const pg   = doc.getPages()[p.page - 1];
        if (!pg) continue;
        const { height: pH } = pg.getSize();

        const pdfX = p.x;
        const pdfY = pH - p.y - p.height; // flip Y (PDF origin = bottom-left)

        if (p.kind === 'signature' || p.kind === 'photo') {
          const imgSrc = p.kind === 'signature' ? sigUrl : photoUrl;
          if (!imgSrc) continue;
          try {
            const bytes = await fetch(imgSrc).then(r => r.arrayBuffer());
            let img;
            try { img = await doc.embedPng(bytes); } catch { img = await doc.embedJpg(bytes); }
            pg.drawImage(img, { x:pdfX, y:pdfY, width:p.width, height:p.height });
          } catch { /* skip */ }
        } else {
          const text = p.value || (p.kind==='date' ? new Date().toLocaleDateString() : p.kind==='time' ? new Date().toLocaleTimeString() : '');
          if (!text) continue;
          const c = hexToRgb(p.color);
          pg.drawText(text, {
            x:pdfX, y:pdfY + p.height * 0.25,
            size:p.fontsize, font:getFont(p), color:rgb(c.r,c.g,c.b),
          });
        }
      }

      const signed = await doc.save();
      const url = URL.createObjectURL(new Blob([signed], { type:'application/pdf' }));
      const a   = document.createElement('a');
      a.href = url; a.download = `signed-${filename}`; a.click();
      URL.revokeObjectURL(url);
      setStatus({ msg:'Signed PDF downloaded!', type:'ok' });
    } catch (err: any) {
      setStatus({ msg:`Download failed: ${err.message}`, type:'err' });
    } finally {
      setDownloading(false);
    }
  }

  function close() {
    window.parent.postMessage({ type:'AFFIXAI_CLOSE_SIGNING' }, '*');
    window.close();
  }

  // ── render ────────────────────────────────────────────────────────────────

  const selectedPlacement = selectedIdx !== null ? placements[selectedIdx] : null;

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:C.bgInset,
      color:C.fg, fontFamily:'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', fontSize:14 }}>

      {/* Hidden file input for local PDF picking */}
      <input ref={fileInputRef} type="file" accept=".pdf,application/pdf"
        style={{ display:'none' }} onChange={handleLocalFile} />

      {/* Source picker modal */}
      {sourceOpen && (
        <div style={{ position:'fixed', inset:0, zIndex:200, background:'rgba(0,0,0,0.55)',
          backdropFilter:'blur(4px)', display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={() => setSourceOpen(false)}>
          <div style={{ background:C.bgElevated, borderRadius:16, padding:24, width:480,
            maxWidth:'94vw', border:`1px solid ${C.border}`, boxShadow:'0 24px 64px rgba(0,0,0,0.3)' }}
            onClick={(e) => e.stopPropagation()}>

            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
              <h3 style={{ fontSize:16, fontWeight:700, color:C.fg, margin:0 }}>Open PDF</h3>
              <button onClick={() => setSourceOpen(false)}
                style={{ width:28, height:28, borderRadius:8, border:`1px solid ${C.border}`,
                  background:'transparent', color:C.fgMuted, cursor:'pointer',
                  display:'grid', placeItems:'center', fontSize:14 }}>✕</button>
            </div>

            {/* Source tabs */}
            <div style={{ display:'flex', gap:4, marginBottom:16 }}>
              {([
                { id:'local',   label:'📁 Device'  },
                { id:'url',     label:'🔗 URL'     },
                { id:'drive',   label:'🟢 Drive'   },
                { id:'dropbox', label:'📦 Dropbox' },
              ] as const).map(s => (
                <button key={s.id}
                  onClick={() => { setSourceTab(s.id); setCloudErr(null); }}
                  style={{ flex:1, height:34, borderRadius:8, fontSize:12,
                    fontWeight: sourceTab===s.id ? 600 : 400, cursor:'pointer',
                    border:`1px solid ${sourceTab===s.id?`${C.brand500}60`:C.border}`,
                    background: sourceTab===s.id ? C.brandSoft : 'transparent',
                    color: sourceTab===s.id ? C.fg : C.fgMuted }}>
                  {s.label}
                </button>
              ))}
            </div>

            {/* Device tab */}
            {sourceTab==='local' && (
              <div style={{ textAlign:'center', padding:'28px 0' }}>
                <button onClick={() => fileInputRef.current?.click()}
                  style={{ padding:'14px 32px', borderRadius:12,
                    border:`1.5px dashed ${C.borderStrong}`, background:C.bgInset,
                    color:C.fg, fontSize:14, fontWeight:500, cursor:'pointer' }}>
                  📁 Choose PDF from device
                </button>
                <p style={{ fontSize:12, color:C.fgMuted, marginTop:12 }}>
                  Supports any PDF file from your computer.
                </p>
              </div>
            )}

            {/* URL / Drive / Dropbox tabs */}
            {(sourceTab==='url' || sourceTab==='drive' || sourceTab==='dropbox') && (
              <div>
                {sourceTab==='drive' && (
                  <div style={{ padding:'10px 12px', borderRadius:10, background:'#f0fdf4',
                    border:'1px solid #bbf7d0', fontSize:12, color:'#166534', marginBottom:12 }}>
                    <strong>How to share:</strong> Open in Google Drive → Share → "Anyone with the link" → Copy link, then paste below.
                  </div>
                )}
                {sourceTab==='dropbox' && (
                  <div style={{ padding:'10px 12px', borderRadius:10, background:'#eff6ff',
                    border:'1px solid #bfdbfe', fontSize:12, color:'#1d4ed8', marginBottom:12 }}>
                    <strong>How to share:</strong> Open in Dropbox → Share → Copy Link, then paste below.
                  </div>
                )}
                {sourceTab==='url' && (
                  <p style={{ fontSize:12, color:C.fgMuted, marginBottom:12 }}>
                    Paste a direct link to any publicly accessible PDF.
                  </p>
                )}

                <input type="url" value={cloudUrl}
                  onChange={(e) => { setCloudUrl(e.target.value); setCloudErr(null); }}
                  onKeyDown={(e) => { if (e.key==='Enter') fetchCloudPdf(); }}
                  placeholder={
                    sourceTab==='drive'   ? 'https://drive.google.com/file/d/…' :
                    sourceTab==='dropbox' ? 'https://www.dropbox.com/s/…' :
                                           'https://example.com/document.pdf'
                  }
                  style={{ width:'100%', height:40, padding:'0 12px', borderRadius:10,
                    border:`1px solid ${cloudErr?C.danger:C.border}`, background:C.bgInset,
                    fontSize:13, color:C.fg, boxSizing:'border-box', outline:'none',
                    display:'block', marginBottom:cloudErr?6:12 }}
                />

                {cloudErr && (
                  <p style={{ fontSize:12, color:C.danger, margin:'0 0 10px' }}>{cloudErr}</p>
                )}

                <button onClick={fetchCloudPdf}
                  disabled={!cloudUrl.trim() || cloudLoading}
                  style={{ width:'100%', height:40, borderRadius:10, border:'none',
                    background: !cloudUrl.trim() ? C.bgInset : C.brandGrad,
                    color: !cloudUrl.trim() ? C.fgSubtle : '#fff',
                    fontSize:13, fontWeight:600,
                    cursor: !cloudUrl.trim() ? 'not-allowed' : 'pointer',
                    opacity: cloudLoading ? 0.6 : 1 }}>
                  {cloudLoading ? '⏳ Fetching PDF…' :
                    sourceTab==='drive'   ? '🟢 Open from Google Drive' :
                    sourceTab==='dropbox' ? '📦 Open from Dropbox' :
                                           '🔗 Open PDF from URL'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Drawing modal */}
      {drawingOpen && (
        <div style={{ position:'fixed', inset:0, zIndex:200, background:'rgba(0,0,0,0.55)',
          backdropFilter:'blur(4px)', display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={() => setDrawingOpen(false)}>
          <div style={{ background:C.bgElevated, borderRadius:16, padding:24, width:380,
            maxWidth:'90vw', border:`1px solid ${C.border}`, boxShadow:'0 24px 64px rgba(0,0,0,0.3)' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize:16, fontWeight:700, color:C.fg, marginBottom:4, margin:0 }}>Draw your signature</h3>
            <p style={{ fontSize:12, color:C.fgMuted, marginTop:4, marginBottom:14 }}>
              Sign in the box below using your mouse or touch.
            </p>
            <div style={{ borderRadius:10, overflow:'hidden', border:`1px solid ${C.borderStrong}`, background:'#fff' }}>
              <canvas ref={drawPadRef} width={332} height={120}
                style={{ display:'block', touchAction:'none', cursor:'crosshair', width:'100%' }}
                onMouseDown={padStart} onMouseMove={padMove}
                onMouseUp={padEnd} onMouseLeave={padEnd}
                onTouchStart={(e) => { e.preventDefault(); padStart(e); }}
                onTouchMove={(e)  => { e.preventDefault(); padMove(e); }}
                onTouchEnd={padEnd}
              />
            </div>
            <div style={{ display:'flex', gap:8, marginTop:12 }}>
              {[['Clear', clearPad], ['Cancel', () => setDrawingOpen(false)]].map(([label, fn]: any) => (
                <button key={label} onClick={fn} style={{ flex:1, height:38, borderRadius:9,
                  border:`1px solid ${C.border}`, background:'transparent', color:C.fgMuted, fontSize:13, cursor:'pointer' }}>
                  {label}
                </button>
              ))}
              <button onClick={saveDrawing} style={{ flex:1, height:38, borderRadius:9, border:'none',
                background:C.brandGrad, color:'#fff', fontSize:13, fontWeight:600, cursor:'pointer' }}>
                Use this
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'10px 18px', background:C.bgElevated, borderBottom:`1px solid ${C.border}`,
        boxShadow:'0 1px 3px rgba(0,0,0,0.06)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:9, background:C.brandGrad,
            display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:14, color:'#fff' }}>✦</div>
          <div>
            <div style={{ fontWeight:700, fontSize:14, lineHeight:1, color:C.fg }}>Sign Document</div>
            <div style={{ fontSize:11, color:C.fgMuted, marginTop:2 }}>{filename}</div>
          </div>
          <button onClick={() => setSourceOpen(true)}
            style={{ padding:'4px 10px', borderRadius:8, border:`1px solid ${C.border}`,
              background:C.bgInset, color:C.fgMuted, fontSize:12, cursor:'pointer', flexShrink:0 }}>
            📂 Open
          </button>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <button onClick={downloadSigned} disabled={placements.length===0||downloading}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', borderRadius:10,
              border:'none', cursor:placements.length===0?'not-allowed':'pointer', fontWeight:600, fontSize:13,
              background:placements.length===0?C.bgInset:C.brandGrad,
              color:placements.length===0?C.fgSubtle:'#fff', opacity:downloading?0.6:1, transition:'opacity 0.15s' }}>
            {downloading ? '⏳ Saving…' : `↓ Save & download${placements.length>0?` (${placements.length})`:''}`}
          </button>
          <button onClick={close} style={{ padding:'8px 14px', borderRadius:10,
            border:`1px solid ${C.border}`, background:'transparent', color:C.fgMuted, cursor:'pointer', fontSize:13 }}>
            ✕ Close
          </button>
        </div>
      </header>

      {/* Status bar */}
      {status && (
        <div style={{ padding:'7px 18px', fontSize:12, display:'flex', alignItems:'center', justifyContent:'space-between',
          background:status.type==='ok'?'#f0fdf4':'#fef2f2',
          color:status.type==='ok'?C.success:C.danger,
          borderBottom:`1px solid ${status.type==='ok'?'#bbf7d0':'#fecaca'}` }}>
          <span>{status.msg}</span>
          <button onClick={() => setStatus(null)}
            style={{ background:'none', border:'none', color:'inherit', cursor:'pointer', fontSize:14, padding:'0 4px' }}>✕</button>
        </div>
      )}

      {/* Body */}
      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>

        {/* PDF viewer */}
        <div style={{ flex:1, overflowY:'auto', padding:'28px 0',
          display:'flex', flexDirection:'column', alignItems:'center', gap:28, background:C.bgInset }}>

          {pageInfos.length===0 && (
            <div style={{ color:C.fgSubtle, marginTop:80, textAlign:'center' }}>
              {pdfBytes ? (
                <div>
                  <div style={{ fontSize:28 }}>⏳</div>
                  <div style={{ marginTop:8 }}>Rendering PDF…</div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize:48, marginBottom:12 }}>📄</div>
                  <div style={{ fontSize:15, fontWeight:600, color:C.fg, marginBottom:6 }}>No document loaded</div>
                  <div style={{ fontSize:13, color:C.fgMuted, marginBottom:20 }}>
                    Open a PDF from your device or cloud storage
                  </div>
                  <button onClick={() => setSourceOpen(true)}
                    style={{ padding:'10px 24px', borderRadius:10, border:'none',
                      background:C.brandGrad, color:'#fff', fontSize:13, fontWeight:600, cursor:'pointer' }}>
                    📂 Open PDF
                  </button>
                </div>
              )}
            </div>
          )}

          {pageInfos.map((info, i) => {
            const pageNum = i + 1;
            const ratio   = info.renderedWidth / info.pdfWidth;
            const pagePlacements = placements
              .map((p, idx) => ({ p, idx }))
              .filter(({ p }) => p.page === pageNum);

            return (
              <div key={i} style={{ position:'relative' }}>
                <div style={{ position:'absolute', top:-20, left:0, fontSize:11, color:C.fgSubtle }}>
                  Page {pageNum} / {numPages}
                </div>
                <div onClick={(e) => handlePageClick(e, i)}
                  style={{ position:'relative', cursor:armedItem?'crosshair':'default',
                    userSelect:'none', boxShadow:'0 4px 24px rgba(0,0,0,0.12)', background:'#fff' }}>

                  <img src={info.canvas.toDataURL()} alt={`Page ${pageNum}`}
                    style={{ display:'block' }} width={info.renderedWidth} height={info.renderedHeight} draggable={false} />

                  {pagePlacements.map(({ p, idx: globalIdx }) => {
                    const isSelected  = selectedIdx === globalIdx;
                    const isImgKind   = p.kind === 'signature' || p.kind === 'photo';
                    const left  = p.x * ratio;
                    const top   = p.y * ratio;
                    const w     = p.width  * ratio;
                    const h     = p.height * ratio;
                    const fontCss = FONT_FAMILIES.find(f => f.value === p.font_family)?.cssFamily || 'inherit';

                    return (
                      <div key={p.id}
                        onMouseDown={(e) => startDrag(e, p.id)}
                        onClick={(e) => { e.stopPropagation(); setSelectedIdx(globalIdx); setArmedItem(null); }}
                        style={{
                          position:'absolute', left, top,
                          width: isImgKind ? w : undefined,
                          height: isImgKind ? h : undefined,
                          zIndex: isSelected ? 11 : 10,
                          cursor:'move',
                          border: isSelected ? `1px solid ${C.brand500}` : '1px solid transparent',
                          borderRadius:2,
                          background: isSelected ? C.brandSoft : 'transparent',
                          display:'flex', alignItems:'center',
                        }}>
                        <div style={{
                          flex:1, minWidth:0, padding:'0 2px', lineHeight:1.2,
                          whiteSpace:'nowrap', overflow:'hidden',
                          ...(isImgKind ? {} : {
                            fontFamily: fontCss,
                            fontSize:`${Math.max(p.fontsize,6)}px`,
                            fontWeight: p.bold ? 700 : 400,
                            fontStyle:  p.italic ? 'italic' : 'normal',
                            color: p.color,
                          }),
                        }}>
                          {p.kind==='signature' && (
                            sigUrl
                              ? <img src={sigUrl} alt="sig" draggable={false}
                                  style={{ maxWidth:'100%', maxHeight:'100%', objectFit:'contain', pointerEvents:'none', display:'block' }} />
                              : <span style={{ color:C.danger, fontStyle:'italic', fontSize:12 }}>No signature saved</span>
                          )}
                          {p.kind==='photo' && (
                            photoUrl
                              ? <img src={photoUrl} alt="photo" draggable={false}
                                  style={{ width:'100%', height:'100%', objectFit:'cover', pointerEvents:'none', display:'block' }} />
                              : <span style={{ color:C.danger, fontStyle:'italic', fontSize:12 }}>No photo saved</span>
                          )}
                          {p.kind!=='signature' && p.kind!=='photo' && (
                            <input
                              type={p.kind==='number'?'number':p.kind==='date'?'date':p.kind==='time'?'time':'text'}
                              value={p.value}
                              onChange={(e) => updPlacement(p.id, { value:e.target.value })}
                              onClick={(ev) => ev.stopPropagation()}
                              onMouseDown={(ev) => ev.stopPropagation()}
                              placeholder={p.kind}
                              draggable={false}
                              style={{ background:'transparent', outline:'none', border:'none',
                                fontFamily:'inherit', fontSize:'inherit', fontWeight:'inherit',
                                fontStyle:'inherit', color:'inherit', minWidth:30, cursor:'text' }}
                            />
                          )}
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); delPlacement(p.id); }}
                          onMouseDown={(e) => e.stopPropagation()}
                          draggable={false}
                          style={{ position:'absolute', top:-8, right:-8, width:16, height:16,
                            borderRadius:'50%', background:C.danger, border:'none', color:'#fff',
                            fontSize:10, cursor:'pointer', display:'flex', alignItems:'center',
                            justifyContent:'center', fontWeight:700 }}>✕</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Right panel */}
        <div style={{ width:320, background:C.bgElevated, borderLeft:`1px solid ${C.border}`,
          display:'flex', flexDirection:'column', overflowY:'auto', flexShrink:0 }}>
          <div style={{ padding:16 }}>
            {selectedPlacement ? (
              <FontControls
                placement={selectedPlacement}
                onChange={(ch) => updPlacement(selectedPlacement.id, ch)}
                onDeselect={() => setSelectedIdx(null)}
              />
            ) : (
              <PalettePanel
                placements={placements}
                armedItem={armedItem}
                defaults={defaults}
                defaultsOpen={defaultsOpen}
                sigUrl={sigUrl}
                photoUrl={photoUrl}
                vaultFields={vaultFields}
                onDefaultsToggle={() => setDefaultsOpen(v => !v)}
                onDefaultsChange={updateDefaults}
                onArm={armItem}
                onDisarm={() => setArmedItem(null)}
                onRedrawSig={() => setDrawingOpen(true)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── PalettePanel ────────────────────────────────────────────────────────────

function PalettePanel({ placements, armedItem, defaults, defaultsOpen, sigUrl, photoUrl, vaultFields,
  onDefaultsToggle, onDefaultsChange, onArm, onDisarm, onRedrawSig }: {
  placements:       Placement[];
  armedItem:        PaletteItem|null;
  defaults:         FontDefaults;
  defaultsOpen:     boolean;
  sigUrl:           string|null;
  photoUrl:         string|null;
  vaultFields:      VaultField[];
  onDefaultsToggle: () => void;
  onDefaultsChange: (v:FontDefaults) => void;
  onArm:            (item:PaletteItem) => void;
  onDisarm:         () => void;
  onRedrawSig:      () => void;
}) {
  return (
    <>
      <h2 style={{ fontSize:16, fontWeight:700, color:C.fg, margin:'0 0 2px' }}>Add fields to document</h2>
      <p style={{ fontSize:12, color:C.fgMuted, margin:'0 0 12px' }}>
        {placements.length} placement{placements.length===1?'':'s'}
      </p>

      {armedItem && (
        <div style={{ marginBottom:12, padding:'8px 10px', borderRadius:10,
          border:`1px solid ${C.brand500}40`, background:C.brandSoft,
          display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ width:28, height:28, borderRadius:7, background:C.bgElevated,
            border:`1px solid ${C.border}`, display:'grid', placeItems:'center',
            flexShrink:0, fontSize:13, color:C.fgMuted }}>
            {ICONS[armedItem.kind]}
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:600, color:C.fg, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {armedItem.label}
            </div>
            <div style={{ fontSize:11, color:C.fgMuted }}>Click on the document to drop. Esc cancels.</div>
          </div>
          <button onClick={onDisarm}
            style={{ fontSize:11, color:C.fgMuted, padding:'4px 8px', borderRadius:6,
              border:`1px solid ${C.border}`, background:'transparent', cursor:'pointer', flexShrink:0 }}>
            Done
          </button>
        </div>
      )}

      <DefaultsBlock value={defaults} open={defaultsOpen} onToggle={onDefaultsToggle} onChange={onDefaultsChange} />

      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
        {PALETTE.map((item) => {
          const isArmed   = armedItem?.id === item.id;
          const isSig     = item.kind === 'signature';
          const isPhoto   = item.kind === 'photo';
          const hasImg    = isSig ? !!sigUrl : isPhoto ? !!photoUrl : true;
          return (
            <div key={item.id} onClick={() => onArm(item)}
              style={{ padding:'8px 10px', borderRadius:10, cursor:'pointer',
                border:`1px solid ${isArmed ? `${C.brand500}60` : C.border}`,
                background: isArmed ? C.brandSoft : C.bgInset,
                boxShadow: isArmed ? `0 0 0 2px ${C.brand500}25` : undefined,
                display:'flex', alignItems:'center', gap:8, transition:'all 0.12s' }}>
              <div style={{ width:28, height:28, borderRadius:7, background:C.bgElevated,
                border:`1px solid ${C.border}`, display:'grid', placeItems:'center',
                flexShrink:0, fontSize:13, color:C.fgMuted }}>
                {ICONS[item.kind]}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:500, color:C.fg }}>{item.label}</div>
                {(isSig || isPhoto) && !hasImg && (
                  <div style={{ fontSize:11, color:C.fgSubtle }}>
                    {isSig ? 'Click to draw signature' : 'Upload photo on dashboard first'}
                  </div>
                )}
                {(isSig || isPhoto) && hasImg && (
                  <div style={{ fontSize:11, color:C.success }}>✓ Ready</div>
                )}
              </div>
              {isArmed && (
                <span style={{ fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em',
                  color:C.brand400, fontWeight:700, flexShrink:0 }}>armed</span>
              )}
              {isSig && hasImg && !isArmed && (
                <button onClick={(e) => { e.stopPropagation(); onRedrawSig(); }}
                  style={{ fontSize:10, color:C.fgMuted, padding:'2px 6px', borderRadius:4,
                    border:`1px solid ${C.border}`, background:C.bgElevated, cursor:'pointer', flexShrink:0 }}>
                  Redraw
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Vault fields */}
      {vaultFields.length > 0 && (
        <>
          <div style={{ fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em',
            color:C.fgSubtle, fontWeight:700, padding:'12px 0 6px' }}>
            Your Data
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
            {vaultFields.map((field) => {
              const vItem: PaletteItem = {
                id: `vault.${field.key}`,
                label: field.label,
                kind: 'text',
                defaultValue: field.value,
                width: Math.max(80, field.value.length * 7),
                height: 18,
              };
              const isArmed = armedItem?.id === vItem.id;
              return (
                <div key={field.key} onClick={() => onArm(vItem)}
                  style={{ padding:'8px 10px', borderRadius:10, cursor:'pointer',
                    border:`1px solid ${isArmed ? `${C.brand500}60` : C.border}`,
                    background: isArmed ? C.brandSoft : C.bgInset,
                    boxShadow: isArmed ? `0 0 0 2px ${C.brand500}25` : undefined,
                    display:'flex', alignItems:'center', gap:8, transition:'all 0.12s' }}>
                  <div style={{ width:28, height:28, borderRadius:7, background:C.bgElevated,
                    border:`1px solid ${C.border}`, display:'grid', placeItems:'center',
                    flexShrink:0, fontSize:11, color:C.fgMuted }}>
                    T
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:500, color:C.fg, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {field.label}
                    </div>
                    <div style={{ fontSize:11, color:C.fgMuted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {field.value}
                    </div>
                  </div>
                  {isArmed && (
                    <span style={{ fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em',
                      color:C.brand400, fontWeight:700, flexShrink:0 }}>armed</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

// ─── DefaultsBlock ────────────────────────────────────────────────────────────

function DefaultsBlock({ value, open, onToggle, onChange }: {
  value:    FontDefaults;
  open:     boolean;
  onToggle: () => void;
  onChange: (v:FontDefaults) => void;
}) {
  const label  = FONT_FAMILIES.find(f => f.value===value.font_family)?.label ?? value.font_family;
  const css    = FONT_FAMILIES.find(f => f.value===value.font_family)?.cssFamily || 'inherit';
  return (
    <div style={{ marginBottom:12, borderRadius:10, border:`1px solid ${C.border}`, background:C.bgInset, overflow:'hidden' }}>
      <button onClick={onToggle}
        style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'8px 10px', background:'transparent', border:'none', cursor:'pointer' }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', color:C.fgSubtle }}>Default font</span>
          <span style={{ fontSize:12, fontFamily:css, fontWeight:value.bold?700:400,
            fontStyle:value.italic?'italic':'normal', color:value.color }}>
            {label.split(' ')[0]} · {value.fontsize}pt{value.bold?' · B':''}{value.italic?' · I':''}
          </span>
        </div>
        <span style={{ fontSize:13, color:C.fgMuted }}>{open?'−':'+'}</span>
      </button>

      {open && (
        <div style={{ padding:'10px 10px 12px', borderTop:`1px solid ${C.border}` }}>
          <label style={LABEL_STYLE}>Family</label>
          <FontFamilySelect value={value.font_family} onChange={(v) => onChange({ ...value, font_family:v })} />

          <label style={{ ...LABEL_STYLE, marginTop:10 }}>
            Size <span style={{ textTransform:'none', color:C.fgMuted }}>({value.fontsize}pt)</span>
          </label>
          <input type="range" min={6} max={36} step={1} value={value.fontsize}
            onChange={(e) => onChange({ ...value, fontsize:Number(e.target.value) })}
            style={{ width:'100%', marginBottom:10, accentColor:C.brand500 }} />

          <div style={{ display:'flex', gap:8, marginBottom:10 }}>
            <BIButton label="B" active={value.bold} style={{ fontWeight:700 }} onClick={() => onChange({ ...value, bold:!value.bold })} />
            <BIButton label="I" active={value.italic} style={{ fontStyle:'italic' }} onClick={() => onChange({ ...value, italic:!value.italic })} />
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <input type="color" value={value.color}
              onChange={(e) => onChange({ ...value, color:e.target.value })}
              style={{ height:32, width:32, borderRadius:8, border:`1px solid ${C.border}`, cursor:'pointer', padding:2 }} />
            <input type="text" value={value.color}
              onChange={(e) => onChange({ ...value, color:e.target.value })}
              style={{ flex:1, height:32, padding:'0 8px', borderRadius:8, border:`1px solid ${C.border}`,
                background:C.bgElevated, fontSize:12, fontFamily:'monospace', color:C.fg }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FontControls ─────────────────────────────────────────────────────────────

function FontControls({ placement:p, onChange, onDeselect }: {
  placement: Placement;
  onChange:  (ch:Partial<Placement>) => void;
  onDeselect:() => void;
}) {
  const isText = !['signature','photo'].includes(p.kind);
  return (
    <div>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:12 }}>
        <div>
          <h2 style={{ fontSize:16, fontWeight:700, color:C.fg, textTransform:'capitalize', margin:0 }}>
            {p.kind} placement
          </h2>
          <p style={{ fontSize:11, color:C.fgMuted, margin:'2px 0 0' }}>Page {p.page}</p>
        </div>
        <button onClick={onDeselect}
          style={{ width:28, height:28, borderRadius:8, border:`1px solid ${C.border}`,
            background:'transparent', color:C.fgMuted, cursor:'pointer', display:'grid', placeItems:'center', fontSize:14 }}>
          ×
        </button>
      </div>

      {!isText ? (
        <p style={{ fontSize:12, color:C.fgMuted, padding:'10px 12px', borderRadius:10,
          background:C.bgInset, border:`1px solid ${C.border}`, margin:0 }}>
          {p.kind === 'photo' ? 'Passport photo' : 'Signature'} placement. Drag to reposition on the PDF.
        </p>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div>
            <label style={LABEL_STYLE}>Font family</label>
            <FontFamilySelect value={p.font_family??'helv'} onChange={(v) => onChange({ font_family:v })} />
            {p.value && (
              <div style={{ marginTop:6, padding:'7px 10px', borderRadius:8, border:`1px solid ${C.border}`,
                background:C.bgBase, fontSize:13, color:C.fg, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                fontFamily:FONT_FAMILIES.find(f=>f.value===p.font_family)?.cssFamily||'inherit' }}>
                {p.value}
              </div>
            )}
          </div>

          <div>
            <label style={LABEL_STYLE}>
              Size <span style={{ fontWeight:400, color:C.fgSubtle }}>({p.fontsize??10}pt)</span>
            </label>
            <input type="range" min={6} max={36} step={1} value={p.fontsize??10}
              onChange={(e) => onChange({ fontsize:Number(e.target.value) })}
              style={{ width:'100%', accentColor:C.brand500 }} />
            <div style={{ display:'flex', gap:4, marginTop:6 }}>
              {[8,10,12,14,18,24].map(s => (
                <button key={s} onClick={() => onChange({ fontsize:s })}
                  style={{ flex:1, height:28, fontSize:11, borderRadius:6, cursor:'pointer',
                    border:`1px solid ${(p.fontsize??10)===s?`${C.brand500}60`:C.border}`,
                    background:(p.fontsize??10)===s?`${C.brand500}15`:'transparent',
                    color:(p.fontsize??10)===s?C.fg:C.fgMuted }}>{s}</button>
              ))}
            </div>
          </div>

          <div style={{ display:'flex', gap:8 }}>
            <BIButton label="B" active={!!p.bold} style={{ fontWeight:700, fontSize:15 }} onClick={() => onChange({ bold:!p.bold })} />
            <BIButton label="I" active={!!p.italic} style={{ fontStyle:'italic', fontSize:15 }} onClick={() => onChange({ italic:!p.italic })} />
          </div>

          <div>
            <label style={LABEL_STYLE}>Color</label>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
              <input type="color" value={p.color??'#000000'}
                onChange={(e) => onChange({ color:e.target.value })}
                style={{ height:36, width:36, borderRadius:8, border:`1px solid ${C.border}`, cursor:'pointer', padding:2 }} />
              <input type="text" value={p.color??'#000000'}
                onChange={(e) => onChange({ color:e.target.value })}
                style={{ flex:1, height:36, padding:'0 8px', borderRadius:8, border:`1px solid ${C.border}`,
                  background:C.bgElevated, fontSize:12, fontFamily:'monospace', color:C.fg }} />
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:6 }}>
              {COLOR_PRESETS.map(c => (
                <button key={c} onClick={() => onChange({ color:c })}
                  style={{ aspectRatio:'1', borderRadius:6, cursor:'pointer',
                    border:`2px solid ${p.color===c?C.brand400:'transparent'}`,
                    background:c, transition:'border-color 0.1s' }}
                  title={c} />
              ))}
            </div>
          </div>

          <div style={{ paddingTop:8, borderTop:`1px solid ${C.border}` }}>
            <p style={{ fontSize:11, color:C.fgSubtle, margin:0 }}>
              Drag the placement box on the PDF to reposition it.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── shared sub-components ────────────────────────────────────────────────────

function FontFamilySelect({ value, onChange }: { value:string; onChange:(v:string)=>void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ width:'100%', height:34, padding:'0 8px', borderRadius:8,
        border:`1px solid ${C.border}`, background:C.bgElevated, fontSize:13, color:C.fg,
        display:'block', marginBottom:0 }}>
      <optgroup label="Standard">
        {FONT_FAMILIES.filter(f=>['sans','serif','mono'].includes(f.category||'')).map(f=>(
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </optgroup>
      <optgroup label="Signing">
        {FONT_FAMILIES.filter(f=>['script','calligraphy','handwriting','signature'].includes(f.category||'')).map(f=>(
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </optgroup>
    </select>
  );
}

function BIButton({ label, active, style, onClick }: {
  label:string; active:boolean; style?:React.CSSProperties; onClick:()=>void;
}) {
  return (
    <button onClick={onClick}
      style={{ flex:1, height:36, borderRadius:8, cursor:'pointer',
        border:`1px solid ${active?`${C.brand500}60`:C.border}`,
        background:active?`${C.brand500}15`:'transparent',
        color:active?C.fg:C.fgMuted, fontSize:14, ...style }}>
      {label}
    </button>
  );
}

const LABEL_STYLE: React.CSSProperties = {
  display:'block', fontSize:12, fontWeight:500, color:C.fgMuted, marginBottom:4,
};
