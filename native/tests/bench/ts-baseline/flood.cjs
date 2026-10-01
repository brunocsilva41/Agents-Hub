if (process.argv.includes('--version')) { process.stdout.write('1.0.0\n'); process.exit(0); }
const N = Number(process.env.FLOOD_N), IV = Number(process.env.FLOOD_IV || 0), PAD = 'x'.repeat(Number(process.env.FLOOD_PAD || 150));
const now = () => performance.timeOrigin + performance.now();
function w(t) { return new Promise((r) => { if (process.stdout.write(t)) r(); else process.stdout.once('drain', r); }); }
process.stdin.resume();
process.stdin.on('end', async () => {
  await new Promise((r) => setTimeout(r, 500));
  if (IV > 0) {
    for (let i = 0; i < N; i++) { await w('F|' + i + '|' + now().toFixed(3) + '|' + PAD + '\n'); await new Promise((r) => setTimeout(r, IV)); }
  } else {
    let b = '';
    for (let i = 0; i < N; i++) { b += 'F|' + i + '|' + now().toFixed(3) + '|' + PAD + '\n'; if (b.length > 65536) { await w(b); b = ''; } }
    await w(b);
  }
  process.exit(0);
});
