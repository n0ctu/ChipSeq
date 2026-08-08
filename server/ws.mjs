// A WebSocket server in enough of RFC 6455 to run the badge protocol.
//
// Node ships a WebSocket CLIENT but no server, and this project takes no
// dependencies - so the handshake and framing live here. That is about 150
// lines, which is a fair price for keeping `npm install` out of a repository
// whose whole point is that it has no build step.
//
// Deliberately partial: text and binary data frames, ping, pong, close. No
// extensions, no permessage-deflate, no compression negotiation. The badge
// protocol sends small JSON frames, so none of that would earn its keep.

import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

// Frame a payload for sending. A server MUST NOT mask (RFC 6455 §5.1), which
// is the one asymmetry with the client side.
export function encodeFrame(payload, opcode = OP.TEXT) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // Node buffers cannot exceed 2^32 anyway; the high word is always zero.
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, body]);
}

// Pull whole frames out of an accumulating buffer.
//
// TCP gives no message boundaries: one read can hold three frames, or half of
// one. Returning the leftover rather than assuming a clean cut is the
// difference between working on a LAN and failing under a relay that splits
// packets differently.
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;

    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      const high = buf.readUInt32BE(p);
      if (high !== 0) throw new Error('frame too large');
      len = buf.readUInt32BE(p + 4);
      p += 8;
    }

    let mask = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) break; // partial frame: wait for more

    const payload = Buffer.from(buf.subarray(p, p + len));
    // Clients MUST mask; unmasking is a 4-byte rotating XOR.
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

// One connection. Minimal surface on purpose: send/close plus three handlers.
export class WsConnection {
  constructor(socket, { onMessage, onClose } = {}) {
    this.socket = socket;
    this.onMessage = onMessage || (() => {});
    this.onClose = onClose || (() => {});
    this.open = true;
    this.id = randomBytes(8).toString('hex');
    this.remote = socket.remoteAddress || 'unknown';

    let buffered = Buffer.alloc(0);
    // A message split across continuation frames is reassembled here.
    let partial = null;

    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      let out;
      try {
        out = decodeFrames(buffered);
      } catch {
        this.close(1009, 'frame too large');
        return;
      }
      buffered = out.rest;
      for (const frame of out.frames) this.handleFrame(frame, (v) => { partial = v; }, () => partial);
    });

    const done = () => {
      if (!this.open) return;
      this.open = false;
      this.onClose();
    };
    socket.on('close', done);
    socket.on('error', done);
    socket.on('end', done);
  }

  handleFrame(frame, setPartial, getPartial) {
    const { fin, opcode, payload } = frame;
    if (opcode === OP.CLOSE) {
      this.close(1000, '');
      return;
    }
    if (opcode === OP.PING) {
      this.raw(encodeFrame(payload, OP.PONG));
      return;
    }
    if (opcode === OP.PONG) return;

    if (opcode === OP.CONT) {
      const prev = getPartial();
      if (!prev) return; // continuation with nothing to continue: ignore
      const joined = { opcode: prev.opcode, payload: Buffer.concat([prev.payload, payload]) };
      if (!fin) { setPartial(joined); return; }
      setPartial(null);
      this.deliver(joined.opcode, joined.payload);
      return;
    }
    if (!fin) {
      setPartial({ opcode, payload });
      return;
    }
    this.deliver(opcode, payload);
  }

  deliver(opcode, payload) {
    if (opcode !== OP.TEXT && opcode !== OP.BIN) return;
    this.onMessage(payload.toString('utf8'));
  }

  raw(buf) {
    if (this.open && !this.socket.destroyed) this.socket.write(buf);
  }

  send(text) {
    this.raw(encodeFrame(text, OP.TEXT));
  }

  // Convenience: everything on this protocol is a JSON object.
  sendJson(obj) {
    this.send(JSON.stringify(obj));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    this.open = false;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.raw(encodeFrame(body, OP.CLOSE));
      this.socket.end();
    } catch {
      /* already gone */
    }
    this.onClose();
  }
}

// Attach to an http.Server's 'upgrade' event.
export function attachWebSocket(httpServer, { path = '/ws', onConnection }) {
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const url = (req.url || '').split('?')[0];
    if (url !== path || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '', '',
    ].join('\r\n'));
    socket.setNoDelay(true); // this is a timing-sensitive protocol; do not wait to batch
    onConnection(new WsConnection(socket), req);
  });
}
