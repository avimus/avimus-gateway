/** In-memory blacklist of revoked token IDs (jti). Zero persistence, per constitution Principle V. */
export class RevocationList {
  private readonly revoked = new Map<string, Date>();

  revoke(jti: string): void {
    this.revoked.set(jti, new Date());
  }

  isRevoked(jti: string): boolean {
    return this.revoked.has(jti);
  }

  revokedAt(jti: string): Date | undefined {
    return this.revoked.get(jti);
  }
}
