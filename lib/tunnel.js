import { spawn } from 'child_process';

let proc = null;
let publicUrl = null;
let readyResolvers = [];

const startTunnel = (port) => {
  if (proc) return;

  proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const handleOutput = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !publicUrl) {
      publicUrl = match[0];
      console.log(`[tunnel] 公開網址 ${publicUrl}`);
      readyResolvers.forEach(r => r(publicUrl));
      readyResolvers = [];
    }
  };

  proc.stdout.on('data', handleOutput);
  proc.stderr.on('data', handleOutput);

  proc.on('exit', (code) => {
    console.warn(`[tunnel] cloudflared 結束 (${code})，5 秒後重啟`);
    proc = null;
    publicUrl = null;
    setTimeout(() => startTunnel(port), 5000);
  });
};

export const initTunnel = (port) => startTunnel(port);

export const getPublicUrl = () => publicUrl;

export const waitForTunnel = (timeoutMs = 30000) => {
  if (publicUrl) return Promise.resolve(publicUrl);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tunnel 啟動逾時')), timeoutMs);
    readyResolvers.push((url) => {
      clearTimeout(timer);
      resolve(url);
    });
  });
};

export const stopTunnel = () => {
  if (proc) {
    proc.removeAllListeners('exit');
    proc.kill();
    proc = null;
    publicUrl = null;
  }
};
