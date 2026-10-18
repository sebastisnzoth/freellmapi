import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { gzipSync, gunzipSync } from 'zlib';
import type { Db } from '../db/types.js';
import type { Scheduler } from './scheduler.js';
import { getDefaultDbPath, defaultDbFactory } from '../db/index.js';
import { restrictToOwner } from './file-permissions.js';

const MAGIC = Buffer.from('FAPIBK1\0');
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const PLACEHOLDER_KEY = 'replace-with-64-char-hex';
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const remoteVersions = new Map<string, string>();
const activeBackups = new Set<string>();
const strictRemote = () => process.env.FREEAPI_DB_BACKUP_STRICT === 'true';

const versionKey = (target: string, dbPath: string) => target + '\0' + path.resolve(dbPath);
const versionPath = (dbPath: string) => dbPath + '.backup-version.json';
function rememberVersion(target: string, dbPath: string, etag: string) {
  remoteVersions.set(versionKey(target, dbPath), etag);
  if (!strictRemote()) return;
  const temporary = versionPath(dbPath) + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(temporary, JSON.stringify({ target, etag }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, versionPath(dbPath));
    restrictToOwner(versionPath(dbPath));
  } finally { fs.rmSync(temporary, { force: true }); }
}
function acknowledgedVersion(target: string, dbPath: string): string | undefined {
  const key = versionKey(target, dbPath);
  const inMemory = remoteVersions.get(key);
  if (inMemory) return inMemory;
  if (!strictRemote()) return undefined;
  try {
    const saved = JSON.parse(fs.readFileSync(versionPath(dbPath), 'utf8')) as { target: string; etag: string };
    if (saved.target !== target || !/^"[0-9a-f-]{36}"$/.test(saved.etag)) throw new Error('invalid version');
    remoteVersions.set(key, saved.etag);
    return saved.etag;
  } catch { throw new Error('strict backup requires acknowledged local version metadata; restore into an empty database path'); }
}

function checkRemote(target: string) {
  const url = new URL(target);
  if (strictRemote() && (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !process.env.FREEAPI_DB_BACKUP_TOKEN?.trim())) {
    throw new Error('strict backup requires HTTPS, bearer token and a URL without credentials/query/fragment');
  }
}

async function boundedBody(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BACKUP_BYTES) throw new Error('backup exceeds size limit');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

export interface DbBackupResult {
  ok: boolean;
  target?: string;
  bytes?: number;
  restored?: boolean;
  skipped?: string;
}

function backupTarget(): string | null {
  const raw = process.env.FREEAPI_DB_BACKUP_TARGET
    ?? process.env.FREEAPI_DB_BACKUP_URL
    ?? process.env.FREEAPI_DB_BACKUP_PATH
    ?? '';
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isDbBackupConfigured(): boolean {
  return backupTarget() !== null;
}

function backupIntervalMs(): number {
  const raw = process.env.FREEAPI_DB_BACKUP_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_INTERVAL_MS;
}

function isHttpTarget(target: string): boolean {
  return target.startsWith('https://') || target.startsWith('http://');
}

function parseBackupKey(): Buffer {
  const raw = (process.env.FREEAPI_DB_BACKUP_KEY || process.env.ENCRYPTION_KEY || '').trim();
  if (!raw || raw === PLACEHOLDER_KEY || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('FREEAPI_DB_BACKUP_KEY or ENCRYPTION_KEY must be a 64-character hex key when DB backup is enabled');
  }
  return Buffer.from(raw, 'hex');
}

function encryptBackup(plain: Buffer): Buffer {
  const key = parseBackupKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

function decryptBackup(payload: Buffer): Buffer {
  if (payload.length < MAGIC.length + 12 + 16 || !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('backup payload has an unsupported format');
  }
  const key = parseBackupKey();
  const ivStart = MAGIC.length;
  const tagStart = ivStart + 12;
  const bodyStart = tagStart + 16;
  const iv = payload.subarray(ivStart, tagStart);
  const tag = payload.subarray(tagStart, bodyStart);
  const ciphertext = payload.subarray(bodyStart);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Split a Hugging Face `/resolve/` download URL into the pieces the commit API
 * needs, or null for anything else.
 *
 * A HF repo serves downloads at `/{type}/{ns}/{repo}/resolve/{rev}/{path}`, but
 * that route is read-only: a PUT to it is answered 404/405 and the blob never
 * lands. Writes go through the commit API instead. Both halves are derived from
 * the one URL the operator configures, so FREEAPI_DB_BACKUP_TARGET stays the
 * plain download URL they can paste into a browser.
 *
 * Models are the type with no prefix segment (`/{ns}/{repo}/resolve/...`);
 * datasets and spaces name themselves. The API path pluralizes the type.
 */
export function parseHuggingFaceTarget(target: string): { commitUrl: string; filePath: string } | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.hostname !== 'huggingface.co') return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const prefixed = segments[0] === 'datasets' || segments[0] === 'spaces';
  const type = prefixed ? segments[0] : 'models';
  const rest = prefixed ? segments.slice(1) : segments;
  // ns / repo / 'resolve' / rev / path…
  if (rest.length < 5 || rest[2] !== 'resolve') return null;
  const [namespace, repo, , revision] = rest;
  const filePath = rest.slice(4).map(decodeURIComponent).join('/');
  if (!namespace || !repo || !revision || !filePath) return null;

  return {
    commitUrl: `https://huggingface.co/api/${type}/${namespace}/${repo}/commit/${revision}`,
    filePath,
  };
}

/**
 * Upload one file through the HF commit API: newline-delimited JSON, a header
 * line naming the commit followed by a line per file.
 *
 * The blob is sent as base64 TEXT rather than as bytes — `encoding: 'utf-8'`,
 * NOT 'base64', because that flag would tell HF to decode the content back to
 * binary before writing it, which is exactly what we are avoiding: repos on Xet
 * storage reject binary blobs pushed through this route. Base64 costs a third
 * more bytes and buys a file the route will actually accept. readTarget()
 * reverses it.
 */
async function uploadToHuggingFace(
  commitUrl: string,
  filePath: string,
  payload: Buffer,
  token: string,
): Promise<void> {
  const lines = [
    { key: 'header', value: { summary: `chore: update ${filePath}` } },
    { key: 'file', value: { path: filePath, content: payload.toString('base64'), encoding: 'utf-8' } },
  ];
  const res = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-ndjson',
      Authorization: `Bearer ${token}`,
    },
    body: lines.map(line => JSON.stringify(line)).join('\n'),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`backup upload failed: HF commit HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
}

/** Undo the base64 wrapper uploadToHuggingFace applies. Sniffed rather than
 *  assumed: a blob left behind by an older build is raw and starts with MAGIC,
 *  and a restore that silently base64-decoded it would turn a recoverable
 *  database into a corrupt one. */
function decodeHuggingFacePayload(raw: Buffer): Buffer {
  if (raw.subarray(0, MAGIC.length).equals(MAGIC)) return raw;
  return Buffer.from(raw.toString('utf8'), 'base64');
}

async function readTarget(target: string, dbPath: string): Promise<Buffer | null> {
  if (isHttpTarget(target)) {
    checkRemote(target);
    const headers: Record<string, string> = {};
    const token = process.env.FREEAPI_DB_BACKUP_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(target, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404 || res.status === 204) {
      if (strictRemote()) throw new Error('strict backup requires an existing provisioned snapshot');
      return null;
    }
    if (!res.ok) throw new Error(`backup restore failed: HTTP ${res.status}`);
    const raw = await boundedBody(res);
    const etag = res.headers.get('etag');
    if (strictRemote() && !/^"[0-9a-f-]{36}"$/.test(etag || '')) throw new Error('backup ETag required');
    if (etag) remoteVersions.set(versionKey(target, dbPath), etag);
    return parseHuggingFaceTarget(target) ? decodeHuggingFacePayload(raw) : raw;
  }

  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target);
}

async function writeTarget(target: string, payload: Buffer, dbPath: string): Promise<void> {
  if (payload.length > MAX_BACKUP_BYTES) throw new Error('backup exceeds size limit');
  if (isHttpTarget(target)) {
    checkRemote(target);
    const token = process.env.FREEAPI_DB_BACKUP_TOKEN?.trim();
    const huggingFace = parseHuggingFaceTarget(target);
    if (huggingFace) {
      // Anonymous writes do not exist on HF; without a token every upload would
      // 401 on a schedule and only ever be noticed as an empty restore.
      if (!token) throw new Error('FREEAPI_DB_BACKUP_TOKEN is required to upload a backup to Hugging Face');
      await uploadToHuggingFace(huggingFace.commitUrl, huggingFace.filePath, payload, token);
      return;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const acknowledged = acknowledgedVersion(target, dbPath);
    if (acknowledged) headers['If-Match'] = acknowledged;
    if (strictRemote()) {
      const version = acknowledged;
      if (!version) throw new Error('restore current snapshot before uploading in strict mode');
      headers['If-Match'] = version;
    }
    const res = await fetch(target, {
      method: 'PUT',
      redirect: 'error',
      headers,
      body: payload,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`backup upload failed: HTTP ${res.status}`);
    const etag = res.headers.get('etag');
    if (strictRemote() && !/^"[0-9a-f-]{36}"$/.test(etag || '')) throw new Error('backup upload ETag required');
    if (etag) rememberVersion(target, dbPath, etag);
    return;
  }

  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  // Encrypted, but not therefore safe to leave world-readable: the key is
  // FREEAPI_DB_BACKUP_KEY or ENCRYPTION_KEY, which on a normal install sits in a
  // .env file on the same host. The mode covers creation; restrictToOwner covers
  // the overwrite case, where an existing file keeps the mode it already had —
  // and covers Windows, where the mode argument is a no-op.
  fs.writeFileSync(target, payload, { mode: 0o600 });
  if (!restrictToOwner(target)) {
    console.warn(`[db-backup] could not restrict permissions on ${target} — it may be readable by other local accounts`);
  }
}

export async function restoreDbBackupIfNeeded(dbPath = getDefaultDbPath()): Promise<DbBackupResult> {
  const target = backupTarget();
  if (!target) return { ok: true, skipped: 'not configured' };
  if (dbPath === ':memory:') return { ok: true, target, skipped: 'memory database' };
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    if (strictRemote()) { checkRemote(target); acknowledgedVersion(target, dbPath); }
    return { ok: true, target, skipped: 'database already exists' };
  }

  if (fs.existsSync(dbPath)) throw new Error('EMPTY_DATABASE_PLACEHOLDER_REQUIRES_RECOVERY: use a new empty path; no existing file is overwritten');
  const payload = await readTarget(target, dbPath);
  if (!payload || payload.length === 0) {
    if (strictRemote()) throw new Error('strict backup refuses an empty remote snapshot');
    return { ok: true, target, skipped: 'no backup found' };
  }

  let restored: Buffer;
  try {
    restored = gunzipSync(decryptBackup(payload), { maxOutputLength: MAX_DATABASE_BYTES });
    if (!restored.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new Error('invalid SQLite header');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not restore SQLite backup: ${detail}`);
  }

  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  // This is the decrypted database — provider keys and the dashboard password
  // hash in the clear. connectDb hardens it too, but that is a later call and
  // sometimes a later process; the file must not be readable in between.
  const temporary = dbPath + '.' + crypto.randomUUID() + '.restore';
  try {
    fs.writeFileSync(temporary, restored, { mode: 0o600, flag: 'wx' });
    const candidate = defaultDbFactory()(temporary);
    try {
      const checked = candidate.pragma('quick_check') as { quick_check: string }[];
      if (checked.length !== 1 || checked[0].quick_check !== 'ok') throw new Error('SQLite integrity check failed');
    } finally { candidate.close?.(); }
    // link is atomic and refuses to replace a database created concurrently.
    fs.linkSync(temporary, dbPath);
  } finally { fs.rmSync(temporary, { force: true }); }
  if (!restrictToOwner(dbPath)) {
    console.warn(`[db-backup] could not restrict permissions on the restored database at ${dbPath}`);
  }
  const etag = remoteVersions.get(versionKey(target, dbPath));
  if (etag) rememberVersion(target, dbPath, etag);
  console.log(`[db-backup] restored ${restored.length} bytes`);
  return { ok: true, target, bytes: restored.length, restored: true };
}

export async function backupDbNow(db: Db, dbPath = getDefaultDbPath()): Promise<DbBackupResult> {
  const target = backupTarget();
  if (!target) return { ok: true, skipped: 'not configured' };
  if (dbPath === ':memory:') return { ok: true, target, skipped: 'memory database' };
  if (!fs.existsSync(dbPath)) return { ok: false, target, skipped: 'database file missing' };

  if (activeBackups.has(target)) throw new Error('backup already in progress');
  activeBackups.add(target);
  let dir: string | undefined;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-snapshot-'));
    fs.chmodSync(dir, 0o700);
    const snapshot = path.join(dir, 'snapshot.db');
    // SQLite itself snapshots committed WAL pages; no best-effort checkpoint/file copy.
    db.prepare('VACUUM INTO ?').run(snapshot);
    const plain = fs.readFileSync(snapshot);
    if (plain.length > MAX_DATABASE_BYTES) throw new Error('database exceeds backup size limit');
    await writeTarget(target, encryptBackup(gzipSync(plain)), dbPath);
    console.log(`[db-backup] uploaded ${plain.length} bytes`);
    return { ok: true, target, bytes: plain.length };
  } finally {
    activeBackups.delete(target);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function startDbBackupPump(db: Db, scheduler: Scheduler, dbPath = getDefaultDbPath()): (() => void) | null {
  if (!backupTarget()) return null;
  const run = () => {
    void backupDbNow(db, dbPath).catch(err => {
      console.warn(`[db-backup] ${err instanceof Error ? err.message : err}`);
    });
  };
  run();
  return scheduler.every(backupIntervalMs(), run);
}
