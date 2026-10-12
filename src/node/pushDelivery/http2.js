import { connect } from 'node:http2';

/** APNs requires HTTP/2. Node's default fetch uses HTTP/1 and cannot deliver a wake. */
export async function nodeAPNsRequest(address, options, createSession = connect) {
  const url = new URL(address);
  if (url.protocol !== 'https:' || !['api.push.apple.com', 'api.sandbox.push.apple.com'].includes(url.hostname)
    || url.port || !url.pathname.startsWith('/3/device/')) throw new Error('Invalid APNs destination.');
  return new Promise((resolve, reject) => {
    const session = createSession(url.origin);
    let stream;
    let settled = false;
    let status = 0;
    let bytes = 0;
    const chunks = [];
    const deadline = setTimeout(() => finish(new Error('APNs request timed out.')), 8_000);
    deadline.unref();
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        stream?.close();
        session.destroy();
        reject(error);
      } else {
        session.close();
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(body) });
      }
    }
    session.once('error', () => finish(new Error('APNs secure connection failed.')));
    try {
      stream = session.request({ ...options.headers, ':method': options.method ?? 'POST',
        ':path': url.pathname });
      stream.on('response', headers => { status = Number(headers[':status']); });
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 4_096) finish(new Error('APNs response exceeded the limit.'));
        else chunks.push(chunk);
      });
      stream.on('error', () => finish(new Error('APNs request failed.')));
      stream.on('end', () => {
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          finish(new Error('APNs returned an invalid response.'));
        } else finish();
      });
      stream.end(options.body);
    } catch { finish(new Error('APNs request could not be started.')); }
  });
}
