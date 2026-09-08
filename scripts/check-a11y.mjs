#!/usr/bin/env node
/**
 * Structural accessibility checks, run against every page in a real browser.
 *
 * Not a substitute for testing with a screen reader or with the people this
 * site is for — but the things it checks are the ones that regress silently
 * when a component moves: a heading level that now skips, a control that lost
 * its accessible name, a target that shrank below 44 pixels.
 *
 * Contrast is checked separately by scripts/check-contrast.mjs, against the
 * palette rather than the rendered page.
 *
 *   node scripts/check-a11y.mjs <baseUrl>
 *
 * Requires a browser. Run it through the Browser pane's javascript_tool by
 * pasting AUDIT_SOURCE below, or with Playwright if it is installed.
 */

export const AUDIT_SOURCE = String.raw`
(() => {
  // 2.5.5 exempts a target that sits inside a sentence or block of text, so
  // links in prose are measured but not failed.
  const inProse = (el) => !!el.closest('p, li, dd, .summary, .example, .source');

  const interactive = [...document.querySelectorAll(
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  const problems = [];

  // 2.5.5 Target size (AAA): 44 by 44.
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    if ((r.width < 44 || r.height < 44) && !inProse(el)) {
      problems.push('target too small: ' + el.tagName + '.' + (el.className || '') +
        ' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
        ' "' + (el.textContent || '').trim().slice(0, 24) + '"');
    }
  }

  // 4.1.2 Name, role, value: every control needs an accessible name.
  for (const el of interactive) {
    const name = (el.textContent || '').trim() || el.getAttribute('aria-label') ||
      el.getAttribute('aria-labelledby') || el.getAttribute('title') ||
      (el.id && document.querySelector('label[for="' + el.id + '"]'));
    if (!name) problems.push('control with no accessible name: ' + el.outerHTML.slice(0, 80));
  }

  // 1.3.1 / 2.4.10: one h1, and no skipped levels.
  const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => +h.tagName[1]);
  const h1s = levels.filter((n) => n === 1).length;
  if (h1s !== 1) problems.push('expected exactly one h1, found ' + h1s);
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) {
      problems.push('heading level skipped: h' + levels[i - 1] + ' to h' + levels[i]);
    }
  }

  // 1.1.1: images need alt text, even if empty for decoration.
  const noAlt = [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length;
  if (noAlt) problems.push(noAlt + ' image(s) with no alt attribute');

  // 1.4.10 Reflow: no sideways scrolling at the current width.
  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    problems.push('horizontal overflow: ' + document.documentElement.scrollWidth + 'px in ' + window.innerWidth + 'px');
  }

  // 3.1.1: the page has to declare its language, and RTL its direction.
  if (!document.documentElement.lang) problems.push('no lang on <html>');
  if (['he', 'ar'].includes(document.documentElement.lang) && document.documentElement.dir !== 'rtl') {
    problems.push('RTL language without dir="rtl"');
  }

  // 1.3.1: landmarks.
  if (!document.querySelector('main')) problems.push('no <main> landmark');

  // 2.4.1: a way past the header.
  if (!document.querySelector('.skip, [class*="skip"]')) problems.push('no skip link');

  return {
    url: location.pathname + location.search,
    controls: interactive.length,
    headings: levels.length,
    problems,
  };
})()
`;

console.log('Paste AUDIT_SOURCE into the browser console on each page, or import it from a driver.');
console.log('Pages to check: /  /search?q=...  /s/<id>  /saved  /smart?q=...  /developers  /accessibility');
