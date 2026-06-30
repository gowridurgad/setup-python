import * as io from '@actions/io';
import os from 'os';
import fs from 'fs';
import path from 'path';

const toolDir = path.join(
  __dirname,
  'runner',
  path.join(Math.random().toString(36).substring(7)),
  'tools'
);
const tempDir = path.join(
  __dirname,
  'runner',
  path.join(Math.random().toString(36).substring(7)),
  'temp'
);

process.env['RUNNER_TOOL_CACHE'] = toolDir;
process.env['RUNNER_TEMP'] = tempDir;

// Suppress the OS-isolated tool-cache suffix (see issue #1087) so that the
// existing tests, which write fixtures to `Python/<version>/<arch>`,
// continue to be found by `tc.find` on Linux test runners. The dedicated
// tests below override these mocks to verify the suffix behavior.
jest.mock('../src/utils', () => {
  const actual = jest.requireActual('../src/utils');
  return {
    ...actual,
    getLinuxToolCacheSuffix: jest.fn().mockResolvedValue(''),
    getLinuxToolCacheSuffixFromUrl: jest.fn().mockReturnValue('')
  };
});

import * as tc from '@actions/tool-cache';
import * as core from '@actions/core';
import * as finder from '../src/find-python';
import * as installer from '../src/install-python';
import * as utils from '../src/utils';

import manifestData from './data/versions-manifest.json';

describe('Finder tests', () => {
  let writeSpy: jest.SpyInstance;
  let spyCoreAddPath: jest.SpyInstance;
  let spyCoreExportVariable: jest.SpyInstance;
  const env = process.env;

  beforeEach(() => {
    writeSpy = jest.spyOn(process.stdout, 'write');
    writeSpy.mockImplementation(() => {});
    jest.resetModules();
    process.env = {...env};
    spyCoreAddPath = jest.spyOn(core, 'addPath');
    spyCoreExportVariable = jest.spyOn(core, 'exportVariable');
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.clearAllMocks();
    jest.restoreAllMocks();
    process.env = env;
  });

  it('Finds Python if it is installed', async () => {
    const getBooleanInputSpy = jest.spyOn(core, 'getBooleanInput');
    getBooleanInputSpy.mockImplementation(input => false);

    const pythonDir: string = path.join(toolDir, 'Python', '3.0.0', 'x64');
    await io.mkdirP(pythonDir);
    fs.writeFileSync(`${pythonDir}.complete`, 'hello');
    // This will throw if it doesn't find it in the cache and in the manifest (because no such version exists)
    await finder.useCpythonVersion('3.x', 'x64', true, false, false, false);
    expect(spyCoreAddPath).toHaveBeenCalled();
    expect(spyCoreExportVariable).toHaveBeenCalledWith(
      'pythonLocation',
      expect.anything()
    );
    expect(spyCoreExportVariable).toHaveBeenCalledWith(
      'PKG_CONFIG_PATH',
      expect.anything()
    );
  });

  it('Finds Python if it is installed without environment update', async () => {
    const pythonDir: string = path.join(toolDir, 'Python', '3.0.0', 'x64');
    await io.mkdirP(pythonDir);
    fs.writeFileSync(`${pythonDir}.complete`, 'hello');
    // This will throw if it doesn't find it in the cache and in the manifest (because no such version exists)
    await finder.useCpythonVersion('3.x', 'x64', false, false, false, false);
    expect(spyCoreAddPath).not.toHaveBeenCalled();
    expect(spyCoreExportVariable).not.toHaveBeenCalled();
  });

  it('Finds stable Python version if it is not installed, but exists in the manifest', async () => {
    const findSpy: jest.SpyInstance = jest.spyOn(tc, 'getManifestFromRepo');
    findSpy.mockImplementation(() => <tc.IToolRelease[]>manifestData);

    const getBooleanInputSpy = jest.spyOn(core, 'getBooleanInput');
    getBooleanInputSpy.mockImplementation(input => false);

    const installSpy: jest.SpyInstance = jest.spyOn(
      installer,
      'installCpythonFromRelease'
    );
    installSpy.mockImplementation(async () => {
      const pythonDir: string = path.join(toolDir, 'Python', '1.2.3', 'x64');
      await io.mkdirP(pythonDir);
      fs.writeFileSync(`${pythonDir}.complete`, 'hello');
    });
    // This will throw if it doesn't find it in the cache and in the manifest (because no such version exists)
    await expect(
      finder.useCpythonVersion('1.2.3', 'x64', true, false, false, false)
    ).resolves.toEqual({
      impl: 'CPython',
      version: '1.2.3'
    });
    expect(spyCoreAddPath).toHaveBeenCalled();
    expect(spyCoreExportVariable).toHaveBeenCalledWith(
      'pythonLocation',
      expect.anything()
    );
    expect(spyCoreExportVariable).toHaveBeenCalledWith(
      'PKG_CONFIG_PATH',
      expect.anything()
    );
  });

  it('Finds pre-release Python version in the manifest', async () => {
    const findSpy: jest.SpyInstance = jest.spyOn(tc, 'getManifestFromRepo');
    findSpy.mockImplementation(() => <tc.IToolRelease[]>manifestData);

    const getBooleanInputSpy = jest.spyOn(core, 'getBooleanInput');
    getBooleanInputSpy.mockImplementation(input => false);

    const installSpy: jest.SpyInstance = jest.spyOn(
      installer,
      'installCpythonFromRelease'
    );
    installSpy.mockImplementation(async () => {
      const pythonDir: string = path.join(
        toolDir,
        'Python',
        '1.2.4-beta.2',
        'x64'
      );
      await io.mkdirP(pythonDir);
      fs.writeFileSync(`${pythonDir}.complete`, 'hello');
    });
    // This will throw if it doesn't find it in the manifest (because no such version exists)
    await expect(
      finder.useCpythonVersion(
        '1.2.4-beta.2',
        'x64',
        false,
        false,
        false,
        false
      )
    ).resolves.toEqual({
      impl: 'CPython',
      version: '1.2.4-beta.2'
    });
  });

  it('Check-latest true, finds the latest version in the manifest', async () => {
    const findSpy: jest.SpyInstance = jest.spyOn(tc, 'getManifestFromRepo');
    findSpy.mockImplementation(() => <tc.IToolRelease[]>manifestData);

    const getBooleanInputSpy = jest.spyOn(core, 'getBooleanInput');
    getBooleanInputSpy.mockImplementation(input => true);

    const cnSpy: jest.SpyInstance = jest.spyOn(process.stdout, 'write');
    cnSpy.mockImplementation(line => {
      // uncomment to debug
      // process.stderr.write('write:' + line + '\n');
    });

    const addPathSpy: jest.SpyInstance = jest.spyOn(core, 'addPath');
    addPathSpy.mockImplementation(() => null);

    const infoSpy: jest.SpyInstance = jest.spyOn(core, 'info');
    infoSpy.mockImplementation(() => {});

    const debugSpy: jest.SpyInstance = jest.spyOn(core, 'debug');
    debugSpy.mockImplementation(() => {});

    const pythonDir: string = path.join(toolDir, 'Python', '1.2.2', 'x64');
    const expPath: string = path.join(toolDir, 'Python', '1.2.3', 'x64');

    const installSpy: jest.SpyInstance = jest.spyOn(
      installer,
      'installCpythonFromRelease'
    );
    installSpy.mockImplementation(async () => {
      await io.mkdirP(expPath);
      fs.writeFileSync(`${expPath}.complete`, 'hello');
    });

    const tcFindSpy: jest.SpyInstance = jest.spyOn(tc, 'find');
    tcFindSpy
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => expPath);

    await io.mkdirP(pythonDir);
    await io.rmRF(path.join(toolDir, 'Python', '1.2.3'));

    fs.writeFileSync(`${pythonDir}.complete`, 'hello');
    // This will throw if it doesn't find it in the cache and in the manifest (because no such version exists)
    await finder.useCpythonVersion('1.2', 'x64', true, true, false, false);

    expect(infoSpy).toHaveBeenCalledWith("Resolved as '1.2.3'");
    expect(infoSpy).toHaveBeenCalledWith(
      'Version 1.2.3 was not found in the local cache'
    );
    expect(infoSpy).toHaveBeenCalledWith(
      'Version 1.2.3 is available for downloading'
    );
    expect(installSpy).toHaveBeenCalled();
    expect(addPathSpy).toHaveBeenCalledWith(expPath);
    await finder.useCpythonVersion(
      '1.2.4-beta.2',
      'x64',
      false,
      true,
      false,
      false
    );
    expect(spyCoreAddPath).toHaveBeenCalled();
    expect(spyCoreExportVariable).toHaveBeenCalledWith(
      'pythonLocation',
      expect.anything()
    );
    expect(spyCoreExportVariable).toHaveBeenCalledWith(
      'PKG_CONFIG_PATH',
      expect.anything()
    );
  });

  it('Finds stable Python version if it is not installed, but exists in the manifest, skipping newer pre-release', async () => {
    const findSpy: jest.SpyInstance = jest.spyOn(tc, 'getManifestFromRepo');
    findSpy.mockImplementation(() => <tc.IToolRelease[]>manifestData);

    const installSpy: jest.SpyInstance = jest.spyOn(
      installer,
      'installCpythonFromRelease'
    );
    installSpy.mockImplementation(async () => {
      const pythonDir: string = path.join(toolDir, 'Python', '1.2.3', 'x64');
      await io.mkdirP(pythonDir);
      fs.writeFileSync(`${pythonDir}.complete`, 'hello');
    });
    // This will throw if it doesn't find it in the cache and in the manifest (because no such version exists)
    await expect(
      finder.useCpythonVersion('1.2', 'x64', false, false, false, false)
    ).resolves.toEqual({
      impl: 'CPython',
      version: '1.2.3'
    });
  });

  it('Finds Python version if it is not installed, but exists in the manifest, pre-release fallback', async () => {
    const findSpy: jest.SpyInstance = jest.spyOn(tc, 'getManifestFromRepo');
    findSpy.mockImplementation(() => <tc.IToolRelease[]>manifestData);

    const installSpy: jest.SpyInstance = jest.spyOn(
      installer,
      'installCpythonFromRelease'
    );
    installSpy.mockImplementation(async () => {
      const pythonDir: string = path.join(
        toolDir,
        'Python',
        '1.1.0-beta.2',
        'x64'
      );
      await io.mkdirP(pythonDir);
      fs.writeFileSync(`${pythonDir}.complete`, 'hello');
    });
    // This will throw if it doesn't find it in the cache and in the manifest (because no such version exists)
    await expect(
      finder.useCpythonVersion('1.1', 'x64', false, false, false, false)
    ).rejects.toThrow();
    await expect(
      finder.useCpythonVersion('1.1', 'x64', false, false, true, false)
    ).resolves.toEqual({
      impl: 'CPython',
      version: '1.1.0-beta.2'
    });
    // Check 1.1.0 version specifier does not fallback to '1.1.0-beta.2'
    await expect(
      finder.useCpythonVersion('1.1.0', 'x64', false, false, true, false)
    ).rejects.toThrow();
  });

  it('Errors if Python is not installed', async () => {
    // This will throw if it doesn't find it in the cache and in the manifest (because no such version exists)
    let thrown = false;
    try {
      await finder.useCpythonVersion(
        '3.300000',
        'x64',
        true,
        false,
        false,
        false
      );
    } catch {
      thrown = true;
    }
    expect(thrown).toBeTruthy();
    expect(spyCoreAddPath).not.toHaveBeenCalled();
    expect(spyCoreExportVariable).not.toHaveBeenCalled();
  });
});

// Dedicated tests for the OS-isolated tool-cache behavior introduced by
// https://github.com/actions/setup-python/issues/1087. They override the
// suppression of `getLinuxToolCacheSuffix`/`getLinuxToolCacheSuffixFromUrl`
// from the module-level `jest.mock` above to assert that the tool-cache
// architecture segment carries the Linux OS suffix and that installs only
// reuse caches keyed by the same arch.
//
// We encode the OS in the architecture segment (e.g. `x64-linux-24.04`)
// rather than the version segment because the version segment is matched
// by `tc.find` via semver semantics, and a suffix like `-linux-24.04`
// produces invalid semver (leading zero in `.04`). The arch segment is a
// free-form string so it sidesteps all that.
describe('OS-isolated tool-cache arch (issue #1087)', () => {
  const env = process.env;
  let writeSpy: jest.SpyInstance;
  let getSuffixSpy: jest.SpyInstance;
  let getSuffixFromUrlSpy: jest.SpyInstance;

  beforeEach(async () => {
    writeSpy = jest.spyOn(process.stdout, 'write');
    writeSpy.mockImplementation(() => {});
    process.env = {...env};
    // Wipe any tool-cache fixtures left by sibling tests in this file so
    // each case starts from a clean slate.
    await io.rmRF(path.join(toolDir, 'Python'));
    // Default these to non-Linux behavior so each test opts in explicitly.
    getSuffixSpy = jest
      .spyOn(utils, 'getLinuxToolCacheSuffix')
      .mockResolvedValue('');
    getSuffixFromUrlSpy = jest
      .spyOn(utils, 'getLinuxToolCacheSuffixFromUrl')
      .mockReturnValue('');
  });

  afterEach(async () => {
    jest.resetAllMocks();
    jest.clearAllMocks();
    jest.restoreAllMocks();
    process.env = env;
    await io.rmRF(path.join(toolDir, 'Python'));
  });

  it('decorates the tool-cache lookup arch with the Linux OS suffix', async () => {
    getSuffixSpy.mockResolvedValue('-linux-24.04');

    const tcFindSpy = jest.spyOn(tc, 'find').mockReturnValue('');
    // Stop after the lookup miss by skipping the manifest lookup.
    jest
      .spyOn(installer, 'findReleaseFromManifest')
      .mockResolvedValue(undefined);

    await expect(
      finder.useCpythonVersion('3.11', 'x64', false, false, false, false)
    ).rejects.toThrow();

    // First call: cache lookup keyed by plain semver + decorated arch.
    expect(tcFindSpy).toHaveBeenCalledWith('Python', '3.11', 'x64-linux-24.04');
  });

  it('finds Python in the OS-suffixed tool-cache directory on Linux', async () => {
    getSuffixSpy.mockResolvedValue('-linux-24.04');

    const pythonDir: string = path.join(
      toolDir,
      'Python',
      '3.0.0',
      'x64-linux-24.04'
    );
    await io.mkdirP(pythonDir);
    fs.writeFileSync(`${pythonDir}.complete`, 'hello');

    await expect(
      finder.useCpythonVersion('3.x', 'x64', false, false, false, false)
    ).resolves.toEqual({impl: 'CPython', version: '3.0.0'});
  });

  it('does not reuse a 20.04 cache when running on 24.04', async () => {
    getSuffixSpy.mockResolvedValue('-linux-24.04');

    // Pre-populate the cache with a different OS arch suffix to simulate
    // the cross-OS pollution that triggered issue #1087.
    const stalePythonDir: string = path.join(
      toolDir,
      'Python',
      '3.0.0',
      'x64-linux-20.04'
    );
    await io.mkdirP(stalePythonDir);
    fs.writeFileSync(`${stalePythonDir}.complete`, 'hello');

    // No manifest entry for `3.x` either, so the install path is not
    // exercised; we just want to confirm the stale cache is ignored.
    jest
      .spyOn(installer, 'findReleaseFromManifest')
      .mockResolvedValue(undefined);

    await expect(
      finder.useCpythonVersion('3.x', 'x64', false, false, false, false)
    ).rejects.toThrow();
  });

  it('does not reuse a plain (unsuffixed) cache from before this fix', async () => {
    getSuffixSpy.mockResolvedValue('-linux-24.04');

    // Pre-existing legacy `Python/3.0.0/x64` install (no OS suffix).
    // The lookup must NOT find this — the whole point of #1087 is to stop
    // treating these as compatible across OSes.
    const legacyPythonDir: string = path.join(
      toolDir,
      'Python',
      '3.0.0',
      'x64'
    );
    await io.mkdirP(legacyPythonDir);
    fs.writeFileSync(`${legacyPythonDir}.complete`, 'hello');

    jest
      .spyOn(installer, 'findReleaseFromManifest')
      .mockResolvedValue(undefined);

    await expect(
      finder.useCpythonVersion('3.x', 'x64', false, false, false, false)
    ).rejects.toThrow();
  });

  it('prefers the suffix derived from the release asset URL over runtime detection', async () => {
    // Runtime says 24.04 but the matched asset says 20.04 — the asset wins.
    getSuffixSpy.mockResolvedValue('-linux-24.04');
    getSuffixFromUrlSpy.mockImplementation((url: string | undefined) =>
      url && url.includes('20.04') ? '-linux-20.04' : ''
    );

    const fakeRelease: tc.IToolRelease = {
      version: '3.11.0',
      stable: true,
      release_url: 'https://example.com/release',
      files: [
        {
          filename: 'python-3.11.0-linux-20.04-x64.tar.gz',
          arch: 'x64',
          platform: 'linux',
          download_url:
            'https://example.com/python-3.11.0-linux-20.04-x64.tar.gz'
        }
      ]
    };

    const tcFindSpy = jest
      .spyOn(tc, 'find')
      // First call (initial cache lookup) misses.
      .mockReturnValueOnce('')
      // Second call (post-install lookup) should hit the asset-derived arch.
      .mockReturnValueOnce(
        path.join(toolDir, 'Python', '3.11.0', 'x64-linux-20.04')
      );

    jest
      .spyOn(installer, 'findReleaseFromManifest')
      .mockResolvedValue(fakeRelease);
    const installSpy = jest
      .spyOn(installer, 'installCpythonFromRelease')
      .mockResolvedValue(undefined);

    await finder.useCpythonVersion('3.11', 'x64', false, false, false, false);

    // Installer is invoked with the install arch and the asset-derived
    // toolcache arch.
    expect(installSpy).toHaveBeenCalledWith(
      fakeRelease,
      'x64',
      'x64-linux-20.04'
    );

    // The second `tc.find` call uses the asset-derived arch suffix, not
    // the (different) runtime-detected suffix.
    expect(tcFindSpy).toHaveBeenLastCalledWith(
      'Python',
      '3.11',
      'x64-linux-20.04'
    );
  });

  it('composes the OS suffix with the freethreaded arch suffix', async () => {
    getSuffixSpy.mockResolvedValue('-linux-24.04');

    const tcFindSpy = jest.spyOn(tc, 'find').mockReturnValue('');
    jest
      .spyOn(installer, 'findReleaseFromManifest')
      .mockResolvedValue(undefined);

    await expect(
      finder.useCpythonVersion('3.13t', 'x64', false, false, false, false)
    ).rejects.toThrow();

    // Freethreaded adds `-freethreaded`; the OS suffix is layered on top.
    expect(tcFindSpy).toHaveBeenCalledWith(
      'Python',
      expect.any(String),
      'x64-freethreaded-linux-24.04'
    );
  });

  it('does not decorate the tool-cache arch on non-Linux platforms', async () => {
    // Both helpers return '' for non-Linux — the suppression we set up in
    // `beforeEach`. Make sure `tc.find` is called with the plain arch.
    const tcFindSpy = jest.spyOn(tc, 'find').mockReturnValue('');
    jest
      .spyOn(installer, 'findReleaseFromManifest')
      .mockResolvedValue(undefined);

    await expect(
      finder.useCpythonVersion('3.11', 'x64', false, false, false, false)
    ).rejects.toThrow();

    expect(tcFindSpy).toHaveBeenCalledWith('Python', '3.11', 'x64');
  });
});
