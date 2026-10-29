const test = require('node:test');
const assert = require('node:assert/strict');
const { readUpload, parseCsv, toTable, ImportError } = require('./importer');

test('CSV handles quotes, commas and line breaks inside values', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",3'), [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', '3']]);
});

test('CSV upload becomes one table with numbers kept as numbers', async () => {
  const [t] = await readUpload(Buffer.from('﻿Tool,Seats,Code\nCopilot,120,007\nChatGPT,45.5,\n,,\n'), 'licences.csv');
  assert.equal(t.name, 'licences');
  assert.deepEqual(t.columns, ['Tool', 'Seats', 'Code']);
  assert.deepEqual(t.rows, [['Copilot', 120, '007'], ['ChatGPT', 45.5, null]]);
});

test('blank and repeated headers get names, empty columns are dropped', () => {
  const t = toTable('x', [['Name', null, 'Name', null], ['a', 1, 'b', null]]);
  assert.deepEqual(t.columns, ['Name', 'Column 2', 'Name (2)']);
  assert.deepEqual(t.rows, [['a', 1, 'b']]);
});

test('dates become plain dates', () => {
  const t = toTable('x', [['When'], [new Date('2026-10-01T00:00:00Z')]]);
  assert.deepEqual(t.rows, [['2026-10-01']]);
});

test('other file types are refused', async () => {
  await assert.rejects(readUpload(Buffer.from('x'), 'notes.xls'), ImportError);
  await assert.rejects(readUpload(Buffer.from('not a zip'), 'book.xlsx'), ImportError);
  await assert.rejects(readUpload(Buffer.from('\n\n'), 'empty.csv'), ImportError);
});
