import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readTarget, writeTarget, getCurrentCasVersion, validateETag } from '../../lib/db-backup.js';

describe('db-backup comprehensive tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
    process.env.FREEAPI_DB_BACKUP_TOKEN = '***';
    process.env.FREEAPI_DB_BACKUP_URL = 'https://test.supabase.co/functions/v1/ugo-hive-backup-receiver';
    process.env.FREEAPI_DB_BACKUP_STRICT = 'false';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('validateETag', () => {
    it('returns UUID for valid quoted ETag', () => {
      expect(validateETag('"123e4567-e89b-12d3-a456-426614174000"')).toBe('123e4567-e89b-12d3-a456-426614174000');
    });
    it('returns null for unquoted ETag', () => {
      expect(validateETag('123e4567-e89b-12d3-a456-426614174000')).toBeNull();
    });
    it('returns null for malformed ETag', () => {
      expect(validateETag('"not-a-uuid"')).toBeNull();
    });
    it('returns null for null/undefined', () => {
      expect(validateETag(null)).toBeNull();
      expect(validateETag(undefined)).toBeNull();
    });
  });

  describe('getCurrentCasVersion', () => {
    it('returns version from Supabase REST API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ version: '7d6ebd52-0832-4df6-aeab-f0fc16878cb6' }]
      });
      vi.stubGlobal('fetch', mockFetch);

      const version = await getCurrentCasVersion(
        'https://test.supabase.co/functions/v1/ugo-hive-backup-receiver',
        'test-token'
      );

      expect(version).toBe('7d6ebd52-0832-4df6-aeab-f0fc16878cb6');
    });

    it('returns null on HTTP error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal('fetch', mockFetch);

      const version = await getCurrentCasVersion('https://test.supabase.co/functions/v1/backup', 'token');
      expect(version).toBeNull();
    });

    it('returns null on network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
      vi.stubGlobal('fetch', mockFetch);

      const version = await getCurrentCasVersion('https://test.supabase.co/functions/v1/backup', 'token');
      expect(version).toBeNull();
    });
  });

  describe('readTarget with stale backup (409)', () => {
    it('returns null for 409 BACKUP_REQUIRES_FRESHNESS_REVIEW in non-strict mode', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 409,
        ok: false,
        text: async () => 'BACKUP_REQUIRES_FRESHNESS_REVIEW',
        headers: { get: () => null }
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await readTarget('https://test.supabase.co/functions/v1/backup', '/tmp/db');
      expect(result).toBeNull();
    });

    it('throws in strict mode for 409', async () => {
      process.env.FREEAPI_DB_BACKUP_STRICT = 'true';
      const mockFetch = vi.fn().mockResolvedValue({
        status: 409,
        ok: false,
        text: async () => 'BACKUP_REQUIRES_FRESHNESS_REVIEW'
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(readTarget('https://test.supabase.co/functions/v1/backup', '/tmp/db'))
        .rejects.toThrow('strict backup requires an existing provisioned snapshot');
    });
  });

  describe('writeTarget with retry logic', () => {
    beforeEach(() => {
      process.env.FREEAPI_DB_BACKUP_TOKEN = '***';
      process.env.FREEAPI_DB_BACKUP_STRICT = 'false';
    });

    it('uploads successfully with correct ETag', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          headers: { get: (h) => h === 'etag' ? '"123e4567-e89b-12d3-a456-426614174000"' : null }
        });
      vi.stubGlobal('fetch', mockFetch);

      const result = await writeTarget('https://test.supabase.co/functions/v1/backup', Buffer.from('test'), '/tmp/db');
      
      expect(result.uploaded).toBe(true);
      expect(result.etag).toBe('"123e4567-e89b-12d3-a456-426614174000"');
      expect(result.retried).toBe(false);
    });

    it('retries on 409 FRESHNESS_REVIEW and succeeds', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 409,
          text: async () => 'BACKUP_REQUIRES_FRESHNESS_REVIEW'
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          headers: { get: (h) => h === 'etag' ? '"fresh-version-uuid"' : null }
        });
      vi.stubGlobal('fetch', mockFetch);

      const result = await writeTarget('https://test.supabase.co/functions/v1/backup', Buffer.from('test'), '/tmp/db');
      
      expect(result.uploaded).toBe(true);
      expect(result.retried).toBe(true);
      expect(result.etag).toBe('"fresh-version-uuid"');
    });

    it('retries on 412 STALE_BACKUP and succeeds', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 412,
          text: async () => 'STALE_BACKUP'
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          headers: { get: (h) => h === 'etag' ? '"fresh-version-uuid"' : null }
        });
      vi.stubGlobal('fetch', mockFetch);

      const result = await writeTarget('https://test.supabase.co/functions/v1/backup', Buffer.from('test'), '/tmp/db');
      
      expect(result.uploaded).toBe(true);
      expect(result.retried).toBe(true);
    });

    it('retries on 428 IF_MATCH_REQUIRED and succeeds', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 428,
          text: async () => 'IF_MATCH_REQUIRED'
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          headers: { get: (h) => h === 'etag' ? '"fresh-version-uuid"' : null }
        });
      vi.stubGlobal('fetch', mockFetch);

      const result = await writeTarget('https://test.supabase.co/functions/v1/backup', Buffer.from('test'), '/tmp/db');
      
      expect(result.uploaded).toBe(true);
      expect(result.retried).toBe(true);
    });

    it('returns uploaded:false for 412/428 with no current version', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 428,
          text: async () => 'IF_MATCH_REQUIRED'
        });
      vi.stubGlobal('fetch', mockFetch);

      const result = await writeTarget('https://test.supabase.co/functions/v1/backup', Buffer.from('test'), '/tmp/db');
      
      expect(result.uploaded).toBe(false);
    });

    it('throws on max retries exceeded', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValue({
          ok: false,
          status: 409,
          text: async () => 'BACKUP_REQUIRES_FRESHNESS_REVIEW'
        });
      vi.stubGlobal('fetch', mockFetch);

      await expect(writeTarget('https://test.supabase.co/functions/v1/backup', Buffer.from('test'), '/tmp/db'))
        .rejects.toThrow('max retries exceeded');
    });

    it('validates ETag format before accepting', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          headers: { get: (h) => h === 'etag' ? 'invalid-etag' : null }
        });
      vi.stubGlobal('fetch', mockFetch);

      await expect(writeTarget('https://test.supabase.co/functions/v1/backup', Buffer.from('test'), '/tmp/db'))
        .rejects.toThrow('backup upload ETag required');
    });
  });

  describe('Concurrency - CAS prevents double write', () => {
    it('second write with same CAS version fails with 412', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          headers: { get: (h) => h === 'etag' ? '"v1"' : null }
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 412,
          text: async () => 'STALE_BACKUP'
        });
      vi.stubGlobal('fetch', mockFetch);

      const r1 = await writeTarget('https://test.supabase.co/functions/v1/backup', Buffer.from('test1'), '/tmp/db1');
      const r2 = await writeTarget('https://test.supabase.co/functions/v1/backup', Buffer.from('test2'), '/tmp/db2');

      expect(r1.uploaded).toBe(true);
      expect(r2.uploaded).toBe(false);
    });
  });

  describe('Network failure handling', () => {
    it('handles network errors gracefully', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);

      await expect(writeTarget('https://test.supabase.co/functions/v1/backup', Buffer.from('test'), '/tmp/db'))
        .rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('Idempotency - retry produces same result', () => {
    it('retried upload produces same ETag', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 409,
          text: async () => 'BACKUP_REQUIRES_FRESHNESS_REVIEW'
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          headers: { get: (h) => h === 'etag' ? '"same-version-uuid"' : null }
        });
      vi.stubGlobal('fetch', mockFetch);

      const r1 = await writeTarget('https://test.supabase.co/functions/v1/backup', Buffer.from('test'), '/tmp/db');
      
      expect(r1.uploaded).toBe(true);
      expect(r1.retried).toBe(true);
      expect(r1.etag).toBe('"same-version-uuid"');
    });
  });
});
