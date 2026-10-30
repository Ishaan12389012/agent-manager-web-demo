const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test@localhost/test'; // never connected to here
const { shareId, download } = require('./excel-sync');

const withFetch = async (handler, fn) => {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => { calls.push(String(url)); return handler(String(url), opts); };
  try { await fn(calls); } finally { global.fetch = real; }
};
const file = (body, headers = {}) => new Response(body, { status: 200, headers });

test('share links are encoded the way Microsoft Graph expects', () => {
  assert.equal(shareId('https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1'),
    'u!aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj9yZXNpZD0xMjMxMjQ0MTkzOTEyITEyJmF1dGhLZXk9MTIwMTkxOSExMjkyMSEx');
});

test('without Graph settings, a work link is downloaded directly', async () => {
  delete process.env.MS_TENANT_ID;
  await withFetch(() => file('xlsx-bytes', { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="Status.xlsx"' }), async (calls) => {
    const out = await download('https://contoso-my.sharepoint.com/:x:/g/personal/raj/abc?e=xyz');
    assert.equal(out.name, 'Status.xlsx');
    assert.equal(out.bytes.toString(), 'xlsx-bytes');
    assert.match(calls[0], /download=1/);
  });
});

test('a link that needs a sign-in gives a clear error', async () => {
  await withFetch(() => file('<html>sign in</html>', { 'content-type': 'text/html' }), async () => {
    await assert.rejects(download('https://contoso-my.sharepoint.com/:x:/g/personal/raj/abc'), /sign-in/);
  });
});

test('with Graph settings, it signs in and downloads through Microsoft Graph', async () => {
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's' });
  try {
    await withFetch((url) => {
      if (url.includes('login.microsoftonline.com')) return Response.json({ access_token: 'tok' });
      if (url.endsWith('$select=name')) return Response.json({ name: 'Status.xlsx' });
      if (url.endsWith('/content')) return file('graph-bytes');
      return new Response('', { status: 404 });
    }, async (calls) => {
      const out = await download('https://contoso-my.sharepoint.com/:x:/g/personal/raj/abc');
      assert.deepEqual([out.name, out.bytes.toString()], ['Status.xlsx', 'graph-bytes']);
      assert.ok(calls.some((u) => u.startsWith('https://graph.microsoft.com/v1.0/shares/u!')));
    });
  } finally {
    delete process.env.MS_TENANT_ID; delete process.env.MS_CLIENT_ID; delete process.env.MS_CLIENT_SECRET;
  }
});
