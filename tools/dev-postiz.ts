import { startPostizFixture } from '../server';

const args = Bun.argv.slice(2);
const fixture = startPostizFixture({ port: 4786 });
const app = Bun.spawn(['bun', 'exact.mjs', ...(args.length ? args : ['web'])], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
});
function stop() { app.kill(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  console.log('Postiz development fixture listening at ' + fixture.origin);
  process.exitCode = await app.exited;
} finally {
  await fixture.stop();
}
