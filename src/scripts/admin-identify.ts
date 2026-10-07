import { createServer } from 'node:http';
import { googleAuthorization, exchangeGoogle } from '../auth/google.strategy';

async function main() {
  const callback = process.env.GOOGLE_CLI_CALLBACK_URL ?? 'http://127.0.0.1:53682/callback';
  const url = new URL(callback);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/callback') throw new Error('INVALID_LOOPBACK');
  const clientId = process.env.GOOGLE_CLI_CLIENT_ID;
  const secret = process.env.GOOGLE_CLI_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('CLI_CLIENT_MISSING');
  const flow = googleAuthorization(callback, clientId);
  await new Promise<void>((resolve, reject) => {
    let used = false;
    const server = createServer(async (req, res) => {
      const received = new URL(req.url ?? '/', callback);
      if (req.method !== 'GET' || used || received.pathname !== '/callback' || received.searchParams.get('state') !== flow.state) { res.writeHead(400).end('Solicitação inválida.'); return; }
      used = true;
      try {
        const profile = await exchangeGoogle(received.searchParams.get('code') ?? '', flow.verifier, flow.nonce, callback, clientId, secret);
        console.log(JSON.stringify({ email: profile.email, googleSub: profile.googleId }));
        res.end('Identidade validada. Volte ao terminal. Nenhuma sessão do Orfina foi criada.'); resolve();
      } catch { res.writeHead(400).end('Identificação recusada.'); reject(new Error('IDENTIFICATION_FAILED')); }
      finally { clearTimeout(timeout); server.close(); }
    });
    const timeout = setTimeout(() => { server.close(); reject(new Error('IDENTIFICATION_TIMEOUT')); }, 180000);
    server.on('error', (error) => { clearTimeout(timeout); server.close(); reject(error); });
    server.listen(Number(url.port), '127.0.0.1', () => console.log(`Abra no navegador local: ${flow.url}`));
  });
}
void main().catch(() => { console.error('Identificação recusada. Verifique cliente OAuth CLI, callback loopback e conexão.'); process.exitCode = 1; });
