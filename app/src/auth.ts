// NIP-98 HTTP auth: the browser signs a kind 27235 event whose `u` tag is the
// request path; the server verifies the signature and freshness and returns a
// session token. Sessions are in-memory (a restart asks for a fresh sign-in),
// which is the right cost for a home-fleet app.

import crypto from 'node:crypto'
import { validateEvent, verifyEvent } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000

export interface Session { pubkey: string; npub: string; expiresAt: number }

export interface AuthHeaderResult {
  event: Event
  pubkey: string
}

export class AuthService {
  private readonly sessions = new Map<string, Session>()

  constructor (
    private readonly windowSec: number,
    private readonly npubOf: (pubkey: string) => string
  ) {}

  /** Decodes `Authorization: Nostr <base64 json>` or a body { event }. */
  parseEvent (header: string | undefined, bodyEvent: unknown): Event | null {
    let raw: string | null = null
    if (header && header.startsWith('Nostr ')) {
      try {
        raw = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
      } catch {
        return null
      }
    } else if (bodyEvent && typeof bodyEvent === 'object') {
      raw = JSON.stringify(bodyEvent)
    }
    if (!raw) return null
    try {
      return JSON.parse(raw) as Event
    } catch {
      return null
    }
  }

  /** Full NIP-98 verification: shape, signature, kind, freshness, u tag. */
  verify (event: Event, pathname: string): AuthHeaderResult | null {
    if (!validateEvent(event) || !verifyEvent(event)) return null
    if (event.kind !== 27235) return null
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - event.created_at) > this.windowSec) return null
    const uTag = event.tags.find(([k]) => k === 'u')
    if (!uTag) return null
    // The spec puts the full URL in `u`; a same-origin SPA often signs just
    // the path. Accept an exact path match or any URL ending in the path.
    const requested = uTag[1] ?? ''
    if (requested !== pathname && !requested.endsWith(pathname)) return null
    return { event, pubkey: event.pubkey }
  }

  issue (pubkey: string): IssuedToken {
    const token = crypto.randomBytes(32).toString('hex')
    const session: Session = { pubkey, npub: this.npubOf(pubkey), expiresAt: Date.now() + SESSION_TTL_MS }
    this.sessions.set(token, session)
    return { token, session }
  }

  /** Token → live session, reaping expired entries as a side effect. */
  lookup (token: string | undefined | null): Session | null {
    if (!token) return null
    const session = this.sessions.get(token)
    if (!session) return null
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token)
      return null
    }
    return session
  }

  /** Extracts the bearer token from an Authorization header. */
  tokenFromHeader (header: string | undefined): string | null {
    if (!header?.startsWith('Bearer ')) return null
    return header.slice(7).trim() || null
  }
}

export interface IssuedToken { token: string; session: Session }
