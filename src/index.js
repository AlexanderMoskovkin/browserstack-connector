import os from 'os';
import Promise from 'pinkie';
import OS from 'os-family';
import { createClient } from 'browserstack';
import { Local as BrowserStackLocal } from 'browserstack-local';
import uid from 'uid';
import wait from './utils/wait';
import Hub from './hub.js';

const DEFAULT_BROWSER_OPENING_MAX_ATTEMPT = 3;
const DEFAULT_BROWSER_OPENING_TIMEOUT     = 60 * 1000;

const DEFAULT_HUB_PORT = 1000;

export default class BrowserStackConnector {
    constructor (username, accessKey, options = {}) {
        this.username  = username;
        this.accessKey = accessKey;

        const { connectorLogging = true, servicePort = DEFAULT_HUB_PORT } = options;

        this.options          = { connectorLogging };
        this.client           = createClient({ username, password: accessKey });
        this.localConnection  = null;
        this.tunnelIdentifier = Date.now();
        this.hubPort          = servicePort || DEFAULT_HUB_PORT;
        this.hub              = new Hub(this.hubPort);
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

    async _startBrowser (browserSettings, url, { jobName, build }, { workingTimeout, openingTimeout }) {
        const browserId = uid(10);

        let worker = null;

        const createWorker = () => {
            return new Promise((resolve, reject) => {
                const settings = {
                    os:              browserSettings.os,
                    os_version:      browserSettings.osVersion,
                    browser:         browserSettings.name || null,
                    browser_version: browserSettings.version || 'latest',
                    device:          browserSettings.device || null,
                    url:             `http://${os.hostname()}:${this.hubPort}/${browserId}?url=${url}`,
                    timeout:         workingTimeout || 1800,
                    name:            jobName,
                    build:           build,
                    localIdentifier: this.tunnelIdentifier
                };

                if ('realMobile' in browserSettings)
                    settings.realMobile = browserSettings.realMobile;

                this.client.createWorker(settings, (err, res) => {
                    if (err) {
                        this._log(err);
                        reject(err);
                        return;
                    }

                    resolve(res.id);
                });
            });
        };

        const waitForUrlOpened = new Promise((resolve, reject) => {
            let timeoutId = null;

            const hubHandler = id => {
                if (id === browserId) {
                    this.hub.removeListener('browser-opened', hubHandler);

                    clearTimeout(timeoutId);
                    resolve();
                }
            };

            timeoutId = setTimeout(async () => {
                this.hub.removeListener('browser-opened', hubHandler);

                await this.stopBrowser(worker.id);

                reject('Browser starting timeout expired');
            }, openingTimeout);

            this.hub.addListener('browser-opened', hubHandler);
        });

        const workerId = await createWorker();

        worker = await this._getWorker(workerId);

        await waitForUrlOpened;

        this._log(`${browserSettings.name} started. See ${worker.browser_url}`);

        return worker;
    }

    async startBrowser (browserSettings, url, { jobName, build } = {}, { maxAttepts, openingTimeout, workingTimeout } = {}) {
        let worker  = null;
        let attempt = 0;
        let error   = null;

        maxAttepts     = maxAttepts || DEFAULT_BROWSER_OPENING_MAX_ATTEMPT;
        openingTimeout = openingTimeout || DEFAULT_BROWSER_OPENING_TIMEOUT;

        while (attempt < maxAttepts && !worker) {
            try {
                error  = null;
                worker = await this._startBrowser(browserSettings, url, { jobName, build }, {
                    workingTimeout,
                    openingTimeout
                });
            }
            catch (err) {
                error = err;

                attempt++;
            }
        }

        if (error)
            throw new Error(`Unable to start browser ${browserSettings.name} due to: ${error}`);

        return worker;
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
        this.hub.close();

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
