#!/usr/bin/env node
/**
 * WCAG contrast check for the public site's palette.
 *
 * The values here mirror the custom properties in packages/web/src/styles.css.
 * They are checked rather than eyeballed because AAA asks for 7:1 on body text,
 * and several colours that look obviously fine land between 5:1 and 7:1 — the
 * first palette failed six of these.
 *
 *   node scripts/check-contrast.mjs
 */

const hex = (h) => { h = h.replace('#',''); return [0,2,4].map((i)=>parseInt(h.slice(i,i+2),16)); };
const lin = (c) => { c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055,2.4); };
const L = (h) => { const [r,g,b] = hex(h).map(lin); return 0.2126*r+0.7152*g+0.0722*b; };
const ratio = (a,b) => { const l1=L(a), l2=L(b); const [hi,lo] = l1>l2?[l1,l2]:[l2,l1]; return (hi+0.05)/(lo+0.05); };
const light = {bg:'#f4f6f8',surface:'#ffffff',surface2:'#eef1f4',fg:'#111827',fgMuted:'#454b56',border:'#868c95',accent:'#0e5a57',accentFg:'#ffffff',accentSoft:'#ecf6f4',hero:'#e2f0ee',urgent:'#99211b',urgentSoft:'#fdeceb',note:'#fff4d6',noteFg:'#4d3200',focus:'#1d64d8'};
const dark = {bg:'#0f1419',surface:'#161c23',surface2:'#1e252e',fg:'#eef1f5',fgMuted:'#a9b2bf',border:'#6b7581',accent:'#7dd3c7',accentFg:'#0f1419',accentSoft:'#15302e',hero:'#132826',urgent:'#ff9b93',urgentSoft:'#34191a',note:'#342a10',noteFg:'#ffe1a3',focus:'#8ab4ff'};
let fails = 0;
for (const [name,p] of [['LIGHT',light],['DARK',dark]]) {
  const rows = [['body/bg',p.fg,p.bg,7],['body/surface',p.fg,p.surface,7],['muted/bg',p.fgMuted,p.bg,7],['muted/surface',p.fgMuted,p.surface,7],['muted/surface2',p.fgMuted,p.surface2,7],['accent/bg',p.accent,p.bg,7],['accent/surface',p.accent,p.surface,7],['button text',p.accentFg,p.accent,7],['accent/accentSoft',p.accent,p.accentSoft,7],['muted/hero',p.fgMuted,p.hero,7],['body/hero',p.fg,p.hero,7],['draft ribbon',p.noteFg,p.note,7],['urgent/soft',p.urgent,p.urgentSoft,7],['urgent/bg',p.urgent,p.bg,7],['control border/surface',p.border,p.surface,3],['control border/bg',p.border,p.bg,3],['focus/bg',p.focus,p.bg,3]];
  console.log('===', name);
  for (const [l,a,b,n] of rows) { const r = ratio(a,b); const ok = r>=n; if(!ok) fails++; console.log(' ', ok?'PASS':'FAIL', l.padEnd(24), r.toFixed(2)+':1'); }
}
console.log(fails ? fails+' FAILURES' : 'all contrast checks pass');
