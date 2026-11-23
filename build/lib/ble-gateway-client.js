"use strict";
// ---------------------------------------------------------------------------
// ble-gateway client helper — COPY THIS FILE INTO YOUR OWN ADAPTER.
//
// It lets any ioBroker adapter receive BLE advertisement packets from the
// central `ble-gateway` adapter without owning the HCI controller itself.
//
// Usage in your adapter:
//
//   import { BleGatewayClient } from './lib/ble-gateway-client';
//
//   class MyAdapter extends Adapter {
//       private ble = new BleGatewayClient(this);
//
//       constructor(options) {
//           super({
//               ...options,
//               message:     obj          => this.onMessage(obj),
//               stateChange: (id, state)  => this.ble.handleStateChange(id, state),
//               unload:      cb           => this.onUnload(cb),
//               ready:       ()           => this.onReady(),
//           });
//       }
//
//       async onReady() {
//           await this.ble.subscribe('sensors', { macs: ['aa:bb:cc:dd:ee:ff'] }, packet => {
//               this.log.info(`${packet.address} rssi=${packet.rssi} data=${packet.manufacturerData?.toString('hex')}`);
//           });
//       }
//
//       // stateChange must reach ble.handleStateChange(): it watches the gateway's
//       // `alive` state and re-subscribes when the gateway restarts.
//
//       onMessage(obj) {
//           if (this.ble.handleMessage(obj)) return; // consumed a 'blePacket'
//           // ... your own commands
//       }
//
//       onUnload(cb) {
//           this.ble.destroy().finally(cb);
//       }
//   }
//
// GATT (connect / read / write / notify) through the gateway:
//
//   const conn = await this.ble.gattConnect('aa:bb:cc:dd:ee:ff');
//   try {
//       await conn.subscribe('fff1', data => this.log.info(`notify ${data.toString('hex')}`));
//       await conn.write('fff2', Buffer.from('0102', 'hex'));
//       const value = await conn.read('2a19');
//   } finally {
//       await conn.disconnect();
//   }
//
// `handleMessage` must be called for every message: notifications arrive as
// 'gattNotify', unexpected link loss as 'gattDisconnected' (see onDisconnect).
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.BleGatewayClient = exports.BleGattConnection = exports.BleGatewayTimeoutError = void 0;
// Same canonical form as the gateway: "0000FFF1-0000-1000-8000-00805F9B34FB" → "fff1".
function normalizeUuid(u) {
    const s = (u || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    if (s.length === 32 && s.startsWith('0000') && s.endsWith('00001000800000805f9b34fb')) {
        return s.slice(4, 8);
    }
    return s;
}
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
// The gateway may wait up to 15 s for the controller to power on before it answers a subscribe.
const SUBSCRIBE_TIMEOUT_MS = 20000;
// Delay after the gateway's `alive` turned true, so it can finish its start-up first.
const RESUBSCRIBE_DELAY_MS = 2000;
// Delay before a subscribe that got no answer is sent again.
const RETRY_DELAY_MS = 10000;
/** Rejection of `request()` when the gateway did not answer in time. */
class BleGatewayTimeoutError extends Error {
}
exports.BleGatewayTimeoutError = BleGatewayTimeoutError;
/** An open GATT connection held by the gateway on behalf of this adapter. */
class BleGattConnection {
    id;
    address;
    characteristics;
    client;
    notifyHandlers = new Map();
    disconnectHandlers = [];
    closed = false;
    // Internal: created by BleGatewayClient.gattConnect().
    constructor(client, id, address, characteristics) {
        this.client = client;
        this.id = id;
        this.address = address;
        this.characteristics = characteristics;
    }
    isOpen() {
        return !this.closed;
    }
    /** Find a characteristic by UUID (short or long form). */
    findCharacteristic(uuid) {
        const want = normalizeUuid(uuid);
        return this.characteristics.find(c => c.uuid === want);
    }
    /** Enable notifications; `onData` receives every notified value. */
    async subscribe(characteristic, onData, service) {
        this.notifyHandlers.set(this.key(characteristic, service), onData);
        await this.client.request('gattSubscribe', { connectionId: this.id, characteristic, service });
    }
    async unsubscribe(characteristic, service) {
        this.notifyHandlers.delete(this.key(characteristic, service));
        await this.client.request('gattUnsubscribe', { connectionId: this.id, characteristic, service });
    }
    /** Write a value. `withoutResponse` = write command instead of write request. */
    async write(characteristic, data, withoutResponse = false, service) {
        await this.client.request('gattWrite', {
            connectionId: this.id,
            characteristic,
            service,
            data: data.toString('hex'),
            withoutResponse,
        });
    }
    async read(characteristic, service) {
        const r = await this.client.request('gattRead', {
            connectionId: this.id,
            characteristic,
            service,
        });
        return Buffer.from(r?.data || '', 'hex');
    }
    /** Close the link. Safe to call twice or after the link dropped. */
    async disconnect() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.client.forget(this.id);
        try {
            await this.client.request('gattDisconnect', { connectionId: this.id });
        }
        catch {
            // already gone on the gateway side
        }
    }
    /** Called when the link drops without disconnect() (device gone, gateway restarted, ...). */
    onDisconnect(cb) {
        this.disconnectHandlers.push(cb);
    }
    // Internal: called by BleGatewayClient.handleMessage().
    dispatchNotify(characteristic, service, data) {
        const uuid = normalizeUuid(characteristic);
        const handler = this.notifyHandlers.get(`${normalizeUuid(service)}/${uuid}`) || this.notifyHandlers.get(uuid);
        handler?.(data);
    }
    // Internal: called by BleGatewayClient.handleMessage().
    dispatchDisconnect(reason) {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const cb of this.disconnectHandlers) {
            try {
                cb(reason);
            }
            catch {
                // ignore
            }
        }
    }
    key(characteristic, service) {
        const uuid = normalizeUuid(characteristic);
        return service ? `${normalizeUuid(service)}/${uuid}` : uuid;
    }
}
exports.BleGattConnection = BleGattConnection;
class BleGatewayClient {
    adapter;
    gateway;
    aliveId;
    onConnectionChange;
    entries = new Map();
    gattConnections = new Map();
    // subscription ids waiting to be (re)sent to the gateway
    pending = new Set();
    flushTimer = null;
    watching = null;
    aliveKnown = false;
    gatewayAlive = false;
    connected = false;
    destroyed = false;
    /**
     * @param adapter your adapter instance (`this`)
     * @param gatewayInstance gateway instance id, default "ble-gateway.0"
     * @param onConnectionChange optional, called with true once the gateway acknowledged a subscription
     *     and with false when the gateway stops or a subscription fails
     */
    constructor(adapter, gatewayInstance = 'ble-gateway.0', onConnectionChange) {
        this.adapter = adapter;
        this.gateway = gatewayInstance;
        this.aliveId = `system.adapter.${this.gateway}.alive`;
        this.onConnectionChange = onConnectionChange;
    }
    /** True while the gateway instance is running (its `alive` state is true). */
    isGatewayAlive() {
        return this.gatewayAlive;
    }
    /**
     * Register (or replace) a subscription and start receiving packets.
     * If the gateway is not running, the subscription is sent as soon as it starts.
     * Re-subscribes automatically if the gateway restarts.
     */
    async subscribe(subscriptionId, filter, onPacket, minIntervalMs) {
        this.entries.set(subscriptionId, { filter, minIntervalMs, handler: onPacket });
        await this.ensureWatching();
        if (!this.gatewayAlive) {
            this.adapter.log.warn(`${this.gateway} is not running — subscription '${subscriptionId}' is sent when it starts`);
            return;
        }
        await this.sendSubscribe(subscriptionId);
    }
    /** Remove one subscription (or all when no id is given). */
    async unsubscribe(subscriptionId) {
        if (subscriptionId) {
            this.entries.delete(subscriptionId);
            this.pending.delete(subscriptionId);
        }
        else {
            this.entries.clear();
            this.pending.clear();
        }
        if (this.gatewayAlive) {
            await this.send('unsubscribe', subscriptionId ? { subscriptionId } : {});
        }
    }
    /**
     * Open a GATT connection to a device through the gateway. The device must
     * advertise within `discoverTimeoutMs`. Always call `disconnect()` when done.
     */
    async gattConnect(address, opts = {}) {
        // Watch the gateway, so its connections are reported as lost when it stops.
        await this.ensureWatching();
        if (!this.gatewayAlive) {
            throw new Error(`${this.gateway} is not running`);
        }
        const discoverTimeoutMs = opts.discoverTimeoutMs ?? 15000;
        const connectTimeoutMs = opts.connectTimeoutMs ?? 15000;
        const r = await this.request('gattConnect', { address: address.toLowerCase(), discoverTimeoutMs, connectTimeoutMs }, 
        // discovery + link + service discovery (10 s on the gateway) + margin
        discoverTimeoutMs + connectTimeoutMs + 15000);
        const conn = new BleGattConnection(this, r.connectionId, r.address, r.characteristics || []);
        this.gattConnections.set(conn.id, conn);
        return conn;
    }
    /**
     * Send a command to the gateway and wait for its answer. Rejects if the
     * gateway answers `{ error }` or does not answer within `timeoutMs`.
     */
    request(command, message, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new BleGatewayTimeoutError(`${this.gateway} did not answer ${command} within ${timeoutMs} ms`));
                }
            }, timeoutMs);
            this.adapter.sendTo(this.gateway, command, message, (res) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                const r = res;
                if (res instanceof Error) {
                    reject(res);
                }
                else if (r && typeof r === 'object' && r.error) {
                    reject(new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error)));
                }
                else {
                    resolve(res);
                }
            }, { timeout: timeoutMs + 1000 });
        });
    }
    // Internal: a connection closed itself.
    forget(connectionId) {
        this.gattConnections.delete(connectionId);
    }
    /** Call from your adapter's `message` handler. Returns true if the message was for this helper. */
    handleMessage(obj) {
        if (!obj) {
            return false;
        }
        switch (obj.command) {
            case 'blePacket': {
                const raw = obj.message;
                const entry = this.entries.get(raw.subscriptionId);
                if (entry) {
                    entry.handler(this.decode(raw));
                }
                return true; // ours by command, even without a live handler
            }
            case 'gattNotify': {
                const m = obj.message;
                this.gattConnections
                    .get(m?.connectionId)
                    ?.dispatchNotify(m.characteristic, m.service || '', Buffer.from(m.data || '', 'hex'));
                return true;
            }
            case 'gattDisconnected': {
                const m = obj.message;
                const conn = this.gattConnections.get(m?.connectionId);
                if (conn) {
                    this.gattConnections.delete(conn.id);
                    conn.dispatchDisconnect(m.reason || 'unknown');
                }
                return true;
            }
            default:
                return false;
        }
    }
    /**
     * Call from your adapter's `stateChange` handler. Watches the gateway's `alive` state:
     * the gateway forgets all subscriptions and GATT connections when it restarts, so
     * subscriptions are sent again as soon as it is back and open connections are
     * reported via `onDisconnect`.
     */
    handleStateChange(id, state) {
        if (id !== this.aliveId || !this.aliveKnown || this.destroyed) {
            return;
        }
        // `alive` is refreshed periodically (true → true) and deleted (null) when it expires after a crash.
        const alive = !!state?.val;
        if (alive === this.gatewayAlive) {
            return;
        }
        this.gatewayAlive = alive;
        if (alive) {
            if (this.entries.size) {
                this.adapter.log.info(`${this.gateway} started — re-subscribing`);
                this.clearFlushTimer();
                this.queueSubscribe(this.entries.keys(), RESUBSCRIBE_DELAY_MS);
            }
        }
        else {
            this.adapter.log.warn(`${this.gateway} stopped — waiting for it to come back`);
            this.clearFlushTimer();
            this.pending.clear();
            this.setConnected(false);
            const conns = [...this.gattConnections.values()];
            this.gattConnections.clear();
            for (const conn of conns) {
                conn.dispatchDisconnect('gateway stopped');
            }
        }
    }
    /** Unsubscribe everything, close all GATT connections and stop watching the gateway. Call from onUnload. */
    async destroy() {
        this.destroyed = true;
        this.clearFlushTimer();
        this.pending.clear();
        // An "unsubscribe all" makes the gateway close our GATT connections too.
        if (this.gatewayAlive || !this.aliveKnown) {
            await this.send('unsubscribe', {});
        }
        for (const conn of this.gattConnections.values()) {
            conn.dispatchDisconnect('client destroyed');
        }
        this.gattConnections.clear();
        this.entries.clear();
        if (this.watching) {
            this.watching = null;
            try {
                await this.adapter.unsubscribeForeignStatesAsync(this.aliveId);
            }
            catch {
                // ignore
            }
        }
    }
    // --- internals ---------------------------------------------------------
    ensureWatching() {
        this.watching ||= (async () => {
            try {
                await this.adapter.subscribeForeignStatesAsync(this.aliveId);
                const st = await this.adapter.getForeignStateAsync(this.aliveId);
                this.gatewayAlive = !!st?.val;
            }
            catch (e) {
                // Unknown state: try anyway, a missing gateway shows up as a timeout.
                this.adapter.log.debug(`${this.gateway} watch failed: ${e.message}`);
                this.gatewayAlive = true;
            }
            this.aliveKnown = true;
        })();
        return this.watching;
    }
    setConnected(connected) {
        if (connected !== this.connected) {
            this.connected = connected;
            this.onConnectionChange?.(connected);
        }
    }
    clearFlushTimer() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }
    /** Send the given subscriptions after `delayMs` (joins an already scheduled send). */
    queueSubscribe(ids, delayMs) {
        for (const id of ids) {
            this.pending.add(id);
        }
        if (this.flushTimer || this.destroyed) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            if (!this.gatewayAlive || this.destroyed) {
                return;
            }
            const ids = [...this.pending];
            this.pending.clear();
            for (const id of ids) {
                void this.sendSubscribe(id);
            }
        }, delayMs);
    }
    async sendSubscribe(subscriptionId) {
        const entry = this.entries.get(subscriptionId);
        if (!entry) {
            return;
        }
        let error = null;
        try {
            await this.request('subscribe', { subscriptionId, filter: entry.filter, minIntervalMs: entry.minIntervalMs }, SUBSCRIBE_TIMEOUT_MS);
        }
        catch (e) {
            error = e;
        }
        if (this.destroyed || this.entries.get(subscriptionId) !== entry) {
            return; // unsubscribed or replaced meanwhile
        }
        if (!error) {
            this.setConnected(true);
            return;
        }
        this.setConnected(false);
        if (!this.gatewayAlive) {
            return; // the gateway stopped meanwhile — sent again when it is back
        }
        if (error instanceof BleGatewayTimeoutError) {
            // The gateway may still be starting up — try again.
            this.adapter.log.warn(`${this.gateway} did not answer subscribe '${subscriptionId}' — retrying`);
            this.queueSubscribe([subscriptionId], RETRY_DELAY_MS);
        }
        else {
            this.adapter.log.warn(`${this.gateway} subscribe '${subscriptionId}' failed: ${error.message}`);
        }
    }
    // Fire a command and wait for the answer, but never hang (gateway may be down).
    async send(command, message) {
        try {
            await this.request(command, message, 5000);
        }
        catch (e) {
            this.adapter.log.debug(`${this.gateway} ${command}: ${e.message}`);
        }
    }
    decode(raw) {
        const out = {
            subscriptionId: raw.subscriptionId,
            address: raw.address,
            addressType: raw.addressType,
            rssi: raw.rssi,
            ts: raw.ts,
            connectable: raw.connectable,
            localName: raw.localName,
            txPowerLevel: raw.txPowerLevel,
            serviceUuids: raw.serviceUuids,
        };
        if (raw.manufacturerData) {
            out.manufacturerData = Buffer.from(raw.manufacturerData, 'hex');
        }
        if (raw.serviceData) {
            out.serviceData = raw.serviceData.map(sd => ({ uuid: sd.uuid, data: Buffer.from(sd.data, 'hex') }));
        }
        return out;
    }
}
exports.BleGatewayClient = BleGatewayClient;
//# sourceMappingURL=ble-gateway-client.js.map