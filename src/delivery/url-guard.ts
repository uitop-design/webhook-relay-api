import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const IPV4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const IPV6_BLOCKED: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

const ipv4BlockList = new BlockList();
for (const [network, prefix] of IPV4_BLOCKED) ipv4BlockList.addSubnet(network, prefix, 'ipv4');

const ipv6BlockList = new BlockList();
for (const [network, prefix] of IPV6_BLOCKED) ipv6BlockList.addSubnet(network, prefix, 'ipv6');

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export type HostResolver = (hostname: string) => Promise<LookupAddress[]>;

export const systemResolver: HostResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return true;
  }
  return family === 4 ? ipv4BlockList.check(address, 'ipv4') : ipv6BlockList.check(address, 'ipv6');
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

export async function resolvePublicAddresses(
  rawUrl: string,
  resolver: HostResolver = systemResolver,
): Promise<LookupAddress[]> {
  const url = new URL(rawUrl);
  const hostname = hostnameOf(url);
  const family = isIP(hostname);

  let addresses: LookupAddress[];
  if (family !== 0) {
    addresses = [{ address: hostname, family }];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch {
      throw new UnsafeUrlError(`Host ${hostname} could not be resolved`);
    }
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Host ${hostname} could not be resolved`);
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new UnsafeUrlError(`Host ${hostname} resolves to a private or reserved address`);
  }
  return addresses;
}

export interface UrlPolicy {
  allowPrivate: boolean;
  resolver?: HostResolver;
}

export function createTargetResolver(policy: UrlPolicy) {
  return async (rawUrl: string): Promise<LookupAddress[] | undefined> =>
    policy.allowPrivate ? undefined : resolvePublicAddresses(rawUrl, policy.resolver);
}

export type TargetResolver = ReturnType<typeof createTargetResolver>;
