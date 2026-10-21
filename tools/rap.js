// Parser for Bohemia rapified configs (config.bin, rvmat) into plain nested objects.
function parseRap(buf) {
  if (buf.toString('latin1', 0, 4) !== '\0raP') throw new Error('not a rapified config');
  let pos;
  const str = () => { const end = buf.indexOf(0, pos); const s = buf.toString('utf8', pos, end); pos = end + 1; return s; };
  const cint = () => { let v = 0, shift = 0, b; do { b = buf[pos++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); return v; };
  const array = () => {
    const out = [];
    for (let n = cint(); n--;) {
      const t = buf[pos++];
      if (t === 0 || t === 4) out.push(str());
      else if (t === 1) { out.push(buf.readFloatLE(pos)); pos += 4; }
      else if (t === 2) { out.push(buf.readInt32LE(pos)); pos += 4; }
      else if (t === 3) out.push(array());
      else throw new Error(`array item type ${t}`);
    }
    return out;
  };
  const body = offset => {
    const saved = pos; pos = offset;
    const node = {};
    str(); // parent class name
    for (let n = cint(); n--;) {
      const t = buf[pos++];
      if (t === 0) { const name = str(); const off = buf.readUInt32LE(pos); pos += 4; node[name] = body(off); }
      else if (t === 1) {
        const sub = buf[pos++], name = str();
        if (sub === 0 || sub === 4) node[name] = str();
        else if (sub === 1) { node[name] = buf.readFloatLE(pos); pos += 4; }
        else { node[name] = buf.readInt32LE(pos); pos += 4; }
      } else if (t === 2) { const name = str(); node[name] = array(); }
      else if (t === 3 || t === 4) str();
      else if (t === 5) { pos += 4; const name = str(); node[name] = array(); }
      else throw new Error(`entry type ${t}`);
    }
    pos = saved;
    return node;
  };
  return body(16);
}
module.exports = { parseRap };
