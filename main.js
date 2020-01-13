'use strict';

/*
 * Created with @iobroker/create-adapter v1.19.0
 */
const utils = require('@iobroker/adapter-core');
const ZabbixPromise = require('zabbix-promise');

let zabbix_url = '';
let secret = 'RjAXsH3vvNa6EE';
const zabbixSetArr = {};
let isConnected = false;
let isInitialized = false;

class Zabbix extends utils.Adapter {
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'zabbix',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.zabbix;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.log.debug("onReady");

        if (this.config.username) {
            this.log.debug("Before getForeignObject");
            this.getForeignObject('system.config', (err, obj) => {
                if (!err && obj) {
                    if (!obj.native || !obj.native.secret) {
                        obj.native = obj.native || {};
                        require('crypto').randomBytes(24, (ex, buf) => {
                            secret = buf.toString('hex');
                            this.extendForeignObject('system.config', {native: {secret: secret}});
                            this.main();
                        });
                    } else {
                        this.config.password = this.decrypt(obj.native.secret, new Buffer(this.config.password, 'base64').toString('binary'));
                        this.main();
                    }
                } else {
                    this.log.error('Cannot find object system.config');
                }
            });
        } else {
            this.main();
        }

        // The adapters config (in the instance object everything under the attribute "native") is accessible via
        // this.config:
        //this.log.info('config option1: ' + this.config.option1);
        //this.log.info('config option2: ' + this.config.option2);

        /*
        For every state in the system there has to be also an object of type state
        Here a simple template for a boolean variable named "testVariable"
        Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables
        */
        /*await this.setObjectAsync('testVariable', {
            type: 'state',
            common: {
                name: 'testVariable',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: true,
            },
            native: {},
        });*/

        /*
        setState examples
        you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
        */
        // the variable testVariable is set to true as command (ack=false)
        //await this.setStateAsync('testVariable', true);

        // same thing, but the value is flagged "ack"
        // ack should be always set to true if the value is received from or acknowledged from the target system
        //await this.setStateAsync('testVariable', { val: true, ack: true });

        // same thing, but the state is deleted after 30s (getState will return null afterwards)
        //await this.setStateAsync('testVariable', { val: true, ack: true, expire: 30 });

        // examples for the checkPassword/checkGroup functions
        //let result = await this.checkPasswordAsync('admin', 'iobroker');
        //this.log.info('check user admin pw ioboker: ' + result);

        //result = await this.checkGroupAsync('admin', 'admin');
        //this.log.info('check group user admin group admin: ' + result);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info('cleaned everything up...');
            this.zabbix.logout();
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

        if(obj && obj.common && obj.common.custom && obj.common.custom[adapter.namespace]) {
            if(obj.common.custom[adapter.namespace].enabled) {
                this.addToObjects(id, obj);
            }
        }
    }

    addToObjects(id, obj) {
        const adapter = this;
        adapter.log.debug("addToObjects: " + JSON.stringify(obj));
        if(!Object.prototype.hasOwnProperty.call(zabbixSetArr, id)) {
            if(obj.common.custom[adapter.namespace].enabledSet) {
                const objExt = { 
                    "zabbixHost": obj.common.custom[adapter.namespace].zabbixHost,
                    "zabbixItemKey": obj.common.custom[adapter.namespace].zabbixItemKey || id
                };
                adapter.addToZabbixSet(id, objExt);
            }
        }
    }

    deleteObject(id) {
        if(Object.prototype.hasOwnProperty.call(zabbixSetArr, id)) {
            this.log.info('Remove Zabbix Set for id:: ' + id);
            delete zabbixSetArr[id];
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if(state) {
            if(Object.prototype.hasOwnProperty.call(zabbixSetArr, id)) {
                if(state.from != 'system.adapter.' + this.namespace) {
                    this.log.debug('Catch state change "'+id+'": ' + JSON.stringify(state));
                    const objExt = zabbixSetArr[id];
                    this.sendToZabbix(objExt.zabbixHost, objExt.zabbixItemKey, state.val);
                }
            }
        }
        
        /*if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }*/
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

    decrypt(key, value) {
        let result = '';
        for (let i = 0; i < value.length; i++) {
            result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
        }
        return result;
    }
    
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

        this.log.debug("Check host");
        if (this.config.host) {
            zabbix_url = this.config.protocol + '://' + this.config.host + ':' + (this.config.port || 80) + this.config.path;
            if (zabbix_url[zabbix_url.length - 1] === '/') {
                zabbix_url = zabbix_url.substring(0, zabbix_url.length - 1);
            }
            zabbix_url += '/api_jsonrpc.php';
        } else {
            this.log.warn('No Zabbix server URL defined.');
            return;
        }

        this.getObjectView('system', 'state', {}, function (err, doc) {
            if(doc && doc.rows) {
                for(let i = 0, l = doc.rows.length; i < l; i++) {
                    const obj = doc.rows[i];
                    if(obj && obj.id && obj.value && obj.value.common && obj.value.common.custom && 
                        obj.value.common.custom[adapter.namespace] && obj.value.common.custom[adapter.namespace].enabled) {
                        if(obj.value.common.custom[adapter.namespace].enabledSet) {
                            const objExt = { 
                                "zabbixHost": obj.value.common.custom[adapter.namespace].zabbixHost,
                                "zabbixItemKey": obj.value.common.custom[adapter.namespace].zabbixItemKey || obj.id
                            };
                            adapter.addToZabbixSet(obj.id, objExt);
                        }
                    }
                }
            }
            adapter.log.debug("Initialization completed");
            isInitialized = true;
            adapter.firstSync();
        });

        this.setState('info.connection', false, true);

        this.log.debug("Before zabbix_connect");
        this.zabbix_connect();

        this.subscribeForeignObjects('*');
        this.subscribeForeignStates('*');
    }

    sendToZabbix(zabbixHost, zabbixItemKey, val) {
        const adapter = this;
        adapter.log.debug('sendToZabbix(' + zabbixHost + ', ' + zabbixItemKey + ', ' + val + ')');

        if(isConnected && isInitialized) {
            const data = {
                server: this.config.host,
                host: zabbixHost,
                key: zabbixItemKey,
                value: val.toString()
            };
            ZabbixPromise.sender(data).then(function(response) {
                adapter.log.debug(JSON.stringify(response));
                //callback(response);
            }).catch(function(response) {
                adapter.log.error(JSON.stringify(response));
                //callback(response);
            });
        } else {
            adapter.log.debug('Still not initialized, ignore.');
        }
    }

    addToZabbixSet(id, objExt) {
        this.log.info('Register Zabbix Set for id: ' + id);
        zabbixSetArr[id] = objExt;
    }

    zabbix_connect(callback) {
        const adapter = this;
        this.log.debug("zabbix_connect");
        if(!this.config.username) {
            this.log.warn("Username is not defined!");
            return;
        }

        this.zabbix = new ZabbixPromise({
            url: zabbix_url,
            user: this.config.username,
            password: this.config.password
        });

        try {
            this.log.debug("Before login");
            this.zabbix.login().then(function(response) {
                adapter.log.debug("Callback login zabbix_connect: " + JSON.stringify(response));
                adapter.setConnectionState(true);
            }).catch(function(response) {
                adapter.log.debug("Callback catch zabbix_connect");
                adapter.log.error("zabbix_connect 1 " + JSON.stringify(response));
            });
        } catch (error) {
            this.log.error("zabbix_connect " + JSON.stringify(error));
        }
    }

    setConnectionState(state) {
        this.log.debug('Set connection state to: ' + state)
        this.setState('info.connection', state, true);
        isConnected = state;
        if(state) {
            this.log.info("Connected to Zabbix server");
            this.firstSync();
        } else {
            this.log.info("Disconnected from Zabbix server");
        }
    }

    firstSync() {
        const adapter = this;
        if(isConnected && isInitialized) {
            for (const key in zabbixSetArr) {
                const objExt = zabbixSetArr[key];
                this.getState(objExt.zabbixItemKey, function(err, obj) {
                    if(!err) {
                        adapter.sendToZabbix(objExt.zabbixHost, objExt.zabbixItemKey, obj.val);
                    }
                });
            }
        }
    }

    test() {
        const adapter = this;
        let val;
        this.log.debug("Before getState");
        const objExt = zabbixSetArr[Object.keys(zabbixSetArr)[0]];
        this.getState(objExt.zabbixItemKey, function(err, obj) {
            if(!err) {
                adapter.log.debug("getState callback");
                adapter.log.debug(JSON.stringify(obj));
                val = obj.val;
                adapter.log.debug("Before sendToZabbix");
                adapter.sendToZabbix(objExt.zabbixHost, objExt.zabbixItemKey, val);
            }
        });
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