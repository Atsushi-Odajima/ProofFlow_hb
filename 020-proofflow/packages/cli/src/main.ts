import { runCli } from './cli.js';
runCli(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), env: process.env }).then((code) => process.exit(code));
