import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  IS_WINDOWS,
  IS_LINUX,
  getOSInfo,
  getLinuxToolCacheSuffix
} from './utils';

import * as semver from 'semver';

import * as installer from './install-python';

import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import * as exec from '@actions/exec';

// Python has "scripts" or "bin" directories where command-line tools that come with packages are installed.
// This is where pip is, along with anything that pip installs.
// There is a separate directory for `pip install --user`.
//
// For reference, these directories are as follows:
//   macOS / Linux:
//      <sys.prefix>/bin (by default /usr/local/bin, but not on hosted agents -- see the `else`)
//      (--user) ~/.local/bin
//   Windows:
//      <Python installation dir>\Scripts
//      (--user) %APPDATA%\Python\PythonXY\Scripts
// See https://docs.python.org/3/library/sysconfig.html

function binDir(installDir: string): string {
  if (IS_WINDOWS) {
    return path.join(installDir, 'Scripts');
  } else {
    return path.join(installDir, 'bin');
  }
}

async function installPip(pythonLocation: string) {
  const pipVersion = core.getInput('pip-version');

  // Validate pip-version format: major[.minor][.patch]
  const versionRegex = /^\d+(\.\d+)?(\.\d+)?$/;
  if (pipVersion && !versionRegex.test(pipVersion)) {
    throw new Error(
      `Invalid pip-version "${pipVersion}". Please specify a version in the format major[.minor][.patch].`
    );
  }

  if (pipVersion) {
    core.info(
      `pip-version input is specified. Installing pip version ${pipVersion}`
    );
    await exec.exec(
      `${pythonLocation}/python -m pip install --upgrade pip==${pipVersion} --disable-pip-version-check --no-warn-script-location`
    );
  }
}

export async function useCpythonVersion(
  version: string,
  architecture: string,
  updateEnvironment: boolean,
  checkLatest: boolean,
  allowPreReleases: boolean,
  freethreaded: boolean
): Promise<InstalledVersion> {
  let manifest: tc.IToolRelease[] | null = null;
  const {version: desugaredVersionSpec, freethreaded: versionFreethreaded} =
    desugarVersion(version);
  let semanticVersionSpec = pythonVersionToSemantic(
    desugaredVersionSpec,
    allowPreReleases
  );
  if (versionFreethreaded) {
    // Use the freethreaded version if it was specified in the input, e.g., 3.13t
    freethreaded = true;
  }

  core.debug(`Semantic version spec of ${version} is ${semanticVersionSpec}`);
  if (freethreaded) {
    // Free threaded versions use an architecture suffix like `x64-freethreaded`
    core.debug(`Using freethreaded version of ${semanticVersionSpec}`);
    architecture += '-freethreaded';
  }

  // On Linux, append an OS-version suffix (e.g. '-ubuntu-24.04') to the
  // *version* segment of the tool-cache path so that Python installations
  // cached for different OS versions on the same self-hosted runner do not
  // conflict. For example:
  //   <tool-cache>/Python/3.8.18/x64
  // becomes
  //   <tool-cache>/Python/3.8.18-ubuntu-24.04/x64
  // The downloaded Python tarball is OS-specific (linked against a particular
  // glibc / OpenSSL), so reusing a cached install across OS versions can
  // break the interpreter.
  // See https://github.com/actions/setup-python/issues/1087.
  const osVersionSuffix = await getLinuxToolCacheSuffix();
  if (osVersionSuffix) {
    core.debug(
      `Using OS-isolated tool-cache path '<tool-cache>/Python/<version>${osVersionSuffix}/<arch>'.`
    );
  }

  if (checkLatest) {
    manifest = await installer.getManifest();
    const resolvedVersion = (
      await installer.findReleaseFromManifest(
        semanticVersionSpec,
        architecture,
        manifest
      )
    )?.version;

    if (resolvedVersion) {
      semanticVersionSpec = resolvedVersion;
      core.info(`Resolved as '${semanticVersionSpec}'`);
    } else {
      core.info(
        `Failed to resolve version ${semanticVersionSpec} from manifest`
      );
    }
  }

  let installDir: string | null = osVersionSuffix
    ? findIsolatedCpythonInstall(
        semanticVersionSpec,
        architecture,
        osVersionSuffix
      )
    : tc.find('Python', semanticVersionSpec, architecture);
  if (!installDir) {
    core.info(
      `Version ${semanticVersionSpec} was not found in the local cache`
    );
    const foundRelease = await installer.findReleaseFromManifest(
      semanticVersionSpec,
      architecture,
      manifest
    );

    if (foundRelease && foundRelease.files && foundRelease.files.length > 0) {
      core.info(`Version ${semanticVersionSpec} is available for downloading`);
      await installer.installCpythonFromRelease(foundRelease);

      if (osVersionSuffix) {
        // The python-versions install script writes to
        // <tool-cache>/Python/<exactVersion>/<arch>; move it to the
        // OS-isolated path before looking it up.
        renameInstallToIsolatedPath(
          foundRelease.version,
          architecture,
          osVersionSuffix
        );
        installDir = findIsolatedCpythonInstall(
          semanticVersionSpec,
          architecture,
          osVersionSuffix
        );
      } else {
        installDir = tc.find('Python', semanticVersionSpec, architecture);
      }
    }
  }

  if (!installDir) {
    const osInfo = await getOSInfo();
    const msg = [
      `The version '${version}' with architecture '${architecture}' was not found for ${
        osInfo
          ? `${osInfo.osName} ${osInfo.osVersion}`
          : 'this operating system'
      }.`
    ];
    if (freethreaded) {
      msg.push(
        `Free threaded versions are only available for Python 3.13.0 and later.`
      );
    }
    msg.push(
      `The list of all available versions can be found here: ${installer.MANIFEST_URL}`
    );
    throw new Error(msg.join(os.EOL));
  }

  const _binDir = binDir(installDir);
  const binaryExtension = IS_WINDOWS ? '.exe' : '';
  const pythonPath = path.join(
    IS_WINDOWS ? installDir : _binDir,
    `python${binaryExtension}`
  );
  if (updateEnvironment) {
    core.exportVariable('pythonLocation', installDir);
    core.exportVariable('PKG_CONFIG_PATH', installDir + '/lib/pkgconfig');
    core.exportVariable('pythonLocation', installDir);
    // https://cmake.org/cmake/help/latest/module/FindPython.html#module:FindPython
    core.exportVariable('Python_ROOT_DIR', installDir);
    // https://cmake.org/cmake/help/latest/module/FindPython2.html#module:FindPython2
    core.exportVariable('Python2_ROOT_DIR', installDir);
    // https://cmake.org/cmake/help/latest/module/FindPython3.html#module:FindPython3
    core.exportVariable('Python3_ROOT_DIR', installDir);
    core.exportVariable('PKG_CONFIG_PATH', installDir + '/lib/pkgconfig');

    if (IS_LINUX) {
      const libPath = process.env.LD_LIBRARY_PATH
        ? `:${process.env.LD_LIBRARY_PATH}`
        : '';
      const pyLibPath = path.join(installDir, 'lib');

      if (!libPath.split(':').includes(pyLibPath)) {
        core.exportVariable('LD_LIBRARY_PATH', pyLibPath + libPath);
      }
    }
    core.addPath(installDir);
    core.addPath(_binDir);

    if (IS_WINDOWS) {
      // Add --user directory
      // `installDir` from tool cache should look like $RUNNER_TOOL_CACHE/Python/<semantic version>/x64/
      // Extract version details
      const version = path.basename(path.dirname(installDir));
      const major = semver.major(version);
      const minor = semver.minor(version);

      const basePath = process.env['APPDATA'] || '';
      let versionSuffix = `${major}${minor}`;
      // Append '-32' for x86 architecture if Python version is >= 3.10
      if (
        architecture === 'x86' &&
        (major > 3 || (major === 3 && minor >= 10))
      ) {
        versionSuffix += '-32';
      } else if (architecture === 'arm64') {
        versionSuffix += '-arm64';
      }
      // Append 't' for freethreaded builds
      if (freethreaded) {
        versionSuffix += 't';
        if (architecture === 'x86-freethreaded') {
          versionSuffix += '-32';
        } else if (architecture === 'arm64-freethreaded') {
          versionSuffix += '-arm64';
        }
      }
      // Add user Scripts path
      const userScriptsDir = path.join(
        basePath,
        'Python',
        `Python${versionSuffix}`,
        'Scripts'
      );
      core.addPath(userScriptsDir);
    }
    // On Linux and macOS, pip will create the --user directory and add it to PATH as needed.
  }

  const installed = versionFromPath(installDir);
  let pythonVersion = installed;
  if (freethreaded) {
    // Add the freethreaded suffix to the version (e.g., 3.13.1t)
    pythonVersion += 't';
  }
  core.setOutput('python-version', pythonVersion);
  core.setOutput('python-path', pythonPath);

  const binaryPath = IS_WINDOWS ? installDir : _binDir;
  await installPip(binaryPath);

  return {impl: 'CPython', version: pythonVersion};
}

/* Desugar free threaded and dev versions */
export function desugarVersion(versionSpec: string) {
  const {version, freethreaded} = desugarFreeThreadedVersion(versionSpec);
  return {version: desugarDevVersion(version), freethreaded};
}

/* Identify freethreaded versions like, 3.13t, 3.13.1t, 3.13t-dev.
 * Returns the version without the `t` and the architectures suffix, if freethreaded */
function desugarFreeThreadedVersion(versionSpec: string) {
  const majorMinor = /^(\d+\.\d+(\.\d+)?)(t)$/;
  if (majorMinor.test(versionSpec)) {
    return {version: versionSpec.replace(majorMinor, '$1'), freethreaded: true};
  }
  const devVersion = /^(\d+\.\d+)(t)(-dev)$/;
  if (devVersion.test(versionSpec)) {
    return {
      version: versionSpec.replace(devVersion, '$1$3'),
      freethreaded: true
    };
  }
  return {version: versionSpec, freethreaded: false};
}

/** Convert versions like `3.8-dev` to a version like `~3.8.0-0`. */
function desugarDevVersion(versionSpec: string) {
  const devVersion = /^(\d+)\.(\d+)-dev$/;
  return versionSpec.replace(devVersion, '~$1.$2.0-0');
}

/** Extracts python version from install path from hosted tool cache as described in README.md */
function versionFromPath(installDir: string) {
  const parts = installDir.split(path.sep);
  const idx = parts.findIndex(part => part === 'PyPy' || part === 'Python');

  return parts[idx + 1] || '';
}

/**
 * Resolve the tool-cache root the same way `tc.find` does.
 * Returns `null` if neither environment variable is set so callers can fall
 * back to the default tool-cache lookup.
 */
function getToolCacheRoot(): string | null {
  return (
    process.env['RUNNER_TOOL_CACHE'] ||
    process.env['AGENT_TOOLSDIRECTORY'] ||
    null
  );
}

/**
 * Look up a previously installed Python in the OS-isolated tool-cache path
 * `<tool-cache>/Python/<exactVersion><osSuffix>/<arch>`.
 *
 * This mirrors `tc.find()` semantics (the install is considered present only
 * when a sibling `.complete` marker file exists) but scans the version
 * directories itself because `tc.find()` always treats the version segment as
 * the bare semver and would never look at the suffixed directories.
 *
 * Returns the resolved install directory or an empty string if no compatible
 * version is installed.
 */
function findIsolatedCpythonInstall(
  semanticVersionSpec: string,
  architecture: string,
  osVersionSuffix: string
): string {
  const toolCacheRoot = getToolCacheRoot();
  if (!toolCacheRoot) {
    return '';
  }
  const pythonRoot = path.join(toolCacheRoot, 'Python');
  if (!fs.existsSync(pythonRoot)) {
    return '';
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(pythonRoot);
  } catch (err) {
    core.debug(
      `Unable to enumerate '${pythonRoot}' for OS-isolated lookup: ${
        (err as Error).message
      }`
    );
    return '';
  }

  // Only consider directories whose name ends with our OS suffix. Strip the
  // suffix to get the exact installed Python version and match it against the
  // requested semver range.
  const candidates = entries
    .filter(name => name.endsWith(osVersionSuffix))
    .map(name => ({
      exactVersion: name.slice(0, name.length - osVersionSuffix.length),
      dirName: name
    }))
    .filter(({exactVersion}) => semver.valid(exactVersion))
    .filter(({exactVersion}) =>
      semver.satisfies(exactVersion, semanticVersionSpec, {
        includePrerelease: true
      })
    )
    .sort((a, b) => semver.rcompare(a.exactVersion, b.exactVersion));

  for (const {dirName} of candidates) {
    const installDir = path.join(pythonRoot, dirName, architecture);
    const marker = `${path.join(pythonRoot, dirName, architecture)}.complete`;
    if (fs.existsSync(installDir) && fs.existsSync(marker)) {
      return installDir;
    }
  }
  return '';
}

/**
 * Move a freshly installed Python directory from the default tool-cache path
 *   <tool-cache>/Python/<exactVersion>/<arch>
 * to the OS-isolated path
 *   <tool-cache>/Python/<exactVersion><osSuffix>/<arch>
 * along with its sibling `.complete` marker file.
 *
 * The python-versions install script writes to the unsuffixed path because the
 * target directory layout is hard-coded in the upstream setup script and
 * cannot be overridden via env var. Renaming after install is the simplest
 * way to get the OS-isolated layout without forking the install script.
 *
 * No-op if the source path does not exist (the install script may have failed
 * before producing it) or if the destination already exists.
 */
function renameInstallToIsolatedPath(
  exactVersion: string,
  architecture: string,
  osVersionSuffix: string
): void {
  const toolCacheRoot = getToolCacheRoot();
  if (!toolCacheRoot) {
    core.debug(
      'RUNNER_TOOL_CACHE is not set; skipping OS-isolated tool-cache rename.'
    );
    return;
  }
  const pythonRoot = path.join(toolCacheRoot, 'Python');
  const sourceVersionDir = path.join(pythonRoot, exactVersion);
  const targetVersionDir = path.join(
    pythonRoot,
    `${exactVersion}${osVersionSuffix}`
  );

  if (!fs.existsSync(sourceVersionDir)) {
    core.debug(
      `OS-isolated rename: source path '${sourceVersionDir}' does not exist; nothing to move.`
    );
    return;
  }
  if (fs.existsSync(targetVersionDir)) {
    core.debug(
      `OS-isolated rename: target path '${targetVersionDir}' already exists; leaving install scripts' output in place.`
    );
    return;
  }

  try {
    fs.renameSync(sourceVersionDir, targetVersionDir);
    // Move any sibling architecture-level `.complete` markers
    // (e.g. `<version>/x64.complete`) which were renamed implicitly with the
    // directory move above — they live inside the renamed dir so no extra
    // work is needed for them. But python-versions historically also writes
    // a top-level `<version>.complete` marker; move it if present.
    const sourceMarker = `${sourceVersionDir}.complete`;
    const targetMarker = `${targetVersionDir}.complete`;
    if (fs.existsSync(sourceMarker) && !fs.existsSync(targetMarker)) {
      fs.renameSync(sourceMarker, targetMarker);
    }
    core.info(
      `Moved Python install to OS-isolated tool-cache path '${targetVersionDir}/${architecture}'.`
    );
  } catch (err) {
    core.warning(
      `Failed to move Python install to OS-isolated tool-cache path '${targetVersionDir}': ${
        (err as Error).message
      }`
    );
  }
}

interface InstalledVersion {
  impl: string;
  version: string;
}

/**
 * Python's prelease versions look like `3.7.0b2`.
 * This is the one part of Python versioning that does not look like semantic versioning, which specifies `3.7.0-b2`.
 * If the version spec contains prerelease versions, we need to convert them to the semantic version equivalent.
 *
 * For easier use of the action, we also map 'x.y' to allow pre-release before 'x.y.0' release if allowPreReleases is true
 */
export function pythonVersionToSemantic(
  versionSpec: string,
  allowPreReleases: boolean
) {
  const prereleaseVersion = /(\d+\.\d+\.\d+)((?:a|b|rc)\d*)/g;
  const majorMinor = /^(\d+)\.(\d+)$/;
  let result = versionSpec.replace(prereleaseVersion, '$1-$2');
  if (allowPreReleases) {
    result = result.replace(majorMinor, '~$1.$2.0-0');
  }
  return result;
}
