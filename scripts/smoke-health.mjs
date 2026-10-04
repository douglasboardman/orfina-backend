const baseUrl = (process.env.ORFINA_API_URL ?? 'http://localhost:3000/api').replace(/\/$/, '');

for (const path of ['/health/live', '/health/ready']) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} respondeu HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== 'ok') throw new Error(`${path} não confirmou estado ok.`);
}

console.log('Health smoke test aprovado.');
