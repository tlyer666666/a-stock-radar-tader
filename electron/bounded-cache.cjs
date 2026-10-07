'use strict';
const { createHash } = require('node:crypto');

// Completed values are LRU/serialized-byte bounded and lazily expired. In-flight promises stay
// owned until their producer settles; evicting them would duplicate real work.
// No interval, listener or background sweep is retained by a cache instance.
// Accounting and expiry are snapshots taken by set(), not process RSS. Replace
// an entry via set() when its value settles or its expiry metadata changes.
class BoundedCache extends Map {
  constructor({ maxEntries = 128, maxBytes = Infinity, maxEntryBytes = maxBytes, staleTtlMs = 0, now = Date.now } = {}) {
    super();
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 128));
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.maxEntryBytes = Math.min(this.maxBytes, Math.max(0, Number(maxEntryBytes) || 0));
    this.staleTtlMs = Math.max(0, Number(staleTtlMs) || 0);
    this.now = now;
    this.entryBytes = new Map();
    this.accountedBytes = 0;
    this.completedEntries = 0;
    this.nextExpiryAt = Infinity;
  }
  expiryOf(entry) {
    if (!entry || entry.promise || !Object.prototype.hasOwnProperty.call(entry, 'value')) return Infinity;
    const expiry = Math.max(Number(entry.expiresAt) + this.staleTtlMs, Number(entry.staleUntil) || 0);
    return Number.isFinite(expiry) ? expiry : Infinity;
  }
  prune() {
    const now = this.now();
    // Most reads occur while every entry is fresh. Only crossing the earliest
    // expiry requires a sweep; a full scan per hit makes large news indexes
    // quadratic to populate and expensive to reuse.
    if (now >= this.nextExpiryAt) {
      this.nextExpiryAt = Infinity;
      for (const [key, entry] of super.entries()) {
        const expiry = this.expiryOf(entry);
        if (expiry <= now) this.delete(key);
        else this.nextExpiryAt = Math.min(this.nextExpiryAt, expiry);
      }
    }
    if (this.completedEntries > this.maxEntries || this.accountedBytes > this.maxBytes) {
      for (const [key, entry] of super.entries()) {
        if (entry?.promise) continue;
        this.delete(key);
        if (this.completedEntries <= this.maxEntries && this.accountedBytes <= this.maxBytes) break;
      }
    }
  }
  get(key) {
    this.prune();
    const value = super.get(key);
    if (super.has(key)) { super.delete(key); super.set(key, value); }
    return value;
  }
  has(key) { this.prune(); return super.has(key); }
  set(key, value) {
    this.delete(key);
    let bytes = 0;
    if (!value?.promise) {
      try { bytes = Buffer.byteLength(JSON.stringify([key, value]), 'utf8'); }
      catch { this.prune(); return this; } // An unaccountable result may still return to its caller.
      if (bytes > this.maxEntryBytes) { this.prune(); return this; }
    }
    super.set(key, value);
    this.entryBytes.set(key, bytes);
    this.accountedBytes += bytes;
    if (!value?.promise) this.completedEntries++;
    this.nextExpiryAt = Math.min(this.nextExpiryAt, this.expiryOf(value));
    this.prune();
    return this;
  }
  delete(key) {
    const completed = super.has(key) && !super.get(key)?.promise;
    if (!super.delete(key)) return false;
    if (completed) this.completedEntries--;
    this.accountedBytes -= this.entryBytes.get(key) || 0;
    this.entryBytes.delete(key);
    return true;
  }
  clear() {
    super.clear();
    this.entryBytes.clear();
    this.accountedBytes = 0;
    this.completedEntries = 0;
    this.nextExpiryAt = Infinity;
  }
  getDiagnostics() {
    this.prune();
    return { completedEntries: this.completedEntries, pendingEntries: this.size - this.completedEntries,
      accountedBytes: this.accountedBytes, maxBytes: this.maxBytes, maxEntryBytes: this.maxEntryBytes };
  }
}

function credentialFingerprint(...parts) {
  return createHash('sha256').update(JSON.stringify(parts.map(part => String(part || '')))).digest('hex');
}

module.exports = { BoundedCache, credentialFingerprint };
