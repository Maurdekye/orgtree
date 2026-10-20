// Bundled, dependency-free OpenCode 2.0.28 plugin. The engine owns mail selection,
// DND, durable custody and session authorization. Never log requests or errors:
// both can contain private mail. This asset is not enabled by the launcher yet.
import net from 'node:net';

const PROTOCOL = 1;
const MAX_TEXT = 128_000;
const MAX_FRAME = 262_144;
const MAX_REQUEST = 4_096;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

/** One request per private pipe connection. No HTTP, credentials or MCP tools. */
export function pipeRequest(endpoint, request, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const line = `${JSON.stringify(request)}\n`;
    if (typeof endpoint !== 'string' ||
        !(endpoint.startsWith('\\\\.\\pipe\\') || endpoint.startsWith('/')) ||
        Buffer.byteLength(line) > MAX_REQUEST) {
      reject(Error('Invalid private mail request'));
      return;
    }
    const socket = net.createConnection(endpoint);
    const chunks = [];
    let bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(Error('Private mail bridge unavailable'));
      else resolve(value);
    };
    // Keep the timer referenced: the request must finish even with no other work.
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.once('connect', () => socket.write(line));
    socket.on('error', () => finish(true));
    socket.on('end', () => finish(true));
    socket.on('close', () => { if (!settled) finish(true); });
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_FRAME) { finish(true); return; }
      chunks.push(chunk);
      const frame = Buffer.concat(chunks, bytes);
      const end = frame.indexOf(10);
      if (end < 0) return;
      try { finish(false, JSON.parse(frame.subarray(0, end).toString('utf8'))); }
      catch { finish(true); }
    });
  });
}

function admissionWithin(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Mail admission unavailable')), milliseconds);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Exported only to test the exact shipped hook without running a provider. */
export function createMailHook({ prompt, rpc, admissionTimeoutMs = 1_500 }) {
  let inflight;
  const deliver = async sessionID => {
    try {
      const response = await rpc({ protocol: PROTOCOL, op: 'claim', sessionID });
      const batch = response?.batch;
      if (response?.protocol !== PROTOCOL || !batch) return;
      if (batch.sessionID !== sessionID || !identifier(batch.id) ||
          !batch.id.startsWith('msg_') || typeof batch.text !== 'string' ||
          !batch.text || Buffer.byteLength(batch.text) > MAX_TEXT) return;

      // Explicit IDs are reconciled by OpenCode against both its durable inbox
      // and promoted session history. A lost reply MUST retry this same ID.
      // resume:false prevents a hook racing cancellation from waking a new turn.
      const admitted = await admissionWithin(Promise.resolve(prompt({
        id: batch.id, sessionID, text: batch.text, delivery: 'steer', resume: false,
      })), admissionTimeoutMs);
      if (admitted?.id !== batch.id || admitted?.sessionID !== sessionID ||
          admitted?.type !== 'user') return;
      await rpc({ protocol: PROTOCOL, op: 'ack', sessionID, id: batch.id });
    } catch {
      // The engine retains the batch. Do not invent a success, dequeue locally,
      // log private text, or interrupt the ACP turn for a bridge failure.
    }
  };
  return event => {
    if (!identifier(event?.sessionID) || !['completed', 'error'].includes(event?.status)) {
      return Promise.resolve();
    }
    // Native tools can finish in parallel. Do not allocate an unbounded queue
    // of callbacks or race two provider admissions for the same engine batch.
    if (!inflight) inflight = deliver(event.sessionID).finally(() => { inflight = undefined; });
    return inflight;
  };
}

export default {
  id: 'orgtree-mail',
  async setup(ctx) {
    const endpoint = process.env.ORGTREE_OPENCODE_MAIL_PIPE;
    if (!endpoint || typeof ctx?.tool?.hook !== 'function' ||
        typeof ctx?.session?.prompt !== 'function') return;
    try {
      const rpc = request => pipeRequest(endpoint, request);
      const hook = createMailHook({ prompt: input => ctx.session.prompt(input), rpc });
      let ready = false;
      ctx.tool.hook('execute.after', event => ready ? hook(event) : Promise.resolve());
      const response = await rpc({ protocol: PROTOCOL, op: 'ready' });
      ready = response?.protocol === PROTOCOL && response?.ready === true;
    } catch {
      // Missing/unsupported bridge leaves the ordinary end-of-turn route intact.
    }
  },
};
