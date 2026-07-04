/**
 * Inline PDF Signing Page — runs inside a full-screen iframe overlay
 * injected by the content script on PDF pages.
 *
 * Features:
 *   - Renders PDF pages with PDF.js (canvas, multi-page, scroll)
 *   - Signature drawing pad (freehand)
 *   - Text / date / initials stamp
 *   - Click anywhere on the page to place a stamp
 *   - Drag placed stamps to reposition
 *   - Delete placed stamps
 *   - Download the signed PDF (client-side via pdf-lib — no server round-trip)
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

// Point the worker at the copy we placed in public/
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

// ---- Types ------------------------------------------------------------------

type ToolType = 'signature' | 'text' | 'date' | 'initials';

interface Stamp {
  id: string;
  page: number;       // 1-indexed
  x: number;         // pixels from left of the page canvas
  y: number;         // pixels from top of the page canvas
  width: number;
  height: number;
  type: ToolType;
  dataUrl?: string;  // for signature/initials (PNG)
  text?: string;     // for text/date
}

// ---- Helpers ----------------------------------------------------------------

function uid() { return Math.random().toString(36).slice(2); }

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---- Component --------------------------------------------------------------

export default function SigningPage() {
  // PDF state
  const [pdfBytes, setPdfBytes]       = useState<Uint8Array | null>(null);
  const [pdfDoc, setPdfDoc]           = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages]       = useState(0);
  const [filename, setFilename]       = useState('document.pdf');
  const [pageScales, setPageScales]   = useState<number[]>([]);   // rendered scale per page
  const [pageCanvases, setPageCanvases] = useState<HTMLCanvasElement[]>([]);

  // Signing state
  const [stamps, setStamps]           = useState<Stamp[]>([]);
  const [activeTool, setActiveTool]   = useState<ToolType>('signature');
  const [sigDataUrl, setSigDataUrl]   = useState<string | null>(null);      // drawn signature
  const [initDataUrl, setInitDataUrl] = useState<string | null>(null);      // drawn initials
  const [customText, setCustomText]   = useState('');
  const [placingMode, setPlacingMode] = useState(false);   // click-to-place active
  const [status, setStatus]           = useState<{msg: string; type: 'ok'|'err'}|null>(null);
  const [downloading, setDownloading] = useState(false);

  // Signature pad
  const sigPadRef    = useRef<HTMLCanvasElement>(null);
  const initPadRef   = useRef<HTMLCanvasElement>(null);
  const isDrawing    = useRef(false);
  const lastXY       = useRef({ x: 0, y: 0 });

  // PDF containers
  const pdfAreaRef   = useRef<HTMLDivElement>(null);
  // page canvas refs keyed by page number
  const canvasRefs   = useRef<Map<number, HTMLCanvasElement>>(new Map());

  // Drag state
  const dragRef      = useRef<{id: string; ox: number; oy: number; mx: number; my: number}|null>(null);

  // ---- Boot — load PDF from chrome.storage.session -------------------------

  useEffect(() => {
    chrome.storage.session.get(['affixai_signing_pdf', 'affixai_signing_name'], (res) => {
      if (res.affixai_signing_pdf) {
        setPdfBytes(base64ToBytes(res.affixai_signing_pdf));
        setFilename(res.affixai_signing_name || 'document.pdf');
      }
    });
    // Also accept postMessage (fallback if session storage isn't available)
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'AFFIXAI_PDF_DATA') {
        setPdfBytes(base64ToBytes(e.data.base64));
        setFilename(e.data.filename || 'document.pdf');
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // ---- Parse PDF with PDF.js -----------------------------------------------

  useEffect(() => {
    if (!pdfBytes) return;
    pdfjsLib.getDocument({ data: pdfBytes }).promise.then((doc) => {
      setPdfDoc(doc);
      setNumPages(doc.numPages);
    });
  }, [pdfBytes]);

  // Render each page when pdfDoc is ready
  useEffect(() => {
    if (!pdfDoc) return;
    const SCALE = 1.4;
    const canvases: HTMLCanvasElement[] = [];
    const scales: number[] = [];

    (async () => {
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const vp = page.getViewport({ scale: SCALE });
        const canvas = canvasRefs.current.get(i) || document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        canvasRefs.current.set(i, canvas);
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        canvases.push(canvas);
        scales.push(SCALE);
      }
      setPageCanvases([...canvases]);
      setPageScales([...scales]);
    })();
  }, [pdfDoc]);

  // ---- Signature pad drawing -----------------------------------------------

  function padStart(e: React.MouseEvent | React.TouchEvent, padRef: React.RefObject<HTMLCanvasElement>) {
    isDrawing.current = true;
    const pos = relPos(e, padRef.current!);
    lastXY.current = pos;
  }

  function padMove(e: React.MouseEvent | React.TouchEvent, padRef: React.RefObject<HTMLCanvasElement>) {
    if (!isDrawing.current) return;
    const canvas = padRef.current!;
    const ctx = canvas.getContext('2d')!;
    const pos = relPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(lastXY.current.x, lastXY.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    lastXY.current = pos;
  }

  function padEnd(padRef: React.RefObject<HTMLCanvasElement>, setter: (v: string) => void) {
    isDrawing.current = false;
    setter(padRef.current!.toDataURL());
  }

  function clearPad(padRef: React.RefObject<HTMLCanvasElement>, setter: (v: string | null) => void) {
    const ctx = padRef.current!.getContext('2d')!;
    ctx.clearRect(0, 0, padRef.current!.width, padRef.current!.height);
    setter(null);
  }

  // ---- Click-to-place on PDF pages -----------------------------------------

  function handlePageClick(e: React.MouseEvent<HTMLDivElement>, pageIndex: number) {
    if (!placingMode) return;
    const pageNum = pageIndex + 1;
    const canvas = canvasRefs.current.get(pageNum);
    if (!canvas) return;

    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    // Determine what to stamp
    let dataUrl: string | undefined;
    let text: string | undefined;
    let w = 160, h = 60;

    if (activeTool === 'signature') {
      if (!sigDataUrl) { setStatus({ msg: 'Draw your signature first.', type: 'err' }); return; }
      dataUrl = sigDataUrl;
    } else if (activeTool === 'initials') {
      if (!initDataUrl) { setStatus({ msg: 'Draw your initials first.', type: 'err' }); return; }
      dataUrl = initDataUrl;
      w = 80; h = 50;
    } else if (activeTool === 'date') {
      text = new Date().toLocaleDateString();
      w = 120; h = 24;
    } else {
      text = customText || 'Text';
      w = Math.max(80, customText.length * 8);
      h = 24;
    }

    setStamps(prev => [...prev, {
      id: uid(), page: pageNum,
      x: cx - w / 2, y: cy - h / 2,
      width: w, height: h,
      type: activeTool,
      dataUrl, text,
    }]);
    setPlacingMode(false);
    setStatus({ msg: 'Placed! Drag to reposition, or click ✕ to remove.', type: 'ok' });
  }

  // ---- Drag to reposition stamps -------------------------------------------

  const startDrag = useCallback((e: React.MouseEvent, id: string, currentX: number, currentY: number) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { id, ox: currentX, oy: currentY, mx: e.clientX, my: e.clientY };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.mx;
      const dy = ev.clientY - dragRef.current.my;
      setStamps(prev => prev.map(s =>
        s.id === dragRef.current!.id
          ? { ...s, x: dragRef.current!.ox + dx, y: dragRef.current!.oy + dy }
          : s
      ));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  function removeStamp(id: string) {
    setStamps(prev => prev.filter(s => s.id !== id));
  }

  // ---- Download signed PDF -------------------------------------------------

  async function downloadSigned() {
    if (!pdfBytes) return;
    setDownloading(true);
    setStatus(null);
    try {
      const doc = await PDFDocument.load(pdfBytes);
      const font = await doc.embedFont(StandardFonts.Helvetica);

      for (const stamp of stamps) {
        const page = doc.getPages()[stamp.page - 1];
        const { width: pW, height: pH } = page.getSize();
        const canvas = canvasRefs.current.get(stamp.page);
        if (!canvas) continue;

        // Canvas → PDF coordinate conversion
        const scaleX = pW / canvas.width;
        const scaleY = pH / canvas.height;
        // PDF y=0 is bottom; canvas y=0 is top
        const pdfX = stamp.x * scaleX;
        const pdfY = pH - (stamp.y + stamp.height) * scaleY;

        if (stamp.dataUrl) {
          const imgBytes = await fetch(stamp.dataUrl).then(r => r.arrayBuffer());
          const img = await doc.embedPng(imgBytes);
          page.drawImage(img, {
            x: pdfX,
            y: pdfY,
            width: stamp.width * scaleX,
            height: stamp.height * scaleY,
          });
        } else if (stamp.text) {
          page.drawText(stamp.text, {
            x: pdfX,
            y: pdfY + stamp.height * scaleY * 0.25,
            size: Math.max(8, stamp.height * scaleY * 0.6),
            font,
            color: rgb(0.1, 0.1, 0.1),
          });
        }
      }

      const signed = await doc.save();
      const blob = new Blob([signed], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `signed-${filename}`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus({ msg: 'Signed PDF downloaded!', type: 'ok' });
    } catch (err: any) {
      setStatus({ msg: `Download failed: ${err.message}`, type: 'err' });
    } finally {
      setDownloading(false);
    }
  }

  // ---- Close overlay -------------------------------------------------------

  function close() {
    // Notify the parent content script to remove this iframe
    window.parent.postMessage({ type: 'AFFIXAI_CLOSE_SIGNING' }, '*');
    window.close();
  }

  // ---- Render --------------------------------------------------------------

  const noSig = !sigDataUrl;
  const readyToPlace =
    (activeTool === 'signature' && !!sigDataUrl) ||
    (activeTool === 'initials' && !!initDataUrl) ||
    activeTool === 'date' ||
    (activeTool === 'text' && !!customText);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f1219', color: '#e2e8f0', fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', background: '#161b27', borderBottom: '1px solid #2d3448' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg,#a855f7,#ec4899)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, color: '#fff' }}>✦</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1 }}>AffixAI — Sign Document</div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{filename}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={downloadSigned} disabled={stamps.length === 0 || downloading}
            style={{ padding: '7px 16px', borderRadius: 8, border: 'none', cursor: stamps.length === 0 ? 'default' : 'pointer', fontWeight: 700, fontSize: 12, background: stamps.length === 0 ? '#374151' : 'linear-gradient(135deg,#a855f7,#ec4899)', color: '#fff', opacity: downloading ? 0.6 : 1 }}>
            {downloading ? 'Saving…' : `⬇ Download Signed PDF${stamps.length > 0 ? ` (${stamps.length})` : ''}`}
          </button>
          <button onClick={close}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}>
            ✕ Close
          </button>
        </div>
      </div>

      {/* ── Status bar ── */}
      {status && (
        <div style={{ padding: '6px 18px', fontSize: 12, background: status.type === 'ok' ? '#14532d' : '#7f1d1d', color: status.type === 'ok' ? '#86efac' : '#fca5a5' }}>
          {status.msg}
          <button onClick={() => setStatus(null)} style={{ marginLeft: 10, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12 }}>✕</button>
        </div>
      )}

      {/* ── Main area ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── PDF Viewer (left) ── */}
        <div ref={pdfAreaRef} style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, background: '#1a2035' }}>
          {pageCanvases.length === 0 && (
            <div style={{ color: '#64748b', marginTop: 80, textAlign: 'center' }}>
              {pdfBytes ? (
                <>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
                  <div>Rendering PDF…</div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>📄</div>
                  <div>Loading PDF…</div>
                </>
              )}
            </div>
          )}

          {pageCanvases.map((canvas, i) => {
            const pageNum = i + 1;
            const pageStamps = stamps.filter(s => s.page === pageNum);
            return (
              <div key={i} style={{ position: 'relative', boxShadow: '0 4px 32px rgba(0,0,0,0.5)' }}>
                {/* Page label */}
                <div style={{ position: 'absolute', top: -22, left: 0, fontSize: 11, color: '#64748b' }}>
                  Page {pageNum} / {numPages}
                </div>

                {/* Clickable overlay */}
                <div
                  onClick={(e) => handlePageClick(e, i)}
                  style={{ position: 'relative', cursor: placingMode ? 'crosshair' : 'default', userSelect: 'none' }}
                >
                  {/* PDF page canvas */}
                  <img
                    src={canvas.toDataURL()}
                    alt={`Page ${pageNum}`}
                    style={{ display: 'block', maxWidth: '100%' }}
                    width={canvas.width}
                    height={canvas.height}
                  />

                  {/* Placed stamps overlay */}
                  {pageStamps.map(stamp => (
                    <div
                      key={stamp.id}
                      onMouseDown={(e) => startDrag(e, stamp.id, stamp.x, stamp.y)}
                      style={{
                        position: 'absolute',
                        left: stamp.x, top: stamp.y,
                        width: stamp.width, height: stamp.height,
                        cursor: 'grab',
                        border: '2px dashed #a855f7',
                        borderRadius: 4,
                        background: 'rgba(168,85,247,0.06)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        userSelect: 'none',
                      }}
                    >
                      {stamp.dataUrl ? (
                        <img src={stamp.dataUrl} alt="sig"
                          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', pointerEvents: 'none' }} />
                      ) : (
                        <span style={{ fontSize: 13, color: '#1a1a2e', fontWeight: 600, pointerEvents: 'none' }}>
                          {stamp.text}
                        </span>
                      )}
                      {/* Remove button */}
                      <button
                        onClick={(e) => { e.stopPropagation(); removeStamp(stamp.id); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{
                          position: 'absolute', top: -10, right: -10,
                          width: 20, height: 20, borderRadius: '50%',
                          background: '#ef4444', border: 'none', color: '#fff',
                          fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontWeight: 700,
                        }}
                      >✕</button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Tools Sidebar (right) ── */}
        <div style={{ width: 240, background: '#161b27', borderLeft: '1px solid #2d3448', display: 'flex', flexDirection: 'column', padding: 14, gap: 14, overflowY: 'auto' }}>

          {/* Tool selector */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Tool</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {(['signature', 'initials', 'date', 'text'] as ToolType[]).map(t => (
                <button key={t} onClick={() => { setActiveTool(t); setPlacingMode(false); }}
                  style={{
                    padding: '6px 4px', borderRadius: 7, border: activeTool === t ? '2px solid #a855f7' : '1px solid #2d3448',
                    background: activeTool === t ? 'rgba(168,85,247,0.15)' : 'transparent',
                    color: activeTool === t ? '#c084fc' : '#94a3b8',
                    fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  }}>
                  {t === 'signature' ? '✍️ Signature' : t === 'initials' ? '🅰️ Initials' : t === 'date' ? '📅 Date' : '📝 Text'}
                </button>
              ))}
            </div>
          </div>

          <div style={{ height: 1, background: '#2d3448' }} />

          {/* Tool-specific UI */}
          {(activeTool === 'signature' || activeTool === 'initials') && (() => {
            const isInit = activeTool === 'initials';
            const padRef = isInit ? initPadRef : sigPadRef;
            const dataUrl = isInit ? initDataUrl : sigDataUrl;
            const setter  = isInit ? setInitDataUrl : setSigDataUrl;
            return (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                  Draw your {isInit ? 'initials' : 'signature'}
                </div>
                <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid #374151', background: '#fff' }}>
                  <canvas
                    ref={padRef}
                    width={210} height={isInit ? 70 : 100}
                    style={{ display: 'block', touchAction: 'none', cursor: 'crosshair' }}
                    onMouseDown={(e) => padStart(e, padRef)}
                    onMouseMove={(e) => padMove(e, padRef)}
                    onMouseUp={() => padEnd(padRef, setter)}
                    onMouseLeave={() => { if (isDrawing.current) padEnd(padRef, setter); }}
                    onTouchStart={(e) => { e.preventDefault(); padStart(e, padRef); }}
                    onTouchMove={(e) => { e.preventDefault(); padMove(e, padRef); }}
                    onTouchEnd={() => padEnd(padRef, setter)}
                  />
                </div>
                <button onClick={() => clearPad(padRef, setter)}
                  style={{ marginTop: 6, width: '100%', padding: '5px 0', borderRadius: 6, border: '1px solid #374151', background: 'transparent', color: '#94a3b8', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Clear
                </button>
                {dataUrl && (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#86efac' }}>✓ {isInit ? 'Initials' : 'Signature'} captured</div>
                )}
              </div>
            );
          })()}

          {activeTool === 'text' && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Text to stamp</div>
              <input
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="Type text…"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #374151', background: '#0f1219', color: '#e2e8f0', fontSize: 12, fontFamily: 'inherit', outline: 'none' }}
              />
            </div>
          )}

          {activeTool === 'date' && (
            <div style={{ fontSize: 12, color: '#94a3b8', padding: '6px 10px', borderRadius: 7, border: '1px solid #374151', background: '#0f1219' }}>
              Stamps today: <strong style={{ color: '#e2e8f0' }}>{new Date().toLocaleDateString()}</strong>
            </div>
          )}

          {/* Place button */}
          {pageCanvases.length > 0 && (
            <button
              onClick={() => {
                if (!readyToPlace) {
                  setStatus({ msg: activeTool === 'signature' ? 'Draw your signature above first.' : activeTool === 'initials' ? 'Draw your initials above first.' : 'Enter text above first.', type: 'err' });
                  return;
                }
                setPlacingMode(true);
                setStatus({ msg: 'Click anywhere on the PDF to place it.', type: 'ok' });
              }}
              style={{
                width: '100%', padding: '10px 0', borderRadius: 8, border: 'none',
                background: placingMode ? 'rgba(168,85,247,0.3)' : 'linear-gradient(135deg,#a855f7,#ec4899)',
                color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                boxShadow: placingMode ? 'none' : '0 2px 12px rgba(168,85,247,0.4)',
              }}>
              {placingMode ? '🎯 Click on the PDF…' : '＋ Place on PDF'}
            </button>
          )}

          {placingMode && (
            <button onClick={() => setPlacingMode(false)}
              style={{ width: '100%', padding: '6px 0', borderRadius: 7, border: '1px solid #374151', background: 'transparent', color: '#94a3b8', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
              Cancel
            </button>
          )}

          <div style={{ height: 1, background: '#2d3448' }} />

          {/* Stamp summary */}
          {stamps.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                Placed ({stamps.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {stamps.map(s => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', borderRadius: 6, background: '#0f1219', fontSize: 11 }}>
                    <span style={{ color: '#94a3b8' }}>
                      {s.type === 'signature' ? '✍️' : s.type === 'initials' ? '🅰️' : s.type === 'date' ? '📅' : '📝'}
                      {' '}p.{s.page}
                    </span>
                    <button onClick={() => removeStamp(s.id)}
                      style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12, padding: '0 2px' }}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Download in sidebar too */}
          <div style={{ marginTop: 'auto' }}>
            <button onClick={downloadSigned} disabled={stamps.length === 0 || downloading}
              style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', cursor: stamps.length === 0 ? 'default' : 'pointer', fontWeight: 700, fontSize: 12, fontFamily: 'inherit', background: stamps.length === 0 ? '#1e293b' : 'linear-gradient(135deg,#a855f7,#ec4899)', color: stamps.length === 0 ? '#475569' : '#fff', opacity: downloading ? 0.6 : 1 }}>
              {downloading ? 'Saving…' : '⬇ Download Signed PDF'}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}

// ---- Util -------------------------------------------------------------------

function relPos(e: React.MouseEvent | React.TouchEvent, el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  if ('touches' in e) {
    return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
  }
  return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top };
}
