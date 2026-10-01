import AjvModule, { type ErrorObject } from 'ajv';

const AjvCtor = (AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule;
const ajv = new (AjvCtor as unknown as new (o: Record<string, unknown>) => { compile: (s: Record<string, unknown>) => ((d: unknown) => boolean) & { errors?: ErrorObject[] | null } })({ allErrors: true, strict: false });
export function validateJsonSchema(schema: Record<string, unknown>, data: unknown): { ok: boolean; errors: string[] } {
  try {
    const validate = ajv.compile(schema);
    const ok = validate(data) as boolean;
    return { ok, errors: ok ? [] : (validate.errors ?? []).slice(0, 20).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()) };
  } catch (e) { return { ok: false, errors: [`invalid schema: ${e instanceof Error ? e.message : String(e)}`] }; }
}
export function jsonPath(obj: unknown, path: string): { exists: boolean; value: unknown } {
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return { exists: false, value: undefined };
    const m = /^(\w+)\[(\d+)\]$/.exec(p);
    if (m) { cur = (cur as Record<string, unknown>)[m[1]!]; if (!Array.isArray(cur)) return { exists: false, value: undefined }; cur = cur[Number(m[2])]; }
    else { if (!(p in (cur as Record<string, unknown>))) return { exists: false, value: undefined }; cur = (cur as Record<string, unknown>)[p]; }
  }
  return { exists: true, value: cur };
}
