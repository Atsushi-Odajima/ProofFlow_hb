import { createRunner } from './runner.js';

const controlUrl = process.env.PROOFFLOW_CONTROL_URL ?? 'http://localhost:8080';
const token = process.env.PROOFFLOW_RUNNER_TOKEN;
if (!token) { console.error('PROOFFLOW_RUNNER_TOKEN is required (create a runner token in Organization → Runners)'); process.exit(2); }
const runner = createRunner({ controlUrl, token, name: process.env.PROOFFLOW_RUNNER_NAME, concurrency: Number(process.env.PROOFFLOW_RUNNER_CONCURRENCY ?? 2), browsers: process.env.PROOFFLOW_RUNNER_BROWSERS?.split(',').map((s) => s.trim()).filter(Boolean), allowPrivateNetwork: process.env.PROOFFLOW_RUNNER_ALLOW_PRIVATE === '1', workDir: process.env.PROOFFLOW_RUNNER_WORKDIR });
runner.start().catch((e) => { console.error(e); process.exit(1); });
const shutdown = () => { console.log('[runner] stopping…'); runner.stop().then(() => process.exit(0)); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
