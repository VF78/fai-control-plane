const fs = process.getBuiltinModule('node:fs/promises');
const http = process.getBuiltinModule('node:http');
const childProcess = process.getBuiltinModule('node:child_process');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
const url = process.getBuiltinModule('node:url');
if (fs === undefined || http === undefined || childProcess === undefined || os === undefined ||
  path === undefined || url === undefined) throw new Error('deployment_executor_jitless_test_builtin_unavailable');

const scriptDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const distDirectory = path.resolve(scriptDirectory, '../dist');
const distEntry = path.join(distDirectory, 'index.js');

const fail = (code) => { throw new Error(`deployment_executor_jitless_test_${code}`); };

if (process.argv[2] === '--child') {
  const [socketPath, socketUid, socketGid, directoryUid, directoryGid] = process.argv.slice(3);
  const built = await import(url.pathToFileURL(distEntry).href);
  const transport = built.createUnixSocketJsonTransport({
    socketPath,
    expectedSocketUid: Number(socketUid),
    expectedSocketGid: Number(socketGid),
    trustedDirectoryUid: Number(directoryUid),
    trustedDirectoryGid: Number(directoryGid)
  });
  const response = await transport.post('/api/deployment-executor/heartbeat', {
    authorization: `Bearer ${'t'.repeat(32)}`,
    'content-type': 'application/json',
    'x-fai-deployment-lease-token': 'l'.repeat(32)
  }, '{"jobId":"jitless-build-test"}');
  const body = await response.json();
  if (response.status !== 200 || body?.ok !== true) fail('response');
  process.stdout.write('deployment executor jitless UDS verified\n');
} else {
  const pending = [distEntry, path.join(distDirectory, 'cli.js')];
  const sources = [];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await fs.readFile(file, 'utf8');
    sources.push({name: path.basename(file), source});
    const localImport = /\b(?:from\s*|import\s*)["'](\.[^"']+\.js)["']/g;
    for (const match of source.matchAll(localImport)) {
      const dependency = path.resolve(path.dirname(file), match[1]);
      if (path.dirname(dependency) !== distDirectory) fail('import_outside_dist');
      pending.push(dependency);
    }
  }
  const esmHttpImport = /\b(?:from\s*|import\s*)["'](?:node:)?http["']/;
  const violation = sources.find(({source}) => esmHttpImport.test(source));
  if (violation !== undefined) fail(`esm_http_import_${violation.name}`);

  if (!process.allowedNodeEnvironmentFlags.has('--jitless') || Number(process.versions.node.split('.')[0]) < 22) {
    process.stdout.write('deployment executor jitless UDS skipped: Node >=22 with --jitless unavailable\n');
  } else {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fai-deployment-jitless-')));
    const socketPath = path.join(directory, 'control.sock');
    let server;
    try {
      await fs.chmod(directory, 0o770);
      server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          if (request.method !== 'POST' || request.url !== '/api/deployment-executor/heartbeat' ||
            request.headers.authorization !== `Bearer ${'t'.repeat(32)}` ||
            request.headers['x-fai-deployment-lease-token'] !== 'l'.repeat(32) ||
            Buffer.concat(chunks).toString('utf8') !== '{"jobId":"jitless-build-test"}') {
            response.writeHead(400); response.end('{"ok":false}'); return;
          }
          response.writeHead(200, {'content-type': 'application/json'}); response.end('{"ok":true}');
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => { server.off('error', reject); resolve(); });
      });
      await fs.chmod(socketPath, 0o660);
      const [directoryStat, socketStat] = await Promise.all([fs.lstat(directory), fs.lstat(socketPath)]);
      const child = childProcess.spawn(process.execPath, ['--jitless', url.fileURLToPath(import.meta.url), '--child',
        socketPath, String(socketStat.uid), String(socketStat.gid), String(directoryStat.uid),
        String(directoryStat.gid)], {stdio: ['ignore', 'pipe', 'pipe']});
      const stdout = []; const stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
      if (exitCode !== 0 || Buffer.concat(stdout).toString('utf8') !==
        'deployment executor jitless UDS verified\n') {
        process.stderr.write(Buffer.concat(stderr));
        fail(`child_${String(exitCode)}`);
      }
      process.stdout.write(Buffer.concat(stdout));
    } finally {
      if (server !== undefined) await new Promise((resolve) => server.close(() => resolve()));
      await fs.rm(directory, {recursive: true, force: true});
    }
  }
}
