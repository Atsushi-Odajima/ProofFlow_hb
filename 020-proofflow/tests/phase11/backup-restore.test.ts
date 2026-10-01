import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPipeline, type Pipeline } from '../helpers/pipeline.js';
import { createTestApp, api, login, type TestApp } from '../helpers/app.js';
import { restoreMain } from '@proofflow/server/restore';
import type { BackupDocument } from '@proofflow/server/services/backup';

let p: Pipeline; let restored: TestApp | null = null;
beforeAll(async () => { p = await createPipeline(); }, 120_000);
afterAll(async () => { await restored?.close(); await p.close(); });

const PASSWORD_IN_VAULT = 'demo-pass-123';

describe('Phase 11: backup / restore (必須テスト34, E2E-10)', () => {
  let doc: BackupDocument;

  it('backup → restore into an empty environment keeps Requirement/Scenario/Run/Defect/Gate traceability', async () => {
    // --- a small but complete project history: requirement → scenario → RC → failing run → defect → BLOCKED gate → manual check ---
    const reqId = (await p.A.post(`/api/v1/projects/${p.project.id}/requirements`, { title: 'Login shows an error for invalid credentials', priority: 'p0', acceptanceCriteria: [{ given: 'the login page', when: 'a wrong password is submitted', then: 'the text "Invalid email or password" is shown' }] })).json().data.id as string;
    const loginSc = await p.createScenario({ title: 'Login invalid shows error', priority: 'p0', requirementIds: [reqId], steps: [{ type: 'navigate', url: '/login' }, { type: 'fill', target: { label: 'Email' }, value: 'wrong@example.com' }, { type: 'fill', target: { label: 'Password' }, value: '{{secret:LOGIN_PASSWORD}}' }, { type: 'click', target: { role: 'button', name: 'Log in' } }, { type: 'assert_text', text: 'Invalid email or password' }] });
    const landing = await p.createScenario({ title: 'Landing loads', priority: 'p1', steps: [{ type: 'navigate', url: '/' }, { type: 'assert_title', title: 'Sample SaaS' }, { type: 'screenshot', label: 'landing' }] });
    const suite = await p.createSuite({ name: 'Critical', kind: 'critical', scenarioIds: [loginSc.id, landing.id], requiredForRelease: true });
    const rc = (await p.A.post(`/api/v1/projects/${p.project.id}/releases`, { version: '1.2.0', environmentId: p.env.id, requiredManualChecks: ['iPhone smoke'] })).json().data as { id: string };
    const run = await p.runAndWait({ suiteId: suite.id, releaseCandidateId: rc.id });
    expect(run.status).toBe('failed');
    const failed = run.results.find((r) => r.status === 'failed')!;
    const defect = (await p.A.post(`/api/v1/projects/${p.project.id}/defects/from-result`, { resultId: failed.id, severity: 'critical' })).json().data as { id: string };
    expect((await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rc.id}/evaluate`)).json().data.result).toBe('BLOCKED');
    expect((await p.A.post(`/api/v1/projects/${p.project.id}/manual-checks`, { releaseCandidateId: rc.id, label: 'iPhone smoke', device: 'iPhone 15', result: 'fail', notes: 'CTA off-screen on device' })).statusCode).toBe(201);
    const snapshot = async (A: ReturnType<typeof api>, orgId: string) => ({
      trace: (await A.get(`/api/v1/projects/${p.project.id}/requirements/${reqId}/traceability`)).json().data,
      run: (await A.get(`/api/v1/runs/${run.id}`)).json().data,
      defect: (await A.get(`/api/v1/projects/${p.project.id}/defects/${defect.id}`)).json().data,
      rc: (await A.get(`/api/v1/projects/${p.project.id}/releases/${rc.id}`)).json().data,
      scenarios: (await A.get(`/api/v1/projects/${p.project.id}/scenarios`)).json().data,
      suites: (await A.get(`/api/v1/projects/${p.project.id}/suites`)).json().data,
      manual: (await A.get(`/api/v1/projects/${p.project.id}/manual-checks`)).json().data,
      audit: (await A.get(`/api/v1/orgs/${orgId}/audit?limit=500`)).json().data as Array<{ action: string }>,
    });
    // --- export: admin/owner only, audited, secrets stay encrypted, checksum detects tampering ---
    await p.A.post(`/api/v1/orgs/${p.s.orgId}/members`, { email: 'dev-bk@a.example', role: 'developer', temporaryPassword: 'Dev-Pass-123456' });
    const D = api(p.t.app, { cookie: await login(p.t.app, 'dev-bk@a.example', 'Dev-Pass-123456') });
    const before = await snapshot(p.A, p.s.orgId);
    expect(before.trace.scenarios[0].defects.length).toBe(1);
    expect((await D.get(`/api/v1/orgs/${p.s.orgId}/backup`)).statusCode).toBe(403);
    const res = await p.A.get(`/api/v1/orgs/${p.s.orgId}/backup`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('proofflow-backup-');
    doc = res.json() as BackupDocument;
    expect(doc.format).toBe('proofflow-backup'); expect(doc.schemaVersion).toBe(1); expect(doc.appVersion).toBe('0.1.0'); expect(doc.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.counts.test_runs).toBe(1); expect(doc.counts.requirements).toBe(1); expect(doc.counts.defects).toBe(1); expect(doc.counts.release_candidates).toBe(1); expect(doc.counts.gate_evaluations).toBe(1); expect(doc.counts.manual_check_results).toBe(1);
    expect(doc.counts.artifacts).toBeGreaterThan(0); expect(doc.counts.secrets).toBe(2); expect(doc.counts.users).toBe(2);
    expect(doc.tables.sessions).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain(PASSWORD_IN_VAULT);
    expect(doc.tables.secrets![0]!.ciphertext).toMatch(/^v1\.k1\./);
    const tampered = structuredClone(doc); (tampered.tables.defects![0] as { severity: string }).severity = 'low';
    const bad = await p.A.post(`/api/v1/orgs/${p.s.orgId}/backup/verify`, tampered);
    expect(bad.statusCode).toBe(400); expect(bad.json().error.message).toContain('checksum');
    const verify = await p.A.post(`/api/v1/orgs/${p.s.orgId}/backup/verify`, doc);
    expect(verify.statusCode).toBe(200); expect(verify.json().data.valid).toBe(true); expect(verify.json().data.restorableHere).toBe(false); // this org already exists here
    const audit = (await p.A.get(`/api/v1/orgs/${p.s.orgId}/audit?action=backup.export`)).json().data;
    expect(audit.length).toBe(1); expect(JSON.stringify(audit)).not.toContain(PASSWORD_IN_VAULT);

    // --- restore into a brand-new empty environment: same master key + signing secret; artifact binaries copied separately ---
    restored = await createTestApp({}, { PROOFFLOW_MASTER_KEY: p.t.cfg.masterKey.toString('base64'), PROOFFLOW_SIGNING_SECRET: p.t.cfg.signingSecret });
    cpSync(join(p.t.dataDir, 'artifacts'), join(restored.dataDir, 'artifacts'), { recursive: true });
    const r = await restored.app.svc.backup.restore(doc);
    expect(r.dryRun).toBe(false); expect(r.counts).toEqual(expect.objectContaining(doc.counts));
    await expect(restored.app.svc.backup.restore(doc)).rejects.toThrow(/not empty/); // a second restore is refused
    const cookie = await login(restored.app, 'pipeline@a.example'); // same credentials work (password hashes restored)
    const R = api(restored.app, { cookie });
    const after = await snapshot(R, p.s.orgId);
    expect(after.trace).toEqual(before.trace);
    expect(after.run).toEqual(before.run);
    expect(after.defect).toEqual(before.defect);
    expect(after.rc).toEqual(before.rc);
    expect(after.scenarios).toEqual(before.scenarios);
    expect(after.suites).toEqual(before.suites);
    expect(after.manual).toEqual(before.manual);
    // audit history is carried over, plus exactly one 'backup.restore' entry on top
    expect(after.audit.length).toBe(before.audit.length + 1);
    expect(after.audit[0]!.action).toBe('backup.restore');
    // the vault decrypts with the same master key
    const secrets = await restored.app.svc.projects.resolveSecrets(p.project.id, p.env.id, ['LOGIN_PASSWORD']);
    expect(secrets.LOGIN_PASSWORD).toBe(PASSWORD_IN_VAULT);
    // evidence is reachable again once the artifact directory has been restored
    const shot = (after.run.results as Array<{ artifacts: Array<{ id: string; kind: string }> }>).flatMap((x) => x.artifacts).find((a) => a.kind === 'screenshot')!;
    expect((await R.get(`/api/v1/artifacts/${shot.id}/download`)).statusCode).toBe(200);
    // the gate re-evaluates to the same verdict from the restored data
    expect((await R.post(`/api/v1/projects/${p.project.id}/releases/${rc.id}/evaluate`)).json().data.result).toBe('BLOCKED');
  });

  it('restore CLI: --dry-run validates, a real restore succeeds once, the second attempt is refused (exit 5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-restore-cli-'));
    const file = join(dir, 'backup.json'); writeFileSync(file, JSON.stringify(doc));
    const env = { NODE_ENV: 'test', PROOFFLOW_DATA_DIR: dir, PROOFFLOW_SQLITE_PATH: join(dir, 'restore.sqlite'), PROOFFLOW_MASTER_KEY: p.t.cfg.masterKey.toString('base64'), PROOFFLOW_SIGNING_SECRET: p.t.cfg.signingSecret } as NodeJS.ProcessEnv;
    expect(await restoreMain([file, '--dry-run'], env)).toBe(0);
    expect(await restoreMain([file], env)).toBe(0);
    expect(await restoreMain([file], env)).toBe(5);
    expect(await restoreMain([], env)).toBe(4);
    const corrupt = join(dir, 'corrupt.json'); writeFileSync(corrupt, JSON.stringify({ ...doc, checksum: '0'.repeat(64) }));
    expect(await restoreMain([corrupt], env)).toBe(1);
  });
});
