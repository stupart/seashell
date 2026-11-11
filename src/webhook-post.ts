import { lookup } from 'dns';
import { request as httpRequest, type IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import { isIP, type LookupFunction } from 'net';

/**
 * Where an automation may post a meeting, and the post itself. A webhook goes
 * to the address written in the automation's file and nowhere else: https
 * only, never on to a redirect, and never to this Mac or the local network
 * unless the file names that address itself (http://localhost:8080/…,
 * https://192.168.1.20/…). The address is checked as it is connected to, so a
 * name that resolves to a public server once and a private one later is
 * still refused.
 */

export type ResolvedAddress = { address: string; family: number };
export type HostLookup = (hostname: string) => Promise<ResolvedAddress[]>;

const LOCALHOST = /^localhost\.?$/iu;

/** The URL's host without IPv6 brackets. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/gu, '');
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((total, part) => total * 256 + Number(part), 0);
}

const IPV4_NOT_PUBLIC: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function publicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  return !IPV4_NOT_PUBLIC.some(([network, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(ipv4Number(network) / 2 ** (32 - bits)));
}

/** The eight 16-bit groups of an IPv6 address, including one ending in dotted IPv4. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase().replace(/%.*$/u, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text)?.[1];
  if (dotted) {
    const value = ipv4Number(dotted);
    text = `${text.slice(0, -dotted.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...new Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.map((group) => Number.parseInt(group, 16));
}

function publicIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  const [first = 0] = groups;
  const embedded = () => `${groups[6]! >>> 8}.${groups[6]! & 0xff}.${groups[7]! >>> 8}.${groups[7]! & 0xff}`;
  // ::ffff:a.b.c.d and 64:ff9b::a.b.c.d reach an IPv4 address: judge that address.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return publicIpv4(embedded());
  if (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return publicIpv4(embedded());
  if (first === 0x2002) return publicIpv4(`${groups[1]! >>> 8}.${groups[1]! & 0xff}.${groups[2]! >>> 8}.${groups[2]! & 0xff}`);
  if (groups.slice(0, 7).every((group) => group === 0)) return false; // :: and ::1
  if (first === 0x100 && groups.slice(1, 4).every((group) => group === 0)) return false; // discard
  if (first === 0x2001 && groups[1] === 0xdb8) return false; // documentation
  return (first & 0xfe00) !== 0xfc00 // unique local
    && (first & 0xffc0) !== 0xfe80 // link-local
    && (first & 0xffc0) !== 0xfec0 // site-local
    && (first & 0xff00) !== 0xff00; // multicast
}

/** A public internet address: not this Mac, the local network, or a reserved range. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address.replace(/%.*$/u, ''));
  return family === 4 ? publicIpv4(address) : family === 6 ? publicIpv6(address) : false;
}

/** The file names this Mac or a local address itself, rather than a name that resolves to one. */
function explicitlyLocal(url: URL): boolean {
  const host = hostOf(url);
  return LOCALHOST.test(host) || (isIP(host) !== 0 && !isPublicAddress(host));
}

function loopback(host: string): boolean {
  return LOCALHOST.test(host) || (isIP(host) === 4 && host.startsWith('127.')) || (isIP(host) === 6 && ipv6Groups(host).join(':') === '0:0:0:0:0:0:0:1');
}

/** Why a webhook address cannot be used, or undefined. Plain http only reaches this Mac, named as such. */
export function webhookAddressProblem(url: URL): string | undefined {
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && loopback(hostOf(url))) return undefined;
  return url.protocol === 'http:'
    ? 'webhooks must be https addresses (plain http only for localhost or 127.0.0.1)'
    : 'webhooks must be https addresses';
}

const resolveAll: HostLookup = (hostname) => new Promise((resolvePromise, reject) => {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => error ? reject(error) : resolvePromise(addresses));
});

/** Resolve the host when connecting, and refuse it if any address it gives is not public. */
function guardedLookup(url: URL, resolveHost: HostLookup): LookupFunction {
  const local = explicitlyLocal(url);
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolveHost(hostname).then((addresses) => {
      const refused = local ? undefined : addresses.find((entry) => !isPublicAddress(entry.address));
      if (refused || !addresses.length) {
        callback(new Error(refused
          ? `${hostname} is on this Mac or the local network (${refused.address}). Write that address in the automation to send there.`
          : `${hostname} has no address`));
      } else if (options?.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    }, (error: Error) => callback(error));
  }) as unknown as LookupFunction;
}

/**
 * POST one body and read only the status. Redirects are answers, never
 * followed, and the reply's body is never read. The shape of fetch, so tests
 * can stand in for it.
 */
export function postWebhook(resolveHost: HostLookup = resolveAll): typeof fetch {
  return (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const problem = webhookAddressProblem(url);
    if (problem) throw new Error(problem);
    const body = typeof init.body === 'string' ? init.body : '';
    const headers = { ...Object.fromEntries(new Headers(init.headers).entries()), 'content-length': String(Buffer.byteLength(body)) };
    return await new Promise<Response>((resolvePromise, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: init.method ?? 'POST', headers, lookup: guardedLookup(url, resolveHost),
      }, (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        if (status < 200 || status > 599) reject(new Error(`the server answered ${status}`));
        else resolvePromise(new Response(null, { status }));
      });
      const stop = () => request.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new Error('The operation was aborted.'));
      if (init.signal?.aborted) stop();
      init.signal?.addEventListener('abort', stop, { once: true });
      request.once('close', () => init.signal?.removeEventListener('abort', stop));
      request.once('error', reject);
      request.end(body);
    });
  }) as typeof fetch;
}
