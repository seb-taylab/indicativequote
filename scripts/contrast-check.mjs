#!/usr/bin/env node
/**
 * §16.2: "WCAG 2.1 AA. Contrast checked in BOTH themes."
 *
 * The axe scan runs in jsdom, which has no layout and no cascade, so
 * `color-contrast` cannot execute there. Rather than let that rule quietly not
 * run, contrast is checked here directly against the palette tokens in
 * app/globals.css -- every foreground/background pair the interface actually
 * puts together, in light and dark.
 *
 * AA thresholds: 4.5:1 for body text, 3:1 for large text and UI boundaries.
 * Status pills are small bold text and are held to 4.5:1.
 */
import { readFileSync } from 'node:fs';

const css = readFileSync('app/globals.css', 'utf8');

function paletteFrom(block) {
  const vars = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    vars[name] = value;
  }
  return vars;
}

// :root { ... } is light. The dark block is the prefers-color-scheme override.
const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf('@media'));
const darkBlock = css.slice(css.indexOf('@media'), css.indexOf('body {'));

const light = paletteFrom(lightBlock);
const dark = { ...light, ...paletteFrom(darkBlock) };

function srgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = srgb(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Every pair the interface actually renders together. */
const PAIRS = [
  ['text', 'bg', 4.5, 'body text on page'],
  ['text', 'surface', 4.5, 'body text on a panel'],
  ['muted', 'bg', 4.5, 'secondary text on page'],
  ['muted', 'surface', 4.5, 'secondary text on a panel'],
  ['accent', 'bg', 4.5, 'link on page'],
  ['accent', 'surface', 4.5, 'link on a panel'],
  ['live', 'live-bg', 4.5, 'status pill: live'],
  ['expiring', 'expiring-bg', 4.5, 'status pill: expiring'],
  ['expired', 'expired-bg', 4.5, 'status pill: expired'],
  ['neutral', 'neutral-bg', 4.5, 'status pill: reason'],
  // WCAG 2.1 SC 1.4.11 applies to CONTROL boundaries, not decorative rules.
  ['control-border', 'bg', 3.0, 'input / select / button outline'],
  ['control-border', 'surface', 3.0, 'control outline on a panel'],
  // --border is a decorative table rule and is deliberately NOT held to 3:1;
  // it conveys no information and 1.4.11 does not cover it.
];

let failures = 0;
for (const [themeName, palette] of [['light', light], ['dark', dark]]) {
  console.log(`\n${themeName} theme`);
  for (const [fgVar, bgVar, min, label] of PAIRS) {
    const fg = palette[fgVar];
    const bg = palette[bgVar];
    if (!fg || !bg) {
      console.log(`  ?      ${label.padEnd(30)} missing token --${fgVar} or --${bgVar}`);
      failures += 1;
      continue;
    }
    const r = ratio(fg, bg);
    const ok = r >= min;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'}   ${label.padEnd(30)} ${r.toFixed(2)}:1  (needs ${min}:1)  ${fg} on ${bg}`,
    );
  }
}

console.log('\n' + '='.repeat(64));
console.log(
  failures === 0
    ? 'PASS - every rendered colour pair meets WCAG 2.1 AA in both themes'
    : `FAIL - ${failures} pair(s) below AA`,
);
process.exit(failures === 0 ? 0 : 1);
