import { Packr } from 'msgpackr';
import type { ClientMsg, ServerMsg } from './messages';

// Plain maps, no record extension: keeps the format simple to debug and stable across peers.
const packr = new Packr({ useRecords: false, moreTypes: false });

export function encode(msg: ClientMsg | ServerMsg): Uint8Array {
  return packr.pack(msg);
}

export function decode<T extends ClientMsg | ServerMsg>(data: Uint8Array | ArrayBuffer): T {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  return packr.unpack(bytes) as T;
}

/** msgpack returns Buffer in Node; normalise byte layers to plain Uint8Array. */
export function toU8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v);
  throw new Error('Expected byte array');
}
