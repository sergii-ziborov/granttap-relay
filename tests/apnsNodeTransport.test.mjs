import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';

// The production adapter must speak real HTTP/2; an intercepted fetch is not proof.
test('Node APNs transport posts an HTTP/2 stream and preserves Apple status', async () => {
  const { nodeAPNsRequest } = await import('../src/node/pushDelivery/http2.js');
  const server = http2.createServer();
  const observed = [];
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', chunk => { body += chunk; });
    stream.on('end', () => {
      observed.push({ method: headers[':method'], path: headers[':path'],
        topic: headers['apns-topic'], body });
      stream.respond({ ':status': 410, 'content-type': 'application/json' });
      stream.end('{"reason":"Unregistered"}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await nodeAPNsRequest('https://api.push.apple.com/3/device/test', {
      method: 'POST', headers: { 'apns-topic': 'com.ziborov.granttap' }, body: '{"granttapWake":true}',
    }, () => http2.connect(origin));
    assert.equal(response.status, 410);
    assert.equal(response.ok, false);
    assert.deepEqual(await response.json(), { reason: 'Unregistered' });
    assert.deepEqual(observed, [{ method: 'POST', path: '/3/device/test',
      topic: 'com.ziborov.granttap', body: '{"granttapWake":true}' }]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Node APNs transport rejects an unexpected destination before connecting', async () => {
  const { nodeAPNsRequest } = await import('../src/node/pushDelivery/http2.js');
  let contacted = false;
  await assert.rejects(nodeAPNsRequest('https://example.org/3/device/test', { body: '{}' },
    () => { contacted = true; }), /APNs destination/);
  assert.equal(contacted, false);
});
