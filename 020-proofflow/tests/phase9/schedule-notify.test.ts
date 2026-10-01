import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPipeline, type Pipeline } from '../helpers/pipeline.js';
import { nextCron, parseCron } from '@proofflow/server/services/schedule';

let p: Pipeline;
beforeAll(async () => { p = await createPipeline(); }, 120_000);
afterAll(async () => { await p.close(); });

describe('Phase 9: schedules (必須テスト36) and notifications', () => {
  it('cron parsing with timezone', () => {
    expect(nextCron('0 3 * * *', 'Asia/Tokyo', new Date('2026-10-01T00:00:00Z'))!.toISOString()).toBe('2026-10-01T18:00:00.000Z'); // 03:00 JST next day = 18:00 UTC
    expect(nextCron('*/15 * * * *', 'UTC', new Date('2026-10-01T10:07:00Z'))!.toISOString()).toBe('2026-10-01T10:15:00.000Z');
    expect(nextCron('0 9 * * 1-5', 'Europe/Berlin', new Date('2026-10-03T12:00:00Z'))!.toISOString()).toBe('2026-10-05T07:00:00.000Z'); // Monday 09:00 CEST
    expect(() => parseCron('60 * * * *')).toThrow();
    expect(() => parseCron('* * *')).toThrow();
  });
  it('必須テスト36: duplicate ticks / overlapping schedules do not explode into duplicate runs', async () => {
    const sc = await p.createScenario({ title: 'Landing', steps: [{ type: 'navigate', url: '/' }] });
    const suite = await p.createSuite({ name: 'Nightly', kind: 'smoke', scenarioIds: [sc.id] });
    const res = await p.A.post(`/api/v1/projects/${p.project.id}/schedules`, { suiteId: suite.id, environmentId: p.env.id, cron: '*/5 * * * *', timezone: 'Asia/Tokyo', priority: 2, overlapPolicy: 'skip', label: 'Nightly smoke' });
    expect(res.statusCode).toBe(201);
    const schedule = res.json().data;
    expect(schedule.next_run_at).toBeTruthy();
    // force due and tick twice at the same instant → exactly one run
    await p.t.db.run(`UPDATE schedules SET next_run_at = ? WHERE id = ?`, ['2026-01-01T00:00:00.000Z', schedule.id]);
    const now = new Date();
    const t1 = await p.t.app.svc.schedules.tick(now);
    expect(t1.fired).toEqual([schedule.id]);
    const runsAfter1 = (await p.A.get(`/api/v1/projects/${p.project.id}/runs`)).json().data.filter((r: { trigger: string }) => r.trigger === 'schedule');
    expect(runsAfter1.length).toBe(1);
    expect(runsAfter1[0].priority).toBe(2);
    // second tick: next_run_at is now in the future → nothing fires; forcing the same due time again hits the idempotency key
    const t2 = await p.t.app.svc.schedules.tick(now);
    expect(t2.fired).toEqual([]);
    await p.t.db.run(`UPDATE schedules SET next_run_at = ? WHERE id = ?`, ['2026-01-01T00:00:00.000Z', schedule.id]);
    const t3 = await p.t.app.svc.schedules.tick(now);
    expect(t3.fired).toEqual([]); expect(t3.skipped).toEqual([schedule.id]); // overlap skip: previous scheduled run still queued
    expect((await p.A.get(`/api/v1/projects/${p.project.id}/runs`)).json().data.filter((r: { trigger: string }) => r.trigger === 'schedule').length).toBe(1);
    await p.runner.drain();
    // after completion, a new due time fires a new run (different idempotency key)
    await p.t.db.run(`UPDATE schedules SET next_run_at = ? WHERE id = ?`, ['2026-01-01T00:05:00.000Z', schedule.id]);
    const t4 = await p.t.app.svc.schedules.tick(new Date());
    expect(t4.fired).toEqual([schedule.id]);
    expect((await p.A.get(`/api/v1/projects/${p.project.id}/runs`)).json().data.filter((r: { trigger: string }) => r.trigger === 'schedule').length).toBe(2);
    await p.runner.drain();
    // disable
    expect((await p.A.patch(`/api/v1/projects/${p.project.id}/schedules/${schedule.id}`, { enabled: false })).json().data.enabled).toBe(0);
    await p.t.db.run(`UPDATE schedules SET next_run_at = ? WHERE id = ?`, ['2026-01-01T00:10:00.000Z', schedule.id]);
    expect((await p.t.app.svc.schedules.tick(new Date())).fired).toEqual([]);
  });
  it('run failure creates in-app notifications once (storm suppression) and delivers to a webhook channel with SSRF policy', async () => {
    const received: unknown[] = [];
    const hook = (await import('node:http')).createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push(JSON.parse(b)); res.writeHead(200); res.end('ok'); }); });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    const hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;
    // private webhook URL rejected unless globally allowed → create channel through the service with a permissive adapter for the test
    expect((await p.A.post(`/api/v1/orgs/${p.s.orgId}/notification-channels`, { type: 'webhook', name: 'local', config: { url: hookUrl }, events: ['run.*', 'gate.blocked'] })).statusCode).toBe(400);
    const { WebhookAdapter } = await import('@proofflow/server/services/notify');
    p.t.app.svc.notify.register(new WebhookAdapter(true));
    p.t.cfg.allowPrivateTargetsGlobally = true;
    expect((await p.A.post(`/api/v1/orgs/${p.s.orgId}/notification-channels`, { type: 'webhook', name: 'local', config: { url: hookUrl }, events: ['run.*', 'gate.blocked'] })).statusCode).toBe(201);
    p.t.cfg.allowPrivateTargetsGlobally = false;
    const sc = await p.createScenario({ title: 'Fails', steps: [{ type: 'navigate', url: '/' }, { type: 'assert_text', text: 'this text does not exist on the page' }] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('failed');
    const notes = (await p.A.get(`/api/v1/orgs/${p.s.orgId}/notifications?unread=true`)).json().data as Array<{ kind: string; title: string; link: string }>;
    expect(notes.filter((n) => n.kind === 'run.failed' && n.link.includes(run.id)).length).toBe(1);
    expect(received.length).toBe(1);
    expect((received[0] as { event: string }).event).toBe('run.failed');
    // same dedupe key again → suppressed
    const again = await p.t.app.svc.notify.notify(p.s.orgId, p.project.id, 'run.failed', 'x', 'y', '/z', `run.failed:${run.id}`);
    expect(again.suppressed).toBe(true);
    expect((await p.A.post(`/api/v1/orgs/${p.s.orgId}/notifications/read`, { ids: 'all' })).statusCode).toBe(200);
    expect((await p.A.get(`/api/v1/orgs/${p.s.orgId}/notifications?unread=true`)).json().data.length).toBe(0);
    const deliveries = (await p.A.get(`/api/v1/orgs/${p.s.orgId}/notification-deliveries`)).json().data;
    expect(deliveries[0].status).toBe('sent');
    const channels = (await p.A.get(`/api/v1/orgs/${p.s.orgId}/notification-channels`)).json().data;
    expect(channels[0].config.url).toContain('…'); // config redacted in listings
    hook.close();
  });
});
