// Course technology lock: Flexbox only in CSS, and nothing loaded from another origin.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GRID_RULES = [/display\s*:\s*(inline-)?grid/i, /grid-template/i];
const OTHER_ORIGIN_RESOURCE = /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i;
const CSS_IMPORT_FROM_OTHER_ORIGIN = /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i;

function filesIn(directory, extension) {
  return fs.readdirSync(path.join(ROOT, directory), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(extension))
    .map(entry => path.join(entry.parentPath, entry.name));
}

const read = file => fs.readFileSync(file, 'utf8');
const label = file => path.relative(ROOT, file);

test('there are style sheets and views to check', () => {
  assert.ok(filesIn('public', '.css').length >= 5);
  assert.ok(filesIn('views', '.ejs').length >= 10);
});

test('no style sheet uses CSS Grid', () => {
  for (const file of filesIn('public', '.css')) {
    for (const rule of GRID_RULES) assert.doesNotMatch(read(file), rule, `${label(file)} must use Flexbox only`);
  }
});

test('no view sets CSS Grid inline', () => {
  for (const file of filesIn('views', '.ejs')) {
    for (const rule of GRID_RULES) assert.doesNotMatch(read(file), rule, label(file));
  }
});

test('no view loads a script or style sheet from another origin', () => {
  for (const file of filesIn('views', '.ejs')) assert.doesNotMatch(read(file), OTHER_ORIGIN_RESOURCE, label(file));
});

test('no style sheet imports another origin', () => {
  for (const file of filesIn('public', '.css')) assert.doesNotMatch(read(file), CSS_IMPORT_FROM_OTHER_ORIGIN, label(file));
});

test('the checks do catch a violation', () => {
  assert.match('.a { display: grid; }', GRID_RULES[0]);
  assert.match('.a { display:inline-grid }', GRID_RULES[0]);
  assert.match('.a { grid-template-columns: 1fr 1fr; }', GRID_RULES[1]);
  assert.match('<script src="https://cdn.example/lib.js"></script>', OTHER_ORIGIN_RESOURCE);
  assert.match('<link rel="stylesheet" href="//cdn.example/a.css">', OTHER_ORIGIN_RESOURCE);
  assert.doesNotMatch('<script src="/analytics.js"></script>', OTHER_ORIGIN_RESOURCE);
  assert.doesNotMatch('<link rel="stylesheet" href="/base.css">', OTHER_ORIGIN_RESOURCE);
});

// Static guard for the responsive audit (DEV4_PLAN Phase E, step 7); the pixel checks themselves are manual.
test('the Editor and analytics pages keep the layout rules the responsive audit relies on', () => {
  const editorCss = read(path.join(ROOT, 'public/editor.css'));
  const analyticsCss = read(path.join(ROOT, 'public/analytics.css'));
  const mobileRules = editorCss.slice(editorCss.indexOf('@media (max-width: 600px)'));
  assert.match(editorCss, /\.status-filter\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(editorCss, /\.action-row\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(editorCss, /\.page-nav\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(mobileRules, /\.compare-columns\s*\{\s*flex-direction:\s*column/);
  assert.match(mobileRules, /\.editor-row\s*\{\s*flex-direction:\s*column/);
  assert.match(mobileRules, /min-height:\s*var\(--tap-target\)/);
  assert.match(editorCss, /--tap-target:\s*2\.75rem/);
  assert.match(editorCss, /\.compare-value[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(analyticsCss, /\.table-scroll\s*\{\s*overflow-x:\s*auto/);
  assert.match(analyticsCss, /\.result-button\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test('the analytics graph is redrawn when its box changes size and is sharp on high-density screens', () => {
  const script = read(path.join(ROOT, 'public/analytics.js'));
  assert.match(script, /new ResizeObserver\(.*drawChart\(currentSeries\)/);
  assert.match(script, /window\.devicePixelRatio/);
  assert.match(script, /context\.setTransform\(ratio, 0, 0, ratio, 0, 0\)/);
});
