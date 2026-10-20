import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The pre-feature adapter installs no plugin: a tool boundary does nothing.
// Keeping that explicit baseline makes the initial red run exercise behaviour.
const asset = new URL('../../../engine/rs/orgtree-engine/src/runtime/opencode_mail_plugin.mjs', import.meta.url);
const plugin = await import(asset.href).catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return { createMailHook: () => async () => {}, pipeRequest: async () => null };
});
const event = { sessionID: 'ses_fixture', status: 'completed' };
const batch = (n, text = `mail ${n}`) => ({ id: `msg_orgtree${n}`, sessionID: event.sessionID, text });
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(batches = [batch(1)], { inbox = new Map() } = {}) {
  const queue = batches.map(clone), calls = [], acknowledgements = [];
  let failAdmission = 0, failAck = 0, corruptAdmission = false;
  const prompt = async input => {
    calls.push(clone(input));
    if (failAdmission-- > 0) throw Error('synthetic admission failure');
    // This is the provider's durable, first-admission-wins ID contract.
    if (!inbox.has(input.id)) inbox.set(input.id, clone(input));
    return { id: corruptAdmission ? 'msg_other' : input.id, sessionID: input.sessionID, type: 'user' };
  };
  const rpc = async request => {
    assert.equal(request.protocol, 1);
    if (request.op === 'claim') {
      assert.equal(request.sessionID, event.sessionID);
      return { protocol: 1, batch: queue[0] ?? null };
    }
    assert.equal(request.op, 'ack');
    assert.equal(request.id, queue[0]?.id);
    assert.equal(request.sessionID, queue[0]?.sessionID);
    if (failAck-- > 0) throw Error('synthetic lost receipt');
    acknowledgements.push(request.id);
    queue.shift();
    return { protocol: 1, acknowledged: true };
  };
  return { queue, calls, inbox, acknowledgements, rpc, prompt,
    hook: () => plugin.createMailHook({ prompt, rpc }),
    failAdmission: () => { failAdmission = 1; },
    failAck: () => { failAck = 1; },
    corruptAdmission: () => { corruptAdmission = true; },
  };
}

test('tool boundary admits the selected batch and then acknowledges its stable identity', async () => {
  const f = fixture();
  await f.hook()(event);
  assert.equal(f.inbox.size, 1);
  assert.deepEqual(f.acknowledgements, ['msg_orgtree1']);
  assert.deepEqual(f.calls[0], { ...batch(1), delivery: 'steer', resume: false });
});

test('failed tool results are also safe delivery boundaries', async () => {
  const f = fixture();
  await f.hook()({ ...event, status: 'error' });
  assert.equal(f.inbox.size, 1);
});

test('a nonterminal tool event cannot claim mail', async () => {
  let claims = 0;
  await plugin.createMailHook({ prompt: async () => assert.fail('unexpected prompt'),
    rpc: async () => { claims++; return {}; } })({ ...event, status: 'running' });
  assert.equal(claims, 0);
});

test('an empty claim (including DND-held mail) does not create provider input', async () => {
  const f = fixture([]);
  await f.hook()(event);
  assert.equal(f.inbox.size, 0);
  assert.deepEqual(f.acknowledgements, []);
});

test('batches arrive in engine order over consecutive boundaries', async () => {
  const f = fixture([batch(1), batch(2), batch(3)]);
  const hook = f.hook();
  for (let i = 0; i < 3; i++) await hook(event);
  assert.deepEqual([...f.inbox.keys()], ['msg_orgtree1', 'msg_orgtree2', 'msg_orgtree3']);
});

test('parallel tool completions coalesce into one claim and one admission', async () => {
  const f = fixture([batch(1), batch(2)]);
  const hook = f.hook();
  await Promise.all(Array.from({ length: 64 }, () => hook(event)));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.acknowledgements, ['msg_orgtree1']);
  await hook(event);
  assert.deepEqual(f.acknowledgements, ['msg_orgtree1', 'msg_orgtree2']);
});

test('admission failure never acknowledges and a later boundary retries the same ID', async () => {
  const f = fixture();
  const hook = f.hook();
  f.failAdmission();
  await hook(event);
  assert.equal(f.queue.length, 1);
  assert.equal(f.inbox.size, 0);
  await hook(event);
  assert.deepEqual(f.calls.map(x => x.id), ['msg_orgtree1', 'msg_orgtree1']);
  assert.equal(f.inbox.size, 1);
});

test('a lost engine acknowledgement retries idempotently before newer mail', async () => {
  const f = fixture([batch(1), batch(2)]);
  const hook = f.hook();
  f.failAck();
  await hook(event);
  assert.equal(f.inbox.size, 1);
  assert.equal(f.queue.length, 2);
  await hook(event);
  assert.deepEqual(f.calls.map(x => x.id), ['msg_orgtree1', 'msg_orgtree1']);
  assert.equal(f.inbox.size, 1);
  await hook(event);
  assert.deepEqual(f.acknowledgements, ['msg_orgtree1', 'msg_orgtree2']);
});

test('a fresh plugin instance retries the durable outstanding batch without another insertion', async () => {
  const f = fixture();
  f.failAck();
  await f.hook()(event);
  assert.equal(f.inbox.size, 1);
  await f.hook()(event);
  assert.equal(f.calls.length, 2);
  assert.equal(f.inbox.size, 1);
  assert.deepEqual(f.acknowledgements, ['msg_orgtree1']);
});

test('an admission response for a different ID is not acknowledged', async () => {
  const f = fixture();
  f.corruptAdmission();
  await f.hook()(event);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.acknowledgements, []);
});

for (const [name, reply] of [
  ['different session', { protocol: 1, batch: { ...batch(1), sessionID: 'ses_other' } }],
  ['unsupported contract', { protocol: 2, batch: batch(1) }],
  ['missing ID', { protocol: 1, batch: { ...batch(1), id: '' } }],
  ['oversized text', { protocol: 1, batch: batch(1, 'x'.repeat(128_001)) }],
  ['nontext body', { protocol: 1, batch: { ...batch(1), text: {} } }],
]) {
  test(`rejects ${name} without admission or acknowledgement`, async () => {
    const calls = [];
    await plugin.createMailHook({ prompt: async () => assert.fail('unexpected admission'),
      rpc: async request => { calls.push(request.op); return reply; } })(event);
    assert.deepEqual(calls, ['claim']);
  });
}

test('bridge failure leaves mail with the engine and never leaks error text', async () => {
  let attempts = 0;
  const hook = plugin.createMailHook({
    prompt: async () => assert.fail('unexpected admission'),
    rpc: async () => { attempts++; throw Error('PRIVATE_SYNTHETIC_MAIL'); },
  });
  await hook(event);
  await hook(event);
  assert.equal(attempts, 2);
});

test('a stalled admission cannot hold the tool hook forever or acknowledge an unknown outcome', async () => {
  const f = fixture();
  const hook = plugin.createMailHook({ rpc: f.rpc, prompt: () => new Promise(() => {}),
    admissionTimeoutMs: 20 });
  await hook(event);
  assert.equal(f.queue.length, 1);
  assert.deepEqual(f.acknowledgements, []);
  // A new hook can retry because custody never moved out of the engine.
  await f.hook()(event);
  assert.equal(f.inbox.size, 1);
});

async function pipeServer(t, respond) {
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\orgtree-mail-test-${randomUUID()}`
    : join(tmpdir(), `orgtree-mail-test-${randomUUID()}.sock`);
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', data => respond(socket, data));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return endpoint;
}

test('private pipe transport sends one bounded JSON line and accepts fragmented response', async t => {
  let request;
  const endpoint = await pipeServer(t, (socket, data) => {
    request = JSON.parse(data.toString());
    socket.write('{"protocol":1,');
    socket.end('"batch":null}\n');
  });
  const response = await plugin.pipeRequest(endpoint, { protocol: 1, op: 'claim', sessionID: 'ses_fixture' });
  assert.deepEqual(response, { protocol: 1, batch: null });
  assert.equal(request.op, 'claim');
});

test('private pipe transport refuses oversized frames', async t => {
  const endpoint = await pipeServer(t, socket => socket.end('x'.repeat(262_145)));
  await assert.rejects(plugin.pipeRequest(endpoint, { protocol: 1, op: 'claim' }));
});

test('private pipe transport bounds an unresponsive bridge and closes its connection', async t => {
  const endpoint = await pipeServer(t, () => {});
  await assert.rejects(plugin.pipeRequest(endpoint, { protocol: 1, op: 'claim' }, 50));
});

test('private pipe transport rejects malformed JSON', async t => {
  const endpoint = await pipeServer(t, socket => socket.end('not-json\n'));
  await assert.rejects(plugin.pipeRequest(endpoint, { protocol: 1, op: 'claim' }));
});

test('plugin setup registers only its tool-after hook and requires bridge readiness', async t => {
  const f = fixture();
  const requests = [];
  const endpoint = await pipeServer(t, (socket, data) => {
    const request = JSON.parse(data.toString());
    requests.push(request);
    void (async () => {
      const response = request.op === 'ready' ? { protocol: 1, ready: true } : await f.rpc(request);
      socket.end(`${JSON.stringify(response)}\n`);
    })();
  });
  const previous = process.env.ORGTREE_OPENCODE_MAIL_PIPE;
  t.after(() => {
    if (previous === undefined) delete process.env.ORGTREE_OPENCODE_MAIL_PIPE;
    else process.env.ORGTREE_OPENCODE_MAIL_PIPE = previous;
  });
  process.env.ORGTREE_OPENCODE_MAIL_PIPE = endpoint;
  const hooks = new Map();
  await plugin.default.setup({ tool: { hook: (name, fn) => hooks.set(name, fn) }, session: { prompt: f.prompt } });
  assert.deepEqual([...hooks.keys()], ['execute.after']);
  await hooks.get('execute.after')(event);
  assert.deepEqual(requests.map(r => r.op), ['ready', 'claim', 'ack']);
  assert.equal(f.inbox.size, 1);
});

test('unsupported bridge handshake leaves its registered hook inert', async t => {
  let requests = 0, hook;
  const endpoint = await pipeServer(t, socket => {
    requests++;
    socket.end('{"protocol":2,"ready":true}\n');
  });
  const previous = process.env.ORGTREE_OPENCODE_MAIL_PIPE;
  t.after(() => {
    if (previous === undefined) delete process.env.ORGTREE_OPENCODE_MAIL_PIPE;
    else process.env.ORGTREE_OPENCODE_MAIL_PIPE = previous;
  });
  process.env.ORGTREE_OPENCODE_MAIL_PIPE = endpoint;
  await plugin.default.setup({ tool: { hook: (_name, fn) => { hook = fn; } },
    session: { prompt: async () => assert.fail('unsupported bridge admitted mail') } });
  await hook(event);
  assert.equal(requests, 1);
});

test('missing OpenCode plugin APIs fall back without throwing or registering hooks', async () => {
  await plugin.default.setup({});
  await plugin.default.setup({ tool: {}, session: {} });
});
