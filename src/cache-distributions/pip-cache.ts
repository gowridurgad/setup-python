import * as glob from '@actions/glob';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as child_process from 'child_process';
import utils from 'util';
import * as path from 'path';
import os from 'os';

import CacheDistributor from './cache-distributor';
import {getLinuxInfo, IS_LINUX, IS_MAC, IS_WINDOWS} from '../utils';
import {CACHE_DEPENDENCY_BACKUP_PATH} from './constants';

class PipCache extends CacheDistributor {
  private cacheDependencyBackupPath: string = CACHE_DEPENDENCY_BACKUP_PATH;

  constructor(
    private pythonVersion: string,
    cacheDependencyPath = '**/requirements.txt'
  ) {
    super('pip', cacheDependencyPath);
  }

  protected async getCacheGlobalDirectories() {
    let exitCode = 1;
    let stdout = '';
    let stderr = '';

    // Define the Python executable based on the platform
    let pythonExecutable = 'python'; // Default Python command for Windows
    if (IS_LINUX || IS_MAC) {
      pythonExecutable = 'python3'; // Use python3 on Linux/macOS
    }

    // Add temporary fix for Windows
    if (IS_WINDOWS) {
      // Check if pip is available
      try {
        await exec.exec('pip', ['--version']);
      } catch (err) {
        // If pip is not available, install pip via python
        core.info('pip not found. Installing pip...');

        // Ensure python is available
        const pythonBinary = await this.getPythonExecutable(pythonExecutable);
        await exec.exec(`${pythonBinary} -m ensurepip`);
        await exec.exec(`${pythonBinary} -m pip install --upgrade pip`);
      }

      // Now execute the command
      const execPromisify = utils.promisify(child_process.exec);
      ({stdout, stderr} = await execPromisify('pip cache dir'));
    } else {
      // For non-Windows systems, just run the command as usual
      ({stdout, stderr, exitCode} = await exec.getExecOutput('pip cache dir'));
    }

    // Handle errors if any
    if (exitCode && stderr) {
      throw new Error(
        `Could not get cache folder path for pip package manager`
      );
    }

    let resolvedPath = stdout.trim();

    if (resolvedPath.includes('~')) {
      resolvedPath = path.join(os.homedir(), resolvedPath.slice(1));
    }

    core.debug(`global cache directory path is ${resolvedPath}`);

    return [resolvedPath];
  }

  // Function to get the correct Python executable based on platform
  private async getPythonExecutable(pythonExecutable: string) {
    let pythonPath = '';
    try {
      // Try running the python command to find the correct executable
      const {stdout} = await exec.getExecOutput(
        `${pythonExecutable} --version`
      );
      pythonPath = path.join(
        process.env['PYTHON_HOME'] || '',
        pythonExecutable
      );
      core.debug(`Using Python executable at: ${pythonPath}`);
    } catch (err) {
      core.error(
        `Python executable not found for ${pythonExecutable}. Please ensure Python is installed.`
      );
      throw err; // Rethrow the error
    }

    return pythonPath;
  }

  protected async computeKeys() {
    const hash =
      (await glob.hashFiles(this.cacheDependencyPath)) ||
      (await glob.hashFiles(this.cacheDependencyBackupPath));
    let primaryKey = '';
    let restoreKey = '';

    if (IS_LINUX) {
      const osInfo = await getLinuxInfo();
      primaryKey = `${this.CACHE_KEY_PREFIX}-${process.env['RUNNER_OS']}-${process.arch}-${osInfo.osVersion}-${osInfo.osName}-python-${this.pythonVersion}-${this.packageManager}-${hash}`;
      restoreKey = `${this.CACHE_KEY_PREFIX}-${process.env['RUNNER_OS']}-${process.arch}-${osInfo.osVersion}-${osInfo.osName}-python-${this.pythonVersion}-${this.packageManager}`;
    } else {
      primaryKey = `${this.CACHE_KEY_PREFIX}-${process.env['RUNNER_OS']}-${process.arch}-python-${this.pythonVersion}-${this.packageManager}-${hash}`;
      restoreKey = `${this.CACHE_KEY_PREFIX}-${process.env['RUNNER_OS']}-${process.arch}-python-${this.pythonVersion}-${this.packageManager}`;
    }

    return {
      primaryKey,
      restoreKey: [restoreKey]
    };
  }
}

export default PipCache;
