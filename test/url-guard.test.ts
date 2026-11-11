import { describe, expect, it, vi } from 'vitest';
import {
  createTargetResolver,
  isPrivateAddress,
  resolvePublicAddresses,
  UnsafeUrlError,
  type HostResolver,
} from '../src/delivery/url-guard.js';

const resolverFor =
  (...addresses: string[]): HostResolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

const failing: HostResolver = async () => {
  throw new Error('ENOTFOUND');
};

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '104.20.23.154', '2606:4700::1'])(
    'allows %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('resolvePublicAddresses', () => {
  it('returns the resolved public addresses', async () => {
    await expect(
      resolvePublicAddresses('https://hooks.example.com/x', resolverFor('93.184.215.14')),
    ).resolves.toEqual([{ address: '93.184.215.14', family: 4 }]);
  });

  it('rejects hosts that resolve to a private address', async () => {
    await expect(
      resolvePublicAddresses('https://internal.example.com', resolverFor('10.0.0.7')),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects when any of the resolved addresses is private', async () => {
    await expect(
      resolvePublicAddresses('https://mixed.example.com', resolverFor('8.8.8.8', '127.0.0.1')),
    ).rejects.toThrow(/private or reserved/);
  });

  it('checks IP literals without DNS', async () => {
    const resolver = vi.fn<HostResolver>();
    await expect(resolvePublicAddresses('http://127.0.0.1:8080/', resolver)).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(resolvePublicAddresses('http://[::1]/', resolver)).rejects.toThrow(UnsafeUrlError);
    await expect(resolvePublicAddresses('http://0x7f.1/', resolver)).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(resolvePublicAddresses('http://8.8.8.8/', resolver)).resolves.toHaveLength(1);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects hosts that cannot be resolved', async () => {
    await expect(resolvePublicAddresses('https://nope.invalid', failing)).rejects.toThrow(
      /could not be resolved/,
    );
    await expect(resolvePublicAddresses('https://empty.example', async () => [])).rejects.toThrow(
      /could not be resolved/,
    );
  });
});

describe('createTargetResolver', () => {
  it('skips the check when private URLs are allowed', async () => {
    const resolver = vi.fn<HostResolver>();
    const resolve = createTargetResolver({ allowPrivate: true, resolver });
    await expect(resolve('http://localhost:4000/hook')).resolves.toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('enforces the check when private URLs are not allowed', async () => {
    const resolve = createTargetResolver({
      allowPrivate: false,
      resolver: resolverFor('127.0.0.1'),
    });
    await expect(resolve('http://localhost:4000/hook')).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
