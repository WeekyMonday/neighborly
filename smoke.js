// Validates that the CSS is well-formed (balanced braces, no dangling
// selectors) and that the inline <script> blocks in the app entry parse as
// valid JavaScript. Catches the class of mistake that a browser only reports
// as a blank page.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const CSS = path.join(ROOT, 'FRONTEND/www/css/artificium-theme.css');
const HTML = path.join(ROOT, 'FRONTEND/www/Neighborly(Update).html');

let failures = 0;

// ---- CSS brace balance ---------------------------------------------------
const css = fs.readFileSync(CSS, 'utf8');
let depth = 0;
let line = 1;
for (const ch of css) {
  if (ch === '\n') line++;
  if (ch === '{') depth++;
  if (ch === '}') depth--;
  if (depth < 0) {
    console.log(`FAIL css: unexpected '}' at line ${line}`);
    failures++;
    break;
  }
}
if (depth !== 0) {
  console.log(`FAIL css: ${depth} unclosed block(s) at end of file`);
  failures++;
} else {
  console.log('PASS css braces are balanced');
}

// A bad insertion can leave a selector list ending in a comma, e.g.
// ".a, .b,\n.c { }" split across an inserted block.
if (/,\s*\}/.test(css)) {
  console.log('FAIL css: a selector list ends with a trailing comma');
  failures++;
} else {
  console.log('PASS css has no trailing-comma selector lists');
}

// ---- inline script syntax -----------------------------------------------
const html = fs.readFileSync(HTML, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((body) => body.trim());

console.log(`Found ${scripts.length} inline script block(s)`);
scripts.forEach((body, index) => {
  try {
    new vm.Script(body, { filename: `inline-${index + 1}.js` });
    console.log(`PASS inline script ${index + 1} parses (${body.length} chars)`);
  } catch (error) {
    console.log(`FAIL inline script ${index + 1}: ${error.message}`);
    failures++;
  }
});

if (failures) {
  console.log(`\n${failures} problem(s) found.`);
  process.exit(1);
}
console.log('\nAsset validation passed.');