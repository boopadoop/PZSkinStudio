// Writes binary FBX files (version 7400), for the preview copies and the test models.
export const utf8 = (text) => Buffer.from(text, 'latin1');
export const int32 = (value) => { const b = Buffer.alloc(5); b[0] = 0x49; b.writeInt32LE(value, 1); return b; };
export const int64 = (value) => { const b = Buffer.alloc(9); b[0] = 0x4c; b.writeBigInt64LE(BigInt(value), 1); return b; };
export const double = (value) => { const b = Buffer.alloc(9); b[0] = 0x44; b.writeDoubleLE(value, 1); return b; };
export const string = (text) => {
  const body = utf8(text);
  const b = Buffer.alloc(5);
  b[0] = 0x53;
  b.writeUInt32LE(body.length, 1);
  return Buffer.concat([b, body]);
};
function array(kind, values, size, write) {
  const head = Buffer.alloc(13);
  head[0] = kind.charCodeAt(0);
  head.writeUInt32LE(values.length, 1);
  head.writeUInt32LE(0, 5);
  head.writeUInt32LE(values.length * size, 9);
  const body = Buffer.alloc(values.length * size);
  values.forEach((value, i) => write.call(body, value, i * size));
  return Buffer.concat([head, body]);
}
export const doubles = (values) => array('d', values, 8, Buffer.prototype.writeDoubleLE);
export const ints = (values) => array('i', values, 4, Buffer.prototype.writeInt32LE);

const NULL_RECORD = Buffer.alloc(13);

export function node(name, props = [], children = []) {
  return { name, props, children };
}

export function encode(item, offset) {
  const props = Buffer.concat(item.props);
  const head = 13 + item.name.length;
  let at = offset + head + props.length;
  const parts = [];
  for (const childNode of item.children) {
    const bytes = encode(childNode, at);
    parts.push(bytes);
    at += bytes.length;
  }
  if (item.children.length) {
    parts.push(NULL_RECORD);
    at += NULL_RECORD.length;
  }
  const record = Buffer.alloc(head);
  record.writeUInt32LE(at, 0);
  record.writeUInt32LE(item.props.length, 4);
  record.writeUInt32LE(props.length, 8);
  record[12] = item.name.length;
  record.write(item.name, 13, 'latin1');
  return Buffer.concat([record, props, ...parts]);
}


// A whole file from its top-level nodes.
export function fbxFile(top) {
  const header = Buffer.alloc(27);
  header.write('Kaydara FBX Binary  \0\x1a\0', 0, 'latin1');
  header.writeUInt32LE(7400, 23);
  let offset = 27;
  const parts = [header];
  for (const item of top) {
    const bytes = encode(item, offset);
    parts.push(bytes);
    offset += bytes.length;
  }
  parts.push(NULL_RECORD);
  return Buffer.concat(parts);
}
