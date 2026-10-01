import { chromium, firefox, webkit, type Browser, type BrowserType } from 'playwright';
import { existsSync } from 'node:fs';
import { InfraError } from './types.js';

const TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };

/** Launches one browser process per engine and reuses it across jobs. Launch failures are infrastructure errors, never test failures. */
export class BrowserPool {
  private browsers = new Map<string, Promise<Browser>>();
  available(): string[] {
    return Object.entries(TYPES).filter(([, t]) => { try { return existsSync(t.executablePath()); } catch { return false; } }).map(([n]) => n);
  }
  async get(name: string): Promise<Browser> {
    const t = TYPES[name];
    if (!t) throw new InfraError(`unsupported browser ${name}`);
    let p = this.browsers.get(name);
    if (!p) {
      p = t.launch({ headless: true }).catch((e) => { this.browsers.delete(name); throw new InfraError(`browser launch failed (${name}): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); });
      this.browsers.set(name, p);
    }
    const b = await p;
    if (!b.isConnected()) { this.browsers.delete(name); return this.get(name); }
    return b;
  }
  async closeAll() { for (const [n, p] of this.browsers) { try { (await p).close(); } catch { /* ignore */ } this.browsers.delete(n); } }
}
