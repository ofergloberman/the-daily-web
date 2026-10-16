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
