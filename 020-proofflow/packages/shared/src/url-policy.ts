import { isIP } from 'node:net';

export interface UrlPolicy { allowPrivateNetwork?: boolean; allowedHosts?: string[]; }
export interface UrlPolicyResult { allowed: boolean; reason?: string; hostname?: string; }

const PRIVATE_V4 = [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16], ['0.0.0.0', 8], ['100.64.0.0', 10], ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const;

function v4ToInt(ip: string): number { return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0; }
export function isPrivateIPv4(ip: string): boolean {
  const n = v4ToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
}
export function isPrivateIPv6(ip: string): boolean {
  const l = ip.toLowerCase();
  if (l === '::1' || l === '::') return true;
  if (l.startsWith('fc') || l.startsWith('fd')) return true; // fc00::/7
  if (l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb')) return true; // fe80::/10
  if (l.startsWith('::ffff:')) { const v4 = l.slice(7); return isIP(v4) === 4 ? isPrivateIPv4(v4) : true; }
  return false;
}
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.localdomain') || h === 'metadata' || h === 'metadata.google.internal') return true;
  if (!h.includes('.') && isIP(h) === 0) return true; // bare hostnames (intranet)
  const ipv = isIP(h);
  if (ipv === 4) return isPrivateIPv4(h);
  if (ipv === 6) return isPrivateIPv6(h);
  return false;
}

/** Static policy check for a target URL. Resolved-IP checks happen in the runner (DNS rebinding guard). */
export function checkTargetUrl(raw: string, policy: UrlPolicy = {}): UrlPolicyResult {
  let u: URL;
  try { u = new URL(raw); } catch { return { allowed: false, reason: 'invalid_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { allowed: false, reason: 'scheme_not_allowed', hostname: u.hostname };
  if (u.username || u.password) return { allowed: false, reason: 'credentials_in_url', hostname: u.hostname };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (policy.allowedHosts && policy.allowedHosts.length > 0) {
    const ok = policy.allowedHosts.some((a) => host === a.toLowerCase() || host.endsWith('.' + a.toLowerCase()));
    if (!ok) return { allowed: false, reason: 'host_not_in_allowlist', hostname: host };
  }
  if (isBlockedHostname(host) && !policy.allowPrivateNetwork) return { allowed: false, reason: 'private_or_local_target_denied', hostname: host };
  return { allowed: true, hostname: host };
}

export function sameSite(a: string, b: string): boolean {
  try { const ua = new URL(a); const ub = new URL(b); return ua.origin === ub.origin; } catch { return false; }
}
