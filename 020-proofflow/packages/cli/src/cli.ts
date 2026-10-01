import { ProofFlowApi, ApiError, type RunSummary } from './api.js';
import { writeFileSync, readFileSync } from 'node:fs';

export interface CliIo { stdout: (s: string) => void; stderr: (s: string) => void; env: Record<string, string | undefined>; fetchImpl?: typeof fetch; }
export const EXIT = { OK: 0, FAILED: 1, FLAKY: 2, INFRA: 3, USAGE: 4, BLOCKED: 5 } as const;

const HELP = `proofflow — ProofFlow CLI (control plane: PROOFFLOW_URL, token: PROOFFLOW_TOKEN)

Commands:
  run      --project <id|slug> --suite <name|id> [--env <name|id>] [--scenario <id>...] [--commit <sha>] [--branch <b>] [--pr <n>] [--build <id>]
           [--release <version>] [--wait] [--timeout <sec>] [--fail-on failed|flaky] [--comment-file <path>] [--json] [--allow-destructive]
  status   <runId> [--wait] [--json]
  gate     --project <id|slug> --release <version> [--strict] [--json]
  retest   --run <runId> | --defect <defectId> [--wait]
  impact   --project <id|slug> --changed <file>... [--run] [--env <name|id>] [--wait]
  export   --project <id|slug> --out <file.json>
  import   --project <id|slug> --file <file.json> [--reason <text>]
  report   --project <id|slug> --release <version> [--format html|pdf] --out <file>

Exit codes: 0 ok/READY · 1 failed · 2 flaky (with --fail-on flaky) · 3 infra error · 4 usage/auth · 5 gate BLOCKED
Secrets never appear in CLI output. Commit/branch/PR are read from GITHUB_* env when not given.`;

export function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string | string[] | boolean> } {
  const [cmd = 'help', ...rest] = argv; const positional: string[] = []; const flags: Record<string, string | string[] | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2); const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[k] = true; continue; }
      const vals: string[] = []; while (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('--')) vals.push(rest[++i]!);
      const existing = flags[k];
      flags[k] = vals.length === 1 && !Array.isArray(existing) ? (existing === undefined ? vals[0]! : [existing as string, ...vals]) : [...(Array.isArray(existing) ? existing : existing ? [existing as string] : []), ...vals];
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}
const str = (v: string | string[] | boolean | undefined) => (Array.isArray(v) ? v[0] : typeof v === 'string' ? v : undefined);
const arr = (v: string | string[] | boolean | undefined) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const { cmd, positional, flags } = parseArgs(argv);
  if (cmd === 'help' || cmd === '--help' || flags.help) { io.stdout(HELP + '\n'); return EXIT.OK; }
  const url = str(flags.url) ?? io.env.PROOFFLOW_URL; const token = str(flags.token) ?? io.env.PROOFFLOW_TOKEN;
  if (!url || !token) { io.stderr('PROOFFLOW_URL and PROOFFLOW_TOKEN are required (env or --url/--token)\n'); return EXIT.USAGE; }
  const api = new ProofFlowApi(url, token, io.fetchImpl);
  const json = !!flags.json;
  const out = (obj: unknown, text: string) => io.stdout(json ? JSON.stringify(obj, null, 2) + '\n' : text + '\n');
  const printRun = (run: RunSummary) => {
    const failed = run.results.filter((r) => r.status !== 'passed');
    const lines = [`run ${run.id}: ${run.status.toUpperCase()}  passed=${run.counts.passed ?? 0} flaky=${(run.counts.flaky ?? 0) + (run.counts.passedAfterRetry ?? 0)} failed=${run.counts.failed ?? 0} infra=${run.counts.infraError ?? 0} total=${run.counts.total ?? 0}`];
    for (const r of failed) lines.push(`  ✗ ${r.scenario?.key ?? r.scenarioId} ${r.scenario?.title ?? ''} [${r.browser} ${r.viewport.name ?? `${r.viewport.width}x${r.viewport.height}`}] ${r.status}: ${r.failure?.message ?? ''}  evidence: ${r.artifacts.map((a) => a.kind).join(',')}`);
    return lines.join('\n');
  };
  const exitFor = (run: RunSummary) => run.status === 'passed' ? EXIT.OK : run.status === 'flaky' ? (str(flags['fail-on']) === 'flaky' ? EXIT.FLAKY : EXIT.OK) : run.status === 'infra_error' ? EXIT.INFRA : EXIT.FAILED;
  try {
    switch (cmd) {
      case 'run': {
        const projectRef = str(flags.project); const suiteRef = str(flags.suite);
        if (!projectRef || (!suiteRef && arr(flags.scenario).length === 0)) { io.stderr('run: --project and --suite (or --scenario) are required\n'); return EXIT.USAGE; }
        const project = await api.resolveProject(projectRef);
        const env = await api.resolveEnvironment(project.id, str(flags.env), project.environments, (project as { defaultEnvironmentId?: string }).defaultEnvironmentId);
        const suite = suiteRef ? await api.resolveSuite(project.id, suiteRef) : undefined;
        let releaseCandidateId: string | undefined;
        if (str(flags.release)) { const rcs = await api.get<Array<{ id: string; version: string }>>(`/api/v1/projects/${project.id}/releases`); releaseCandidateId = rcs.find((r) => r.version === str(flags.release))?.id; if (!releaseCandidateId) { io.stderr(`release candidate ${str(flags.release)} not found\n`); return EXIT.USAGE; } }
        const ghSha = io.env.GITHUB_SHA; const ghRef = io.env.GITHUB_HEAD_REF || io.env.GITHUB_REF_NAME; const ghRun = io.env.GITHUB_RUN_ID;
        const prFromRef = io.env.GITHUB_REF?.match(/refs\/pull\/(\d+)\//)?.[1];
        const body = { environmentId: env.id, suiteId: suite?.id, scenarioIds: arr(flags.scenario).length ? arr(flags.scenario) : undefined, commitSha: str(flags.commit) ?? ghSha, branch: str(flags.branch) ?? ghRef, prNumber: str(flags.pr) ? Number(str(flags.pr)) : prFromRef ? Number(prFromRef) : undefined, buildId: str(flags.build) ?? ghRun, trigger: 'ci', releaseCandidateId, allowDestructive: !!flags['allow-destructive'], idempotencyKey: str(flags['idempotency-key']) };
        const run = await api.post<{ id: string; status: string }>(`/api/v1/projects/${project.id}/runs`, body);
        if (!flags.wait) { out(run, `run ${run.id} queued (${run.status}). Use: proofflow status ${run.id} --wait`); return EXIT.OK; }
        const final = await api.waitForRun(run.id, { timeoutMs: Number(str(flags.timeout) ?? 1800) * 1000, onTick: (r) => { if (!json) io.stderr(`… ${r.status} ${r.counts.passed ?? 0}/${r.counts.total ?? 0}\r`); } });
        out(final, printRun(final));
        if (str(flags['comment-file'])) { const cs = await api.get<{ markdown: string }>(`/api/v1/runs/${run.id}/ci-summary`); writeFileSync(str(flags['comment-file'])!, cs.markdown); }
        return exitFor(final);
      }
      case 'status': {
        const runId = positional[0]; if (!runId) { io.stderr('status: runId required\n'); return EXIT.USAGE; }
        const run = flags.wait ? await api.waitForRun(runId, { timeoutMs: Number(str(flags.timeout) ?? 1800) * 1000 }) : await api.get<RunSummary>(`/api/v1/runs/${runId}`);
        out(run, printRun(run));
        return ['queued', 'running'].includes(run.status) ? EXIT.OK : exitFor(run);
      }
      case 'gate': {
        const projectRef = str(flags.project); const version = str(flags.release);
        if (!projectRef || !version) { io.stderr('gate: --project and --release are required\n'); return EXIT.USAGE; }
        const project = await api.resolveProject(projectRef);
        const rcs = await api.get<Array<{ id: string; version: string }>>(`/api/v1/projects/${project.id}/releases`);
        const rc = rcs.find((r) => r.version === version); if (!rc) { io.stderr(`release candidate ${version} not found\n`); return EXIT.USAGE; }
        const ev = await api.post<{ result: string; rules: Array<{ pass: boolean; message: string }> }>(`/api/v1/projects/${project.id}/releases/${rc.id}/evaluate`);
        out(ev, `gate ${version}: ${ev.result}\n` + ev.rules.map((r) => `  ${r.pass ? '✓' : '✗'} ${r.message}`).join('\n'));
        if (ev.result === 'BLOCKED') return EXIT.BLOCKED;
        if (ev.result === 'READY_WITH_ACCEPTED_RISK' && flags.strict) return EXIT.BLOCKED;
        return EXIT.OK;
      }
      case 'retest': {
        let run: { id: string };
        if (str(flags.run)) run = await api.post<{ id: string }>(`/api/v1/runs/${str(flags.run)}/retest-failed`, { label: 'cli retest' });
        else if (str(flags.defect)) { const projectRef = str(flags.project); if (!projectRef) { io.stderr('retest --defect needs --project\n'); return EXIT.USAGE; } const project = await api.resolveProject(projectRef); run = await api.post<{ id: string }>(`/api/v1/projects/${project.id}/defects/${str(flags.defect)}/retest`, {}); }
        else { io.stderr('retest: --run <runId> or --defect <defectId> required\n'); return EXIT.USAGE; }
        if (!flags.wait) { out(run, `retest run ${run.id} queued`); return EXIT.OK; }
        const final = await api.waitForRun(run.id, { timeoutMs: Number(str(flags.timeout) ?? 1800) * 1000 }); out(final, printRun(final)); return exitFor(final);
      }
      case 'impact': {
        const projectRef = str(flags.project); const changed = arr(flags.changed);
        if (!projectRef || !changed.length) { io.stderr('impact: --project and --changed <files> required\n'); return EXIT.USAGE; }
        const project = await api.resolveProject(projectRef);
        const imp = await api.post<{ candidates: Array<{ scenarioId: string; key: string; title: string; reasons: string[] }>; note: string }>(`/api/v1/projects/${project.id}/test-impact`, { changedFiles: changed });
        out(imp, `candidates (${imp.candidates.length}):\n` + imp.candidates.map((c) => `  ${c.key} ${c.title} — ${c.reasons.join(', ')}`).join('\n') + `\n${imp.note}`);
        if (flags.run && imp.candidates.length) { const env = await api.resolveEnvironment(project.id, str(flags.env), project.environments, (project as { defaultEnvironmentId?: string }).defaultEnvironmentId); const run = await api.post<{ id: string }>(`/api/v1/projects/${project.id}/runs`, { environmentId: env.id, scenarioIds: imp.candidates.map((c) => c.scenarioId), trigger: 'agent', label: 'impact candidates' }); if (!flags.wait) { out(run, `run ${run.id} queued`); return EXIT.OK; } const final = await api.waitForRun(run.id); out(final, printRun(final)); return exitFor(final); }
        return EXIT.OK;
      }
      case 'export': {
        const projectRef = str(flags.project); const outFile = str(flags.out);
        if (!projectRef || !outFile) { io.stderr('export: --project and --out required\n'); return EXIT.USAGE; }
        const project = await api.resolveProject(projectRef);
        const doc = await api.get(`/api/v1/projects/${project.id}/export/definitions`);
        writeFileSync(outFile, JSON.stringify(doc, null, 2)); io.stdout(`exported definitions to ${outFile}\n`); return EXIT.OK;
      }
      case 'import': {
        const projectRef = str(flags.project); const file = str(flags.file);
        if (!projectRef || !file) { io.stderr('import: --project and --file required\n'); return EXIT.USAGE; }
        const project = await api.resolveProject(projectRef);
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        const res = await api.post<{ errors: string[] }>(`/api/v1/projects/${project.id}/import/definitions`, { ...doc, changeReason: str(flags.reason) });
        out(res, `import result: ${JSON.stringify(res)}`); return res.errors.length ? EXIT.FAILED : EXIT.OK;
      }
      case 'report': {
        const projectRef = str(flags.project); const version = str(flags.release); const outFile = str(flags.out);
        if (!projectRef || !version || !outFile) { io.stderr('report: --project, --release and --out required\n'); return EXIT.USAGE; }
        const project = await api.resolveProject(projectRef);
        const rcs = await api.get<Array<{ id: string; version: string }>>(`/api/v1/projects/${project.id}/releases`);
        const rc = rcs.find((r) => r.version === version); if (!rc) { io.stderr(`release candidate ${version} not found\n`); return EXIT.USAGE; }
        const rep = await api.post<{ artifactId: string; checksum: string }>(`/api/v1/projects/${project.id}/releases/${rc.id}/report`, { format: str(flags.format) ?? 'html' });
        const bin = await api.raw(`/api/v1/artifacts/${rep.artifactId}/download`);
        writeFileSync(outFile, bin.body); io.stdout(`report written to ${outFile} (sha256 ${rep.checksum})\n`); return EXIT.OK;
      }
      default: io.stderr(`unknown command ${cmd}\n${HELP}\n`); return EXIT.USAGE;
    }
  } catch (e) {
    if (e instanceof ApiError) { io.stderr(`error ${e.status} ${e.code}: ${e.message}${e.details ? ' ' + JSON.stringify(e.details) : ''}\n`); return e.status === 401 || e.status === 403 || e.status === 404 ? EXIT.USAGE : EXIT.FAILED; }
    io.stderr(`error: ${e instanceof Error ? e.message : String(e)}\n`); return EXIT.FAILED;
  }
}
