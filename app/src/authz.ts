// Authorization: ADMIN_NPUB always passes; the admin-managed allowlist file
// passes; and when a Marmot group is active, every current member passes.
// Hex pubkeys (used by Marmot group state) are accepted alongside npubs.

import { nip19 } from 'nostr-tools'
import type { Store } from './store'

export type MemberSource = 'admin' | 'allowlist' | 'marmot'

export interface MemberRecord { npub: string; addedAt: number; addedBy: string }

export interface AuthzDecision {
  allowed: boolean
  source: MemberSource | null
}

export class Authz {
  private allowlist: MemberRecord[] = []
  private marmotMembers: Set<string> = new Set()

  constructor (
    private readonly adminNpub: string,
    private readonly store: Store
  ) {
    this.allowlist = store.readJson<MemberRecord[]>('allowlist.json', [])
    const adminHex = this.adminPubkey()
    if (!adminHex) throw new Error('ERR_ADMIN_NPUB_INVALID: ADMIN_NPUB does not decode')
  }

  private adminPubkey (): string | null {
    try {
      const { type, data } = nip19.decode(this.adminNpub)
      return type === 'npub' ? data as string : null
    } catch {
      return null
    }
  }

  isAdmin (pubkeyOrNpub: string): boolean {
    if (pubkeyOrNpub === this.adminNpub) return true
    return pubkeyOrNpub === this.adminPubkey()
  }

  /** Called by the Marmot module whenever group state changes. */
  setMarmotMembers (hexPubkeys: string[]): void {
    this.marmotMembers = new Set(hexPubkeys)
  }

  decide (pubkeyOrNpub: string): AuthzDecision {
    if (this.isAdmin(pubkeyOrNpub)) return { allowed: true, source: 'admin' }
    // Normalize npub → hex once, then compare against both stores.
    let hex = pubkeyOrNpub
    if (pubkeyOrNpub.startsWith('npub1')) {
      try {
        hex = nip19.decode(pubkeyOrNpub).data as string
      } catch {
        return { allowed: false, source: null }
      }
    }
    // Stored members are npubs; the caller passes hex — compare in hex.
    const memberHexes = this.allowlist.map((m) => (m.npub.startsWith('npub1') ? String(nip19.decode(m.npub).data) : m.npub))
    if (memberHexes.includes(hex)) {
      return { allowed: true, source: 'allowlist' }
    }
    if (this.marmotMembers.has(hex)) return { allowed: true, source: 'marmot' }
    return { allowed: false, source: null }
  }

  list (): MemberRecord[] {
    return [...this.allowlist]
  }

  add (npub: string, addedBy: string): MemberRecord {
    if (!npub.startsWith('npub1')) throw new Error('ERR_MEMBER_NPUB_INVALID')
    if (this.isAdmin(npub)) throw new Error('ERR_MEMBER_IS_ADMIN')
    if (!this.allowlist.some((m) => m.npub === npub)) {
      this.allowlist.push({ npub, addedAt: Date.now(), addedBy })
      this.persist()
    }
    return this.allowlist.find((m) => m.npub === npub)!
  }

  remove (npub: string): boolean {
    const before = this.allowlist.length
    this.allowlist = this.allowlist.filter((m) => m.npub !== npub)
    this.persist()
    return this.allowlist.length < before
  }

  private persist (): void {
    this.store.writeJson('allowlist.json', this.allowlist)
  }
}
