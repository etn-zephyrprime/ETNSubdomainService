// Which resolved IP addresses App Check's fetcher may connect to: public unicast only. Everything internal
// or special is refused — loopback, RFC1918 private, link-local (incl. the cloud metadata address
// 169.254.169.254), CGNAT, multicast, reserved/documentation/benchmark ranges, and the IPv6 equivalents.
// IPv6 forms that embed an IPv4 address (IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, NAT64
// 64:ff9b::/96, 6to4 2002::/16, Teredo 2001::/32) are refused outright rather than unpacked.
import net from "net";

const V4_BLOCKED = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

const toV4Int = (ip) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);

function v4Blocked(ip) {
  const n = toV4Int(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = toV4Int(base);
    return n >= start && n < start + size;
  });
}

/** An IPv6 address as 8 numbers (handles :: and a trailing dotted IPv4 part), or null. */
export function expandV6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = toV4Int(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  if (s.split("::").length > 2) return null;
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : null;
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function v6Blocked(ip) {
  const g = expandV6(ip);
  if (!g) return true;
  const zeroPrefix = (n) => g.slice(0, n).every((x) => x === 0);
  if (zeroPrefix(8)) return true; // ::
  if (zeroPrefix(7) && g[7] === 1) return true; // ::1
  if (zeroPrefix(5) && g[5] === 0xffff) return true; // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeroPrefix(6)) return true; // ::a.b.c.d (IPv4-compatible, deprecated)
  if (zeroPrefix(4) && g[4] === 0xffff && g[5] === 0) return true; // ::ffff:0:a.b.c.d (SIIT)
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard 100::/64
  if (g[0] === 0x2001 && g[1] < 0x200) return true; // 2001::/23 IETF protocol (incl. Teredo 2001::/32)
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x2002) return true; // 6to4 (embeds IPv4)
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // documentation 3fff::/20
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if ((g[0] & 0xe000) !== 0x2000) return true; // only global unicast 2000::/3 is allowed
  return false;
}

/** True only for a public unicast IP address. Anything unparseable is refused. */
export function isPublicAddress(ip) {
  const kind = net.isIP(String(ip || "").replace(/^\[|\]$/g, "").split("%")[0]);
  if (kind === 4) return !v4Blocked(ip);
  if (kind === 6) return !v6Blocked(ip);
  return false;
}
