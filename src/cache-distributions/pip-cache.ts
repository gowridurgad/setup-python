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

    if (IS_WINDOWS) {
      // Check if Python is installed
      try {
        await exec.exec(`${pythonExecutable}`, ['--version']);
      } catch (err) {
        core.info(
          `Python not found. Installing Python ${this.pythonVersion}...`
        );
        await this.installPython();
      }

      // Check if pip is installed
      try {
        await exec.exec('pip', ['--version']);
      } catch (err) {
        core.info('pip not found. Installing pip...');
        await this.installPip(pythonExecutable);
      }

      // Get pip cache directory
      const execPromisify = utils.promisify(child_process.exec);
      ({stdout, stderr} = await execPromisify('pip cache dir'));
    } else {
      // For non-Windows systems, check if pip is available
      try {
        await exec.getExecOutput('python -m pip --version');
      } catch (err) {
        core.info('pip not found. Installing pip...');
        await this.installPip(pythonExecutable);
      }

      // Run the command to get pip cache dir
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

  // Function to install Python if it's missing
  private async installPython() {
    core.info(`Downloading Python ${this.pythonVersion}...`);
    const pythonInstallerUrl = `https://www.python.org/ftp/python/${this.pythonVersion}/python-${this.pythonVersion}.exe`;

    // Download and install Python
    await exec.exec('curl', ['-O', pythonInstallerUrl]);
    await exec.exec(`python-${this.pythonVersion}.exe`, [
      '/quiet',
      'InstallAllUsers=1',
      'PrependPath=1',
      'Include_pip=1'
    ]);

    // Clean up the installer
    await exec.exec('del', [`python-${this.pythonVersion}.exe`]);
  }

  // Function to install pip if it's missing
  private async installPip(pythonExecutable: string) {
    core.info('Installing pip using ensurepip...');
    await exec.exec(`${pythonExecutable} -m ensurepip`);
    await exec.exec(`${pythonExecutable} -m pip install --upgrade pip`);
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
