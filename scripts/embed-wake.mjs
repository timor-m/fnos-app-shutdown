import { readFileSync, writeFileSync } from 'node:fs';
const path = new URL('../packages/server/assets/fnos-shutdown-executor.sh', import.meta.url);
const runtime = readFileSync(new URL('./wake-runtime.py', import.meta.url), 'utf8').trimEnd();
const block = `# BEGIN EMBEDDED WAKE RUNTIME\nwake_runtime() {\n    local wake_source\n    wake_source=$(cat <<'FNOS_WAKE_PY'\n${runtime}\nFNOS_WAKE_PY\n)\n    /usr/bin/python3 -I -c "$wake_source" "$1"\n}\n# END EMBEDDED WAKE RUNTIME`;
let shell = readFileSync(path, 'utf8');
const expression = /# BEGIN EMBEDDED WAKE RUNTIME[\s\S]*?# END EMBEDDED WAKE RUNTIME/;
if (!expression.test(shell)) throw new Error('Missing wake embed marker');
const next = shell.replace(expression, () => block);
if (process.argv.includes('--check')) {
  if (next !== shell) throw new Error('RTC runtime is out of sync; run node scripts/embed-wake.mjs');
} else writeFileSync(path, next);
