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
const light = {bg:'#f7f8fb',surface:'#ffffff',surface2:'#eef1f7',fg:'#14161c',fgMuted:'#4b515f',border:'#8d9097',accent:'#17418f',accentFg:'#ffffff',urgent:'#99211b',urgentSoft:'#fdeceb',focus:'#0b63d6'};
const dark = {bg:'#0e1016',surface:'#171a22',surface2:'#1f232d',fg:'#eef0f6',fgMuted:'#a6aebf',border:'#636772',accent:'#9db8ff',accentFg:'#0e1016',urgent:'#ff8f88',urgentSoft:'#33191a',focus:'#8ab4ff'};
let fails = 0;
for (const [name,p] of [['LIGHT',light],['DARK',dark]]) {
  const rows = [['body/bg',p.fg,p.bg,7],['body/surface',p.fg,p.surface,7],['muted/bg',p.fgMuted,p.bg,7],['muted/surface',p.fgMuted,p.surface,7],['muted/surface2',p.fgMuted,p.surface2,7],['accent/bg',p.accent,p.bg,7],['accent/surface',p.accent,p.surface,7],['button text',p.accentFg,p.accent,7],['urgent/soft',p.urgent,p.urgentSoft,7],['urgent/bg',p.urgent,p.bg,7],['control border/surface',p.border,p.surface,3],['control border/bg',p.border,p.bg,3],['focus/bg',p.focus,p.bg,3]];
  console.log('===', name);
  for (const [l,a,b,n] of rows) { const r = ratio(a,b); const ok = r>=n; if(!ok) fails++; console.log(' ', ok?'PASS':'FAIL', l.padEnd(24), r.toFixed(2)+':1'); }
}
console.log(fails ? fails+' FAILURES' : 'all contrast checks pass');
