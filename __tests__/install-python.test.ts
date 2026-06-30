import {
  getManifest,
  getManifestFromRepo,
  getManifestFromURL,
  installCpythonFromRelease
} from '../src/install-python';
import * as httpm from '@actions/http-client';
import * as tc from '@actions/tool-cache';
import * as exec from '@actions/exec';
import * as core from '@actions/core';
import * as io from '@actions/io';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

jest.mock('@actions/http-client');
jest.mock('@actions/tool-cache');
jest.mock('@actions/tool-cache', () => ({
  getManifestFromRepo: jest.fn(),
  downloadTool: jest.fn(),
  extractZip: jest.fn(),
  extractTar: jest.fn(),
  HTTPError: class HTTPError extends Error {
    httpStatusCode: number | undefined;
    constructor(httpStatusCode: number | undefined, message: string) {
      super(message);
      this.httpStatusCode = httpStatusCode;
    }
  }
}));
jest.mock('@actions/exec');
const mockManifest = [
  {
    version: '1.0.0',
    stable: true,
    files: [
      {
        filename: 'tool-v1.0.0-linux-x64.tar.gz',
        platform: 'linux',
        arch: 'x64',
        download_url: 'https://example.com/tool-v1.0.0-linux-x64.tar.gz'
      }
    ]
  }
];

describe('getManifest', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should return manifest from repo', async () => {
    (tc.getManifestFromRepo as jest.Mock).mockResolvedValue(mockManifest);
    const manifest = await getManifest();
    expect(manifest).toEqual(mockManifest);
  });

  it('should return manifest from URL if repo fetch fails', async () => {
    (tc.getManifestFromRepo as jest.Mock).mockRejectedValue(
      new Error('Fetch failed')
    );
    (httpm.HttpClient.prototype.getJson as jest.Mock).mockResolvedValue({
      result: mockManifest
    });
    const manifest = await getManifest();
    expect(manifest).toEqual(mockManifest);
  });
});

describe('getManifestFromRepo', () => {
  it('should return manifest from repo', async () => {
    (tc.getManifestFromRepo as jest.Mock).mockResolvedValue(mockManifest);
    const manifest = await getManifestFromRepo();
    expect(manifest).toEqual(mockManifest);
  });
});

describe('getManifestFromURL', () => {
  it('should return manifest from URL', async () => {
    (httpm.HttpClient.prototype.getJson as jest.Mock).mockResolvedValue({
      result: mockManifest
    });
    const manifest = await getManifestFromURL();
    expect(manifest).toEqual(mockManifest);
  });

  it('should throw error if unable to get manifest from URL', async () => {
    (httpm.HttpClient.prototype.getJson as jest.Mock).mockResolvedValue({
      result: null
    });
    await expect(getManifestFromURL()).rejects.toThrow(
      'Unable to get manifest from'
    );
  });
});

describe('installCpythonFromRelease — OS-isolated tool-cache (issue #1087)', () => {
  let runnerToolCache: string;
  const originalEnv = process.env;

  const fakeRelease: tc.IToolRelease = {
    version: '3.11.0',
    stable: true,
    release_url: 'https://example.com/release',
    files: [
      {
        filename: 'python-3.11.0-linux-24.04-x64.tar.gz',
        arch: 'x64',
        platform: 'linux',
        download_url: 'https://example.com/python-3.11.0-linux-24.04-x64.tar.gz'
      }
    ]
  };

  beforeEach(() => {
    jest.resetAllMocks();

    // Real temp tool-cache directory so we can assert directory moves.
    runnerToolCache = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-'));
    process.env = {
      ...originalEnv,
      RUNNER_TOOL_CACHE: runnerToolCache,
      AGENT_TOOLSDIRECTORY: ''
    };

    // Stub network + extract + install-script execution.
    (tc.downloadTool as jest.Mock).mockResolvedValue(
      path.join(runnerToolCache, 'archive.tar.gz')
    );
    (tc.extractTar as jest.Mock).mockResolvedValue(
      path.join(runnerToolCache, 'extracted')
    );
    (tc.extractZip as jest.Mock).mockResolvedValue(
      path.join(runnerToolCache, 'extracted')
    );

    // Simulate the upstream python-versions install script writing to the
    // legacy `Python/<version>/<installArch>` location.
    (exec.exec as jest.Mock).mockImplementation(async () => {
      const versionDir = path.join(
        runnerToolCache,
        'Python',
        fakeRelease.version
      );
      const archDir = path.join(versionDir, 'x64');
      fs.mkdirSync(archDir, {recursive: true});
      fs.writeFileSync(path.join(archDir, 'python'), '#!/bin/sh\n');
      fs.writeFileSync(`${archDir}.complete`, '');
      return 0;
    });

    jest.spyOn(core, 'info').mockImplementation(() => {});
    jest.spyOn(core, 'debug').mockImplementation(() => {});
    jest.spyOn(core, 'warning').mockImplementation(() => {});
    jest.spyOn(core, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (runnerToolCache) {
      await io.rmRF(runnerToolCache);
    }
    jest.restoreAllMocks();
  });

  it('leaves the install in place when no toolcacheArchitecture is given (back-compat)', async () => {
    await installCpythonFromRelease(fakeRelease);

    const legacyArchDir = path.join(runnerToolCache, 'Python', '3.11.0', 'x64');
    expect(fs.existsSync(legacyArchDir)).toBe(true);
    expect(fs.existsSync(`${legacyArchDir}.complete`)).toBe(true);
  });

  it('leaves the install in place when install arch matches toolcache arch', async () => {
    await installCpythonFromRelease(fakeRelease, 'x64', 'x64');

    const legacyArchDir = path.join(runnerToolCache, 'Python', '3.11.0', 'x64');
    expect(fs.existsSync(legacyArchDir)).toBe(true);
    expect(fs.existsSync(`${legacyArchDir}.complete`)).toBe(true);
  });

  it('renames the install to the toolcache arch when they differ', async () => {
    await installCpythonFromRelease(fakeRelease, 'x64', 'x64-linux-24.04');

    const legacyArchDir = path.join(runnerToolCache, 'Python', '3.11.0', 'x64');
    const isolatedArchDir = path.join(
      runnerToolCache,
      'Python',
      '3.11.0',
      'x64-linux-24.04'
    );
    expect(fs.existsSync(legacyArchDir)).toBe(false);
    expect(fs.existsSync(`${legacyArchDir}.complete`)).toBe(false);
    expect(fs.existsSync(isolatedArchDir)).toBe(true);
    expect(fs.existsSync(`${isolatedArchDir}.complete`)).toBe(true);
    // The python binary moved with the directory.
    expect(fs.existsSync(path.join(isolatedArchDir, 'python'))).toBe(true);
  });

  it('does not clobber an existing target arch directory', async () => {
    // Pre-populate the target so the rename would clobber it.
    const isolatedArchDir = path.join(
      runnerToolCache,
      'Python',
      '3.11.0',
      'x64-linux-24.04'
    );
    fs.mkdirSync(isolatedArchDir, {recursive: true});
    fs.writeFileSync(path.join(isolatedArchDir, 'sentinel'), 'preserved');
    fs.writeFileSync(`${isolatedArchDir}.complete`, '');

    await installCpythonFromRelease(fakeRelease, 'x64', 'x64-linux-24.04');

    // Sentinel survives — we didn't overwrite the pre-existing install.
    expect(
      fs.readFileSync(path.join(isolatedArchDir, 'sentinel'), 'utf8')
    ).toBe('preserved');
    // The just-installed legacy path is left intact (no-op rename).
    const legacyArchDir = path.join(runnerToolCache, 'Python', '3.11.0', 'x64');
    expect(fs.existsSync(legacyArchDir)).toBe(true);
  });
});
