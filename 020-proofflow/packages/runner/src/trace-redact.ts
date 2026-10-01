import JSZip from 'jszip';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Redactor } from './evidence.js';

const SENSITIVE = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization)$/i;

/**
 * Post-process a Playwright trace.zip: mask secret values in action/network/stack entries and redact sensitive headers.
 * Screenshots inside the trace cannot be text-masked (documented limitation; use mask selectors / password inputs).
 */
export async function redactTraceZip(path: string, red: Redactor, extraHeaders: string[] = []): Promise<{ entries: number; modified: number }> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  let entries = 0; let modified = 0;
  const extra = new Set(extraHeaders.map((h) => h.toLowerCase()));
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue; entries++;
    if (/\.(trace|network|stacks)$/.test(name)) {
      const text = await file.async('string');
      const lines = text.split('\n').map((line) => {
        if (!line.trim()) return line;
        if (name.endsWith('.network')) {
          try {
            const ev = JSON.parse(line) as { snapshot?: { request?: { headers?: { name: string; value: string }[]; postData?: { text?: string } }; response?: { headers?: { name: string; value: string }[] } } };
            for (const side of [ev.snapshot?.request, ev.snapshot?.response]) for (const h of side?.headers ?? []) if (SENSITIVE.test(h.name) || extra.has(h.name.toLowerCase())) h.value = '[REDACTED]';
            if (ev.snapshot?.request?.postData?.text) ev.snapshot.request.postData.text = red.text(ev.snapshot.request.postData.text);
            return red.text(JSON.stringify(ev));
          } catch { return red.text(line); }
        }
        return red.text(line);
      });
      const out = lines.join('\n');
      if (out !== text) { modified++; zip.file(name, out); }
    } else if (name.startsWith('resources/')) {
      const buf = await file.async('nodebuffer');
      const asText = buf.toString('utf8');
      const redacted = red.text(asText);
      if (redacted !== asText) { modified++; zip.file(name, Buffer.from(redacted, 'utf8')); }
    }
  }
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return { entries, modified };
}
