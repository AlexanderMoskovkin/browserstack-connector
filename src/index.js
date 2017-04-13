import Promise from 'pinkie';
import OS from 'os-family';
import { createClient } from 'browserstack';
import { Local as BrowserStackLocal } from 'browserstack-local';
import wait from './utils/wait';


export default class BrowserStackConnector {
    constructor (username, accessKey, options = {}) {
        this.username  = username;
        this.accessKey = accessKey;

        const { connectorLogging = true } = options;

        this.options          = { connectorLogging };
        this.client           = createClient({ username, password: accessKey });
        this.localConnection  = null;
        this.tunnelIdentifier = Date.now();
    }

    _log (message) {
        if (this.options.connectorLogging)
            process.stdout.write(message + '\n');
    }

    _getWorkers () {
        return new Promise(resolve => this.client.getWorkers((err, res) => resolve(res)));
    }

    async _getWorker (id) {
        const getWorker = () => {
            return new Promise(resolve => {
                this.client.getWorker(id, (err, worker) => resolve(worker));
            });
        };

        const maxAttempts    = 30;
        const requestTimeout = 10000;

        let attempts = 0;

        while (attempts++ <= maxAttempts) {
            const worker = await getWorker();

            if (worker && worker.status === 'running')
                return worker;

            await wait(requestTimeout);
        }
    }

    async _getMaxAvailableMachines () {
        return new Promise((resolve, reject) => {
            this.client.getApiStatus((err, status) => {
                if (err) {
                    this._log(err);
                    reject(err);
                }
                else
                    resolve(status.sessions_limit);
            });
        });
    }

    async _getFreeMachineCount () {
        const [maxMachines, workers] = await Promise.all([this._getMaxAvailableMachines(), this._getWorkers()]);

        return maxMachines - workers.length;
    }

    async getSessionUrl (id) {
        const worker = await this._getWorker(id);

        return worker && worker.browser_url;
    }

    async startBrowser (browserSettings, url, { jobName, build } = {}, timeout = null) {
        const createWorker = () => {
            return new Promise((resolve, reject) => {
                const settings = {
                    os:              browserSettings.os,
                    os_version:      browserSettings.osVersion,
                    browser:         browserSettings.name || null,
                    browser_version: browserSettings.version || 'latest',
                    device:          browserSettings.device || null,
                    url:             url,
                    timeout:         timeout || 1800,
                    name:            jobName,
                    build:           build,
                    localIdentifier: this.tunnelIdentifier
                };

                this.client.createWorker(settings, (err, worker) => {
                    if (err) {
                        this._log(err);
                        reject(err);
                        return;
                    }

                    resolve(worker.id);
                });
            });
        };

        const workerId = await createWorker();

        return await this._getWorker(workerId);
    }

    stopBrowser (workerId) {
        return new Promise((resolve, reject) => {
            this.client.terminateWorker(workerId, (err, data) => {
                if (err) {
                    this._log(err);
                    reject(err);
                    return;
                }

                resolve(data.time);
            });
        });
    }

    connect () {
        const opts = {
            'key':                    this.accessKey,
            'logfile':                OS.win ? 'NUL' : '/dev/null',
            'enable-logging-for-api': true,
            'localIdentifier':        this.tunnelIdentifier
        };

        this.localConnection = new BrowserStackLocal();

        return new Promise((resolve, reject) => {
            this.localConnection.start(opts, err => {
                if (err) {
                    this._log(err);
                    reject(err);
                }
                else
                    resolve();
            });
        });
    }

    disconnect () {
        return new Promise(resolve => this.localConnection.stop(resolve));
    }

    async waitForFreeMachines (machineCount, requestInterval, maxAttemptCount) {
        var attempts = 0;

        while (attempts < maxAttemptCount) {
            var freeMachineCount = await this._getFreeMachineCount();

            if (freeMachineCount >= machineCount)
                return;

            this._log(`The number of free machines (${freeMachineCount}) is less than requested (${machineCount}).`);

            await wait(requestInterval);
            attempts++;
        }

        throw new Error('There are no free machines');
    }
}
