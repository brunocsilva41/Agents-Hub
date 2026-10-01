if (process.argv.includes('--version')) { process.stdout.write('1.0.0\n'); process.exit(0); }
const agente = process.env.FAKE_AGENT; let prompt = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const sid = 'nat-' + agente + '-' + process.pid;
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake', tools: [] });
  const sleep = Number(process.env.FAKE_SLEEP_MS || 0);
  if (sleep) await new Promise((r) => setTimeout(r, sleep));
  out({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: sid, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
});
