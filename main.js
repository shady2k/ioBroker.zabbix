'use strict';

/*
 * Created with @iobroker/create-adapter v1.19.0
 */
const utils = require('@iobroker/adapter-core');
const ZabbixPromise = require('./zabbix-promise');

function parseToSeconds(timeString) {
    let seconds = parseFloat(timeString);
    if (timeString.indexOf('d') != -1) {
        seconds *= 3600 * 24;
    }
    if (timeString.indexOf('m') != -1) {
        seconds *= 60;
    }
    if (timeString.indexOf('h') != -1) {
        seconds *= 3600;
    }
    if (timeString.indexOf('s') != -1) {
        seconds *= 1;
    }
    return seconds;
}

class Zabbix extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        const opts = typeof options === 'string' ? { name: options } : { ...options, name: 'zabbix' };
        super(opts);
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.isConnected = false;
        this.isInitialized = false;
        this.zabbixSetArr = {};
        this.zabbixGetArr = {};
        this.zabbix_url = '';
        this.globalTimer = null;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.log.debug('onReady');

        if (this.config.username) {
            this.log.debug('Before getForeignObject');
            this.getForeignObject('system.config', (err, obj) => {
                if (!err && obj) {
                    this.config.password = this.config.password.toString() || '';
                    this.main();
                } else {
                    this.log.error('Cannot find object system.config');
                }
            });
        } else {
            this.main();
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info('cleaned everything up...');
            this.stopTimer();
            //this.zabbix.logout();
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        const adapter = this;
        adapter.log.debug('Object change detected: ' + JSON.stringify(obj));
        this.deleteObject(id);

        if (obj && obj.common && obj.common.custom && obj.common.custom[adapter.namespace]) {
            if (obj.common.custom[adapter.namespace].enabled) {
                this.addToObjects(id, obj);
            }
        }
    }

    addToObjects(id, obj) {
        const adapter = this;
        adapter.log.debug('addToObjects: ' + JSON.stringify(obj));

        let custom = null;
        if (obj && obj.value && obj.value.common && obj.value.common.custom && obj.value.common.custom[adapter.namespace]) {
            custom = obj.value.common.custom[adapter.namespace];
        } else if (obj && obj.common && obj.common.custom && obj.common.custom[adapter.namespace]) {
            custom = obj.common.custom[adapter.namespace];
        } else {
            adapter.log.debug('Unknown object, ignore');
            return;
        }

        // Set
        if (!Object.prototype.hasOwnProperty.call(this.zabbixSetArr, id)) {
            if (custom.enabledSet) {
                const objExt = {
                    'id': id,
                    'zabbixHost': custom.zabbixHost,
                    'zabbixItemKey': custom.zabbixItemKey || id,
                    'Ack': custom.Ack,
                };
                adapter.addToZabbixSet(objExt);
            }
        }
        // Get
        if (!Object.prototype.hasOwnProperty.call(this.zabbixGetArr, id)) {
            if (custom.enabledGet) {
                const objExt = {
                    'id': id,
                    'zabbixItemGet': custom.zabbixItemGet,
                    'interval': parseToSeconds(custom.interval) || 30,
                    'setAck': custom.setAck === true,
                    'status': 0, //ready
                    'ttl': 0
                };
                adapter.addToZabbixGet(objExt);
            }
        }
    }

    deleteObject(id) {
        //Set
        if (Object.prototype.hasOwnProperty.call(this.zabbixSetArr, id)) {
            this.log.info('Remove Zabbix Set for id: ' + id);
            delete this.zabbixSetArr[id];
        }
        //Get
        if (Object.prototype.hasOwnProperty.call(this.zabbixGetArr, id)) {
            this.log.info('Remove Zabbix Get for id: ' + id);
            delete this.zabbixGetArr[id];
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            if (Object.prototype.hasOwnProperty.call(this.zabbixSetArr, id)) {
                if (state.from != 'system.adapter.' + this.namespace) {
                    this.log.debug('Catch state change "' + id + '": ' + JSON.stringify(state));
                    const objExt = this.zabbixSetArr[id];
                    if (state.ack === objExt.Ack) {
                        this.sendToZabbix(objExt.zabbixHost, objExt.zabbixItemKey, state.val);
                    } else {
                        this.log.debug('Ignore state value change, because unmatched ack');
                    }
                }
            }
        }
    }

    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.message" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    // 	if (typeof obj === 'object' && obj.message) {
    // 		if (obj.command === 'send') {
    // 			// e.g. send email or pushover or whatever
    // 			this.log.info('send command');

    // 			// Send response in callback if required
    // 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    // 		}
    // 	}
    // }


    main() {
        const adapter = this;

        if (this.config.url) {
            this.config.protocol = this.config.url.match(/^https:/) ? 'https' : 'http';
            const url = this.config.url.replace('https://', '').replace('http://', '');
            let parts = url.split('/');
            this.config.path = '/' + (parts[1] || '');
            parts = parts[0].split(':');
            this.config.host = parts[0];
            this.config.port = parts[1] || 80;
            delete this.config.url;
        }

        this.log.debug('Check host');
        if (this.config.host) {
            this.zabbix_url = this.config.protocol + '://' + this.config.host + ':' + (this.config.port || 80) + this.config.path;
            if (this.zabbix_url[this.zabbix_url.length - 1] === '/') {
                this.zabbix_url = this.zabbix_url.substring(0, this.zabbix_url.length - 1);
            }
            this.zabbix_url += '/api_jsonrpc.php';
        } else {
            this.log.warn('No Zabbix server URL defined.');
            return;
        }

        this.getObjectView('system', 'state', {}, function (err, doc) {
            if (doc && doc.rows) {
                for (let i = 0, l = doc.rows.length; i < l; i++) {
                    const obj = doc.rows[i];
                    if (obj && obj.id && obj.value && obj.value.common && obj.value.common.custom &&
                        obj.value.common.custom[adapter.namespace] && obj.value.common.custom[adapter.namespace].enabled) {
                        adapter.addToObjects(obj.id, obj);
                    }
                }
            }
            adapter.log.debug('Initialization completed');
            adapter.isInitialized = true;
            adapter.init();
        });

        this.setState('info.connection', false, true);

        this.log.debug('Before zabbix_connect');

        this.zabbix_connect();

        this.subscribeForeignObjects('*');
        this.subscribeForeignStates('*');
    }

    sendToZabbix(zabbixHost, zabbixItemKey, val) {
        const adapter = this;
        adapter.log.debug('sendToZabbix(' + zabbixHost + ', ' + zabbixItemKey + ', ' + val + ')');

        if (this.isConnected && this.isInitialized) {
            const data = {
                server: this.config.host,
                host: zabbixHost,
                key: zabbixItemKey,
                value: val.toString()
            };
            ZabbixPromise.sender(data).then(function (response) {
                adapter.log.debug('Zabbix Set response: ' + JSON.stringify(response));
            }).catch(function (response) {
                adapter.log.error('Zabbix Set response: ' + JSON.stringify(response));
            });
        } else {
            adapter.log.debug('Still not initialized, ignore.');
        }
    }

    getFromZabbix(objArr) {
        const adapter = this;
        const icnt = Object.keys(objArr).length;
        adapter.log.debug('getFromZabbix, count: ' + icnt);
        if (icnt > 0) {
            const itemids = Object.values(objArr).map(a => a.zabbixItemGet);

            if (this.isConnected && this.isInitialized && itemids.length > 0) {
                try {
                    const data = {
                        itemids: itemids,
                        output: ['lastvalue']
                    };
                    adapter.zabbix.request('item.get', data).then(function (response) {
                        adapter.log.debug('Zabbix Get response: ' + JSON.stringify(response));
                        adapter.processZabbixResponse(response);
                    }).catch(function (response) {
                        adapter.log.error('Zabbix Get response: ' + JSON.stringify(response));
                        adapter.log.warn('There are an error while processing request.');
                        adapter.disconnectFromZabbix();
                        for (const i in objArr) {
                            adapter.zabbixGetArr[objArr[i].id].status = 0;
                        }
                    });
                } catch (err) {
                    adapter.log.error(JSON.stringify(err));
                    adapter.log.warn('There are an error while processing request.');
                    adapter.disconnectFromZabbix();
                    for (const i in objArr) {
                        adapter.zabbixGetArr[objArr[i].id].status = 0;
                    }
                }
            } else {
                adapter.log.debug('Still not initialized, ignore.');
                for (const i in objArr) {
                    adapter.zabbixGetArr[objArr[i].id].status = 0;
                }
            }
        }
    }

    processZabbixResponse(response) {
        this.log.debug('processZabbixResponse call, count = ' + Object.keys(response).length);
        for (const i in response) {
            const obj = Object.values(this.zabbixGetArr).find(o => o.zabbixItemGet == response[i].itemid);
            if (obj) {
                this.log.debug('Found matched object in zabbixGetArr: ' + JSON.stringify(obj));
                this.zabbixGetArr[obj.id].ttl = this.zabbixGetArr[obj.id].interval;
                this.zabbixGetArr[obj.id].status = 0;
                this.log.debug('Update state value "' + obj.id + '" (val = ' + response[i].lastvalue + ', ack = ' + this.zabbixGetArr[obj.id].setAck + ')');
                this.setForeignStateAsync(obj.id, response[i].lastvalue, this.zabbixGetArr[obj.id].setAck);
            }
        }
    }

    addToZabbixSet(objExt) {
        this.log.debug('addToZabbixSet call: ' + JSON.stringify(objExt));
        this.log.info('Register Zabbix Set for id: ' + objExt.id);
        this.zabbixSetArr[objExt.id] = objExt;
    }

    addToZabbixGet(objExt) {
        this.log.debug('addToZabbixGet call: ' + JSON.stringify(objExt));
        this.log.info('Register Zabbix Get for id: ' + objExt.id);
        this.zabbixGetArr[objExt.id] = objExt;
    }

    disconnectFromZabbix() {
        const adapter = this;
        adapter.log.debug('Disconnecting from Zabbix server.');
        if (adapter.isConnected) {
            adapter.setConnectionState(false);
        }
        adapter.stopTimer();
        setTimeout(function () {
            adapter.zabbix_connect();
        }, 30000);
    }

    zabbix_connect() {
        const adapter = this;
        this.log.debug('zabbix_connect');
        if (!this.config.username) {
            this.log.warn('Username is not defined!');
            return;
        }

        try {
            this.zabbix = new ZabbixPromise({
                url: this.zabbix_url,
                user: this.config.username,
                password: this.config.password
            });

            this.log.debug('Before login');
            this.log.debug(`Trying to connect to ${this.zabbix_url}`);

            this.zabbix.login().then(function () {
                adapter.log.debug('Callback login zabbix_connect');
                adapter.setConnectionState(true);
            }).catch(function (err) {
                adapter.log.error(JSON.stringify(err));
                adapter.log.warn('Can\'t connect to Zabbix server! Will try to connect in 30 sec...');
                adapter.disconnectFromZabbix();
            });
        } catch (err) {
            adapter.log.error(JSON.stringify(err));
            adapter.log.warn('Can\'t connect to Zabbix server! Will try to connect in 30 sec...');
            adapter.disconnectFromZabbix();
        }
    }

    setConnectionState(state) {
        this.log.debug('Set connection state to: ' + state);
        this.setState('info.connection', state, true);
        this.isConnected = state;
        if (state) {
            this.log.info('Connected to Zabbix server');
            this.init();
        } else {
            this.log.info('Disconnected from Zabbix server');
        }
    }

    firstSync() {
        const adapter = this;
        for (const key in this.zabbixSetArr) {
            const objExt = this.zabbixSetArr[key];
            this.getState(objExt.zabbixItemKey, function (err, obj) {
                if (!err && obj) {
                    adapter.sendToZabbix(objExt.zabbixHost, objExt.zabbixItemKey, obj.val);
                }
            });
        }
    }

    startTimer() {
        const adapter = this;
        this.globalTimer = setTimeout(function () {
            adapter.onTick();
        }, 1000);
    }

    stopTimer() {
        this.log.debug('Stopping timer.');
        if (this.globalTimer) clearTimeout(this.globalTimer);
    }

    onTick() {
        this.log.silly('Timer tick: ' + JSON.stringify(this.zabbixGetArr));
        if (this.isConnected && this.isInitialized) {
            const objArr = [];

            for (const key in this.zabbixGetArr) {
                const objExt = this.zabbixGetArr[key];
                objExt.ttl = objExt.ttl - 1;
                if (objExt.ttl < 0) objExt.ttl = 0;
                if (objExt.ttl == 0 && objExt.status == 0) {
                    objExt.status = 1;
                    objArr.push(this.zabbixGetArr[key]);
                }
            }

            if (objArr.length > 0) {
                this.getFromZabbix(objArr);
            }

            this.startTimer();
        } else {
            this.log.debug('Not initialized, ignore.');
            this.stopTimer();
        }
    }

    init() {
        this.log.debug('Init call');
        if (this.isConnected && this.isInitialized) {
            this.firstSync();
            this.onTick();
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Zabbix(options);
} else {
    // otherwise start the instance directly
    new Zabbix();
}