import * as path from 'path';
import * as os from 'os';
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import * as exec from '@actions/exec';
import {ExecOptions} from '@actions/exec';
import * as httpm from '@actions/http-client';
import * as fs from 'fs';
import * as semver from 'semver';
import {
  IS_WINDOWS,
  IS_LINUX,
  getDownloadFileName,
  getOsSuffix
} from './utils.js';
import {IToolRelease} from '@actions/tool-cache';

const TOKEN = core.getInput('token');
const AUTH = !TOKEN ? undefined : `token ${TOKEN}`;
const MANIFEST_REPO_OWNER = 'actions';
const MANIFEST_REPO_NAME = 'python-versions';
const MANIFEST_REPO_BRANCH = 'main';
export const MANIFEST_URL = `https://raw.githubusercontent.com/${MANIFEST_REPO_OWNER}/${MANIFEST_REPO_NAME}/${MANIFEST_REPO_BRANCH}/versions-manifest.json`;

interface LinuxOsRelease {
  id: string;
  versionId: string;
}

function getLinuxOsRelease(): LinuxOsRelease | null {
  try {
    const content = fs.readFileSync('/etc/os-release', 'utf8');
    const lines = content.split('\n');
    let id = '';
    let versionId = '';
    for (const line of lines) {
      const parts = line.split('=');
      if (parts.length === 2) {
        const key = parts[0].trim();
        const value = parts[1].trim().replace(/^"/, '').replace(/"$/, '');
        if (key === 'ID') id = value;
        if (key === 'VERSION_ID') versionId = value;
      }
    }
    if (id && versionId) {
      return {id, versionId};
    }
    return null;
  } catch {
    return null;
  }
}

function findRhelRelease(
  semanticVersionSpec: string,
  architecture: string,
  manifest: tc.IToolRelease[],
  osVersion: string
): tc.IToolRelease | undefined {
  for (const candidate of manifest) {
    const version = candidate.version;
    core.debug(`check ${version} satisfies ${semanticVersionSpec}`);

    if (!semver.satisfies(version, semanticVersionSpec)) continue;

    const file = candidate.files.find(item => {
      core.debug(
        `${item.arch}===${architecture} && ${item.platform}===rhel && ${item.platform_version}===${osVersion}`
      );
      const archMatch = item.arch === architecture;
      const platformMatch = item.platform === 'rhel';
      const versionMatch =
        !item.platform_version ||
        item.platform_version === osVersion ||
        osVersion.startsWith(item.platform_version);
      return archMatch && platformMatch && versionMatch;
    });

    if (file) {
      core.debug(`matched ${candidate.version}`);
      const result = Object.assign({}, candidate);
      result.files = [file];
      return result;
    }
  }
  return undefined;
}

const MANIFEST_FETCH_MAX_ATTEMPTS = 3;
const MANIFEST_FETCH_RETRY_BASE_DELAY_MS = 1000;

export async function findReleaseFromManifest(
  semanticVersionSpec: string,
  architecture: string,
  manifest: tc.IToolRelease[] | null
): Promise<tc.IToolRelease | undefined> {
  if (!manifest) {
    manifest = await getManifest();
  }

  // On RHEL, tc.findFromManifest() won't match because os.platform() returns 'linux'
  // but manifest entries use platform 'rhel'. Use custom filtering for RHEL.
  if (IS_LINUX) {
    const osRelease = getLinuxOsRelease();
    if (osRelease && osRelease.id === 'rhel') {
      core.debug(
        `Detected RHEL ${osRelease.versionId}, using custom manifest filtering`
      );
      return findRhelRelease(
        semanticVersionSpec,
        architecture,
        manifest,
        osRelease.versionId
      );
    }
  }

  const foundRelease = await tc.findFromManifest(
    semanticVersionSpec,
    false,
    manifest,
    architecture
  );

  return foundRelease;
}

function isIToolRelease(obj: any): obj is IToolRelease {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof obj.version === 'string' &&
    typeof obj.stable === 'boolean' &&
    Array.isArray(obj.files) &&
    obj.files.every(
      (file: any) =>
        typeof file.filename === 'string' &&
        typeof file.platform === 'string' &&
        typeof file.arch === 'string' &&
        typeof file.download_url === 'string'
    )
  );
}

// Rejects empty or truncated manifest responses.
function isValidManifest(manifest: unknown): manifest is tc.IToolRelease[] {
  return (
    Array.isArray(manifest) &&
    manifest.length > 0 &&
    manifest.every(isIToolRelease)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// HTTP 403/429 from http-client (`statusCode`) or tool-cache (`httpStatusCode`).
function isRateLimitError(err: unknown): boolean {
  const e = err as
    | {httpStatusCode?: number; statusCode?: number}
    | null
    | undefined;
  const status = e?.httpStatusCode ?? e?.statusCode;
  return status === 403 || status === 429;
}

// Fetches and validates a manifest, retrying transient failures with backoff.
async function fetchValidManifest(
  source: string,
  fetcher: () => Promise<tc.IToolRelease[]>
): Promise<tc.IToolRelease[]> {
  let lastError: Error | undefined;
  let attempts = 0;

  for (let attempt = 1; attempt <= MANIFEST_FETCH_MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      const manifest = await fetcher();
      if (isValidManifest(manifest)) {
        return manifest;
      }
      throw new Error(
        `The manifest fetched from ${source} is empty, truncated, or does not contain any valid tool release entries.`
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      core.debug(
        `Attempt ${attempt}/${MANIFEST_FETCH_MAX_ATTEMPTS} to fetch the manifest from ${source} failed: ${lastError.message}`
      );

      // Rate limits won't clear within the backoff window; fall back instead.
      if (isRateLimitError(err)) {
        core.debug(
          `${source} is rate-limited; skipping retries for this source.`
        );
        break;
      }

      if (attempt < MANIFEST_FETCH_MAX_ATTEMPTS) {
        const delay = MANIFEST_FETCH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        core.debug(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Failed to fetch a valid manifest from ${source} after ${attempts} attempt(s): ${lastError?.message}`
  );
}

export async function getManifest(): Promise<tc.IToolRelease[]> {
  try {
    return await fetchValidManifest('the GitHub API', getManifestFromRepo);
  } catch (err) {
    core.debug('Fetching the manifest via the API failed.');
    if (err instanceof Error) {
      core.debug(err.message);
    } else {
      core.debug('An unexpected error occurred while fetching the manifest.');
    }
  }

  try {
    return await fetchValidManifest('the raw URL', getManifestFromURL);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fail loudly so the action doesn't exit 0 without installing Python.
    throw new Error(
      `Failed to fetch the Python versions manifest. The response was empty, truncated, or invalid, and all retries were exhausted. ${message}`,
      {cause: err}
    );
  }
}

export function getManifestFromRepo(): Promise<tc.IToolRelease[]> {
  core.debug(
    `Getting manifest from ${MANIFEST_REPO_OWNER}/${MANIFEST_REPO_NAME}@${MANIFEST_REPO_BRANCH}`
  );
  return tc.getManifestFromRepo(
    MANIFEST_REPO_OWNER,
    MANIFEST_REPO_NAME,
    AUTH,
    MANIFEST_REPO_BRANCH
  );
}

export async function getManifestFromURL(): Promise<tc.IToolRelease[]> {
  core.debug('Falling back to fetching the manifest using raw URL.');

  const http: httpm.HttpClient = new httpm.HttpClient('tool-cache');
  const response = await http.getJson<tc.IToolRelease[]>(MANIFEST_URL);
  if (!response.result) {
    throw new Error(`Unable to get manifest from ${MANIFEST_URL}`);
  }
  return response.result;
}

async function installPython(
  workingDirectory: string,
  toolCacheOverride?: string
) {
  const options: ExecOptions = {
    cwd: workingDirectory,
    env: {
      ...process.env,
      ...(IS_LINUX && {LD_LIBRARY_PATH: path.join(workingDirectory, 'lib')}),
      // Issue #1087: on self-hosted Linux, redirect setup.sh's install target
      // to a temp dir so its `rm -rf $VERSION_PATH` step can't destroy our
      // previously-scoped sibling directories. We move the finished install
      // into the real (OS-scoped) tool-cache location afterward.
      ...(toolCacheOverride && {
        AGENT_TOOLSDIRECTORY: toolCacheOverride,
        RUNNER_TOOL_CACHE: toolCacheOverride
      })
    },
    silent: true,
    listeners: {
      stdout: (data: Buffer) => {
        core.info(data.toString().trim());
      },
      stderr: (data: Buffer) => {
        const msg = data.toString().trim();
        if (/^WARNING:/im.test(msg)) {
          core.warning(msg);
        } else {
          core.error(msg);
        }
      }
    }
  };

  if (IS_WINDOWS) {
    await exec.exec('powershell', ['./setup.ps1'], options);
  } else {
    await exec.exec('bash', ['./setup.sh'], options);
  }
}

/**
 * Issue #1087: relocate a freshly-installed Python from a scratch tool-cache
 * root into the real cache under an OS-scoped arch directory.
 *
 * Why the scratch root? `setup.sh` inside `actions/python-versions` release
 * tarballs starts by `rm -rf`-ing `$AGENT_TOOLSDIRECTORY/Python/<version>/`,
 * which would destroy any previously-scoped sibling directories (e.g. wipe
 * `x64-ubuntu-20.04/` when a job installs for `x64-ubuntu-24.04/`). By
 * pointing setup.sh at a fresh temp dir we let it do its destructive setup
 * safely, then move the finished tree into the real cache ourselves.
 *
 * Layout after this function:
 *   $REAL_TOOL_CACHE/Python/<version>/<arch>-<osId>-<osVer>/         (files)
 *   $REAL_TOOL_CACHE/Python/<version>/<arch>-<osId>-<osVer>.complete (marker)
 */
function relocateFromScratchToScopedCache(
  release: tc.IToolRelease,
  scratchRoot: string,
  suffix: string
): void {
  const arch = release.files[0].arch;
  const scopedArch = `${arch}-${suffix}`;

  const realRoot =
    process.env['AGENT_TOOLSDIRECTORY'] || process.env['RUNNER_TOOL_CACHE'];
  if (!realRoot) {
    core.warning(
      'Issue #1087: neither AGENT_TOOLSDIRECTORY nor RUNNER_TOOL_CACHE is ' +
        'set; cannot relocate scratch install. Cache will not be reused.'
    );
    return;
  }

  const src = path.join(scratchRoot, 'Python', release.version, arch);
  const destVersionDir = path.join(realRoot, 'Python', release.version);
  const dest = path.join(destVersionDir, scopedArch);
  const destMarker = `${dest}.complete`;

  core.debug(
    `Issue #1087: relocate src=${src} -> dest=${dest} (suffix=${suffix})`
  );

  try {
    if (!fs.existsSync(src)) {
      core.warning(
        `Issue #1087: expected install at ${src} but it does not exist. ` +
          `Cache will not be scoped.`
      );
      return;
    }

    fs.mkdirSync(destVersionDir, {recursive: true});

    // If a previous run already scoped this exact combination, clear it.
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, {recursive: true, force: true});
    }
    if (fs.existsSync(destMarker)) {
      fs.rmSync(destMarker, {force: true});
    }

    // Try atomic rename first; fall back to copy if src/dest live on
    // different filesystems (EXDEV, e.g. /tmp vs /opt on some runners).
    try {
      fs.renameSync(src, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
        core.debug('Issue #1087: cross-device rename; falling back to copy.');
        fs.cpSync(src, dest, {recursive: true});
        fs.rmSync(src, {recursive: true, force: true});
      } else {
        throw e;
      }
    }

    // Write the marker last so tc.find only reports "usable" after the
    // relocation is fully committed.
    fs.writeFileSync(destMarker, '');

    core.debug(`Issue #1087: relocated to ${dest}`);
  } catch (e) {
    core.warning(
      `Issue #1087: failed to relocate scratch install into scoped cache: ` +
        `${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    // Always clean up the scratch dir; even a partial install leaves debris.
    try {
      fs.rmSync(scratchRoot, {recursive: true, force: true});
    } catch {
      /* best effort */
    }
  }
}

export async function installCpythonFromRelease(release: tc.IToolRelease) {
  if (!release.files || release.files.length === 0) {
    throw new Error('No files found in the release to download.');
  }
  const downloadUrl = release.files[0].download_url;

  core.info(`Download from "${downloadUrl}"`);
  let pythonPath = '';
  try {
    const fileName = getDownloadFileName(downloadUrl);
    pythonPath = await tc.downloadTool(downloadUrl, fileName, AUTH);
    core.info('Extract downloaded archive');
    let pythonExtractedFolder;
    if (IS_WINDOWS) {
      pythonExtractedFolder = await tc.extractZip(pythonPath);
    } else {
      pythonExtractedFolder = await tc.extractTar(pythonPath);
    }

    // Issue #1087: on self-hosted Linux, install into a scratch tool-cache
    // dir so that setup.sh's destructive `rm -rf $VERSION_PATH` can't wipe
    // previously-scoped sibling arch directories. Then relocate the result
    // into the real cache under the OS-scoped arch name.
    const suffix = getOsSuffix();
    const scratchRoot = suffix
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'setup-python-1087-'))
      : undefined;

    core.info('Execute installation script');
    await installPython(pythonExtractedFolder, scratchRoot);

    if (suffix && scratchRoot) {
      relocateFromScratchToScopedCache(release, scratchRoot, suffix);
    }
  } catch (err) {
    if (err instanceof tc.HTTPError) {
      // Rate limit?
      if (err.httpStatusCode === 403) {
        core.error(
          `Received HTTP status code 403. This indicates a permission issue or restricted access.`
        );
      } else if (err.httpStatusCode === 429) {
        core.info(
          `Received HTTP status code 429.  This usually indicates the rate limit has been exceeded`
        );
      } else {
        core.info(err.message);
      }
      if (err.stack) {
        core.debug(err.stack);
      }
    }
    throw err;
  }
}
