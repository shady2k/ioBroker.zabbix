'use strict';

/*
 * Created with @iobroker/create-adapter v1.19.0
 */
const utils = require('@iobroker/adapter-core');
const ZabbixPromise = require('zabbix-promise');

let zabbix_url = "";
let secret = 'RjAXsH3vvNa6EE';

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
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
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

    decrypt(key, value) {
        let result = '';
        for (let i = 0; i < value.length; i++) {
            result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
        }
        return result;
    }
    
    main() {
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

        this.setState('info.connection', false, true);

        this.log.debug("Before zabbix_connect");
        this.zabbix_connect();

        this.subscribeStates('*');
    }

    zabbix_connect(callback) {
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
            let adapter = this;
            this.log.debug("Before login");
            this.zabbix.login().then(function(response) {
                adapter.log.debug("Callback login");
                adapter.setConnectionState(true);
            }).catch(function(response) {
                adapter.log.debug("Callback catch");
                adapter.log.error(JSON.stringify(response));
            });
        } catch (error) {
            this.log.error(error);
        }
    }

    setConnectionState(state) {
        this.log.debug('Set connection state to: ' + state)
        this.setState('info.connection', state, true);
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