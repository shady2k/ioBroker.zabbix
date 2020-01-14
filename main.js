'use strict';

/*
 * Created with @iobroker/create-adapter v1.19.0
 */
const utils = require('@iobroker/adapter-core');
const ZabbixPromise = require('zabbix-promise');

function parseToSeconds(timeString){
    let seconds = parseFloat(timeString);
    if(timeString.indexOf('d') != -1){
        seconds *= 3600 * 24;
    }
    if(timeString.indexOf('m') != -1){
        seconds *= 60;
    }
    if(timeString.indexOf('h') != -1){
        seconds *= 3600;
    }
    if(timeString.indexOf('s') != -1){
        seconds *= 1;
    }
    return seconds;
}

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
        this.isConnected = false;
        this.isInitialized = false;
        this.zabbixSetArr = {};
        this.zabbixGetArr = {};
        this.zabbix_url = '';
        this.secret = 'RjAXsH3vvNa6EE';
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
                    if (!obj.native || !obj.native.secret) {
                        obj.native = obj.native || {};
                        require('crypto').randomBytes(24, (ex, buf) => {
                            this.secret = buf.toString('hex');
                            this.extendForeignObject('system.config', {native: {secret: this.secret}});
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

        if(obj && obj.common && obj.common.custom && obj.common.custom[adapter.namespace]) {
            if(obj.common.custom[adapter.namespace].enabled) {
                this.addToObjects(id, obj);
            }
        }
    }

    addToObjects(id, obj) {
        const adapter = this;
        adapter.log.debug('addToObjects: ' + JSON.stringify(obj));
        if(!Object.prototype.hasOwnProperty.call(this.zabbixSetArr, id)) {
            if(obj.common.custom[adapter.namespace].enabledSet) {
                const objExt = { 
                    'zabbixHost': obj.common.custom[adapter.namespace].zabbixHost,
                    'zabbixItemKey': obj.common.custom[adapter.namespace].zabbixItemKey || id
                };
                adapter.addToZabbixSet(id, objExt);
            }
        }
    }

    deleteObject(id) {
        if(Object.prototype.hasOwnProperty.call(this.zabbixSetArr, id)) {
            this.log.info('Remove Zabbix Set for id:: ' + id);
            delete this.zabbixSetArr[id];
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if(state) {
            if(Object.prototype.hasOwnProperty.call(this.zabbixSetArr, id)) {
                if(state.from != 'system.adapter.' + this.namespace) {
                    this.log.debug('Catch state change "'+id+'": ' + JSON.stringify(state));
                    const objExt = this.zabbixSetArr[id];
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
            if(doc && doc.rows) {
                for(let i = 0, l = doc.rows.length; i < l; i++) {
                    const obj = doc.rows[i];
                    if(obj && obj.id && obj.value && obj.value.common && obj.value.common.custom && 
                        obj.value.common.custom[adapter.namespace] && obj.value.common.custom[adapter.namespace].enabled) {
                        const custom = obj.value.common.custom[adapter.namespace];
                        // Set enabled states
                        if(custom.enabledSet) {
                            const objExt = { 
                                'zabbixHost': custom.zabbixHost,
                                'zabbixItemKey': custom.zabbixItemKey || obj.id
                            };
                            adapter.addToZabbixSet(obj.id, objExt);
                        }
                        //Get enabled states
                        if(custom.enabledGet) {
                            const objExt = { 
                                'id': obj.id,
                                'zabbixItemGet': custom.zabbixItemGet,
                                'interval': parseToSeconds(custom.interval) || 30,
                                'setAck': custom.setAck === true,
                                'status': 0, //ready
                                'ttl': 0
                            };
                            adapter.addToZabbixGet(obj.id, objExt);
                        }
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

        if(this.isConnected && this.isInitialized) {
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

    getFromZabbix(objArr) {
        const adapter = this;
        const icnt = Object.keys(objArr).length;
        adapter.log.debug('getFromZabbix, count: ' + icnt);
        if(icnt > 0) {
            const itemids = Object.values(objArr).map(a => a.zabbixItemGet);

            if(this.isConnected && this.isInitialized && itemids.length > 0) {
                try {
                    const data = {
                        itemids: itemids,
                        output: ['lastvalue']
                    };
                    adapter.zabbix.request('item.get', data).then(function(response) {
                        adapter.log.debug(JSON.stringify(response));
                        adapter.processZabbixResponse(response);
                    }).catch(function(response) {
                        adapter.log.error(JSON.stringify(response));
                        adapter.log.warn('There are an error while processing request.');
                        adapter.disconnectFromZabbix();
                        for(const i in objArr) {
                            adapter.zabbixGetArr[objArr[i].id].status = 0;
                        }
                    });
                } catch (err) {
                    adapter.log.error(JSON.stringify(err));
                    adapter.log.warn('There are an error while processing request.');
                    adapter.disconnectFromZabbix();
                    for(const i in objArr) {
                        adapter.zabbixGetArr[objArr[i].id].status = 0;
                    }
                }
            } else {
                adapter.log.debug('Still not initialized, ignore.');
                for(const i in objArr) {
                    adapter.zabbixGetArr[objArr[i].id].status = 0;
                }
            }
        }
    }

    processZabbixResponse(response) {
        for (const i in response)
        {
            //this.log.debug();
            const obj = Object.values(this.zabbixGetArr).find(o => o.zabbixItemGet == response[i].itemid);
            if(obj) {
                this.zabbixGetArr[obj.id].ttl = this.zabbixGetArr[obj.id].interval;
                this.zabbixGetArr[obj.id].status = 0;
                this.log.debug('Update state val ' + obj.id + ' = ' + response[i].lastvalue + ', ack = ' + this.zabbixGetArr[obj.id].setAck);
                this.setStateAsync(obj.id, response[i].lastvalue, this.zabbixGetArr[obj.id].setAck);
            }
            this.log.debug(JSON.stringify(obj));
        }
    }

    addToZabbixSet(id, objExt) {
        this.log.info('Register Zabbix Set for id: ' + id);
        this.zabbixSetArr[id] = objExt;
    }

    addToZabbixGet(id, objExt) {
        this.log.info('Register Zabbix Get for id: ' + id);
        this.zabbixGetArr[id] = objExt;
    }

    disconnectFromZabbix() {
        const adapter = this;
        adapter.log.debug('Disconnecting from Zabbix server.');
        if(adapter.isConnected) { 
            adapter.setConnectionState(false);
        }
        adapter.stopTimer();
        setTimeout(function() {
            adapter.zabbix_connect();
        }, 30000);
    }

    zabbix_connect() {
        const adapter = this;
        this.log.debug('zabbix_connect');
        if(!this.config.username) {
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
            
            this.zabbix.login().then(function() {
                adapter.log.debug('Callback login zabbix_connect');
                adapter.setConnectionState(true);
            }).catch(function(err) {
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
        if(state) {
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
            this.getState(objExt.zabbixItemKey, function(err, obj) {
                if(!err && obj) {
                    adapter.sendToZabbix(objExt.zabbixHost, objExt.zabbixItemKey, obj.val);
                }
            });
        }
    }

    startTimer() {
        const adapter = this;
        this.globalTimer = setTimeout(function() {
            adapter.onTick();
        }, 1000);
    }

    stopTimer() {
        this.log.debug('Stopping timer.');
        clearTimeout(this.globalTimer);
    }

    onTick() {
        this.log.debug('Timer tick: ' + JSON.stringify(this.zabbixGetArr));
        if(this.isConnected && this.isInitialized) {
            const objArr = [];

            for (const key in this.zabbixGetArr) {
                const objExt = this.zabbixGetArr[key];
                objExt.ttl = objExt.ttl - 1;
                if(objExt.ttl < 0) objExt.ttl = 0;
                if(objExt.ttl == 0 && objExt.status == 0) {
                    objExt.status = 1;
                    objArr.push(this.zabbixGetArr[key]);
                }
            }
            
            if(objArr.length > 0) {
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
        if(this.isConnected && this.isInitialized) {
            this.firstSync();
            this.onTick();
        }
    }

    test() {
        const adapter = this;
        let val;
        const objExt = this.zabbixSetArr[Object.keys(this.zabbixSetArr)[0]];
        this.getState(objExt.zabbixItemKey, function(err, obj) {
            if(!err && obj) {
                adapter.log.debug('getState callback');
                adapter.log.debug(JSON.stringify(obj));
                val = obj.val;
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