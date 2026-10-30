// Keeps a spreadsheet stored in OneDrive or SharePoint in sync with Verdict.
//
// Set EXCEL_SYNC_URL to the file's share link. Every EXCEL_SYNC_MINUTES (default 5) the server
// downloads the file and, when its contents changed, re-imports it like an upload on the Data page.
//
// Two ways to download it:
// - With MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET (a Microsoft Entra app with the
//   Files.Read.All application permission), it signs in to Microsoft Graph. Works for any work file.
// - Without them, it downloads the link directly. That only works for "Anyone with the link" shares.
const crypto = require('crypto');
const { importFile, ImportError } = require('./datasets');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_BYTES = 10 * 1024 * 1024;

const status = {
  enabled: false, method: null, fileName: null,
  lastCheckAt: null, lastChangeAt: null, lastError: null, running: false,
};
let lastHash = null;

const shareId = (url) => 'u!' + Buffer.from(url).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');

class SyncError extends Error {}

async function graphToken() {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(MS_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new SyncError(`Microsoft sign-in failed: ${data.error_description || data.error || r.status}`);
  return data.access_token;
}

async function readBody(r) {
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new SyncError('The file is bigger than 10 MB.');
  return buf;
}

// Returns { name, bytes } for the file behind the share link.
async function download(url) {
  if (useGraph()) {
    const auth = { Authorization: `Bearer ${await graphToken()}` };
    const item = `${GRAPH}/shares/${shareId(url)}/driveItem`;
    const meta = await fetch(`${item}?$select=name`, { headers: auth });
    if (!meta.ok) throw new SyncError(`Microsoft Graph couldn’t open the file (${meta.status}). Check the link and that the app has Files.Read.All with admin consent.`);
    const { name } = await meta.json();
    const file = await fetch(`${item}/content`, { headers: auth });
    if (!file.ok) throw new SyncError(`Microsoft Graph couldn’t download the file (${file.status}).`);
    return { name, bytes: await readBody(file) };
  }

  const u = new URL(url);
  const personal = /(^|\.)1drv\.ms$|(^|\.)onedrive\.live\.com$/.test(u.hostname);
  const target = personal ? `https://api.onedrive.com/v1.0/shares/${shareId(url)}/root/content` : (u.searchParams.set('download', '1'), u.toString());
  const r = await fetch(target, { redirect: 'follow' });
  if (!r.ok || /text\/html/.test(r.headers.get('content-type') || '')) {
    throw new SyncError('The link asked for a sign-in, so it isn’t shared with “Anyone with the link”. Use the Microsoft Graph settings instead.');
  }
  const disposition = r.headers.get('content-disposition') || '';
  const m = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const name = m ? decodeURIComponent(m[1] || m[2]) : null;
  return { name, bytes: await readBody(r) };
}

const useGraph = () => Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);

// Checks the file once. Re-imports only when the contents changed (or when forced).
async function syncOnce({ force = false } = {}) {
  const url = process.env.EXCEL_SYNC_URL;
  if (!url) throw new SyncError('Sync isn’t set up. Add EXCEL_SYNC_URL to the server settings.');
  if (status.running) return status;
  status.running = true;
  try {
    const { name, bytes } = await download(url);
    const fileName = process.env.EXCEL_SYNC_NAME || name || 'OneDrive workbook.xlsx';
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (force || hash !== lastHash) {
      await importFile(bytes, fileName, null);
      lastHash = hash;
      status.lastChangeAt = new Date().toISOString();
    }
    Object.assign(status, { fileName, lastError: null });
  } catch (err) {
    status.lastError = err.message;
    if (!(err instanceof SyncError) && !(err instanceof ImportError)) console.error('Excel sync failed:', err);
  } finally {
    status.running = false;
    status.lastCheckAt = new Date().toISOString();
  }
  return status;
}

function start() {
  if (!process.env.EXCEL_SYNC_URL) return;
  status.enabled = true;
  status.method = useGraph() ? 'Microsoft Graph' : 'share link';
  const minutes = Math.max(1, Number(process.env.EXCEL_SYNC_MINUTES) || 5);
  status.everyMinutes = minutes;
  syncOnce();
  setInterval(syncOnce, minutes * 60 * 1000).unref();
}

module.exports = { start, syncOnce, status, shareId, download };
